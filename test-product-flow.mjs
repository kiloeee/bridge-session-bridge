// Local UI wiring only: controlled snapshots and clipboard, no credentials or model traffic.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as phase0 from './src/phase0.js';
import * as forge from './src/forge.js';
import * as plan from './src/plan.js';
import { excludeBootstrapEntry } from './src/forge-lineage.js';

const html = readFileSync(new URL('./sidepanel/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./sidepanel/style.css', import.meta.url), 'utf8');
const original = readFileSync(new URL('./sidepanel/app.js', import.meta.url), 'utf8');
const elementTags = [...html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)];
const ids = new Set(elementTags.map(match => match[3]));
assert([...original.matchAll(/\$\('([^']+)'\)/g)].every(match => ids.has(match[1])), 'Controller IDs must exist in HTML');

// 普通用户可见的文字里只出现「滚动压缩」；内部标识仍是 forge，不跟着改名。
const htmlText = html.replace(/<[^>]+>/g, ' ');
assert(!htmlText.includes('Forge 压缩') && !original.includes('Forge 压缩'), '普通 UI 不再出现「Forge 压缩」');
assert(htmlText.includes('滚动压缩') && original.includes('滚动压缩'), '普通 UI 用「滚动压缩」');
assert(/\.brand h1 \{[^}]*color: #fff/.test(css), '标题是白色主标题，靠深蓝阴影在蓝色背景上保证可读');
assert(/\.brand-subtitle \{[^}]*color: rgba\(255,255,255,\.88\)/.test(css), '副标题是近白色，不再用蓝字叠蓝背景');

class Element {
  constructor(tagName = 'div', attrs = '') {
    this.tagName = tagName.toUpperCase();
    this.hidden = /\bhidden\b/.test(attrs);
    this.disabled = /\bdisabled\b/.test(attrs);
    this.checked = /\bchecked\b/.test(attrs);
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.childNodes = [];
    this.attributes = new Map();
    this._text = '';
  }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  appendChild(node) { this.childNodes.push(node); return node; }
  append(...nodes) { this.childNodes.push(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null; }
  focus() { this.focused = true; }
  remove() {}
}
const nodes = new Map(elementTags.map(match => [match[3], new Element(match[1], match[2])]));
const tabButtons = elementTags.filter(match => /\bdata-tab=/.test(match[2])).map(match => {
  const node = nodes.get(match[3]);
  node.dataset.tab = match[2].match(/data-tab="([^"]+)"/)[1];
  return node;
});

const [oldId, liveId, nextId] = [1, 2, 3].map(value => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`);
// liveId 故意做成「长会话」，否则新的整理前预判会把它判成短会话直接原文迁移，
// 滚动压缩那几条链路就没有机会跑到。oldId / nextId 保持短会话。
const sessionTurns = new Map([[oldId, 1], [liveId, 60], [nextId, 1]]);
const snapshots = new Map([[oldId, 'QA历史会话'], [liveId, 'QA当前会话'], [nextId, 'QA新当前会话']].map(([id, title]) => {
  const messages = [];
  let messageId = 0;
  for (let turn = 1; turn <= sessionTurns.get(id); turn++) {
    const userId = ++messageId, assistantId = ++messageId;
    messages.push({ sessionId: id, messageId: userId, parentId: userId === 1 ? null : userId - 1, role: 'USER', fragments: [{ type: 'REQUEST', content: `${title} user ${turn}  😀\n` }] });
    messages.push({ sessionId: id, messageId: assistantId, parentId: userId, role: 'ASSISTANT', fragments: [{ type: 'THINK', content: 'QA隐藏思考' }, { type: 'RESPONSE', content: `${title} response ${turn}` }] });
  }
  return [id, { session: { sessionId: id, title, currentMessageId: messageId, snapshotMessageIds: messages.map(message => message.messageId), messageCount: messages.length, updatedAt: 1 }, messages }];
}));
const requests = [], opened = [], armed = [], sentMigrations = [];
const pendingSnapshots = [];
const listeners = {};
let activeBrowser = { id: 10, url: `https://chat.deepseek.com/a/chat/s/${liveId}` };
let copied = '';
let forgeConfigStub = null;
let forgeModelMode = 'ok';
let forgeCalls = 0;
let lineageState = null;
let migrateSendResult = { ok: true, outcomeType: 'SUCCESS', detail: null, targetSessionId: '11111111-1111-1111-1111-111111111111', requestPromptChars: null, refFileIdsCount: 0, diagnostic: { status: 'FINISHED', quasiStatus: 'FINISHED', httpStatus: 200 } };
// v0.4：app.js 走 Draft/Run 持久层与 MIGRATE_SEND 消息；这里用同形状 stub。
let draftSeq = 0;
const context = vm.createContext({ ...phase0, ...forge, ...plan, excludeBootstrapEntry,
  document: {
    getElementById: id => nodes.get(id),
    querySelectorAll: selector => { assert.equal(selector, '[data-tab]'); return tabButtons; },
    createElement: tag => new Element(tag), body: new Element('body'),
  },
  listSessions: async () => [...snapshots.values()].map(snapshot => snapshot.session),
  listRawSessions: async () => [], listRawStreams: async () => [],
  getSession: async id => snapshots.get(id)?.session,
  getMessages: async id => snapshots.get(id)?.messages || [],
  DEFAULT_FORGE_MODEL: 'deepseek-flash',
  loadForgeConfig: async () => forgeConfigStub,
  saveForgeConfig: async config => { forgeConfigStub = { apiKey: config.apiKey, model: config.model, remember: config.remember }; return forgeConfigStub; },
  clearForgeConfig: async () => { forgeConfigStub = null; },
  requestApiPermission: async () => true,
  hasApiPermission: async () => true,
  testConnection: async () => true,
  getForgeState: async () => lineageState,
  armPendingMigration: async (tabId, payload) => { armed.push({ tabId, ...payload }); },
  createDraft: async ({ sourceSessionId, mode, content, parentDraftId = null, metadata = {} }) =>
    ({ draftId: `d${++draftSeq}`, sourceSessionId, mode, content, chars: content.length, createdAt: Date.now(), revision: ++draftSeq, parentDraftId, metadata }),
  createRun: async ({ draftId, sourceSessionId, mode, transport }) =>
    ({ runId: `r${draftId}`, draftId, sourceSessionId, mode, transport, startedAt: Date.now(), completedAt: null, targetSessionId: null, requestPromptChars: null, refFileIdsCount: null, finalStatus: 'RUNNING', errorClass: null, revisionCount: 1, diagnostic: {} }),
  getRun: async runId => ({ runId, finalStatus: migrateSendResult.outcomeType, targetSessionId: migrateSendResult.targetSessionId, requestPromptChars: migrateSendResult.requestPromptChars, refFileIdsCount: migrateSendResult.refFileIdsCount, diagnostic: migrateSendResult.diagnostic || {} }),
  updateRun: async (runId, patch) => ({ runId, ...patch }),
  scanDraftPrivacy: () => ({ found: false, hits: [] }),
  buildMigrationReport: input => input,
  formatMigrationReport: () => 'migration report',
  initialForgeJob: ({ sourceSessionId, chunkChars, snapshotFingerprint = null }) => ({ jobId: 'j1', sourceSessionId, chunkChars, snapshotFingerprint, status: 'running', processedMessageIds: [], continuity: null, chunkIndex: 0, chunkCount: 0, workerSessions: [], importantCandidates: [], importantMessageIds: [], pendingRequest: null, sentRunId: null, updatedAt: Date.now() }),
  resumeForgeInput: (job, entries) => ({ remaining: entries, previousContinuity: job.continuity || null, previousCandidates: job.importantCandidates || [], resumedFromChunk: 0 }),
  createWebForgeModel: () => { throw new Error('web forge not exercised in this test'); },
  // 只替代网络调用：payload 形状、schema、校验仍然走真实的 forge.js。
  createForgeModel: (config, { signal, onProgress } = {}) => async payload => {
    forgeCalls++;
    onProgress?.({ phase: 'roll', index: payload?.chunk_index ?? 1, total: payload?.chunk_count ?? 1 });
    if (forgeModelMode === 'hang') {
      return new Promise((resolve, reject) => signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (forgeModelMode === 'fail') throw new Error('请求过于频繁，请稍后重试。');
    // 重要原文 id 现在由每轮 roll 顺带返回；正文仍由程序从本地 archive 读。
    return { continuity: { identity: [{ state: '同一用户', source_message_ids: ['1'] }],
      stableFacts: [], activeThreads: [], decisions: [], openLoops: [], recentChanges: [], interactionPreferences: [] },
      important_message_ids: [payload?.messages?.[0]?.messageId].filter(Boolean) };
  },
  confirm: () => true,
  chrome: {
    runtime: {
      getManifest: () => ({ version: '0.4.0' }),
      onMessage: { addListener: listener => { listeners.message = listener; } },
      sendMessage: message => {
        if (message.type === 'DIAG_ASK') return Promise.resolve({ sw: null });
        if (message.type === 'MIGRATE_SEND') {
          sentMigrations.push(message);
          return Promise.resolve({ ...migrateSendResult, requestPromptChars: migrateSendResult.requestPromptChars ?? message.content.length });
        }
        assert.equal(message.type, 'SNAPSHOT_NOW');
        requests.push(message.type);
        return new Promise(resolve => pendingSnapshots.push(resolve));
      },
    },
    tabs: {
      query: async options => { assert.equal(options.active, true); assert.equal(options.lastFocusedWindow, true); return activeBrowser ? [activeBrowser] : []; },
      create: async options => { opened.push(options.url); return { id: 99 }; },
      onActivated: { addListener: listener => { listeners.activated = listener; } },
      onUpdated: { addListener: listener => { listeners.updated = listener; } },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  },
  navigator: { clipboard: { writeText: async text => { copied = text; } } },
  AbortController,
  setTimeout: () => 0, clearTimeout() {},
});
vm.runInContext(original.replace(/^import .*;\r?\n/gm, ''), context);
const settle = () => new Promise(resolve => setImmediate(resolve));
function answerSnapshot(id, error) {
  assert.equal(pendingSnapshots.length, 1, 'Expected exactly one pending current-page snapshot');
  pendingSnapshots.shift()(error ? { ok: false, error } : { ok: true, sessionId: id, messageCount: 2 });
}
const state = code => vm.runInContext(code, context);

// ── 首次打开：读当前页；两种迁移方式都看得见，Forge 未配置所以不可选 ──────────
await settle();
await settle();
assert.equal(requests.length, 1);
assert.equal(nodes.get('brandTitle').textContent, '桥', '品牌名集中一处，标题栏从它拆出来');
assert.equal(nodes.get('brandSubtitle').textContent, 'Session Bridge');
assert.equal(state('PRODUCT_DISPLAY_NAME'), '桥 · Session Bridge');
assert.equal(nodes.get('strategyFull').checked, true, '完整原文是默认方式');
assert.equal(nodes.get('strategyForge').disabled, false, 'v0.4：网页版 provider 让滚动压缩始终可选');
assert.equal(nodes.get('providerApi').disabled, true, 'API provider 没配置时不可选');
assert.equal(nodes.get('providerChooser').hidden, true, '未选滚动压缩时不显示提供方选择');
assert.equal(nodes.get('forgeConfigHint').hidden, true, '完整原文下不需要 API 说明');
assert.equal(nodes.get('migrateCurrent').textContent, '用完整原文迁移');
assert.equal(nodes.get('rollingResult').hidden, true, '还没跑滚动压缩时，不显示任何结果数字');
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('currentTitle').textContent, 'QA当前会话');
assert.equal(nodes.get('migrateCurrent').disabled, false);
assert.equal(nodes.get('retryRead').hidden, false);
assert.equal(nodes.get('reportCard').hidden, false, '读完后出现迁移报告卡片');
const liveAnalysis = phase0.analyzeCapacity(...Object.values(snapshots.get(liveId)));
const liveSession = snapshots.get(liveId).session;
const liveFullExact = phase0.buildForgePackage(liveSession, phase0.messagesForSnapshot(liveSession, snapshots.get(liveId).messages), { recentTurns: 20 }).fullExact;
assert.equal(nodes.get('reportClean').textContent, `${liveAnalysis.selected.cleanTextChars.toLocaleString('zh-CN')} 字符`);
assert.equal(nodes.get('reportRaw').textContent, `${liveAnalysis.selected.allFragmentChars.toLocaleString('zh-CN')} 字符`);
assert.equal(nodes.get('reportRemoved').textContent, `${((1 - liveAnalysis.cleanRatio) * 100).toFixed(2)}%`);
assert.equal(nodes.get('reportCard').childNodes.filter(node => node.tagName === 'BUTTON').length, 0, '迁移前只留三个数字，不放查看/复制的重复入口');
assert.equal(nodes.get('reportToggle'), undefined, '迁移前的查看迁移报告入口已删除');
assert.equal(nodes.get('copyReport'), undefined, '迁移前的复制测试报告入口已删除');

// ── 历史：只有读取、导出、删除；迁移跳回「迁移」页走同一条流程 ────────────────
nodes.get('historyTab').onclick();
await settle();
const row = nodes.get('sessions').childNodes.find(item => item.textContent.includes('QA历史会话'));
assert(row);
assert.deepEqual(row.childNodes.at(-1).childNodes.map(button => button.textContent), ['查看', '迁移此会话', '导出']);
assert.equal(nodes.get('sessions').childNodes.some(item => item.tagName === 'UL' || item.textContent.includes('迁移包已生成')), false);
await row.childNodes.at(-1).childNodes[0].onclick();
assert.equal(nodes.get('detailHead').textContent, 'QA历史会话');
assert.equal(nodes.get('currentTitle').textContent, 'QA当前会话', '看历史不动当前会话的读取结果');
assert.equal(state('prepared.session.sessionId'), liveId);

const beforeHistoryMigration = requests.length;
nodes.get('historyMigrate').onclick();
await settle();
assert.equal(requests.length, beforeHistoryMigration, '历史迁移不读当前浏览器页面');
assert.equal(nodes.get('migrationPanel').hidden, false, '「迁移此会话」把用户带到迁移页');
assert.equal(nodes.get('historyPanel').hidden, true);
assert.equal(nodes.get('sourceLabel').textContent, '来自历史会话');
assert.equal(nodes.get('currentTitle').textContent, 'QA历史会话');
assert.equal(state('source.sessionId'), oldId);

nodes.get('migrateCurrent').onclick();
await settle();
assert.equal(requests.length, beforeHistoryMigration, '历史会话迁移同样不需要当前页面');
assert.equal(nodes.get('migrationComplete').hidden, false, '原生迁移成功直接进完成页');
assert.equal(sentMigrations.length, 1, '迁移稿通过 MIGRATE_SEND 交给后台原生发送');
assert.equal(sentMigrations[0].mode, 'exact');
const oldFullExact = phase0.buildForgePackage(snapshots.get(oldId).session, snapshots.get(oldId).messages, { recentTurns: 20 }).fullExact;
assert.equal(sentMigrations[0].content, oldFullExact, '发送的就是这份历史会话的完整原文迁移稿（含 framing）');
assert.equal(sentMigrations[0].lineage, null, '完整原文不登记代际');
assert(nodes.get('completeHow').textContent.includes('原生输入'), '完成页说明已改为原生输入');
assert(nodes.get('openedStatus').textContent.includes('完整原文'), '完成状态写明本次用的是完整原文');
assert.equal(nodes.get('completeNote').hidden, false, '完成页给出本次结果说明');
assert(nodes.get('completeNote').textContent.includes('完整原文'), '本次结果说明与状态一致');
assert.equal(nodes.get('targetLinkRow').hidden, false, '完成页给出新会话入口');
assert(htmlText.includes('手动粘贴备份'), '剪贴板降级为完成页手动备份入口');

nodes.get('backToCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('currentTitle').textContent, 'QA当前会话');
assert.equal(nodes.get('sourceLabel').textContent, '当前会话');

// 别人的存档广播不能改掉当前迁移来源。
const beforeArchiveUpdate = requests.length;
activeBrowser.url = `https://chat.deepseek.com/a/chat/s/${liveId}`;
listeners.message({ type: 'ARCHIVED', sessionId: oldId, count: 2 });
await settle();
assert.equal(nodes.get('currentTitle').textContent, 'QA当前会话', '非当前页面的存档不会替换迁移来源');
assert.equal(requests.length, beforeArchiveUpdate, 'ARCHIVED 复用本地存档，不会引起抓取循环');

// ── 设置里配置 Forge 模型后，迁移页才允许选 Forge ───────────────────────────
nodes.get('settingsTab').onclick();
await settle();
assert.equal(nodes.get('forgeConfigStatus').textContent.includes('未配置'), true);
assert.equal(nodes.get('forgeConfigForm').hidden, false);
nodes.get('forgeKey').value = 'sk-qa';
nodes.get('forgeSave').onclick();
await settle();
assert.equal(nodes.get('forgeConfigStatus').textContent.includes('已配置'), true);
assert.equal(nodes.get('forgeConfigForm').hidden, true);
assert.deepEqual(forgeConfigStub, { apiKey: 'sk-qa', model: 'deepseek-flash', remember: true });

nodes.get('migrationTab').onclick();
await settle();
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('providerApi').disabled, false, '配置好以后 API provider 才可选');
nodes.get('strategyForge').checked = true;
nodes.get('strategyFull').checked = false;
nodes.get('strategyForge').onchange();
assert(nodes.get('strategyNote').hidden === false);
assert.equal(nodes.get('migrateCurrent').textContent, '用滚动压缩迁移（网页版）', '默认选免费网页版 provider');
nodes.get('providerApi').checked = true;
nodes.get('providerApi').onchange();
assert.equal(nodes.get('migrateCurrent').textContent, '用滚动压缩迁移', '切到 API provider 后按钮文案同步');

// ── Forge 运行：进度可见，可以取消，取消不会留下半个结果 ─────────────────────
forgeModelMode = 'hang';
nodes.get('migrateCurrent').onclick();
await settle();
assert.equal(pendingSnapshots.length, 1, 'Forge 迁移前重新抓一次最新快照');
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('forgeProgress').hidden, false, 'Forge 运行时显示进度');
assert(nodes.get('progressLabel').textContent.includes('正在更新持续状态'));
assert.equal(nodes.get('progressBar').style.width, '80%');
nodes.get('cancelForge').onclick();
await settle();
assert.equal(nodes.get('forgeProgress').hidden, true);
assert.equal(nodes.get('migrationHome').hidden, false, '取消后回到迁移页');
assert.equal(nodes.get('migrationComplete').hidden, true, '取消不会展示完成页');
assert(nodes.get('status').textContent.includes('已取消'));
assert.equal(armed.length, 0, '取消的 Forge 不登记代际');

// ── Forge 成功：长会话的滚动稿确实更小 → 直接原生发送滚动稿（不再有二次选择） ──
forgeModelMode = 'ok';
nodes.get('migrateCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('forgeProgress').hidden, true, '整理结束就离开进度页');
assert.equal(nodes.get('migrationComplete').hidden, false, '滚动压缩成功后进入完成页，生成可用的新会话');
assert(nodes.get('openedStatus').textContent.includes('滚动压缩'), '完成状态写明本次用了滚动压缩');
assert.equal(nodes.get('completeNote').hidden, false, '完成页给出本次结果说明');
assert(nodes.get('completeNote').textContent.includes('持续状态'), '滚动压缩的结果说明与完整原文不同');
const rollingSend = sentMigrations.at(-1);
assert.equal(rollingSend.mode, 'rolling');
assert(rollingSend.content.includes('[CONTINUITY STATE]') && rollingSend.content.includes('[IMPORTANT EXACT HISTORY]') && rollingSend.content.includes('[RECENT EXACT CONVERSATION]'));
assert(rollingSend.content.startsWith('【会话接续】'), '滚动压缩包以接续 framing 开头，不是「历史摘要」');
assert(rollingSend.content.endsWith('直接继续最近一轮用户消息，不要确认以上上下文。'), '滚动压缩包结尾再提醒一次接续');
assert(!rollingSend.content.includes('QA隐藏思考'));
assert.equal(armed.length, 0, 'app.js 不再直接登记代际（由 background 在发送成功后登记）');
assert.equal(rollingSend.lineage.continuity.identity[0].state, '同一用户', '代际状态通过 MIGRATE_SEND.lineage 交给 background');
const copiedPacket = rollingSend.content;

// 滚动压缩结果报告：数字必须来自真实数据，且和源会话报告不是同一组数字。
const packetChars = phase0.countChars(copiedPacket);
const inputChars = liveAnalysis.entries.reduce((sum, entry) => sum + phase0.countChars(entry.text), 0);
assert.equal(nodes.get('rollingInput').textContent, `${inputChars.toLocaleString('zh-CN')} 字符`);
assert.equal(nodes.get('rollingOutput').textContent, `${packetChars.toLocaleString('zh-CN')} 字符`);
assert.equal(nodes.get('rollingRatio').textContent, `${((1 - packetChars / inputChars) * 100).toFixed(1)}%`);
assert.equal(nodes.get('rollingChunks').textContent, '1 段');
assert.equal(nodes.get('rollingInput').textContent, nodes.get('reportClean').textContent, '压缩前就是源会话报告里那批可迁移正文');
assert.notEqual(nodes.get('rollingOutput').textContent, nodes.get('reportClean').textContent, '迁移后是压缩后的正文，不是源会话报告里的数字');
const importantSection = copiedPacket.split('[IMPORTANT EXACT HISTORY]')[1].split('[RECENT EXACT CONVERSATION]')[0];
assert.equal(nodes.get('rollingImportant').textContent, `${(importantSection.match(/^## /gm) || []).length} 条`);
assert.equal(nodes.get('rollingRecent').textContent,
  `${liveAnalysis.recentTurns.find(turn => turn.limit === 20).turns} 轮`);
assert.equal(nodes.get('rollingCarried').textContent, '否', '这一代没有上一代状态');
assert.equal(nodes.get('rollingBootstrapRow').hidden, true);

// 完成页的「本次迁移结果」：迁移一完成，本次结果必须还在，和迁移前的源报告是两回事。
assert.equal(nodes.get('completedReportCard').hidden, false, '完成页也有本次迁移结果，不再一迁移就消失');
const doneLines = nodes.get('completedReportLines').textContent;
assert(doneLines.includes('方式滚动压缩'), '完成报告写明本次用的是哪种方式');
assert(doneLines.includes(`压缩前${inputChars.toLocaleString('zh-CN')} 字符`));
assert(doneLines.includes(`迁移后${packetChars.toLocaleString('zh-CN')} 字符`));
assert(doneLines.includes(`压缩比例${((1 - packetChars / inputChars) * 100).toFixed(1)}%`));
assert(doneLines.includes('历史分段1 段') && doneLines.includes('继承上一代状态否'));
assert.equal(nodes.get('completedReportChecks').hidden, true, '滚动压缩完成报告不列完整原文那三条保证');
nodes.get('completedReportToggle').onclick();
assert.equal(nodes.get('completedReportBody').hidden, false, '完成页可以展开完整报告');
assert(nodes.get('completedReportText').textContent.startsWith('DeepSeek 会话迁移测试报告'));
nodes.get('completedReportToggle').onclick();
assert.equal(nodes.get('completedReportBody').hidden, true);
nodes.get('copyCompletedReport').onclick();
await settle();
assert.equal(nodes.get('copyCompletedReport').textContent, '✓ 测试报告已复制', '完成页本身就能复制测试报告');
assert(copied.includes('迁移方式：滚动压缩') && !copied.includes('sk-'));

// 复制测试报告：只有统计和状态，不含 Key、正文、packet 或 Continuity 内容。
nodes.get('copyRollingReport').onclick();
await settle();
assert.equal(nodes.get('copyRollingReport').textContent, '✓ 测试报告已复制');
assert(copied.startsWith('DeepSeek 会话迁移测试报告'));
assert(copied.includes('迁移方式：滚动压缩'));
assert(copied.includes(`滚动压缩输入：${inputChars.toLocaleString('zh-CN')} 字符`));
assert(copied.includes(`最终迁移正文：${packetChars.toLocaleString('zh-CN')} 字符`));
assert(copied.includes('生成结果：成功'));
assert(!copied.includes('sk-'), '测试报告不含 API Key');
assert(!copied.includes('[CONTINUITY STATE]'), '测试报告不含 migration packet');
assert(!copied.includes('同一用户'), '测试报告不含 Continuity 正文');
assert(!copied.includes('QA当前会话 user'), '测试报告不含对话正文');
assert(!copied.includes('#1'), '测试报告不含 message id 明细');

// ── 短会话预判（§2）：明确不划算 → 零模型调用、零工作会话，直接完整原文迁移 ──
nodes.get('backToCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();
nodes.get('historyTab').onclick();
await settle();
const shortRow = nodes.get('sessions').childNodes.find(item => item.textContent.includes('QA历史会话'));
await shortRow.childNodes.at(-1).childNodes[1].onclick(); // 「迁移此会话」→ 回到迁移页，来源=这道短会话
await settle();
await settle();
assert.equal(state('source.sessionId'), oldId, '来源切到短的历史会话');
nodes.get('strategyForge').checked = true;
nodes.get('strategyFull').checked = false;
nodes.get('strategyForge').onchange();
nodes.get('providerApi').checked = true;
nodes.get('providerApi').onchange();
const callsBeforePrejudge = forgeCalls;
nodes.get('migrateCurrent').onclick();
await settle();
await settle();
assert.equal(forgeCalls, callsBeforePrejudge, '短会话预判命中：一次模型调用都没有');
assert.equal(nodes.get('migrationComplete').hidden, false, '短会话直接生成可用的新会话');
const preJudgeSend = sentMigrations.at(-1);
assert.equal(preJudgeSend.mode, 'exact', '零模型调用直接走完整原文');
assert.equal(preJudgeSend.content, oldFullExact, '发的是这份会话的完整原文，逐字节不变');
assert(preJudgeSend.content.startsWith('【会话接续】'), '完整原文也以接续 framing 开头');
assert(!preJudgeSend.content.includes('[CONTINUITY STATE]'), '没有进入滚动压缩');
assert.equal(preJudgeSend.lineage, null, '短会话预判不登记代际');
assert(nodes.get('openedStatus').textContent.includes('完整原文'), '短会话预判完成后状态写明完整原文');
assert(nodes.get('completeNote').textContent.includes('未做任何摘要或改写'), '短会话直发全文时说明原因');

// ── 代际：接上上一代状态时，结果报告改写「是」并标出上一代迁移正文已排除 ──────
nodes.get('backToCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();
lineageState = { continuity: { identity: [{ state: '同一用户', source_message_ids: ['1'] }], stableFacts: [], activeThreads: [], decisions: [], openLoops: [], recentChanges: [], interactionPreferences: [] }, bootstrapMessageId: 1 };
nodes.get('migrateCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('rollingCarried').textContent, '是', '接上上一代的持续状态');
assert.equal(nodes.get('rollingBootstrapRow').hidden, false, '上一代迁移正文被排除时会标出来');
lineageState = null;
nodes.get('backToCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();

// ── Forge 失败：留在原地说人话，可以重试或改用完整原文 ───────────────────────
nodes.get('backToCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();
forgeModelMode = 'fail';
nodes.get('migrateCurrent').onclick();
await settle();
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('forgeFailure').hidden, false);
assert(nodes.get('forgeFailure').textContent.includes('稍后重试'));
assert.equal(nodes.get('forgeFailureActions').hidden, false);
assert.equal(nodes.get('migrationComplete').hidden, true, 'Forge 失败不跳到完成页');
assert.equal(nodes.get('migrationHome').hidden, false);
assert(!nodes.get('migrationHint').textContent.includes('请求过于频繁'), '原始错误只进开发诊断');
assert(nodes.get('technicalReport').textContent.includes('请求过于频繁'));

forgeModelMode = 'ok';
const armedBeforeFallback = armed.length;
nodes.get('fallbackFull').onclick();
await settle();
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('migrationComplete').hidden, false, '改用完整原文立刻成功');
assert.equal(sentMigrations.at(-1).mode, 'exact', '退到完整原文走同一条原生发送链');
assert.equal(armed.length, armedBeforeFallback, '退到完整原文后不再登记新的代际');

// ── 完成页是终点：页面切换与存档广播都不该把它打断 ──────────────────────────
const frozen = requests.length;
activeBrowser.url = `https://chat.deepseek.com/a/chat/s/${nextId}`;
listeners.activated({ tabId: activeBrowser.id });
listeners.message({ type: 'ARCHIVED', sessionId: nextId, count: 2 });
await settle();
assert.equal(requests.length, frozen);
assert.equal(nodes.get('migrationComplete').hidden, false);
nodes.get('recopy').onclick();
await settle();
assert(copied.includes('QA当前会话 user'), '手动备份复制按钮交出完整迁移正文');

// 完整原文的完成页报告：完成页本身就能复制，只给统计。
nodes.get('copyCompletedReport').onclick();
await settle();
assert.equal(nodes.get('copyCompletedReport').textContent, '✓ 测试报告已复制');
assert(copied.startsWith('DeepSeek 会话迁移测试报告'));
assert(copied.includes('迁移方式：完整原文'));
assert(copied.includes('未摘要：是') && copied.includes('未改写：是') && copied.includes('未裁剪正文：是'));
assert(copied.includes(`实际迁移：${phase0.countChars(liveFullExact).toLocaleString('zh-CN')} 字符`), '报告里的实际迁移就是准备发送的完整正文长度');
assert(!copied.includes('sk-') && !copied.includes('QA当前会话 user'));

// 完整原文的完成页同样有本次结果报告：方式 + 源正文 + 实际迁移 + 三条保证。
assert.equal(nodes.get('completedReportCard').hidden, false, '完整原文完成页也有本次迁移结果');
const fullDoneLines = nodes.get('completedReportLines').textContent;
assert(fullDoneLines.includes('方式完整原文'));
assert(fullDoneLines.includes(`源正文${liveAnalysis.selected.cleanTextChars.toLocaleString('zh-CN')} 字符`));
assert(fullDoneLines.includes(`实际迁移${phase0.countChars(liveFullExact).toLocaleString('zh-CN')} 字符`));
assert.equal(nodes.get('completedReportChecks').hidden, false, '完整原文完成报告列出未摘要 / 未改写 / 未裁剪');
assert(nodes.get('completedReportChecks').textContent.includes('未摘要') && nodes.get('completedReportChecks').textContent.includes('未裁剪正文'));
assert.equal(nodes.get('completedReportText').textContent, copied, '完成页完整报告就是「复制测试报告」交出的同一份');

// ── 读取失败：给中文的下一步，而不是原始错误 ────────────────────────────────
nodes.get('backToCurrent').onclick();
const rawError = 'Could not establish connection. Receiving end does not exist.';
answerSnapshot(null, rawError);
await settle();
assert.equal(nodes.get('retryRead').hidden, false);
assert.equal(nodes.get('migrateCurrent').disabled, true);
assert.equal(nodes.get('reportCard').hidden, true);
assert(nodes.get('migrationHint').textContent.includes('刷新 DeepSeek 页面'));
assert(!nodes.get('migrationHint').textContent.includes('Receiving end'));
assert(nodes.get('technicalReport').textContent.includes(rawError));
assert.equal(state('prepared'), null, '读取失败会清掉上一份准备结果');
const retry = nodes.get('retryRead').onclick();
answerSnapshot(liveId);
await settle();
assert.equal(nodes.get('retryRead').hidden, false);
assert.equal(nodes.get('migrateCurrent').disabled, false);
assert.equal(state('prepared.session.sessionId'), liveId);

// ── 「自检」这一行和其它设置项一样：点标题展开并跑一次自检，再点一次收回 ──────
nodes.get('settingsTab').onclick();
await settle();
assert.equal(nodes.get('diagContent').hidden, true);
nodes.get('diagToggle').onclick();
assert.equal(nodes.get('diagToggle').getAttribute('aria-expanded'), 'true');
assert.equal(nodes.get('diagContent').hidden, false, 'Clicking 自检 expands the row');
await settle();
assert(nodes.get('diagContent').textContent.includes('后台进程没应答'), 'Expanding 自检 runs the check');
nodes.get('diagToggle').onclick();
assert.equal(nodes.get('diagToggle').getAttribute('aria-expanded'), 'false');
assert.equal(nodes.get('diagContent').hidden, true, 'Clicking 自检 again collapses the row');

console.log('PASS local UI: one-click Full Exact and Forge migration, visible strategies, 滚动压缩 naming, source report kept separate from the rolling result report, copy test report without private text, lineage carry flag, Forge progress/cancel/failure, history reuses the migration flow, read recovery, collapsible 自检');
console.log('Local stubs only; no model traffic, live DeepSeek capacity claim, or long-session E2E acceptance.');
