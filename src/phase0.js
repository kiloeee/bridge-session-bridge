// Phase 0 is local measurement and verbatim export. No model request or trimming.
export const CAPACITY_GROUPS = ['REQUEST', 'RESPONSE', 'THINK', 'SEARCH', 'TOOL', 'TIP', 'FILE', 'OTHER'];

// Unicode code points, not tokens, bytes, grapheme clusters, or UTF-16 units.
export function countChars(text) {
  let count = 0;
  for (const _ of typeof text === 'string' ? text : '') count++;
  return count;
}

const idOf = value => value == null ? null : String(value);
const fragmentsOf = message => Array.isArray(message.fragments) ? message.fragments : [];
const isContent = fragment => typeof fragment.content === 'string';

export function messagesForSnapshot(session, storedMessages) {
  if (!Array.isArray(session.snapshotMessageIds)) throw new Error('这份存档来自旧版本，请重新读取当前页快照。');
  const ids = session.snapshotMessageIds.map(String);
  const byId = new Map(storedMessages.map(message => [String(message.messageId), message]));
  const messages = ids.map(id => byId.get(id));
  if (new Set(ids).size !== ids.length || messages.some(message => !message) || messages.length !== session.messageCount) {
    throw new Error('本次快照消息条数不一致，请重新读取当前页快照。');
  }
  return messages;
}

function groupOf(type = '') {
  if (CAPACITY_GROUPS.includes(type)) return type;
  // TOOL_SEARCH belongs to TOOL; SEARCH remains its own fragment family.
  if (type.startsWith('TOOL_')) return 'TOOL';
  if (type.startsWith('SEARCH_')) return 'SEARCH';
  if (type.startsWith('FILE_')) return 'FILE';
  return 'OTHER';
}

function timestamp(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : (Date.parse(value) || 0) / 1000;
  }
  return 0;
}

// Follow one parent chain. Sorting all messages would mix regenerated replies.
export function selectBranch(session, messages) {
  const byId = new Map(messages.map(message => [idOf(message.messageId), message]));
  const parents = new Set(messages.map(message => idOf(message.parentId)).filter(id => byId.has(id)));
  const leaves = messages.filter(message => !parents.has(idOf(message.messageId)));
  const currentId = idOf(session?.currentMessageId);
  let chosen = byId.get(currentId);
  const inferred = !chosen;
  const warnings = [];
  if (inferred) warnings.push(currentId == null
    ? '快照缺少 current_message_id，不能确认页面当前分支；以下路径只是最新叶子推断。'
    : `快照没有 current_message_id 指向的 #${currentId}，不能确认页面当前分支；以下路径只是最新叶子推断。`);
  if (!chosen) {
    const candidates = leaves.length ? leaves : messages;
    chosen = [...candidates].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)
      || (Number(b.messageId) || 0) - (Number(a.messageId) || 0)).at(0);
  }
  const reversed = [];
  const seen = new Set();
  let cursor = chosen;
  while (cursor) {
    const id = idOf(cursor.messageId);
    if (seen.has(id)) { warnings.push(`父链有循环，已停止于 #${id}，原文可能不完整。`); break; }
    seen.add(id);
    reversed.push(cursor);
    const parent = idOf(cursor.parentId);
    if (parent == null || parent === '0') break;
    cursor = byId.get(parent);
    if (!cursor) warnings.push(`缺少父消息 #${parent}，当前存档不足以保证完整前文。`);
  }
  const siblingCounts = new Map();
  for (const message of messages) {
    const parent = idOf(message.parentId);
    siblingCounts.set(parent, (siblingCounts.get(parent) || 0) + 1);
  }
  return {
    messages: reversed.reverse(),
    selectedMessageId: chosen?.messageId ?? null,
    inferred,
    leafCount: leaves.length,
    forkCount: [...siblingCounts.values()].filter(count => count > 1).length,
    excludedMessages: messages.length - reversed.length,
    warnings,
  };
}

function measureFragments(messages) {
  const groups = Object.fromEntries(CAPACITY_GROUPS.map(group => [group, { fragments: 0, chars: 0 }]));
  const types = {};
  let nonTextContents = 0;
  for (const message of messages) for (const fragment of fragmentsOf(message)) {
    const type = typeof fragment.type === 'string' ? fragment.type : '(missing type)';
    const chars = isContent(fragment) ? countChars(fragment.content) : 0;
    const group = groups[groupOf(type)];
    group.fragments++;
    group.chars += chars;
    const exact = types[type] || (types[type] = { fragments: 0, chars: 0 });
    exact.fragments++;
    exact.chars += chars;
    if (Object.hasOwn(fragment, 'content') && !isContent(fragment)) nonTextContents++;
  }
  return {
    groups, types, nonTextContents,
    allFragmentChars: Object.values(groups).reduce((sum, group) => sum + group.chars, 0),
    cleanTextChars: groups.REQUEST.chars + groups.RESPONSE.chars,
  };
}

