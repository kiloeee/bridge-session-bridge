import { listSessions, getMessages, getSession, deleteSession, deleteRawForSession, listRawStreams, listRawSessions, readRawText, exportAll, importAll } from '../src/db.js';
import { buildMarkdown } from '../src/markdown.js';
import { replayStream } from '../src/rebuild.js';
import { analyzeCapacity, formatCapacityReport, messagesForSnapshot, countChars, buildForgePackage } from '../src/phase0.js';
import { rollupForge, assembleForgePacket } from '../src/forge.js';
import { DEFAULT_FORGE_MODEL, loadForgeConfig, saveForgeConfig, clearForgeConfig, requestApiPermission, hasApiPermission, testConnection, createForgeModel } from '../src/forge-provider.js';
import { getForgeState, excludeBootstrapEntry } from '../src/forge-lineage.js';
import { createDraft, createRun, getRun, updateRun, scanDraftPrivacy, buildMigrationReport, formatMigrationReport } from '../src/draft.js';
import { createWebForgeModel, initialForgeJob, resumeForgeInput } from '../src/web-forge.js';
import { DEFAULT_CHUNK_CHARS } from '../src/forge.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const number = value => value.toLocaleString('zh-CN');
const RECENT_TURNS = 20;
// 品牌只在这一个常量里写死；标题栏两层与页面标题都从它拆出来。
const PRODUCT_DISPLAY_NAME = '桥 · Session Bridge';
const [PRODUCT_NAME, PRODUCT_SUBTITLE] = PRODUCT_DISPLAY_NAME.split(' · ');

let activeTab = 'migration';
// 迁移页只有一个「来源」：当前页面的会话，或用户从历史里挑的会话。两者共用一个流程。
let source = { kind: 'current' };
let prepared = null;          // { session, messages, analysis, forge }
let completedText = '';       // 完成页「重新复制」用的正文
let completedForge = null;    // { run, sessionId, session, analysis }：上一次滚动压缩的结果报告
// 完成页的「本次迁移结果」：本轮真正执行出来的结果（不重新算），迁移完成前存下来。
let completedMigration = null; // { strategy, sessionId, session, analysis, run: forgeRun|null, inputChars, migrationChars }
let completedReportSnapshot = null; // 完成页「查看完整报告 / 复制测试报告」用的同一份文本
// 滚动压缩反而更大时挂在这里等用户决定：{ result, forgeRun }，两条路都复用已算出的结果。
let pendingForgeChoice = null;
let forgeConfig = null;
let forgeController = null;
let reading = false;
let preparing = false;
let readSerial = 0;
let pendingPageRead = false;
let historyCurrent = null;
let hasHistorySelection = false;
let historySerial = 0;
// v0.4 原生迁移：最近一次 Draft / Run 与 CONTENT_FILTER 恢复页上下文。
let completedDraft = null;    // MigrationDraft（最新 revision）
let completedRun = null;      // MigrationRun
let filterCtx = null;         // { result, draft, mode, forgeRun }

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const anchor = el('a');
  anchor.href = url;
  anchor.download = name.replace(/[\\/:*?"<>|]/g, '_');
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function say(text, kind = 'info') {
  const status = $('status');
  status.textContent = text;
  status.className = `status ${kind}`;
  status.hidden = !text;
  clearTimeout(say.timer);
  if (text) say.timer = setTimeout(() => { status.hidden = true; }, 6000);
}

function recordTechnical(label, error) {
  $('technicalReport').textContent = [label, error ? String(error.message || error) : '',
    prepared ? formatCapacityReport(prepared.session, prepared.analysis) : ''].filter(Boolean).join('\n\n');
}

function readableError(error) {
  const text = String(error?.message || error || '');
  if (/Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(text)) {
    return '暂时无法读取当前会话。请刷新 DeepSeek 页面，再点「重新读取」。';
  }
  if (/已有 DeepSeek 会话|没有打开.*会话|当前.*标签页|没有.*DeepSeek/i.test(text)) {
    return '请先在当前标签页打开要迁移的 DeepSeek 会话。';
  }
  if (/旧版本|快照消息条数|父消息|父链|current_message_id|完整前文|非字符串|未送达完|被截断/i.test(text)) {
    return '当前会话读取不完整，请重新读取后再迁移。';
  }
  if (/没有.*正文|没有.*消息/.test(text)) return '这个会话还没有可迁移的对话内容。';
  return '暂时无法完整读取会话，请保持 DeepSeek 会话打开后重新读取。';
}

// Provider 已经把失败翻成人话了，这里只补齐 Forge 特有的下一步提示。
function forgeErrorMessage(error) {
  const text = String(error?.message || error || '');
  if (/API Key/.test(text)) return 'API Key 无效，请在「设置」里重新填写。';
  if (/余额|计费|账户/.test(text)) return 'DeepSeek API 账户余额不足，请充值后重试。';
  if (/频繁|稍后/.test(text)) return '请求过于频繁，请稍后重试。';
  if (/连接|网络/.test(text)) return '无法连接 DeepSeek API，请检查网络后重试。';
  if (/有效结果/.test(text)) return '滚动压缩这次没有生成有效结果，请重试。';
  return '滚动压缩没有完成，可以重试，或者改用完整原文迁移。';
}

function switchTab(name) {
  activeTab = name;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const chosen = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
  }
  for (const tab of ['migration', 'history', 'settings']) $(tab + 'Panel').hidden = tab !== name;
  if (name === 'migration' && $('migrationComplete').hidden && !reading && !preparing) readSource();
  if (name === 'settings') refreshForgeConfig().catch(error => recordTechnical('读取 Forge 配置失败', error));
  if (name === 'history') refreshSessions().catch(error => {
    recordTechnical('历史读取失败', error);
    say('暂时无法读取本地历史，请稍后再试。', 'err');
  });
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.onclick = () => switchTab(button.dataset.tab);
  button.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...document.querySelectorAll('[data-tab]')];
    const index = buttons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    switchTab(buttons[next].dataset.tab);
  };
}

// ── 迁移方式 ────────────────────────────────────────────────────────────────
// 两种方式常驻可见，选之前就能看懂各自保留什么。Forge 没配好时是「不可选 + 说明」，
// 而不是选进去再报错。滚动压缩再分提供方：免费网页版（默认可用）/ API。
const strategyValue = () => ($('strategyForge')?.checked ? 'forge' : 'full');
const providerValue = () => ($('providerApi')?.checked && !$('providerApi').disabled ? 'api' : 'web');

function updateStrategyUi() {
  const configured = !!forgeConfig;
  $('strategyForge').disabled = false;
  const forge = strategyValue() === 'forge';
  $('providerChooser').hidden = !forge;
  $('providerApi').disabled = !configured;
  if (!configured && $('providerApi').checked) $('providerWeb').checked = true;
  $('forgeConfigHint').hidden = forge && configured ? true : !forge ? true : false;
  $('forgeConfigHint').hidden = !(forge && !configured);
  if (forge) {
    const web = providerValue() === 'web';
    $('strategyNote').textContent = configured
      ? (web ? '将使用你当前登录的 DeepSeek 网页逐段整理；原始对话按段发给网页版，可中断后续跑。'
             : '将调用已配置的 DeepSeek API 整理这份对话；原始对话不会离开这台电脑，只有整理用的请求会发给你自己的 Key。')
      : '将使用你当前登录的 DeepSeek 网页逐段整理；较慢，可中断后从进度继续。';
    $('strategyNote').hidden = false;
    $('migrateCurrent').textContent = web ? '用滚动压缩迁移（网页版）' : '用滚动压缩迁移';
    $('migrateExplain').textContent = '滚动压缩会保留持续状态、关键原话和最近完整对话；更早的对话会被压缩。整理完成后自动用原生输入发送到新会话。';
  } else {
    $('strategyNote').hidden = true;
    $('migrateCurrent').textContent = '用完整原文迁移';
    $('migrateExplain').textContent = '迁移会保留完整对话原文，通过原生输入直接发送到新会话（不经剪贴板）。思考过程、搜索记录等不会占用新窗口上下文。';
  }
}

function setActionsDisabled(disabled) {
  $('migrateCurrent').disabled = disabled || !prepared;
  $('retryRead').disabled = disabled;
}

// ── 读取来源 ────────────────────────────────────────────────────────────────
async function analysisFor(sessionId) {
  const [session, stored] = await Promise.all([getSession(sessionId), getMessages(sessionId)]);
  if (!session) throw new Error('没有完整会话存档。');
  const messages = messagesForSnapshot(session, stored);
  const analysis = analyzeCapacity(session, messages);
  if (!analysis.entries.length) throw new Error('这个会话没有 REQUEST / RESPONSE 正文。');
  if (analysis.branch.warnings.length) throw new Error(analysis.branch.warnings.join('\n'));
  const forge = buildForgePackage(session, messages, { recentTurns: RECENT_TURNS });
  return { session, messages, analysis, forge };
}

async function captureCurrentSession() {
  const captured = await chrome.runtime.sendMessage({ type: 'SNAPSHOT_NOW' });
  if (!captured?.ok || !captured.sessionId) throw new Error(captured?.error || '当前页面没有返回快照确认。');
  return analysisFor(captured.sessionId);
}

async function readSource() {
  if (reading || preparing) return;
  pendingPageRead = false;
  reading = true;
  const serial = ++readSerial;
  const fromHistory = source.kind === 'history';
  $('migrateCurrent').disabled = true;
  $('retryRead').disabled = true;
  $('currentTitle').textContent = fromHistory ? '正在读取这份存档…' : '正在读取当前会话…';
  $('currentMeta').textContent = '';
  $('reportCard').hidden = true;
  $('migrationHint').textContent = fromHistory ? '正在读取本地存档。' : '正在读取当前 DeepSeek 页面的对话。';
  $('migrationHint').hidden = false;
  try {
    const result = fromHistory ? await analysisFor(source.sessionId) : await captureCurrentSession();
    if (serial === readSerial) showCurrent(result);
    await refreshSessions();
  } catch (error) {
    if (serial === readSerial) showReadFailure(error);
  } finally {
    reading = false;
    $('retryRead').disabled = false;
    if (pendingPageRead && currentPreparationVisible()) {
      pendingPageRead = false;
      readSource();
    }
  }
}

function currentPreparationVisible() {
  return activeTab === 'migration' && $('migrationComplete').hidden && $('forgeProgress').hidden;
}

async function activeBrowserTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs.length === 1 ? tabs[0] : null;
}

