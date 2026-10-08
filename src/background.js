import { saveSnapshot, appendRaw, countSessions } from './db.js';
import { normalizeMessages, normalizeSession } from './normalize.js';
import { buildCanonicalSnapshot } from './archive.js';
import { saveForgeState, takePendingMigration, armPendingMigration } from './forge-lineage.js';
import { updateRun } from './draft.js';
import { classifyOutcome, summarizeRequestBody } from './outcome.js';
import { replayStream } from './rebuild.js';
import { renderForgePrompt } from './web-forge.js';

const STREAM_URL = /\/api\/v0\/chat\/(completion|regenerate|continue|edit_message|resume_stream)(\?|$)/;
const FILTER = { urls: ['https://chat.deepseek.com/*'] };
const SETTLE_MS = 900;

const inflight = new Map();
const settling = new Map();
const SESSION_KEY = 'inflight';
let hydrated = false;

// 全程加保护：这一行若在顶层同步抛错，下面所有监听都不会注册，表现就是"什么都没录到"
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const stored = await chrome.storage.session.get(SESSION_KEY);
  for (const [tab, ids] of Object.entries(stored[SESSION_KEY] || {})) {
    const set = new Set(ids);
    if (set.size) inflight.set(Number(tab), set);
  }
}

function persist() {
  const snapshot = {};
  for (const [tab, set] of inflight) snapshot[tab] = [...set];
  chrome.storage.session.set({ [SESSION_KEY]: snapshot }).catch(() => {});
}

function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text && color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

const DIAG_KEY = 'dsrDiag';
const blankDiag = () => ({ swStartedAt: Date.now(), lastEventAt: null, streamRequests: 0, rawBatches: 0,
  rawEvents: 0, rawChars: 0, streamsSeen: 0, streamsEnded: 0, snapshotsSaved: 0, errors: [] });

async function note(mutate) {
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    const d = Object.assign(blankDiag(), stored[DIAG_KEY] || {});
    mutate(d);
    d.lastEventAt = Date.now();
    d.errors = d.errors.slice(-6);
    await chrome.storage.local.set({ [DIAG_KEY]: d });
  } catch { /* 自检本身不该拖垮主流程 */ }
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function requestSnapshot(tabId, reason) {
  return chrome.tabs.sendMessage(tabId, { type: 'SNAPSHOT_REQUEST', reason })
    .catch(err => { badge(tabId, '!', '#d33'); throw err; });
}

function begin(tabId, requestId) {
  clearTimeout(settling.get(tabId));
  settling.delete(tabId);
  if (!inflight.has(tabId)) inflight.set(tabId, new Set());
  inflight.get(tabId).add(requestId);
  note(d => { d.streamRequests++; });
  badge(tabId, '●', '#f08c00');
  persist();
}

function end(tabId, requestId) {
  const set = inflight.get(tabId);
  if (!set) return;
  set.delete(requestId);
  if (set.size) { persist(); return; }
  inflight.delete(tabId);
  persist();
  badge(tabId, '···', '#4c9aff');
  settling.set(tabId, setTimeout(() => {
    settling.delete(tabId);
    badge(tabId, '');
    requestSnapshot(tabId, 'stream_end').catch(() => {});
  }, SETTLE_MS));
}

chrome.webRequest.onBeforeRequest.addListener(async d => {
  if (d.tabId < 0 || !STREAM_URL.test(d.url)) return;
  await hydrate();
  begin(d.tabId, d.requestId);
}, FILTER);

for (const event of ['onCompleted', 'onErrorOccurred']) {
  chrome.webRequest[event].addListener(async d => {
    await hydrate();
    if (inflight.has(d.tabId)) end(d.tabId, d.requestId);
  }, FILTER);
}

chrome.tabs.onRemoved.addListener(tabId => {
  inflight.delete(tabId);
  clearTimeout(settling.get(tabId));
  settling.delete(tabId);
  persist();
});

// 迁移包在新窗口里就是第一条 user 消息；记下它，下一代 Forge 才能把它排除掉。
function firstUserMessageId(messages) {
  for (const message of messages) {
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    if (String(message.role || '').toUpperCase() === 'USER' || fragments.some(f => f.type === 'REQUEST')) {
      return String(message.messageId);
    }
  }
  return null;
}