function cleanEntries(messages) {
  const entries = [];
  for (const message of messages) {
    let pending = null;
    for (const fragment of fragmentsOf(message)) {
      if (!['REQUEST', 'RESPONSE'].includes(fragment.type) || !isContent(fragment)) continue;
      const role = fragment.type === 'REQUEST' ? 'user' : 'assistant';
      if (pending?.role === role) pending.text += fragment.content;
      else {
        pending = { role, messageId: message.messageId, text: fragment.content };
        entries.push(pending);
      }
    }
  }
  return entries;
}

function splitTurns(messages) {
  const turns = [];
  let current = null;
  let unpairedAssistantChars = 0;
  for (const message of messages) {
    // A file-only USER message still starts a turn, even with zero clean text.
    if (String(message.role || '').toUpperCase() === 'USER'
      || fragmentsOf(message).some(fragment => fragment.type === 'REQUEST')) {
      current = []; turns.push(current);
    }
    for (const entry of cleanEntries([message])) {
      if (current) current.push(entry);
      else unpairedAssistantChars += countChars(entry.text);
    }
  }
  return { turns, unpairedAssistantChars };
}

export function analyzeCapacity(session, messages) {
  const branch = selectBranch(session, messages);
  const selected = measureFragments(branch.messages);
  const allStored = measureFragments(messages);
  const entries = cleanEntries(branch.messages);
  const { turns, unpairedAssistantChars } = splitTurns(branch.messages);
  const snapshot = { session, messages: branch.messages };
  const withoutContents = {
    session,
    messages: branch.messages.map(message => ({ ...message,
      fragments: fragmentsOf(message).map(fragment => ({ ...fragment,
        ...(isContent(fragment) ? { content: '' } : {}),
      })),
    })),
  };
  const normalizedJsonChars = countChars(JSON.stringify(snapshot));
  const otherJsonChars = countChars(JSON.stringify(withoutContents));
  const latestUser = [...branch.messages].reverse().find(message => String(message.role || '').toUpperCase() === 'USER'
    || fragmentsOf(message).some(fragment => fragment.type === 'REQUEST'));
  return {
    branch, selected, allStored, entries,
    cleanRatio: selected.allFragmentChars ? selected.cleanTextChars / selected.allFragmentChars : null,
    normalizedJsonChars, otherJsonChars,
    encodedContentJsonChars: normalizedJsonChars - otherJsonChars,
    totalTurns: turns.length,
    unpairedAssistantChars,
    latestUser: latestUser ? {
      messageId: latestUser.messageId,
      bodyChars: fragmentsOf(latestUser).filter(fragment => fragment.type === 'REQUEST' && isContent(fragment))
        .reduce((sum, fragment) => sum + countChars(fragment.content), 0),
    } : null,
    recentTurns: [10, 20, 40].map(limit => ({
      limit,
      turns: Math.min(limit, turns.length),
      chars: turns.slice(-limit).flat().reduce((sum, entry) => sum + countChars(entry.text), 0),
    })),
  };
}

function assertExactText(analysis) {
  const { branch } = analysis;
  if (branch.messages.some(message => fragmentsOf(message).some(fragment =>
    ['REQUEST', 'RESPONSE'].includes(fragment.type) && !isContent(fragment)))) {
    throw new Error('REQUEST / RESPONSE 含非字符串 content，无法保证逐字正文原文，已停止导出。');
  }
}

function renderTranscript(session, analysis, entries, scope) {
  const { branch } = analysis;
  const out = [`# ${session.title || session.sessionId}`, '',
    `会话：${session.sessionId}`,
    `路径：${branch.inferred ? '最新叶子推断' : 'current_message_id'} → #${branch.selectedMessageId}`,
    `范围：${scope}；未摘要、未改写。`,
    '不含 THINK、搜索、工具、提示、文件载荷、TEMPLATE_RESPONSE 等其他 fragment；兄弟分支未拼入正文。',
    ...branch.warnings.map(warning => `注意：${warning}`), ''];
  for (const entry of entries) out.push(`## ${entry.role === 'user' ? '用户' : '助手'} #${entry.messageId}`, '', entry.text, '');
  return out.join('\n');
}

export function buildCleanTranscript(session, analysis) {
  assertExactText(analysis);
  return renderTranscript(session, analysis, analysis.entries, '此路径全部 REQUEST / RESPONSE 原文，未按预算裁剪');
}