async function currentPageChanged(tabId) {
  if (source.kind !== 'current' || !currentPreparationVisible() || preparing) return;
  try {
    const tab = await activeBrowserTab();
    if (tabId != null && tab?.id !== tabId) return;
    if (source.kind !== 'current' || !currentPreparationVisible() || preparing) return;
    if (reading) {
      pendingPageRead = true;
      ++readSerial;
      return;
    }
    if (!tab?.url?.startsWith('https://chat.deepseek.com/')) {
      showReadFailure(new Error('请先将已有 DeepSeek 会话设为当前标签页。'));
      return;
    }
    readSource();
  } catch (error) { recordTechnical('当前页面变化读取失败', error); }
}

async function refreshCurrentArchive(sessionId) {
  if (source.kind !== 'current' || !currentPreparationVisible() || reading || preparing) return;
  const serial = readSerial;
  const tab = await activeBrowserTab();
  const activeSessionId = tab?.url?.match(/\/a\/chat\/s\/([0-9a-f-]{36})/)?.[1];
  if (activeSessionId !== sessionId || source.kind !== 'current' || !currentPreparationVisible() || reading || preparing) return;
  const result = await analysisFor(sessionId);
  if (serial === readSerial && currentPreparationVisible() && !reading && !preparing) showCurrent(result);
}

// ── 迁移页渲染 ──────────────────────────────────────────────────────────────
function showCurrent(result) {
  prepared = result;
  // 同一份会话的滚动压缩结果留着（用户从完成页返回时还要看它）；换了会话就作废。
  if (completedForge && completedForge.sessionId !== result.session.sessionId) completedForge = null;
  if (completedMigration && completedMigration.sessionId !== result.session.sessionId) completedMigration = null;
  clearForgeChoice();
  const { session, analysis } = result;
  $('sourceLabel').textContent = source.kind === 'history' ? '来自历史会话' : '当前会话';
  $('currentTitle').textContent = session.title || 'DeepSeek 会话';
  $('currentMeta').textContent = analysis.branch.excludedMessages
    ? `当前分支 ${analysis.branch.messages.length} 条消息 · 已读取`
    : `${analysis.branch.messages.length} 条消息 · 已读取`;
  $('migrationHint').textContent = '';
  $('migrationHint').hidden = true;
  $('retryRead').hidden = false;

  const removed = analysis.cleanRatio == null ? '—' : `${((1 - analysis.cleanRatio) * 100).toFixed(2)}%`;
  $('reportCard').hidden = false;
  $('reportRaw').textContent = `${number(analysis.selected.allFragmentChars)} 字符`;
  $('reportClean').textContent = `${number(analysis.selected.cleanTextChars)} 字符`;
  $('reportRemoved').textContent = removed;

  updateStrategyUi();
  renderRollingResult();
  setActionsDisabled(false);
  recordTechnical('当前会话已读取');
}

function showReadFailure(error) {
  prepared = null;
  completedForge = null;
  completedMigration = null;
  completedReportSnapshot = null;
  clearForgeChoice();
  $('sourceLabel').textContent = source.kind === 'history' ? '来自历史会话' : '当前会话';
  $('currentTitle').textContent = source.kind === 'history' ? '这份存档暂时读不出来' : '打开你想迁移的会话';
  $('currentMeta').textContent = '尚未读取到可迁移的对话';
  $('reportCard').hidden = true;
  renderRollingResult();
  $('migrationHint').textContent = readableError(error);
  $('migrationHint').hidden = false;
  $('retryRead').hidden = false;
  updateStrategyUi();
  setActionsDisabled(true);
  recordTechnical('当前会话读取失败', error);
}

// ── 迁移报告 ────────────────────────────────────────────────────────────────
// 源会话报告讲的是「输入」（清洗结果），滚动压缩结果讲的是「输出」（压缩后真正发出去的正文）。
// 两者都只写数字和状态，不带任何正文、id 或 Key，用户可以放心复制给开发者。
function sourceRemovedPercent(analysis) {
  return analysis.cleanRatio == null ? null : (1 - analysis.cleanRatio) * 100;
}

function fullExactReport() {
  if (!prepared) return null;
  const { session, analysis, forge } = prepared;
  const groups = analysis.selected.groups;
  const removed = sourceRemovedPercent(analysis);
  return [
    'DeepSeek 会话迁移测试报告', '',
    '迁移方式：完整原文', '',
    `会话：${session.title || 'DeepSeek 会话'}`, '',
    `主路径消息：${analysis.branch.messages.length}`, '',
    `原始内容：${number(analysis.selected.allFragmentChars)} 字符`,
    `可迁移正文：${number(analysis.selected.cleanTextChars)} 字符`,
    removed == null ? null : `清理比例：${removed.toFixed(2)}%`, '',
    `用户原文：${number(groups.REQUEST.chars)} 字符`,
    `助手原文：${number(groups.RESPONSE.chars)} 字符`,
    `思考 / 搜索 / 工具：${number(groups.THINK.chars + groups.SEARCH.chars + groups.TOOL.chars)} 字符`, '',
    `实际迁移：${number(countChars(forge.fullExact))} 字符`, '',
    '未摘要：是', '未改写：是', '未裁剪正文：是',
  ].filter(line => line !== null).join('\n');
}

function rollingReport() {
  if (!completedForge) return null;
  const { run, session, analysis } = completedForge;
  const stats = run.packet.stats;
  const removed = sourceRemovedPercent(analysis);
  const ratio = run.inputChars > 0 ? 1 - stats.packetChars / run.inputChars : null;
  const recent = analysis.recentTurns.find(turn => turn.limit === RECENT_TURNS);
  return [
    'DeepSeek 会话迁移测试报告', '',
    '迁移方式：滚动压缩', '',
    `会话：${session.title || 'DeepSeek 会话'}`, '',
    `主路径消息：${analysis.branch.messages.length}`, '',
    `原始内容：${number(analysis.selected.allFragmentChars)} 字符`,
    `可迁移正文：${number(analysis.selected.cleanTextChars)} 字符`,
    removed == null ? null : `源会话清理：${removed.toFixed(2)}%`, '',
    `滚动压缩输入：${number(run.inputChars)} 字符`,
    `最终迁移正文：${number(stats.packetChars)} 字符`,
    ratio == null ? null : `滚动压缩比例：${(ratio * 100).toFixed(2)}%`, '',
    `处理历史分段：${run.rolled.chunks}`,
    `关键原话：${run.packet.importantExact.length} 条`,
    recent ? `最近完整对话：${recent.turns} 轮` : null, '',
    `继承上一代状态：${run.carriedContinuity ? '是' : '否'}`,
    run.excludedBootstrap ? '上一代迁移正文：已排除' : null, '',
    '生成结果：成功',
  ].filter(line => line !== null).join('\n');
}

// 复制反馈走按钮文字本身，1.8 秒后复原：不弹窗、不下载、不生成文件。
function wireCopyReport(buttonId, build) {
  const button = $(buttonId);
  const label = button.textContent;
  let timer = null;
  button.onclick = async () => {
    const report = build();
    if (!report) return;
    let ok = true;
    try { await navigator.clipboard.writeText(report); }
    catch (error) { ok = false; recordTechnical('复制测试报告失败', error); }
    button.textContent = ok ? '✓ 测试报告已复制' : '复制失败，请重试';
    button.disabled = true;
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = label; button.disabled = false; }, 1800);
  };
}
wireCopyReport('copyRollingReport', rollingReport);
// 完成页的「复制测试报告」交出的是同一份快照，保证看到什么就复制到什么。
wireCopyReport('copyCompletedReport', () => completedReportSnapshot);

function renderRollingResult() {
  const box = $('rollingResult');
  if (!completedForge) { box.hidden = true; return; }
  const { run, analysis } = completedForge;
  const stats = run.packet.stats;
  const ratio = run.inputChars > 0 ? 1 - stats.packetChars / run.inputChars : null;
  const recent = analysis.recentTurns.find(turn => turn.limit === RECENT_TURNS);
  $('rollingInput').textContent = `${number(run.inputChars)} 字符`;
  $('rollingOutput').textContent = `${number(stats.packetChars)} 字符`;
  $('rollingRatioRow').hidden = ratio == null;
  $('rollingRatio').textContent = ratio == null ? '' : `${(ratio * 100).toFixed(1)}%`;
  $('rollingChunks').textContent = `${run.rolled.chunks} 段`;
  $('rollingImportant').textContent = `${run.packet.importantExact.length} 条`;
  $('rollingRecent').textContent = recent ? `${recent.turns} 轮` : '—';
  $('rollingCarried').textContent = run.carriedContinuity ? '是' : '否';
  $('rollingBootstrapRow').hidden = !run.excludedBootstrap;
  box.hidden = false;
}

// 完成页的「本次迁移结果」：数字全部来自本轮 migration() 已经跑出来的真实结果，不重新计算。
// 迁移前的源会话报告讲「准备迁什么」，这份讲「刚才实际上迁了什么」，两种方式都有。
function renderCompletedReport() {
  const card = $('completedReportCard');
  const lines = $('completedReportLines');
  const checks = $('completedReportChecks');
  lines.textContent = '';
  checks.textContent = '';
  checks.hidden = true;
  $('completedReportToggle').setAttribute('aria-expanded', 'false');
  $('completedReportToggle').textContent = '查看完整报告';
  $('completedReportBody').hidden = true;
  completedReportSnapshot = null;
  if (!completedMigration) { card.hidden = true; return; }

  const row = (label, value) => {
    const line = el('div', 'report-line');
    line.append(el('span', null, label), el('strong', null, value));
    lines.append(line);
  };

  if (completedMigration.strategy === 'forge') {
    const { run, analysis, inputChars, migrationChars } = completedMigration;
    const ratio = inputChars > 0 ? 1 - migrationChars / inputChars : null;
    const recent = analysis.recentTurns.find(turn => turn.limit === RECENT_TURNS);
    row('方式', '滚动压缩');
    row('压缩前', `${number(inputChars)} 字符`);
    row('迁移后', `${number(migrationChars)} 字符`);
    if (ratio != null) row('压缩比例', `${(ratio * 100).toFixed(1)}%`);
    row('历史分段', `${run.rolled.chunks} 段`);
    row('关键原话', `${run.packet.importantExact.length} 条`);
    if (recent) row('最近完整对话', `${recent.turns} 轮`);
    row('继承上一代状态', run.carriedContinuity ? '是' : '否');
    if (run.excludedBootstrap) row('上一代迁移正文', '已排除');
    completedReportSnapshot = rollingReport();
  } else {
    row('方式', '完整原文');
    row('源正文', `${number(completedMigration.analysis.selected.cleanTextChars)} 字符`);
    row('实际迁移', `${number(completedMigration.migrationChars)} 字符`);
    for (const text of ['✓ 未摘要', '✓ 未改写', '✓ 未裁剪正文']) checks.append(el('p', 'report-check', text));
    checks.hidden = false;
    completedReportSnapshot = fullExactReport();
  }
  $('completedReportText').textContent = completedReportSnapshot || '';
  card.hidden = false;
}