// 从「迁移」打开的新窗口第一次被读到：B ← A，之后 B 再 Forge 就接上一代 Continuity。
async function bindLineage(tabId, sessionId, messages) {
  const pending = await takePendingMigration(tabId);
  if (!pending?.sourceSessionId || pending.sourceSessionId === sessionId) return;
  await saveForgeState(sessionId, {
    continuity: pending.continuity,
    sourceSessionId: pending.sourceSessionId,
    bootstrapMessageId: firstUserMessageId(messages),
  });
  broadcast({ type: 'LINEAGE_BOUND', sessionId, sourceSessionId: pending.sourceSessionId });
}

async function handleSnapshot(msg, sender) {
  if (!Array.isArray(msg.chatMessages)) throw new Error('历史接口未返回 chat_messages 数组');
  const normalizedMessages = normalizeMessages(msg.sessionId, msg.chatMessages || [])
    .map(m => ({ ...m, archivedAt: Date.now() }));
  const { session, messages } = buildCanonicalSnapshot(
    { ...normalizeSession(msg.sessionId, msg.session), snapshotCapturedAt: Date.now() }, normalizedMessages);
  await saveSnapshot(session, messages);
  note(d => { d.snapshotsSaved++; d.lastSessionId = msg.sessionId; });
  if (sender?.tab?.id != null) {
    try { await bindLineage(sender.tab.id, session.sessionId, normalizedMessages); }
    catch { /* 代际绑定失败不该影响存档本身 */ }
  }
  broadcast({ type: 'ARCHIVED', sessionId: msg.sessionId, count: messages.length });
  return { ok: true, sessionId: session.sessionId, messageCount: session.messageCount };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'SNAPSHOT') {
    handleSnapshot(msg, sender).then(respond).catch(err => {
      const message = String(err.message || err);
      note(d => d.errors.push(`取历史失败: ${message}`));
      broadcast({ type: 'ARCHIVE_ERROR', sessionId: msg.sessionId, message });
      respond({ ok: false, sessionId: msg.sessionId, error: message });
    });
    return true;
  }

  if (msg.type === 'SNAPSHOT_NOW') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true, url: 'https://chat.deepseek.com/*' }).then(async tabs => {
      if (tabs.length !== 1) { respond({ ok: false, error: '请先将已有 DeepSeek 会话设为当前标签页，再读取快照。' }); return; }
      const result = await requestSnapshot(tabs[0].id, 'manual');
      respond(result || { ok: false, error: '当前页面没有返回快照确认。' });
    }).catch(err => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'RAW_BATCH') {
    const events = msg.batch || [];
    note(d => {
      d.rawBatches++;
      d.rawEvents += events.length;
      for (const e of events) {
        if (e.type === 'start') d.streamsSeen++;
        if (e.type === 'chunk') {
          d.rawChars += (e.text || '').length;
          if (e.done) { d.streamsEnded++; if (e.error) d.errors.push(`流中断: ${e.error}`); }
        }
      }
    });
    // 运行级观察器（native 迁移 / Web Forge worker）与存档链并行，互不影响。
    dispatchStreamEvent(sender?.tab?.id ?? null, events);
    appendRaw(events)
      .then(() => respond({ ok: true }))
      .catch(err => {
        note(d => d.errors.push(`写库失败: ${String(err.message || err)}`));
        respond({ ok: false, error: String(err.message || err) });
      });
    for (const e of events) {
      if (e.type === 'chunk' && e.done) broadcast({ type: 'RAW_DONE', streamId: e.streamId, sessionId: e.sessionId });
    }
    return true;
  }

  if (msg.type === 'DIAG_ASK') {
    (async () => {
      const stored = await chrome.storage.local.get(DIAG_KEY);
      const found = [];
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
      } catch (err) {
        found.push({ error: `列标签页就失败了：${String(err.message || err)}` });
      }
      for (const t of tabs) {
        try {
          found.push({ tabId: t.id, title: (t.title || '').slice(0, 24), ok: true, ...(await chrome.tabs.sendMessage(t.id, { type: 'DIAG_PING' })) });
        } catch (err) {
          found.push({ tabId: t.id, title: (t.title || '').slice(0, 24), ok: false, error: String(err.message || err) });
        }
      }
      let dbStats;
      try { dbStats = await countSessions(); } catch (err) { dbStats = { error: String(err.message || err) }; }
      respond({
        sw: Object.assign(blankDiag(), stored[DIAG_KEY] || {}),
        tabs: found,
        manifestVersion: chrome.runtime.getManifest().version,
        dbStats,
      });
    })();
    return true;
  }

  if (msg.type === 'ARCHIVE_ERROR') {
    respond({ ok: true });
    broadcast(msg);
    return true;
  }

  if (msg.type === 'MIGRATE_SEND') {
    migrateSend(msg).then(respond).catch(err => respond({ ok: false, errorClass: 'UNKNOWN', detail: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'WEB_FORGE_CALL') {
    webForgeCall(msg).then(respond).catch(err => respond({ ok: false, errorClass: 'UNKNOWN', detail: String(err.message || err) }));
    return true;
  }

  if (msg.type === 'WEB_FORGE_RESET') {
    resetWebForgeJob(msg.jobId).then(() => respond({ ok: true })).catch(err => respond({ ok: false, error: String(err.message || err) }));
    return true;
  }

  return false;
});

// ════════════════════════════════════════════════════════════════════════════
// Native 迁移传输编排：观察器 + 注入/发送/终态仲裁。
// 证据链：recorder-main（requestBody/SSE）→ RAW_BATCH（sender.tab.id 关联）→
// classifyOutcome（request → HTTP → SSE → history）。
// ════════════════════════════════════════════════════════════════════════════

const CHAT_HOME = 'https://chat.deepseek.com/';
const COMPLETION_RE = /\/api\/v0\/chat\/(completion|regenerate|continue|edit_message|resume_stream)(\?|$)/;
const streamWatchers = new Map(); // tabId -> Set<fn(event)>

function dispatchStreamEvent(tabId, events) {
  if (tabId == null) return;
  const set = streamWatchers.get(tabId);
  if (!set) return;
  for (const watcher of [...set]) {
    for (const event of events) {
      try { watcher(event); } catch { /* 观察器异常不影响录制 */ }
    }
  }
}

function addWatcher(tabId, fn) {
  if (!streamWatchers.has(tabId)) streamWatchers.set(tabId, new Set());
  streamWatchers.get(tabId).add(fn);
}
function removeWatcher(tabId, fn) {
  streamWatchers.get(tabId)?.delete(fn);
  if (streamWatchers.get(tabId)?.size === 0) streamWatchers.delete(tabId);
}

chrome.tabs.onRemoved.addListener(tabId => {
  streamWatchers.delete(tabId);
  for (const [jobId, job] of webForgeJobs) if (job.tabId === tabId) webForgeJobs.delete(jobId);
});

function terminalTimeoutMs(chars) {
  if (chars > 500000) return 480000;
  if (chars > 100000) return 300000;
  return 180000;
}

// 等待目标 tab 的 content script（transport.js）就绪。
async function waitTransportReady(tabId, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'BRIDGE_PING' });
      if (pong?.ok) return pong;
    } catch { /* 尚未注入，继续等 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('新 DeepSeek 页面未就绪（content script 未应答）');
    await new Promise(r => setTimeout(r, 500));
  }
}

// 观察一次 completion 流：首个匹配请求的 requestBody / HTTP status / SSE 全文 / 终止原因。
// 「终态」= recorder 报 done（流收尾）后再等 grace 让最后的 BATCH 帧落网。
function observeCompletion(tabId, { expectedSessionId = null, timeoutMs = 300000 } = {}) {
  return new Promise(resolve => {
    const state = {
      sawRequest: false, requestBody: null, url: null, httpStatus: null,
      sse: '', streamError: null, streamId: null, chatSessionId: null,
    };
    let settled = false;
    let doneTimer = null;
    const hardTimeout = setTimeout(() => finish('timeout'), timeoutMs);

    const matchesStart = event => {
      if (event.type !== 'start' || !COMPLETION_RE.test(event.url || '')) return false;
      if (state.sawRequest) return false;
      if (expectedSessionId) {
        try { return JSON.parse(event.requestBody || '{}').chat_session_id === expectedSessionId; }
        catch { return false; }
      }
      return true;
    };

    const watcher = event => {
      if (matchesStart(event)) {
        state.sawRequest = true;
        state.requestBody = event.requestBody || null;
        state.url = event.url;
        state.streamId = event.streamId;
        try { state.chatSessionId = JSON.parse(event.requestBody || '{}').chat_session_id || null; } catch { /* keep null */ }
        return;
      }
      if (!state.streamId || event.streamId !== state.streamId) return;
      if (event.type === 'meta' && state.httpStatus == null) state.httpStatus = event.status;
      if (event.type === 'chunk') {
        state.sse += event.text || '';
        if (event.error) state.streamError = event.error;
        if (event.done) {
          clearTimeout(hardTimeout);
          doneTimer = setTimeout(() => finish(null), 1800); // grace：最后一帧 BATCH / 模板覆盖
        }
      }
    };

    function finish(why) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      clearTimeout(doneTimer);
      removeWatcher(tabId, watcher);
      resolve({ ...state, timeoutReason: why });
    }

    addWatcher(tabId, watcher);
  });
}