export function buildRecentExact(session, analysis, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Recent Exact 轮数必须是正整数。');
  assertExactText(analysis);
  const { turns } = splitTurns(analysis.branch.messages);
  return renderTranscript(session, analysis, turns.slice(-limit).flat(),
    `此路径最近 ${limit} turns（实际 ${Math.min(limit, turns.length)}）的 REQUEST / RESPONSE 原文；这是独立近期摘录，不能代替全量正文`);
}

// 迁移 framing：这只是同一段对话换了个窗口继续，不是新资料。首尾各说一次，
// 因为超长粘贴在 DeepSeek 页面可能被收成附件卡片，只看开头的说明不够稳。
const migrationPrologue = [
  '【会话接续】',
  '',
  '下面的内容属于你与用户正在进行的同一段对话，是上一窗口中真实发生的对话上下文。',
  '',
  '请把它直接视为你已经参与过、并紧接当前时刻之前发生的对话，而不是参考资料、附件内容或需要总结的历史记录。',
  '',
  '不要：',
  '- 确认“已读取 / 已了解历史”',
  '- 提及窗口切换、迁移、存档、附件或这段说明',
  '- 主动总结、复述此前内容',
  '',
  '请直接从最后一轮对话继续，像窗口从未中断一样自然回应用户。',
  '',
  '【此前对话开始】',
].join('\n');

const migrationEpilogue = [
  '【此前对话结束】',
  '',
  '请直接继续最后一轮用户消息。',
  '不要解释或确认以上上下文，不要提及迁移本身。',
].join('\n');

function packetText(body, index, total) {
  return `【会话接续】历史片段 ${index}/${total}\n以下是你与用户已经发生过的同一段对话的片段，请按顺序读取。\n<<<片段>>>\n${body}\n<<<片段结束>>>\n${index === total ? '全部分段已结束。请直接从最近一轮用户消息继续，不要复述、不要确认已读取这些历史。' : '请等待下一段，无需展开回复。'}`;
}

// A caller's character budget is a local packaging constraint, never a Web limit.
// No budget means one full exact packet. Splitting preserves every code point.
export function buildExactPackets(transcript, { maxChars = null } = {}) {
  if (typeof transcript !== 'string') throw new Error('分包输入必须是文本。');
  if (maxChars != null && (!Number.isSafeInteger(maxChars) || maxChars < 1)) {
    throw new Error('分包字符预算必须是正整数，或留空使用完整原文。');
  }
  const fullChars = countChars(transcript);
  if (maxChars == null || fullChars <= maxChars) return {
    mode: 'full', fullChars, maxChars,
    packets: [{ index: 1, total: 1, body: transcript, text: transcript, chars: fullChars }],
  };
  const points = Array.from(transcript);
  const largestIndex = '9'.repeat(String(fullChars).length);
  const overhead = countChars(packetText('', largestIndex, largestIndex));
  const bodyBudget = maxChars - overhead;
  if (bodyBudget < 1) throw new Error(`分包预算不足以容纳说明和原文，至少需要 ${overhead + 1} 字符。`);
  const total = Math.ceil(fullChars / bodyBudget);
  const packets = [];
  for (let start = 0; start < points.length; start += bodyBudget) {
    const body = points.slice(start, start + bodyBudget).join('');
    const index = packets.length + 1;
    const text = packetText(body, index, total);
    packets.push({ index, total, body, text, chars: countChars(text) });
  }
  return { mode: 'packetized', fullChars, maxChars, packets };
}

export function buildForgePackage(session, messages, { recentTurns = 20, maxChars = null } = {}) {
  const analysis = analyzeCapacity(session, messages);
  const cleanExact = buildCleanTranscript(session, analysis);
  const fullExact = `${migrationPrologue}\n\n${cleanExact}\n\n${migrationEpilogue}`;
  return {
    app: 'deepseek-session-forge', version: 1, exportedAt: Date.now(),
    strategy: 'FULL_EXACT_FIRST',
    archive: { session, messages },
    cleanExact, fullExact,
    recentExact: buildRecentExact(session, analysis, recentTurns), recentTurns,
    packetPlan: buildExactPackets(fullExact, { maxChars }),
    capacityReport: formatCapacityReport(session, analysis),
    // Reserved for a future evidence-driven compression stage; no model call here.
    olderHistoryCompression: null,
    limitations: ['原文范围为当前父链全部 REQUEST / RESPONSE 字符串；其他 fragment 与附件保存在 archive 中，未转成迁移正文。',
      '分包不能证明或扩大 DeepSeek Web 的实际上下文容量。',
      '这是历史文本注入，不能还原服务器的旧消息角色或模型内部状态。'],
  };
}