function showProgress() {
  hideAllOutcomePages();
  $('migrationHome').hidden = true;
  $('forgeProgress').hidden = false;
  $('progressBar').style.width = '4%';
  $('progressLabel').textContent = '正在准备…';
}
function hideProgress() {
  $('forgeProgress').hidden = true;
  $('migrationHome').hidden = false;
}
function showForgeFailure(text) {
  hideProgress();
  $('forgeFailure').textContent = text;
  $('forgeFailure').hidden = false;
  $('forgeFailureActions').hidden = false;
}
function clearForgeFailure() {
  $('forgeFailure').hidden = true;
  $('forgeFailureActions').hidden = true;
}

// ── Forge ───────────────────────────────────────────────────────────────────
async function runForge(result, signal) {
  const lineage = await getForgeState(result.session.sessionId);
  const { entries, excluded } = excludeBootstrapEntry(result.analysis.entries, lineage?.bootstrapMessageId);
  const model = createForgeModel(forgeConfig, {
    signal,
    onProgress: event => {
      if (event.phase === 'roll') {
        const total = Math.max(event.total || 1, 1);
        $('progressLabel').textContent = `正在更新持续状态 · ${event.index} / ${total}`;
        $('progressBar').style.width = `${Math.round((event.index / total) * 80)}%`;
      } else {
        $('progressLabel').textContent = '正在挑选关键原话…';
        $('progressBar').style.width = '92%';
      }
    },
  });
  const rolled = await rollupForge({
    entries,
    previousContinuity: lineage?.continuity || null,
    model,
  });
  const packet = assembleForgePacket({
    session: result.session,
    analysis: result.analysis,
    continuity: rolled.continuity,
    importantMessageIds: rolled.importantMessageIds,
    recentTurns: RECENT_TURNS,
    fullExactChars: countChars(result.forge.fullExact),
  });
  // 压缩前 = 本轮真正进入滚动压缩链的 clean 正文（排除上一代迁移正文后）。
  const inputChars = entries.reduce((sum, entry) => sum + countChars(entry.text), 0);
  return { rolled, packet, inputChars, excludedBootstrap: excluded, carriedContinuity: !!lineage?.continuity };
}

async function copyCompleted(text) {
  try {
    await navigator.clipboard.writeText(text);
    $('copiedStatus').textContent = '✓ 已复制到剪贴板';
    $('copiedStatus').dataset.state = 'ok';
    return true;
  } catch (error) {
    $('copiedStatus').textContent = '尚未复制成功，请点「重新复制」';
    $('copiedStatus').dataset.state = 'error';
    recordTechnical('复制迁移内容失败', error);
    return false;
  }
}

function hideAllOutcomePages() {
  $('migrationComplete').hidden = true;
  $('outcomeFilter').hidden = true;
  $('outcomeFailed').hidden = true;
  $('migrationHome').hidden = true;
  $('forgeProgress').hidden = true;
}

// ── v0.4 原生迁移：Draft → Run → native send → 终态分流 ────────────────────
function showSendProgress(label) {
  hideAllOutcomePages();
  $('forgeProgress').hidden = false;
  $('cancelForge').hidden = true; // 单次 native 发送不可中途取消（窗口已建立）
  $('progressBar').style.width = '10%';
  $('progressLabel').textContent = label;
}

async function sendMigrationDraft(result, { mode, content, forgeRun = null, metadata = {} }) {
  const draft = await createDraft({ sourceSessionId: result.session.sessionId, mode, content, metadata });
  const run = await createRun({ draftId: draft.draftId, sourceSessionId: result.session.sessionId, mode, transport: 'native-composer' });
  completedDraft = draft;
  completedRun = run;
  showSendProgress(mode === 'exact' ? '正在写入新会话…' : '正在发送接续稿…');
  const sendResult = await chrome.runtime.sendMessage({
    type: 'MIGRATE_SEND', runId: run.runId, draftId: draft.draftId,
    sourceSessionId: result.session.sessionId, mode, content,
    lineage: forgeRun ? { continuity: forgeRun.rolled?.continuity || null } : null,
  });
  const freshRun = await getRun(run.runId).catch(() => run);
  completedRun = freshRun || run;
  completedText = content;
  completedMigration = {
    strategy: mode === 'rolling' ? 'forge' : 'full',
    sessionId: result.session.sessionId,
    session: result.session,
    analysis: result.analysis,
    run: forgeRun,
    inputChars: forgeRun ? forgeRun.inputChars : result.analysis.selected.cleanTextChars,
    migrationChars: countChars(content),
  };
  routeOutcome(sendResult, { result, draft, mode, forgeRun });
}

function routeOutcome(sendResult, ctx) {
  const type = sendResult?.outcomeType || 'UNKNOWN';
  if (type === 'SUCCESS') {
    renderNativeComplete(ctx, sendResult);
    $('migrationHome').hidden = true;
    $('migrationComplete').hidden = false;
    $('forgeProgress').hidden = true;
    refreshSessions().catch(error => recordTechnical('历史列表刷新失败', error));
    return;
  }
  hideAllOutcomePages();
  if (type === 'CONTENT_FILTER') { showFilterRecovery(ctx, sendResult); return; }
  showOutcomeFailure(type, sendResult, ctx);
}

function renderNativeComplete(ctx, sendResult) {
  const { result, draft, mode } = ctx;
  completedReportSnapshot = null;
  $('completedTitle').textContent = `${result.session.title || '这份会话'} · ${mode === 'rolling' ? '滚动压缩' : '完整原文'}`;
  $('completeHow').textContent = `迁移稿已通过原生输入直接发送（不经剪贴板）。版本 v${draft.revision} · 发出 ${number(sendResult.requestPromptChars ?? draft.chars)} 字符 · 附件引用 0。`;
  if (sendResult.targetSessionId) {
    $('targetLinkRow').hidden = false;
    $('targetLink').href = `https://chat.deepseek.com/a/chat/s/${sendResult.targetSessionId}`;
    $('targetLink').textContent = '打开接续的新会话';
    $('openedStatus').textContent = '✓ 已自动发送，新会话已建立';
  } else {
    $('targetLinkRow').hidden = true;
    $('openedStatus').textContent = '已发送';
  }
  $('openedStatus').dataset.state = 'ok';
  $('openNewSession').hidden = true;
  $('cancelForge').hidden = false;
  renderCompletedReport();
}

// ── 失败分流页（TOO_LONG / RATE_LIMITED / NETWORK_ERROR / TRANSPORT_ERROR / UNKNOWN） ──
function failureButton(label, cls, onClick) {
  const button = el('button', cls, label);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function showOutcomeFailure(type, sendResult, ctx) {
  const actions = $('failedActions');
  actions.textContent = '';
  const diag = {
    outcome: type, detail: sendResult?.detail || null,
    request_prompt_chars: sendResult?.requestPromptChars ?? null,
    ref_file_ids_count: sendResult?.refFileIdsCount ?? null,
    draft_chars: ctx?.draft?.chars ?? null, draft_revision: ctx?.draft?.revision ?? null,
    target_session_created: !!sendResult?.targetSessionId,
    sse_status: sendResult?.diagnostic?.status ?? null,
    quasi_status: sendResult?.diagnostic?.quasiStatus ?? null,
    http_status: sendResult?.diagnostic?.httpStatus ?? null,
  };
  $('failedDiagText').textContent = JSON.stringify(diag, null, 2);
  const backHome = () => { hideAllOutcomePages(); $('migrationHome').hidden = false; };

  if (type === 'TOO_LONG') {
    $('failedTitle').textContent = '新窗口提示内容超过可接受长度';
    $('failedExplain').textContent = ctx?.mode === 'exact'
      ? '这份会话的完整原文超出新窗口可接受的长度。可以改用滚动压缩：较早的对话会被整理成持续状态，只保留关键原话和最近完整对话。'
      : '滚动压缩后的接续稿仍超出长度。可以用更紧的分段预算重新整理，也可以编辑迁移稿手动缩减。';
    if (ctx?.mode === 'exact') {
      actions.appendChild(failureButton('改用滚动压缩', 'primary-button', () => {
        $('strategyFull').checked = false;
        $('strategyForge').checked = true;
        updateStrategyUi();
        migrate(true, providerValue());
      }));
    } else {
      actions.appendChild(failureButton('用更紧预算重新整理', 'primary-button', () => retryRollingTighter(ctx)));
    }
    actions.appendChild(failureButton('编辑迁移稿', 'text-button', () => { backHome(); showFilterRecovery(ctx, sendResult); }));
  } else if (type === 'RATE_LIMITED') {
    $('failedTitle').textContent = '请求过于频繁，已暂停';
    $('failedExplain').textContent = 'DeepSeek 提示请求过于频繁。迁移稿没有改动，稍等片刻后可原样重试。';
    actions.appendChild(failureButton('原稿重试', 'primary-button', () => resendDraft(ctx.draft, ctx)));
    actions.appendChild(failureButton('稍后再说', 'text-button', backHome));
  } else if (type === 'NETWORK_ERROR') {
    $('failedTitle').textContent = '网络中断，迁移没有完成';
    $('failedExplain').textContent = '发送或等待结果时网络中断。迁移稿保持原样，可直接重试。';
    actions.appendChild(failureButton('原稿重试', 'primary-button', () => resendDraft(ctx.draft, ctx)));
    actions.appendChild(failureButton('稍后再说', 'text-button', backHome));
  } else if (type === 'TRANSPORT_ERROR') {
    $('failedTitle').textContent = '桥的传输出了问题（这不是你的内容问题）';
    $('failedExplain').textContent = /FILE_CONVERSION/.test(sendResult?.detail || '')
      ? '迁移内容被 DeepSeek 页面转换成了附件而不是普通文本。桥绝不把附件当作迁移成功，也不会降级成附件发送。请把下面的诊断报告发给开发者。'
      : '迁移稿没有能作为普通文本完整发出。桥不会宣称这次迁移成功。请把下面的诊断报告发给开发者。';
    actions.appendChild(failureButton('复制诊断报告', 'primary-button', async event => {
      const report = formatMigrationReport(buildMigrationReport({ draft: ctx?.draft, run: completedRun, sourceMeta: sourceMetaOf(ctx) }));
      try { await navigator.clipboard.writeText(report); event.target.textContent = '✓ 已复制诊断报告'; } catch { say('复制失败', 'err'); }
    }));
    actions.appendChild(failureButton('编辑迁移稿重试', 'text-button', () => { backHome(); showFilterRecovery(ctx, sendResult); }));
  } else {
    $('failedTitle').textContent = '结果无法确认';
    $('failedExplain').textContent = '迁移已发出，但桥没有拿到足够证据判断结果。为免误导，这里不猜测成功或失败。可查看新会话实际状态，或重试。';
    actions.appendChild(failureButton('原稿重试', 'primary-button', () => resendDraft(ctx.draft, ctx)));
    actions.appendChild(failureButton('返回', 'text-button', backHome));
  }
  $('migrationHome').hidden = true;
  $('outcomeFilter').hidden = true;
  $('migrationComplete').hidden = true;
  $('forgeProgress').hidden = true;
  $('outcomeFailed').hidden = false;
  recordTechnical(`迁移结果 ${type}`, sendResult?.detail || null);
}

function sourceMetaOf(ctx) {
  if (!ctx?.result) return {};
  return { messageCount: ctx.result.analysis.branch.messages.length, cleanTextChars: ctx.result.analysis.selected.cleanTextChars };
}

// ── CONTENT_FILTER 人工恢复页 ───────────────────────────────────────────────
// 这是用户辅助工具，不是敏感内容预测器：不自动删句、不改写、不猜审查原因。
// 迁移稿按「## 用户/助手 #id」标题切块，支持搜索 / 角色筛选 / 编辑 / 恢复 / revision 重发。
function parseDraftBlocks(content) {
  const blocks = [];
  const re = /^## (用户|助手) #(.+)$/gm;
  const marks = [];
  for (const m of content.matchAll(re)) marks.push({ index: m.index, role: m[1] === '用户' ? 'user' : 'assistant', id: m[2] });
  if (!marks.length) return [{ role: null, id: null, text: content }];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : content.length;
    blocks.push({ role: marks[i].role, id: marks[i].id, text: content.slice(start, end).trim() });
  }
  const prelude = content.slice(0, marks[0].index).trim();
  if (prelude) blocks.unshift({ role: null, id: null, text: prelude });
  return blocks;
}

