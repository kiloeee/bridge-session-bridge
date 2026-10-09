// WebForgeProvider：无 API Key 用户用「登录中的 DeepSeek 网页」跑 Forge。
// 与 forge-provider.js（ApiForgeProvider）遵守同一份 forge.js 合同：
// model(payload) → {continuity} | {important_message_ids}。
// 这里只负责两件纯事：把 payload 渲染成网页 prompt、把 RESPONSE 文本解析回 JSON。
// 真正的发送/等待/观察由 background 的 worker 会话管理完成（经 call 注入）。

export function renderForgePrompt(payload) {
  const task = payload?.task === 'important' ? 'important' : 'roll';
  const header = task === 'important'
    ? [
      '你在协助维护一份跨窗口延续用的对话状态整理。下面给你一份对话数据。',
      '你的唯一任务：从整段对话里挑出对后续对话仍然重要、值得逐字保留的消息 id。',
      '规则：',
      '- 只返回真实存在的 message_id，不得改写或复述正文，不得返回正文文本。',
      '- 宁可少而准：最近的消息已经单独保留，不要把它们重复标成重要。',
      '',
      '只输出一个 JSON 对象，格式：{"important_message_ids": ["消息id"]}，不要输出任何其他文字或代码块标记。',
    ]
    : [
      '你在协助维护一份跨窗口延续用的「持续状态」。这是状态更新，不是摘要。',
      '规则：',
      '- 就地更新/取代/解决/作废已有条目，而不是每块都追加新条目；语义重复的条目合并，source_message_ids 取并集。',
      '- 新条目只能引用 previous_continuity 或本块 messages 里真实存在的 id，不得凭空捏造。',
      '- 不要写普通摘要，不要按时间顺序复述对话，不要把猜测写成事实。',
      '- 未被新证据推翻的长期状态必须保留。',
      '- 另外，在本块里挑出最多 2 条最值得逐字保留的消息，放进同一份 JSON 的 "important_message_ids"（只能给本块真实存在的 id，宁少勿多，可以给 0 条）。',
      '',
      '只输出一个 JSON 对象，格式：{"continuity": {"identity": [...], "stableFacts": [...], "activeThreads": [...], "decisions": [...], "openLoops": [...], "recentChanges": [...], "interactionPreferences": [...]}, "important_message_ids": [...]}，',
      '每个字段是数组，每条形如 {"state": "一句话状态", "source_message_ids": ["消息id"]}。不要输出任何其他文字或代码块标记。',
    ];
  const body = task === 'important'
    ? JSON.stringify({ continuity: payload.continuity, messages: payload.messages, max_important: payload.max_important })
    : JSON.stringify({ previous_continuity: payload.previous_continuity, messages: payload.messages });
  return [...header, '', '【数据开始】', body, '【数据结束】'].join('\n');
}

// RESPONSE 文本 → JSON 对象。容忍 ```json 围栏和前后闲话；形状不合返回 null。
export function extractModelJson(text, task) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  let candidate = raw.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  candidate = candidate.slice(start, end + 1);
  let data;
  try { data = JSON.parse(candidate); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (task === 'important') return Array.isArray(data.important_message_ids) ? data : null;
  return data.continuity && typeof data.continuity === 'object' && !Array.isArray(data.continuity) ? data : null;
}

// call({prompt, task}) → {ok, response} | {ok:false, errorClass, detail}（由 background 实现）。
// 返回 forge.js 期望的 model(payload)。解析失败只重试一次，与 API provider 行为一致。
export function createWebForgeModel({ call }) {
  if (typeof call !== 'function') throw new Error('createWebForgeModel 需要一个 call 函数。');
  return async payload => {
    const task = payload?.task === 'important' ? 'important' : 'roll';
    const prompt = renderForgePrompt(payload);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call({ prompt, task, payload });
      if (!result?.ok) {
        const err = new Error(result?.detail || 'Web Forge 调用失败。');
        err.errorClass = result?.errorClass || 'UNKNOWN';
        throw err;
      }
      const parsed = extractModelJson(result.response, task);
      if (parsed) return parsed;
      // JSON 解析失败重试一次；网络类错误直接抛出（由 runner 决定重试策略）。
    }
    const err = new Error('Web Forge 这次没有生成有效结果，请重试。');
    err.errorClass = 'UNKNOWN';
    throw err;
  };
}

// Web Forge job 的 checkpoint 结构与推进逻辑（sidepanel runner 与测试共用）。
// checkpoint 存 chrome.storage.local（durable）：continuity / importantCandidates / processed 都是 id 级，
// 绝不存正文。pendingRequest 是「防重复发送」的关键——一次向 DeepSeek 网页发出请求之前先落盘，
// 结果持久化后再清除。SW 或浏览器重启后据此判断在途请求，绝不盲目重发。
export function initialForgeJob({ sourceSessionId, chunkChars, snapshotFingerprint = null }) {
  return {
    jobId: `webforge-${sourceSessionId}-${Date.now().toString(36)}`,
    sourceSessionId,
    chunkChars,
    snapshotFingerprint,
    // running | paused_filter | paused_rate_limit | paused_uncertain | assembled | sending | done | failed
    status: 'running',
    processedMessageIds: [],
    continuity: null,
    chunkIndex: 0,
    chunkCount: 0,
    importantCandidates: [], // [{ id, chunkIndex, fromModel }]，恢复时带回，绝不只留 continuity 而丢 important
    importantMessageIds: [],
    workerSessions: [], // { sessionId, chunkRange, rotatedAt }
    pendingRequest: null, // { chunkIndex, task, promptFingerprint, workerSessionId, tabId, stage, at }
    sentRunId: null, // 最终 Native Transport 成功后才写；用于区分「整理完成」与「迁移完成」
    updatedAt: Date.now(),
  };
}

// 旧 checkpoint（v0.4.1）没有 importantCandidates，只有 importantMessageIds 与可能已完成的 continuity。
// 恢复时按 id 回填候选，宁可复用已付出的整理结果，也绝不全部清空后重新收费。
function legacyCandidatesFrom(job) {
  return (job.importantMessageIds || []).map(id => ({ id: String(id), chunkIndex: 0, fromModel: true }));
}

// 从 checkpoint 恢复：只喂未处理的 entries，continuity 与重要候选都用已保存状态。
export function resumeForgeInput(job, entries) {
  const done = new Set((job.processedMessageIds || []).map(String));
  const remaining = entries.filter(entry => !done.has(String(entry.messageId)));
  const previousCandidates = Array.isArray(job.importantCandidates)
    ? job.importantCandidates
    : legacyCandidatesFrom(job);
  return {
    remaining,
    previousContinuity: job.continuity || null,
    previousCandidates,
    resumedFromChunk: job.chunkIndex || 0,
  };
}