export function formatCapacityReport(session, analysis) {
  const { branch, selected, allStored } = analysis;
  const number = value => value.toLocaleString('zh-CN');
  const out = [`Phase 0 容量报告 · ${session.title || session.sessionId}`, '',
    `服务器快照读取时间：${session.snapshotCapturedAt ? new Date(session.snapshotCapturedAt).toLocaleString('zh-CN') : '未记录（fixture / 历史版本）'}`,
    `路径：${branch.inferred ? '最新叶子推断（不是已确认的页面当前分支）' : '会话 current_message_id'} → #${branch.selectedMessageId}`,
    `当前路径 ${branch.messages.length} 条消息；本次快照共 ${branch.messages.length + branch.excludedMessages} 条；排除 ${branch.excludedMessages} 条其他路径消息。`,
    `分叉父节点 ${branch.forkCount} 个；叶子 ${branch.leafCount} 个。迁移正文沿父链，不串联兄弟分支。`,
    ...branch.warnings.map(warning => `注意：${warning}`), '',
    '字符口径：fragment.content 字符串的 Unicode 码点数；不是 token 或字节。',
    `当前路径全部 fragment 正文：${number(selected.allFragmentChars)} 字符`,
    `仅 REQUEST + RESPONSE clean text：${number(selected.cleanTextChars)} 字符`,
    `清洗后保留比例：${analysis.cleanRatio == null ? '无正文，不能计算' : (analysis.cleanRatio * 100).toFixed(2) + '%'}`,
    `排除其他 fragment 字符比例：${analysis.cleanRatio == null ? '无正文，不能计算' : ((1 - analysis.cleanRatio) * 100).toFixed(2) + '%'}`, '',
    '分组（content 字符串；空载荷也计 fragment 数）：', '类型: 当前路径字符 / 本次快照全部字符（含其他分支）'];
  for (const group of CAPACITY_GROUPS) out.push(`${group}: ${number(selected.groups[group].chars)} / ${number(allStored.groups[group].chars)} 字符；当前路径 ${selected.groups[group].fragments} fragments`);
  out.push('', '原始类型明细（TOOL_SEARCH 等归 TOOL；SEARCH 独立）：');
  for (const [type, value] of Object.entries(selected.types)) out.push(`${type}: ${number(value.chars)} 字符 / ${value.fragments} fragments`);
  out.push('', `本次快照所有节点（含其他分支）fragment 正文：${number(allStored.allFragmentChars)} 字符`,
    `其中 REQUEST + RESPONSE：${number(allStored.cleanTextChars)} 字符。该总数不是迁移路径长度。`, '',
    `当前路径共 ${analysis.totalTurns} turns；1 turn = 一次用户消息及后续助手消息，至下一次用户消息。`);
  for (const recent of analysis.recentTurns) out.push(`最近 ${recent.limit} turns（实际 ${recent.turns}）：${number(recent.chars)} clean text 字符`);
  if (analysis.unpairedAssistantChars) out.push(`开头无对应用户的助手正文：${number(analysis.unpairedAssistantChars)} 字符；不计入最近 turns。`);
  out.push('', '自然 App 消息核对线索（尚未核对，不表示 PASS）：', analysis.latestUser
    ? `当前路径最末用户消息：#${analysis.latestUser.messageId}；REQUEST 正文 ${number(analysis.latestUser.bodyChars)} 字符。`
    : '当前路径没有用户消息。');
  try {
    out.push(`实际 clean.txt 全文（含说明、角色标签、分隔符）：${number(countChars(buildCleanTranscript(session, analysis)))} 字符。`);
  } catch (err) { out.push(`clean.txt 当前不能逐字导出：${err.message}`); }
  out.push('', 'JSON 数量另算（当前路径的本地规范化快照，不是服务端原始响应）：',
    `紧凑 JSON 序列化总量：${number(analysis.normalizedJsonChars)} 字符`,
    `清空字符串 content 后的其他字段＋JSON 结构：${number(analysis.otherJsonChars)} 字符`,
    `content 的 JSON 编码增量：${number(analysis.encodedContentJsonChars)} 字符（含转义膨胀）`,
    '其他字段含 session/message metadata、搜索 results、工具 result、文件字段等；不能称为纯正文，也不一定只是 metadata。',
    'clean text 正文字数不含导出标题、角色标签和分隔符；实际发送全文体积见上方 clean.txt 全文字符量。',
    '完整正文导出只保留上述单一路径的 REQUEST / RESPONSE，原文不截断。');
  if (selected.nonTextContents) out.push(`注意：${selected.nonTextContents} 个 content 不是字符串；已保留在存档，但未当作文本统计或导出。`);
  return out.join('\n');
}