function showFilterRecovery(ctx, sendResult) {
  filterCtx = { ...ctx, failedDetail: sendResult?.detail || null };
  const draft = ctx.draft;
  $('draftEditor').value = draft.content;
  $('draftSearch').value = '';
  $('draftRoleFilter').value = 'all';
  updateDraftMeta();
  renderFilterClues(ctx.result.session.sessionId);
  renderPrivacyAlerts();
  $('migrationHome').hidden = true;
  $('migrationComplete').hidden = true;
  $('forgeProgress').hidden = true;
  $('outcomeFailed').hidden = true;
  $('outcomeFilter').hidden = false;
  recordTechnical('迁移被内容检查拦截，进入人工恢复页', sendResult?.detail || null);
}

function updateDraftMeta() {
  const content = $('draftEditor').value;
  $('draftCharsLabel').textContent = `${number(countChars(content))} 字符 · 版本将保存为 v${(completedDraft?.revision || filterCtx?.draft?.revision || 0) + 1}`;
}

function renderPrivacyAlerts() {
  const scan = scanDraftPrivacy($('draftEditor').value);
  const list = $('privacyAlertList');
  list.textContent = '';
  $('privacyAlerts').hidden = !scan.found;
  if (!scan.found) return;
  for (const hit of scan.hits) {
    const row = el('div', 'privacy-hit');
    row.appendChild(el('span', null, `${hit.kind} · ${hit.count} 处`));
    row.appendChild(el('span', 'sample', hit.sample));
    list.appendChild(row);
  }
}

// 历史线索：只查本地 archive 里这个 source 会话真实的 CONTENT_FILTER 记录。
// 有就展示（明确标注“只是历史线索”）；没有就正常说明，绝不因此阻塞。
async function renderFilterClues(sessionId) {
  const card = $('filterClues');
  const body = $('filterCluesBody');
  const list = $('filterCluesList');
  list.textContent = '';
  card.hidden = false;
  body.textContent = '正在查看本地记录…';
  try {
    const streams = await listRawStreams(sessionId);
    const clues = [];
    for (const s of streams) {
      try {
        const raw = await readRawText(s.streamId);
        const r = replayStream(raw);
        if (r.filtered) clues.push({ s, r, prompt: promptOf(s) });
      } catch { /* 单条流回放失败不影响其他 */ }
    }
    if (!clues.length) {
      body.textContent = '没有可用的历史过滤线索。';
      return;
    }
    body.textContent = `过去这个会话曾出现过 ${clues.length} 条内容过滤记录。这只是历史线索，不代表本次失败原因相同。`;
    for (const clue of clues.slice(-3)) {
      const cardEl = el('details', 'clue-card');
      const summary = el('summary', null, `${new Date(clue.s.startedAt || 0).toLocaleString()} · 提问：${(clue.prompt || '（未记录）').slice(0, 40)}`);
      cardEl.appendChild(summary);
      if (clue.r.response) {
        const label = el('div', null, `当时的回答在页面上被替换为：「${clue.r.template || '（模板话术）'}」。以下是擦除前已到达浏览器的原文（${number(clue.r.chars)} 字符）：`);
        cardEl.appendChild(label);
        cardEl.appendChild(el('pre', 'body', clue.r.response.slice(0, 2000) + (clue.r.response.length > 2000 ? '…' : '')));
      } else {
        cardEl.appendChild(el('div', 'warn', '当时的原始帧里没有可恢复的正文。'));
      }
      list.appendChild(cardEl);
    }
  } catch (error) {
    body.textContent = '没有可用的历史过滤线索。';
    recordTechnical('历史过滤线索读取失败', error);
  }
}

// 编辑器：搜索（循环定位）、角色筛选（预览模式，编辑在全文上进行）。
function setupDraftEditor() {
  let lastSearch = { query: '', index: 0 };
  $('draftSearch').onkeydown = event => {
    if (event.key !== 'Enter') return;
    const editor = $('draftEditor');
    const query = editor.value; // 占位：搜索目标是被编辑的全文
    const needle = $('draftSearch').value.trim();
    if (!needle) return;
    const hay = editor.value;
    let from = lastSearch.query === needle ? lastSearch.index : 0;
    let pos = hay.indexOf(needle, from);
    if (pos === -1 && from > 0) pos = hay.indexOf(needle, 0);
    if (pos === -1) { say('没有找到。', 'info'); return; }
    lastSearch = { query: needle, index: pos + needle.length };
    editor.focus();
    editor.setSelectionRange(pos, pos + needle.length);
    const line = hay.slice(0, pos).split('\n').length;
    editor.scrollTop = (line - 4) * parseFloat(getComputedStyle(editor).lineHeight || 19);
  };
  $('draftRoleFilter').onchange = () => {
    const filter = $('draftRoleFilter').value;
    const editor = $('draftEditor');
    if (filter === 'all') {
      editor.value = $('draftEditor').dataset.fullText || editor.value;
      editor.readOnly = false;
    } else {
      editor.dataset.fullText = editor.value;
      const blocks = parseDraftBlocks(editor.value).filter(b => b.role === filter);
      editor.value = blocks.length ? blocks.map(b => b.text).join('\n\n') : '（这个角色在迁移稿里没有正文块）';
      editor.readOnly = true;
    }
    updateDraftMeta();
  };
  $('draftEditor').oninput = () => { if (!$('draftEditor').readOnly) { updateDraftMeta(); renderPrivacyAlerts(); } };
  $('draftRestore').onclick = () => {
    if (!filterCtx) return;
    $('draftRoleFilter').value = 'all';
    $('draftEditor').readOnly = false;
    $('draftEditor').value = filterCtx.draft.content;
    updateDraftMeta();
    renderPrivacyAlerts();
    say('已恢复到原迁移稿。', 'ok');
  };
  // 保存修改 → 新 revision（parentDraftId 链）→ 全新 target session 重发。
  // 每次重发都由用户主动点击，桥绝不自动循环修改/重试。
  $('draftRetry').onclick = async () => {
    if (!filterCtx || reading || preparing) return;
    const edited = $('draftRoleFilter').value === 'all'
      ? $('draftEditor').value
      : ($('draftEditor').dataset.fullText || $('draftEditor').value);
    if (!edited.trim()) { say('迁移稿是空的，请先编辑。', 'err'); return; }
    preparing = true;
    setActionsDisabled(true);
    try {
      const { result, mode, forgeRun } = filterCtx;
      const draft = await createDraft({
        sourceSessionId: result.session.sessionId,
        mode,
        content: edited,
        parentDraftId: filterCtx.draft.draftId,
        metadata: { ...filterCtx.draft.metadata, editedAfterFilter: true },
      });
      const run = await createRun({ draftId: draft.draftId, sourceSessionId: result.session.sessionId, mode, transport: 'native-composer' });
      await updateRun(run.runId, { revisionCount: draft.revision }).catch(() => {});
      completedDraft = draft;
      completedRun = run;
      showSendProgress('正在把修改后的迁移稿写入新会话…');
      const sendResult = await chrome.runtime.sendMessage({
        type: 'MIGRATE_SEND', runId: run.runId, draftId: draft.draftId,
        sourceSessionId: result.session.sessionId, mode, content: edited,
        lineage: forgeRun ? { continuity: forgeRun.rolled?.continuity || null } : null,
      });
      const freshRun = await getRun(run.runId).catch(() => run);
      completedRun = freshRun || run;
      completedText = edited;
      completedMigration = {
        strategy: mode === 'rolling' ? 'forge' : 'full',
        sessionId: result.session.sessionId,
        session: result.session,
        analysis: result.analysis,
        run: forgeRun,
        inputChars: forgeRun ? forgeRun.inputChars : result.analysis.selected.cleanTextChars,
        migrationChars: countChars(edited),
      };
      routeOutcome(sendResult, { result, draft, mode, forgeRun });
    } catch (error) {
      recordTechnical('修订重发失败', error);
      say('重发没有完成，请稍后再试。', 'err');
    } finally {
      preparing = false;
      setActionsDisabled(false);
    }
  };
  $('filterRolling').onclick = () => {
    if (!filterCtx) return;
    $('outcomeFilter').hidden = true;
    $('strategyFull').checked = false;
    $('strategyForge').checked = true;
    updateStrategyUi();
    say('滚动压缩是另一种迁移方式，不保证绕过内容检查。', 'info');
    migrate(true, providerValue());
  };
  $('filterCopy').onclick = async () => {
    const edited = $('draftRoleFilter').value === 'all' ? $('draftEditor').value : ($('draftEditor').dataset.fullText || '');
    try { await navigator.clipboard.writeText(edited); say('已复制当前迁移稿。', 'ok'); }
    catch { say('复制失败。', 'err'); }
  };
}
setupDraftEditor();