async function pullHistoryViaTab(tabId, sessionId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'HISTORY_PULL', sessionId });
      if (res?.ok) return res;
    } catch { /* content script 未就绪或页面切换，重试 */ }
    await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

// 一次完整的 native 发送：确保 tab → 等就绪 → 注入+完整性验证 → 真实发送 →
// 观察终态 → 分类。tab 由调用方决定（迁移=新 tab；worker=复用 tab）。
async function nativeSendAndObserve({ tabId = null, content, expectedSessionId = null, progress = null }) {
  let createdTab = false;
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: CHAT_HOME });
    tabId = tab.id;
    createdTab = true;
  }
  progress?.({ phase: 'waiting_page', tabId });
  await waitTransportReady(tabId);
  progress?.({ phase: 'injecting', tabId });
  const inject = await chrome.tabs.sendMessage(tabId, { type: 'TRANSPORT_INJECT', text: content });
  if (!inject?.ok || !inject.renderedMatches || inject.headOk === false || inject.tailOk === false) {
    return {
      ok: false, stage: 'inject', tabId, createdTab, inject,
      outcome: { type: 'TRANSPORT_ERROR', ok: false, detail: `composer 注入未通过完整性验证：${inject?.reason || inject?.detail || `rendered ${inject?.renderedChars}/${inject?.inputChars}`}`, evidence: { inject } },
    };
  }
  progress?.({ phase: 'sending', tabId });
  const observation = observeCompletion(tabId, { expectedSessionId, timeoutMs: terminalTimeoutMs(content.length) });
  const send = await chrome.tabs.sendMessage(tabId, { type: 'TRANSPORT_SEND' });
  if (!send?.clicked) {
    return {
      ok: false, stage: 'send', tabId, createdTab, inject,
      outcome: { type: 'TRANSPORT_ERROR', ok: false, detail: `发送控件未触发：${send?.reason || 'unknown'}`, evidence: { send } },
    };
  }
  progress?.({ phase: 'observing', tabId });
  const obs = await observation;
  const request = summarizeRequestBody(obs.requestBody);
  const history = obs.chatSessionId ? await pullHistoryViaTab(tabId, obs.chatSessionId) : null;
  const outcome = classifyOutcome({
    draftChars: content.length,
    request,
    httpStatus: obs.httpStatus,
    sseText: obs.sse || null,
    streamError: obs.streamError,
    sawRequest: obs.sawRequest,
    history,
    sendClicked: !!send?.clicked,
  });
  return { ok: outcome.ok, stage: 'observed', tabId, createdTab, inject, send, observation: obs, request, history, outcome, targetSessionId: obs.chatSessionId };
}