// 原稿重试：同一 Draft 原样再发一次（内容零修改），新 run、新会话。
async function resendDraft(draft, ctx) {
  if (reading || preparing) return;
  preparing = true;
  setActionsDisabled(true);
  try {
    await sendMigrationDraft(ctx.result, { mode: draft.mode, content: draft.content, forgeRun: ctx.forgeRun || null, metadata: draft.metadata });
  } catch (error) {
    recordTechnical('原稿重试失败', error);
    say('重试没有完成，请稍后再试。', 'err');
  } finally {
    preparing = false;
    setActionsDisabled(false);
  }
}

// rolling TOO_LONG：只允许一次更紧预算重排，不递归。
async function retryRollingTighter(ctx) {
  if (reading || preparing) return;
  preparing = true;
  setActionsDisabled(true);
  try {
    const jobKey = `webForgeJob:${ctx.result.session.sessionId}`;
    const stored = await chrome.storage.local.get(jobKey);
    const job = stored[jobKey];
    if (job) {
      job.chunkChars = Math.max(4000, Math.floor((job.chunkChars || DEFAULT_CHUNK_CHARS) / 2));
      job.status = 'running';
      job.processedMessageIds = []; // 预算变了，整体重排一次（仅一次机会）
      job.continuity = null;
      await chrome.storage.local.set({ [jobKey]: job });
    }
    hideAllOutcomePages();
    await migrate(true, 'web');
  } finally {
    preparing = false;
    setActionsDisabled(false);
  }
}

// 「不值得压缩」这一关：两条路都用刚刚已经算出来的结果，不重新抓取、不重新调用模型。
async function resolveForgeChoice(keepForge) {
  if (!pendingForgeChoice || reading || preparing) return;
  preparing = true;
  setActionsDisabled(true);
  const { result, forgeRun } = pendingForgeChoice;
  clearForgeChoice();
  // 改选完整原文后，这次滚动压缩的结果就不该再挂在首页了。
  if (!keepForge) completedForge = null;
  try {
    await sendMigrationDraft(result, keepForge
      ? { mode: 'rolling', content: forgeRun.packet.packet, forgeRun, metadata: { provider: 'api', chunks: forgeRun.rolled.chunks } }
      : { mode: 'exact', content: result.forge.fullExact });
  } catch (error) {
    recordTechnical('迁移收尾失败', error);
    showReadFailure(error);
  } finally {
    preparing = false;
    setActionsDisabled(false);
  }
}

// ── 迁移主入口：exact / rolling(api) / rolling(web) 三路共用 native 发送 ────
async function migrate(useForge, provider = 'api') {
  if (reading || preparing) return;
  preparing = true;
  clearForgeFailure();
  clearForgeChoice();
  setActionsDisabled(true);
  forgeController = new AbortController();
  const signal = forgeController.signal;
  try {
    const result = source.kind === 'history' ? await analysisFor(source.sessionId) : await captureCurrentSession();
    showCurrent(result);
    if (!useForge) {
      await sendMigrationDraft(result, { mode: 'exact', content: result.forge.fullExact, metadata: { provider: null } });
      return;
    }

    showProgress();
    $('cancelForge').hidden = false;
    if (provider === 'web') {
      const run = await runWebForgeMigration(result, signal);
      completedForge = { run: run.forgeRun, sessionId: result.session.sessionId, session: result.session, analysis: result.analysis };
      renderRollingResult();
      const rollingChars = countChars(run.text);
      const fullChars = countChars(result.forge.fullExact);
      if (rollingChars >= fullChars) {
        hideProgress();
        pendingForgeChoice = { result, forgeRun: run.forgeRun };
        showForgeChoice(rollingChars, fullChars);
        return;
      }
      $('progressBar').style.width = '96%';
      $('progressLabel').textContent = '正在发送接续稿…';
      await sendMigrationDraft(result, { mode: 'rolling', content: run.text, forgeRun: run.forgeRun, metadata: run.metadata });
      return;
    }

    if (!forgeConfig) { say('请先在「设置」里配置滚动压缩模型，或改用免费网页版。', 'err'); hideProgress(); return; }
    const forgeRun = await runForge(result, signal);
    $('progressBar').style.width = '100%';
    $('progressLabel').textContent = '正在发送接续稿…';
    completedForge = { run: forgeRun, sessionId: result.session.sessionId, session: result.session, analysis: result.analysis };
    renderRollingResult();
    // 产品层保护：这个窗口太短时 Recent Exact 会覆盖整个会话，滚动整理反而更大——不直接迁，先让用户看到。
    const rollingChars = countChars(forgeRun.packet.packet);
    const fullChars = countChars(result.forge.fullExact);
    if (rollingChars >= fullChars) {
      hideProgress();
      pendingForgeChoice = { result, forgeRun };
      showForgeChoice(rollingChars, fullChars);
      return;
    }
    await sendMigrationDraft(result, { mode: 'rolling', content: forgeRun.packet.packet, forgeRun, metadata: { provider: 'api', chunks: forgeRun.rolled.chunks } });
  } catch (error) {
    if (error?.name === 'AbortError') {
      hideProgress();
      say('已取消。进度已保存，下次可以继续。', 'info');
    } else if (useForge) {
      await handleForgeRunError(error, provider);
    } else {
      showReadFailure(error);
    }
  } finally {
    preparing = false;
    forgeController = null;
    setActionsDisabled(false);
  }
}

// Web Forge 的失败分流：CONTENT_FILTER / RATE_LIMITED 暂停可恢复；NETWORK 同 chunk 自动重试。
async function handleForgeRunError(error, provider) {
  const cls = error?.errorClass;
  if (provider === 'web' && webForgeJob) {
    if (cls === 'CONTENT_FILTER') {
      webForgeJob.status = 'paused_filter';
      await saveWebForgeJob().catch(() => {});
      showForgeFailure('整理过程被 DeepSeek 的内容检查拦下了。桥不会自动改写你的内容。进度已保存；你可以稍后继续，或改用完整原文迁移。');
      return;
    }
    if (cls === 'RATE_LIMITED') {
      webForgeJob.status = 'paused_rate_limit';
      await saveWebForgeJob().catch(() => {});
      showForgeFailure('整理请求过于频繁，已暂停。进度已保存，稍后点「重试滚动压缩」会从断点继续。');
      return;
    }
  }
  recordTechnical('Forge 失败', error);
  showForgeFailure(forgeErrorMessage(error));
}

// ── Web Forge（免费网页版 rolling）：checkpoint 断点续跑 ────────────────────
let webForgeJob = null;

const webForgeJobKey = sessionId => `webForgeJob:${sessionId}`;

async function loadWebForgeJob(sessionId) {
  const stored = await chrome.storage.local.get(webForgeJobKey(sessionId));
  return stored[webForgeJobKey(sessionId)] || null;
}

async function saveWebForgeJob() {
  if (!webForgeJob) return;
  webForgeJob.updatedAt = Date.now();
  await chrome.storage.local.set({ [webForgeJobKey(webForgeJob.sourceSessionId)]: webForgeJob });
}

async function runWebForgeMigration(result, signal) {
  const lineage = await getForgeState(result.session.sessionId);
  const { entries, excluded } = excludeBootstrapEntry(result.analysis.entries, lineage?.bootstrapMessageId);
  webForgeJob = await loadWebForgeJob(result.session.sessionId);
  const resumed = !!webForgeJob && ['paused_filter', 'paused_rate_limit', 'running'].includes(webForgeJob.status) && webForgeJob.processedMessageIds?.length;
  if (!webForgeJob || webForgeJob.status === 'done') {
    webForgeJob = initialForgeJob({ sourceSessionId: result.session.sessionId, chunkChars: DEFAULT_CHUNK_CHARS });
  } else {
    webForgeJob.status = 'running';
  }
  await saveWebForgeJob();
  if (resumed) $('progressLabel').textContent = `继续上次整理（已完成 ${webForgeJob.chunkIndex || 0} 段）…`;

  const { remaining, previousContinuity, resumedFromChunk } = resumeForgeInput(webForgeJob, entries);
  const call = async ({ task, payload }) => {
    if (signal.aborted) { const err = new Error('已取消'); err.name = 'AbortError'; throw err; }
    const res = await chrome.runtime.sendMessage({ type: 'WEB_FORGE_CALL', jobId: webForgeJob.jobId, payload });
    if (res?.ok && res.workerSessionId) {
      if (!webForgeJob.workerSessions.some(w => w.sessionId === res.workerSessionId)) {
        webForgeJob.workerSessions.push({ sessionId: res.workerSessionId, chunkRange: `#${webForgeJob.chunkIndex || 0}`, rotatedAt: Date.now() });
      }
    }
    return res;
  };
  const model = createWebForgeModel({ call });
  const onChunk = async info => {
    webForgeJob.chunkIndex = resumedFromChunk + info.chunkIndex;
    webForgeJob.chunkCount = resumedFromChunk + info.chunkCount;
    webForgeJob.continuity = info.continuity;
    webForgeJob.processedMessageIds = [...new Set([...(webForgeJob.processedMessageIds || []), ...info.processedMessageIds])];
    await saveWebForgeJob();
    $('progressLabel').textContent = `正在整理第 ${webForgeJob.chunkIndex} / ${webForgeJob.chunkCount} 段 · 进度已保存`;
    $('progressBar').style.width = `${Math.min(88, Math.round((webForgeJob.chunkIndex / Math.max(webForgeJob.chunkCount, 1)) * 80))}%`;
  };

  let rolled = null;
  // NETWORK_ERROR：同一 chunk 原样重试（checkpoint 保证只重做失败块），最多 3 次。
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      rolled = await rollupForge({ entries: remaining, previousContinuity, model, chunkChars: webForgeJob.chunkChars, onChunk });
      break;
    } catch (error) {
      if (error?.name === 'AbortError' || error?.errorClass !== 'NETWORK_ERROR' || attempt === 3) throw error;
      $('progressLabel').textContent = `网络中断，正在重试（第 ${attempt + 1} 次）…`;
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  webForgeJob.importantMessageIds = rolled.importantMessageIds;
  webForgeJob.status = 'done';
  await saveWebForgeJob();

  const packet = assembleForgePacket({
    session: result.session,
    analysis: result.analysis,
    continuity: rolled.continuity,
    importantMessageIds: rolled.importantMessageIds,
    recentTurns: RECENT_TURNS,
    fullExactChars: countChars(result.forge.fullExact),
  });
  const inputChars = entries.reduce((sum, entry) => sum + countChars(entry.text), 0);
  return {
    text: packet.packet,
    forgeRun: { rolled, packet, inputChars, excludedBootstrap: excluded, carriedContinuity: !!lineage?.continuity },
    metadata: { provider: 'web', chunks: rolled.chunks, workerSessions: webForgeJob.workerSessions.length || null },
  };
}

function showForgeChoice(rollingChars, fullChars) {
  const extra = fullChars > 0 ? (rollingChars / fullChars - 1) * 100 : null;
  $('notHelpfulFull').textContent = `${number(fullChars)} 字符`;
  $('notHelpfulRolling').textContent = `${number(rollingChars)} 字符`;
  $('notHelpfulExtraRow').hidden = extra == null;
  $('notHelpfulExtra').textContent = extra == null ? '' : `约 ${extra.toFixed(1)}%`;
  $('rollingResult').hidden = true;
  $('forgeNotHelpful').hidden = false;
}

function clearForgeChoice() {
  pendingForgeChoice = null;
  $('forgeNotHelpful').hidden = true;
}

// chrome.permissions.request 必须带着点击手势同步发起；先 await 一次就丢掉手势。
// 已授权时 request 会立刻返回 true 且不弹窗，所以直接 request 比先 contains 更稳。
function apiPermission() {
  try { return requestApiPermission(); } catch { return hasApiPermission(); }
}

$('migrateCurrent').onclick = () => {
  const useForge = strategyValue() === 'forge';
  const provider = providerValue();
  if (useForge && provider === 'api' && !forgeConfig) { say('请先在「设置」里配置 API Key，或改用免费网页版。', 'err'); return; }
  const gate = useForge && provider === 'api' ? apiPermission() : Promise.resolve(true);
  gate.then(allowed => {
    if (allowed) return migrate(useForge, provider);
    showForgeFailure('需要允许访问 api.deepseek.com，滚动压缩才能整理对话。');
  }).catch(error => {
    recordTechnical('Forge 权限申请失败', error);
    showForgeFailure('无法申请 DeepSeek API 访问权限，请重试。');
  });
};
$('retryRead').onclick = () => readSource();
$('backToCurrent').onclick = () => {
  source = { kind: 'current' };
  $('migrationComplete').hidden = true;
  $('migrationHome').hidden = false;
  clearForgeFailure();
  readSource();
};
$('recopy').onclick = () => copyCompleted(completedText);
$('retryForge').onclick = () => { clearForgeFailure(); $('strategyForge').checked = true; $('strategyFull').checked = false; updateStrategyUi(); migrate(true, providerValue()); };
$('fallbackFull').onclick = () => {
  clearForgeFailure();
  $('strategyFull').checked = true;
  $('strategyForge').checked = false;
  updateStrategyUi();
  migrate(false);
};
$('notHelpfulUseFull').onclick = () => resolveForgeChoice(false);
$('notHelpfulKeepForge').onclick = () => resolveForgeChoice(true);
$('cancelForge').onclick = () => forgeController?.abort();
$('completedReportToggle').onclick = () => {
  const expanding = $('completedReportToggle').getAttribute('aria-expanded') !== 'true';
  $('completedReportToggle').setAttribute('aria-expanded', String(expanding));
  $('completedReportToggle').textContent = expanding ? '收起完整报告' : '查看完整报告';
  $('completedReportBody').hidden = !expanding;
};
for (const radio of [$('strategyFull'), $('strategyForge'), $('providerWeb'), $('providerApi')]) {
  radio.onchange = () => updateStrategyUi();
}
$('openNewSession').onclick = async () => {
  try {
    await chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
    $('openedStatus').textContent = '✓ 新 DeepSeek 窗口已打开';
    $('openedStatus').dataset.state = 'ok';
    $('openNewSession').hidden = true;
  } catch (error) {
    recordTechnical('打开新会话失败', error);
  }
};

// ── 设置：Forge 模型 ────────────────────────────────────────────────────────
async function refreshForgeConfig() {
  forgeConfig = await loadForgeConfig().catch(() => null);
  $('forgeConfigStatus').textContent = forgeConfig
    ? `状态：已配置 · ${forgeConfig.remember ? '已记住' : '只保留到浏览器关闭'}`
    : '状态：未配置';
  $('forgeConfigSummary').hidden = !forgeConfig;
  $('forgeConfigForm').hidden = !!forgeConfig;
  $('forgeKey').value = '';
  $('forgeTestResult').textContent = '';
  updateStrategyUi();
}

$('forgeConfigChange').onclick = () => {
  $('forgeConfigForm').hidden = false;
  $('forgeConfigSummary').hidden = true;
  $('forgeKey').focus();
};
$('configureForge').onclick = () => { switchTab('settings'); $('forgeConfigChange').click(); };
$('forgeConfigRemove').onclick = async () => {
  if (!confirm('移除已保存的 DeepSeek API Key？移除后滚动压缩将不可用，完整原文迁移不受影响。')) return;
  try {
    await clearForgeConfig();
    await refreshForgeConfig();
    say('已移除滚动压缩配置。', 'ok');
  } catch (error) {
    recordTechnical('移除 Forge 配置失败', error);
    say('移除没有完成，请稍后再试。', 'err');
  }
};
$('forgeTest').onclick = async () => {
  const apiKey = $('forgeKey').value.trim();
  if (!apiKey) { $('forgeTestResult').textContent = '请先填写 API Key。'; return; }
  const allowed = apiPermission();
  if (!(await allowed)) { $('forgeTestResult').textContent = '需要允许访问 api.deepseek.com 才能测试连接。'; return; }
  $('forgeTest').disabled = true;
  $('forgeTestResult').textContent = '正在测试连接…';
  try {
    await testConnection({ apiKey, model: DEFAULT_FORGE_MODEL });
    $('forgeTestResult').textContent = '✓ 连接正常，可以保存。';
  } catch (error) {
    recordTechnical('Forge 连接测试失败', error);
    $('forgeTestResult').textContent = forgeErrorMessage(error);
  } finally {
    $('forgeTest').disabled = false;
  }
};
$('forgeSave').onclick = async () => {
  const apiKey = $('forgeKey').value.trim();
  if (!apiKey) { $('forgeTestResult').textContent = '请先填写 API Key。'; return; }
  try {
    const allowed = apiPermission();
    if (!(await allowed)) { $('forgeTestResult').textContent = '需要允许访问 api.deepseek.com 才能保存。'; return; }
    await saveForgeConfig({ apiKey, model: DEFAULT_FORGE_MODEL, remember: $('forgeRemember').checked });
    await refreshForgeConfig();
    say('滚动压缩已配置。现在可以在「迁移」页选择它。', 'ok');
  } catch (error) {
    recordTechnical('保存 Forge 配置失败', error);
    $('forgeTestResult').textContent = forgeErrorMessage(error);
  }
};