// ── MIGRATE_SEND：一次真实迁移 run（exact 或 rolling 的最终 packet） ──────────
async function migrateSend({ runId, draftId, sourceSessionId, mode, content, lineage = null }) {
  const patchProgress = event => broadcast({ type: 'MIGRATION_PROGRESS', runId, ...event });
  const result = await nativeSendAndObserve({ content, progress: patchProgress });
  const statusPatch = {
    targetSessionId: result.targetSessionId || null,
    requestPromptChars: result.request?.promptChars ?? null,
    refFileIdsCount: result.request?.refFileIdsCount ?? null,
    finalStatus: result.outcome?.type || 'UNKNOWN',
    errorClass: result.outcome?.ok ? null : (result.outcome?.detail || null),
    completedAt: Date.now(),
    diagnostic: {
      status: result.outcome?.evidence?.status ?? null,
      quasiStatus: result.outcome?.evidence?.quasiStatus ?? null,
      httpStatus: result.observation?.httpStatus ?? null,
      injectChars: result.inject?.renderedChars ?? null,
      transportHow: result.send?.how ?? null,
    },
  };
  if (runId) await updateRun(runId, statusPatch).catch(() => {});
  // 滚动压缩成功才登记代际（与 v0.3 语义一致：完整原文不继承）。
  if (mode === 'rolling' && result.ok && result.tabId != null && lineage?.continuity) {
    await armPendingMigration(result.tabId, { sourceSessionId, continuity: lineage.continuity })
      .catch(err => note(d => d.errors.push(`登记代际失败: ${String(err.message || err).slice(0, 80)}`)));
  }
  broadcast({ type: 'MIGRATION_OUTCOME', runId, draftId, sourceSessionId, mode, ...statusPatch, detail: result.outcome?.detail || null });
  return {
    ok: result.ok,
    outcomeType: result.outcome?.type || 'UNKNOWN',
    detail: result.outcome?.detail || null,
    ...statusPatch,
    evidence: result.outcome?.evidence || null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Web Forge worker 会话管理：一个 job 一个 tab；会话膨胀则轮换；
// 每次 call = 注入 Forge prompt → 真实发送 → 观察终态 → 抽 RESPONSE。
// 串行执行（job.busy 锁），绝不并发轰炸。
// ════════════════════════════════════════════════════════════════════════════

const webForgeJobs = new Map(); // jobId -> { tabId, workerSessionId, workerChars, busy }
const WORKER_ROTATE_CHARS = 150000;

async function resetWebForgeJob(jobId) {
  webForgeJobs.delete(jobId);
}

async function webForgeCall({ jobId, payload }) {
  let job = webForgeJobs.get(jobId);
  if (!job) {
    const tab = await chrome.tabs.create({ url: CHAT_HOME });
    job = { tabId: tab.id, workerSessionId: null, workerChars: 0, busy: false };
    webForgeJobs.set(jobId, job);
  }
  if (job.busy) return { ok: false, errorClass: 'RATE_LIMITED', detail: '上一个整理请求还没有结束，已跳过并发调用。' };
  job.busy = true;
  try {
    const prompt = renderForgePrompt(payload);
    if (job.workerChars > 0 && job.workerChars + prompt.length > WORKER_ROTATE_CHARS) {
      // worker 会话膨胀：当前 Continuity 已在手（模型输出），换新会话继续，不让 worker 无限变长。
      await chrome.tabs.update(job.tabId, { url: CHAT_HOME });
      job.workerSessionId = null;
      job.workerChars = 0;
      await new Promise(r => setTimeout(r, 1200));
    }
    await waitTransportReady(job.tabId);
    const result = await nativeSendAndObserve({ tabId: job.tabId, content: prompt });
    if (result.targetSessionId) job.workerSessionId = result.targetSessionId;
    job.workerChars += prompt.length + (result.observation?.sse?.length || 0);
    if (!result.ok) {
      return { ok: false, errorClass: result.outcome?.type || 'UNKNOWN', detail: result.outcome?.detail || 'worker 调用失败' };
    }
    let response = '';
    try { response = replayStream(result.observation.sse || '').response || ''; } catch { response = ''; }
    return { ok: true, response, workerSessionId: job.workerSessionId, workerChars: job.workerChars };
  } finally {
    job.busy = false;
  }
}