// ── 历史 ────────────────────────────────────────────────────────────────────
async function refreshSessions() {
  const [sessions, rawSessions] = await Promise.all([listSessions(), listRawSessions()]);
  const list = $('sessions');
  list.textContent = '';
  const archived = new Set(sessions.map(session => session.sessionId));
  const rawOnly = rawSessions.filter(raw => !raw.sessionId || !archived.has(raw.sessionId));
  if (!sessions.length && !rawOnly.length) {
    list.appendChild(el('li', 'empty', '还没有历史会话。打开 DeepSeek 中的会话，进入「迁移」即可读取。'));
    return;
  }
  const items = [
    ...sessions.map(session => ({ at: (session.updatedAt || 0) * 1000, session, id: session.sessionId })),
    ...rawOnly.map(raw => ({ at: raw.lastAt || 0, raw, id: raw.sessionId || null })),
  ].sort((a, b) => b.at - a.at);
  for (const item of items) {
    const title = item.session?.title || (item.id ? '尚未完整读取的会话' : '未关联会话的记录');
    const row = el('li', 'history-row');
    const copy = el('div', 'history-copy');
    copy.appendChild(el('h3', 'title', title));
    copy.appendChild(el('p', 'meta', item.session
      ? `${item.session.messageCount} 条消息 · ${new Date(item.at).toLocaleDateString('zh-CN')}`
      : `${item.raw.streams} 条记录 · 尚无完整对话`));
    row.appendChild(copy);
    const actions = el('div', 'history-actions');
    const view = el('button', 'text-button', '查看');
    view.onclick = () => selectHistory(item.id).catch(historyError);
    const migrate = el('button', 'text-button', '迁移此会话');
    migrate.disabled = !item.session;
    migrate.onclick = () => migrateHistory(item.id);
    const exportButton = el('button', 'text-button', '导出');
    exportButton.onclick = () => exportMd(true, item.id).catch(historyError);
    actions.append(view, migrate, exportButton);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function historyError(error) {
  recordTechnical('历史会话操作失败', error);
  say('这份存档暂时无法完整迁移。可打开原会话，在「迁移」页重新读取。', 'err');
}

function linkLine(result) {
  const div = el('div', 'refline');
  const link = el('a', null, result.title || result.url || '查看来源');
  link.href = result.url || '#';
  link.target = '_blank';
  link.rel = 'noreferrer';
  div.appendChild(link);
  if (result.site_name) div.appendChild(el('span', 'refsrc', ` — ${result.site_name}`));
  return div;
}

async function selectHistory(sessionId) {
  historyCurrent = sessionId;
  hasHistorySelection = true;
  const serial = ++historySerial;
  $('historyList').hidden = true;
  $('historyDetail').hidden = false;
  const [session, messages] = await Promise.all([
    sessionId ? getSession(sessionId) : null,
    sessionId ? getMessages(sessionId) : [],
  ]);
  if (serial !== historySerial) return;
  $('detailHead').textContent = session?.title || '尚未完整读取的会话';
  $('historyMigrate').disabled = !session;
  const box = $('detail');
  box.textContent = '';
  for (const message of messages) {
    const card = el('article', `msg ${message.role === 'USER' ? 'user' : 'assistant'}`);
    card.appendChild(el('h3', null, message.role === 'USER' ? '你' : 'DeepSeek'));
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    const byId = new Map(fragments.map(fragment => [fragment.id, fragment]));
    const other = [];
    for (const fragment of fragments) {
      if (fragment.type === 'REQUEST' || fragment.type === 'RESPONSE') {
        card.appendChild(el('pre', 'body', fragment.content));
        if (fragment.type === 'RESPONSE' && Array.isArray(fragment.references) && fragment.references.length) {
          const refs = el('details');
          refs.appendChild(el('summary', null, '引用来源'));
          for (const pointer of fragment.references) {
            const origin = pointer && byId.get(pointer.id);
            if (origin?.result?.url) refs.appendChild(linkLine(origin.result));
            else if (origin?.type === 'TOOL_SEARCH') for (const result of origin.results || []) refs.appendChild(linkLine(result));
          }
          card.appendChild(refs);
        }
      } else if (fragment.type === 'THINK') {
        const thought = el('details');
        thought.appendChild(el('summary', null, '思考过程'));
        thought.appendChild(el('pre', 'body', fragment.content));
        card.appendChild(thought);
      } else other.push(fragment);
    }
    if (other.length) {
      const records = el('details');
      records.appendChild(el('summary', null, `其他记录 · ${other.length} 项`));
      records.appendChild(el('pre', 'body', JSON.stringify(other, null, 2)));
      card.appendChild(records);
    }
    const metadata = el('details', 'message-meta');
    metadata.appendChild(el('summary', null, '消息信息'));
    metadata.appendChild(el('pre', 'body', JSON.stringify({
      messageId: message.messageId, parentId: message.parentId, status: message.status,
      tokenUsage: message.tokenUsage, incomplete: message.incomplete,
      hasPendingFragment: message.hasPendingFragment, unknownFragmentTypes: message.unknownFragmentTypes,
    }, null, 2)));
    card.appendChild(metadata);
    box.appendChild(card);
  }
  if (!messages.length) box.appendChild(el('p', 'empty', '这里没有完整对话存档。已有原始记录可在下方展开查看。'));
  await refreshRawArea(sessionId);
}

// 历史不再有自己的复制/完成流程：切到「迁移」页、把这个会话当成来源，走同一条路。
function migrateHistory(sessionId) {
  if (!sessionId) return;
  source = { kind: 'history', sessionId };
  switchTab('migration');
}

$('backToHistory').onclick = () => {
  $('historyList').hidden = false;
  $('historyDetail').hidden = true;
  refreshSessions().catch(historyError);
};
$('historyMigrate').onclick = () => migrateHistory(historyCurrent);
$('historyExport').onclick = () => exportMd(true).catch(historyError);

// 原始帧列表 + 重建区。select() 首次渲染和流收尾（RAW_DONE）后的增量刷新共用，
// 后者不动正文区，用户读到一半不会被闪回去
async function refreshRawArea(sessionId) {
  const [messages, streams] = await Promise.all([
    sessionId ? getMessages(sessionId) : [],
    listRawStreams(sessionId),
  ]);
  // 每条流只读一次、只回放一次，原始帧列表和重建区共用结果
  const replays = new Map();
  for (const s of streams) {
    try { replays.set(s.streamId, replayStream(await readRawText(s.streamId))); }
    catch { /* 单条流回放失败不影响其他 */ }
  }
  if (sessionId !== historyCurrent) return; // 等库的时候用户点了别的，别覆盖
  renderRawList(sessionId, streams, replays);
  renderRecovered(sessionId, { onlyFiltered: messages.length > 0, streams, replays });
}

// 选中会话时直接把原始帧重放成可读内容：有正式存档的会话只补被过滤的流
// （正常流和正式消息重复），纯原始帧会话则全部重建。回放结果由 select 统一算好传进来
function renderRecovered(sessionId, { onlyFiltered = false, streams = [], replays = new Map() } = {}) {
  const box = $('recovered');
  box.textContent = '';
  box.hidden = true;
  const cards = [];
  for (const s of streams) {
    const r = replays.get(s.streamId);
    if (!r || (!r.response && !r.think)) continue;
    if (onlyFiltered && !r.filtered) continue;
    cards.push({ s, r, prompt: promptOf(s) });
  }
  if (!cards.length) return;
  box.hidden = false;
  const recovered = el('details');
  recovered.appendChild(el('summary', null,
    `从原始记录恢复的回答 · ${cards.length} 条`));
  box.appendChild(recovered);
  for (const { s, r, prompt } of cards) {
    const card = el('article', `msg assistant${r.filtered ? ' filtered' : ''}`);
    card.appendChild(el('h3', null,
      `${new Date(s.startedAt || 0).toLocaleString()} · ${r.filtered ? '⚠ 被过滤，以下是擦除前原文' : '原始帧重建'}`));

    const chips = el('div', 'chips');
    if (r.think) chips.appendChild(el('span', 'chip t-THINK', `THINK ${r.think.length}`));
    if (r.response) chips.appendChild(el('span', 'chip t-RESPONSE', `RESPONSE ${r.chars}`));
    if (r.filtered) chips.appendChild(el('span', 'chip filtered', 'CONTENT_FILTER'));
    if (r.tokenUsage != null) chips.appendChild(el('span', 'chip meta-chip', `${r.tokenUsage} tok`));
    card.appendChild(chips);

    if (prompt) card.appendChild(el('div', 'meta', `提问：${prompt}`));
    if (r.think) {
      const det = el('details');
      const secs = r.thinkSecs != null ? ` ${(Math.round(r.thinkSecs * 10) / 10)}s` : '';
      det.appendChild(el('summary', null, `思考${secs}`));
      det.appendChild(el('pre', 'body', r.think));
      card.appendChild(det);
    }
    if (r.response) card.appendChild(el('pre', 'body', r.response));
    if (r.filtered && r.template) card.appendChild(el('div', 'warn', `页面上实际显示：「${r.template}」`));
    recovered.appendChild(card);
  }
}

// 从 requestBody 里抠提问文本（抠不出就空）
function promptOf(s) {
  try { return JSON.parse(s.start?.requestBody || '{}').prompt || ''; } catch { return ''; }
}

// 单条流的重建 Markdown 段，导出正文和附录共用
function recoveredSection(s, r, prompt, { includeThinking = true } = {}) {
  const out = [`## ${new Date(s.startedAt || 0).toLocaleString()} · ${r.filtered ? '⚠ 被过滤（已恢复擦除前原文）' : '原始帧重建'}`,
    `> 流 ${s.streamId.slice(0, 8)} · 状态 ${r.status || '?'} · ${r.frames} 帧${r.tokenUsage != null ? ` · ${r.tokenUsage} tok` : ''}`, ''];
  if (prompt) out.push('**提问：** ' + prompt, '');
  if (includeThinking && r.think) {
    const secs = r.thinkSecs != null ? ` ${(Math.round(r.thinkSecs * 10) / 10)}s` : '';
    out.push(`<details><summary>思考${secs}</summary>`, '', r.think, '', '</details>', '');
  }
  if (r.response) out.push(`### 回答${r.filtered ? '（页面实际未显示）' : ''}`, '', r.response, '');
  if (r.filtered && r.template) out.push(`> 页面上最终被替换成模板话术：「${r.template}」`, '');
  return out;
}

async function exportMd(includeThinking, sessionId = historyCurrent) {
  const [session, messages, streams] = await Promise.all([
    sessionId ? getSession(sessionId) : null,
    sessionId ? getMessages(sessionId) : [],
    listRawStreams(sessionId),
  ]);
  const replays = new Map();
  for (const s of streams) {
    try { replays.set(s.streamId, replayStream(await readRawText(s.streamId))); } catch { /* 单条流回放失败不影响其他 */ }
  }

  // 没有正式存档（被过滤/快照失败的会话常这样）：直接从原始帧重建导出，
  // 这就是原「重建被过滤内容」按钮干的事，现在并进导出按钮
  if (!session || !messages.length) {
    const label = (session && session.title) || sessionId || '未关联会话';
    const out = [`# ${label} · 原始帧重建`, '',
      `> 此会话没有正式存档，Markdown 从 ${streams.length} 条原始 SSE 帧流重放生成 · ${new Date().toLocaleString()}`,
      '> 被过滤的条目恢复的是"擦除前已到达浏览器"的原文，页面实际显示的是模板话术', ''];
    let total = 0, filtered = 0;
    for (const s of streams) {
      const r = replays.get(s.streamId);
      if (!r || (!r.response && !r.think)) continue;
      total++;
      if (r.filtered) filtered++;
      out.push('---', '', ...recoveredSection(s, r, promptOf(s)));
    }
    if (!total) { say('没有可导出的内容：既无正式存档，原始帧里也没有内容帧', 'err'); return; }
    download(`${label}.md`, out.join('\n'), 'text/markdown');
    say(`已导出重建版：${total} 条流 · ${filtered} 条被过滤已恢复`, 'ok');
    return;
  }

  let md = buildMarkdown(session, messages, { includeThinking });
  // 被 CONTENT_FILTER 擦掉的回答不在正式存档里，作为附录自动补上
  const appendix = [];
  for (const s of streams) {
    const r = replays.get(s.streamId);
    if (r && r.filtered && (r.response || r.think)) appendix.push(...recoveredSection(s, r, promptOf(s), { includeThinking }));
  }
  if (appendix.length) md += ['', '', '---', '', '# 附录：被过滤的回答（从原始帧重建，正式存档里没有）', '', ...appendix].join('\n');
  download(`${session.title || sessionId}.md`, md, 'text/markdown');
  say(appendix.length ? '已导出，附录含被过滤回答的重建' : '已生成 Markdown 文件', 'ok');
}

// 原始帧流列表；点一条下载该条 .sse.txt。回放结果由 select 统一算好传进来，这里不再重复读库
function renderRawList(sessionId, streams, replays) {
  const box = $('rawList');
  box.textContent = '';
  box.hidden = !streams.length;
  if (!streams.length) return;
  // 原始帧是排障手段不是日常界面，默认折叠，省得几十条流把详情区顶没
  const det = el('details');
  det.appendChild(el('summary', null, `原始帧 · ${streams.length} 条流（服务端撤不回；点一条可下载 .sse.txt）`));
  for (const s of streams) {
    const line = el('div', 'rawline');
    const status = s.end?.error ? `出错：${s.end.error}`
      : s.meta ? `HTTP ${s.meta.status}` : s.start ? '未收尾' : '不完整';
    line.appendChild(el('span', null, `${new Date(s.startedAt || 0).toLocaleTimeString()} · ${status}`));
    // 被 CONTENT_FILTER 擦过的流给出徽标，用户一眼看出哪条有救、救回多少字
    const r = replays.get(s.streamId);
    if (r) {
      if (r.filtered && r.response) line.appendChild(el('span', 'chip filtered', `被过滤 · 已恢复 ${r.chars} 字`));
      else if (r.filtered) line.appendChild(el('span', 'chip filtered', '被过滤 · 帧内无正文'));
      else if (r.response) line.appendChild(el('span', 'chip meta-chip', `${r.chars} 字`));
    }
    line.appendChild(el('span', 'rawid', s.streamId.slice(0, 8)));
    line.onclick = async () => {
      const text = await readRawText(s.streamId);
      download(`${s.streamId}.sse.txt`,
        `# endpoint\n${s.start?.url || ''}\n\n# requestBody\n${s.start?.requestBody || ''}\n\n# raw\n${text}`,
        'text/plain');
    };
    det.appendChild(line);
  }
  box.appendChild(det);
}

function chain(state, label, detail) {
  const row = el('div', `drow ${state}`);
  row.appendChild(el('span', 'dot', state === 'ok' ? '✓' : state === 'bad' ? '✗' : '·'));
  row.appendChild(el('span', 'dlabel', label));
  row.appendChild(el('span', 'ddetail', detail || ''));
  return row;
}

async function runDiag() {
  const content = $('diagContent');
  content.textContent = '';
  content.appendChild(el('div', 'live-meta', '正在自检…'));

  const res = await chrome.runtime.sendMessage({ type: 'DIAG_ASK' });
  content.textContent = '';
  if (!res || !res.sw) {
    content.appendChild(chain('bad', '后台进程没应答', JSON.stringify(res)));
    return;
  }
  const { sw, tabs, dbStats, manifestVersion } = res;
  content.appendChild(chain('ok', '后台进程在跑', `脚本版本 ${manifestVersion} · 启动于 ${new Date(sw.swStartedAt).toLocaleTimeString()}`));

  const list = tabs || [];
  if (!list.length) {
    content.appendChild(chain('bad', '没找到任何 DeepSeek 标签页',
      '地址栏确认是 https://chat.deepseek.com/ 开头；不是的话扩展本来就不该注入'));
    return;
  }

  const live = list.filter(t => t.ok);
  content.appendChild(chain(live.length ? 'ok' : 'bad', `扫了 ${list.length} 个 DeepSeek 标签页`,
    live.length ? `${live.length} 个有应答` : '全部无应答 —— 脚本进不去网页'));
  for (const dead of list.filter(t => !t.ok)) {
    content.appendChild(chain('bad', `标签页「${dead.title || dead.tabId}」没装上脚本`,
      '去扩展详情页允许访问 chat.deepseek.com，再刷新该页'));
  }
  if (!live.length) return;

  const tab = live[0];
  const injected = tab.mainHook && tab.bridge;
  content.appendChild(chain(injected ? 'ok' : 'bad', '网页脚本',
    `拦抄的 ${tab.mainHook ? '在' : '不在'} · 转发桥 ${tab.bridge ? '在' : '不在'} · 握手暗号 ${tab.nonce ? '有' : '无'}`));

  const hitsOk = tab.streamHits > 0;
  content.appendChild(chain(hitsOk ? 'ok' : tab.xhrTotal > 0 ? 'bad' : 'wait',
    hitsOk ? '堵到了出数据的请求' : tab.xhrTotal > 0 ? '一个请求都没堵上' : '尚无流请求（读取已有历史无需新提问）',
    `网页共 ${tab.xhrTotal} 个请求 · 匹配 ${tab.streamHits} 个 · 会话 ${tab.sessionId || '（新的，还没生成 id）'}`));

  content.appendChild(chain(tab.bridgeRecv > 0 ? 'ok' : 'wait', '页面侧抄到内容',
    `共 ${tab.bridgeRecv} 段，送出 ${tab.batchesSent} 批，失败 ${tab.sendFails} 次`));
  content.appendChild(chain(sw.rawChars > 0 ? 'ok' : 'wait', '后台收到原始文本',
    `${sw.rawChars} 字 · ${sw.streamsSeen} 条流 / 收尾 ${sw.streamsEnded} 条`));
  content.appendChild(chain((dbStats?.rawChunkRows || 0) > 0 ? 'ok' : 'wait', '已写入本地库',
    `原始块 ${dbStats?.rawChunkRows ?? '?'} 行 · 正式存档 ${dbStats?.sessions ?? '?'} 个会话 ${dbStats?.messages ?? '?'} 条消息`));

  try {
    const est = await navigator.storage.estimate();
    const mb = n => (n / 1048576).toFixed(1);
    content.appendChild(chain('ok', '本地占用',
      `${mb(est.usage || 0)} MB${est.quota ? ` · 浏览器配额约 ${mb(est.quota)} MB` : ''} · 可在设置页「备份全部」导出`));
  } catch { /* 拿不到占用信息就算了 */ }

  if (tab.sendFails > 0 && tab.lastSendError) content.appendChild(chain('bad', '页面投递失败', tab.lastSendError));
  for (const e of sw.errors || []) content.appendChild(chain('bad', '后台报错', e));
  if (!hitsOk) content.appendChild(chain('wait', '下一步', '打开已有会话，进入「迁移」页读取历史即可，无需发送新消息。'));
}

// 「自检」这一行和其它设置项一样：点标题开合，展开时跑一次自检。
$('diagToggle').onclick = () => {
  const expanding = $('diagToggle').getAttribute('aria-expanded') !== 'true';
  $('diagToggle').setAttribute('aria-expanded', String(expanding));
  $('diagContent').hidden = !expanding;
  if (!expanding) return;
  runDiag().catch(error => {
    recordTechnical('自检失败', error);
    say('自检暂时没有完成，可在开发诊断中查看原因。', 'err');
  });
};

$('backup').onclick = async () => {
  try {
    const data = await exportAll();
    const day = new Date().toISOString().slice(0, 10);
    download(`deepseek-archive-${day}.json`, JSON.stringify(data), 'application/json');
    say(`已备份 ${data.sessions.length} 个会话。`, 'ok');
  } catch (error) {
    recordTechnical('备份失败', error);
    say('备份没有完成，请稍后再试。', 'err');
  }
};
$('restore').onclick = () => $('restoreFile').click();
$('restoreFile').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { say('请选取本扩展导出的 JSON 备份文件。', 'err'); return; }
  if (data?.app !== 'ds-archive' || !Array.isArray(data.sessions)) { say('这不是本扩展的备份文件。', 'err'); return; }
  if (!confirm(`恢复 ${data.sessions.length} 个会话？已有的同一记录会被覆盖。`)) return;
  try {
    await importAll(data);
    await refreshSessions();
    say('备份已恢复。', 'ok');
  } catch (error) {
    recordTechnical('恢复备份失败', error);
    say('恢复没有完成，请检查备份文件。', 'err');
  }
};
$('drop').onclick = async () => {
  if (!hasHistorySelection) return;
  if (!confirm('删除这份本地存档及原始记录？此操作不能撤销，不会删除 DeepSeek 云端会话。')) return;
  try {
    if (historyCurrent) await deleteSession(historyCurrent);
    else await deleteRawForSession(null);
    // 正把这份存档当成迁移来源时，删了就回到当前会话，免得留下指向空记录的状态。
    if (source.kind === 'history' && source.sessionId === historyCurrent) source = { kind: 'current' };
    historyCurrent = null;
    hasHistorySelection = false;
    historySerial++;
    $('historyDetail').hidden = true;
    $('historyList').hidden = false;
    await refreshSessions();
    say('本地存档已删除。', 'ok');
  } catch (error) {
    recordTechnical('删除本地存档失败', error);
    say('本地存档未能删除。', 'err');
  }
};

chrome.runtime.onMessage.addListener(message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ARCHIVED') {
    refreshSessions().catch(error => recordTechnical('历史列表刷新失败', error));
    if (hasHistorySelection && message.sessionId === historyCurrent && !$('historyDetail').hidden) {
      selectHistory(historyCurrent).catch(error => recordTechnical('历史详情刷新失败', error));
    }
    // Our own fresh snapshot also broadcasts ARCHIVED. Reuse its saved result,
    // rather than starting another snapshot in response to that broadcast.
    refreshCurrentArchive(message.sessionId).catch(error => recordTechnical('当前会话存档刷新失败', error));
  } else if (message.type === 'RAW_DONE') {
    if (hasHistorySelection && (message.sessionId || null) === historyCurrent && !$('historyDetail').hidden) refreshRawArea(historyCurrent).catch(error => recordTechnical('原始记录刷新失败', error));
  } else if (message.type === 'LINEAGE_BOUND') {
    recordTechnical('已接上上一代的持续状态', message.sourceSessionId);
  } else if (message.type === 'MIGRATION_PROGRESS') {
    if (message.phase === 'waiting_page') $('progressLabel').textContent = '正在打开新会话页面…';
    if (message.phase === 'injecting') $('progressLabel').textContent = '正在写入迁移内容…';
    if (message.phase === 'sending') $('progressLabel').textContent = '正在发送…';
    if (message.phase === 'observing') { $('progressLabel').textContent = '已发送，正在等待结果…'; $('progressBar').style.width = '70%'; }
  } else if (message.type === 'ARCHIVE_ERROR') {
    recordTechnical('后台存档失败', message.message);
  }
});

chrome.tabs.onActivated?.addListener(info => currentPageChanged(info.tabId));
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.url) currentPageChanged(tabId);
});

const manifest = chrome.runtime.getManifest();
document.title = PRODUCT_DISPLAY_NAME;
$('brandTitle').textContent = PRODUCT_NAME;
$('brandSubtitle').textContent = PRODUCT_SUBTITLE;
$('versionInfo').textContent = `版本 ${manifest.version} · 原生输入迁移与滚动压缩（网页版 / API）均可用。`;
refreshSessions().catch(error => recordTechnical('历史列表读取失败', error));
refreshForgeConfig()
  .catch(error => recordTechnical('读取 Forge 配置失败', error))
  .finally(() => readSource());
