// Generational Forge：把「更早的历史」压成一份 Continuity State，与 Important Exact、
// Recent Exact 一起带进下一代 Session。纯函数、无网络、无 Chrome 依赖。
// 语义模型调用由外部注入（forge-cli 接本地 companion），扩展本身不发任何模型请求。

import { countChars, buildRecentExact } from './phase0.js';

// §6 固定 schema。连续性不允许自由作文：字段固定，每条都带 source_message_ids。
export const CONTINUITY_FIELDS = [
  ['identity', '身份与关系'],
  ['stableFacts', '长期事实'],
  ['activeThreads', '进行中的事项'],
  ['decisions', '决定与承诺'],
  ['openLoops', '未结事项'],
  ['recentChanges', '最近变化'],
  ['interactionPreferences', '交流偏好'],
];
const FIELD_KEYS = CONTINUITY_FIELDS.map(([key]) => key);

// 本地确定性预算，不是 DeepSeek 网页上限。
export const DEFAULT_CHUNK_CHARS = 12000;
export const DEFAULT_MAX_IMPORTANT = 12;
// Continuity 的本地结构预算：每字段最多保留多少条。可调，不是产品常量，
// 也不代表任何容量上限——它唯一的职责是让 Continuity 与原文长度解耦（见 boundContinuity）。
export const DEFAULT_MAX_ITEMS_PER_FIELD = 12;

// §4 统一 updater 合同。engine 保持无网络、无厂商依赖，但所有 backend
// （DeepSeek API / 本地模型 / 任何 OpenAI-compatible）都必须服从同一语义，
// 否则每个 backend 会把「Forge」理解成普通摘要，结果发散。
export const FORGE_UPDATER_CONTRACT = Object.freeze({
  task: 'roll',
  purpose: '把 previous_continuity 更新为「当前仍有效的状态」，并吸收当前 chunk 的新证据。',
  input: Object.freeze(['previous_continuity', 'messages（当前 chronological chunk，只有本块）']),
  output: '固定 schema（CONTINUITY_FIELDS），每条 {state, source_message_ids}；可选 important_message_ids',
  required: Object.freeze([
    '更新 / 取代 / 解决 / 作废已有条目时，就地修改该条目的 state，而不是再追加一条',
    '合并语义重复的条目，source_message_ids 取并集',
    '新条目必须给出真实存在的 source_message_ids，只能引用 previous_continuity 或当前 chunk 中的 id',
    '未被新证据推翻的长期状态必须保留',
  ]),
  forbidden: Object.freeze([
    '普通摘要 / 按时间顺序复述整个对话',
    '无脑追加：每块都新增一条，却不更新旧条目',
    '把猜测、推断升级成事实陈述',
    '保留已被新证据明确推翻、或已完成 / 已失效的旧状态',
    '引用不存在或凭空捏造的 source_message_ids',
  ]),
});

// 重要原文选择合同：模型只挑 id，正文由程序读取，模型不得改写。
export const FORGE_IMPORTANT_CONTRACT = Object.freeze({
  task: 'important',
  purpose: '从整段 clean entries 里挑出对后续对话仍然重要、值得逐字保留的 message。',
  required: Object.freeze(['只返回已存在的 message_id，不得改写或复述正文', '宁可少而准，也不要把整段历史全部标成重要']),
  forbidden: Object.freeze(['返回不存在的 id', '返回正文文本', '把 Recent Exact 已覆盖的最近消息重复标为重要']),
});

export const DEFAULT_FRAMING = [
  '【会话接续】',
  '',
  '下面是同一段持续对话在上一窗口结束时保留下来的上下文。',
  '其中包含持续状态、关键原话和最近完整对话。',
  '',
  '这些内容描述的是你与用户已经共同经历过的对话上下文，',
  '不是需要评论、总结或确认阅读的资料。',
  '',
  '请直接把它作为当前对话状态继续使用。',
  '不要提及迁移、压缩、历史记录、附件或本说明。',
  '不要回复“已了解背景/历史”。',
  '直接接着最近一轮用户消息继续。',
].join('\n');

// 结尾再说一次，离模型实际生成位置最近；长粘贴被收成附件后开头说明未必还在模型视野里。
export const DEFAULT_OUTRO = [
  '【接续】',
  '直接继续最近一轮用户消息，不要确认以上上下文。',
].join('\n');

// 给模型的 schema 骨架，避免它自由发挥字段。
export function schemaSkeleton() {
  const item = { state: '一句话状态', source_message_ids: ['m..'] };
  return JSON.stringify(Object.fromEntries(CONTINUITY_FIELDS.map(([key]) => [key, [item]])), null, 2);
}

export function emptyContinuity() {
  return Object.fromEntries(FIELD_KEYS.map(key => [key, []]));
}

const isItem = value => value && typeof value === 'object'
  && typeof value.state === 'string' && value.state.trim()
  && Array.isArray(value.source_message_ids);

// 结构校验：字段缺失按空数组，未知字段忽略；条目形状不对直接报错。
export function validateContinuity(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Continuity 必须是对象。');
  const out = {};
  for (const key of FIELD_KEYS) {
    const list = state[key] ?? [];
    if (!Array.isArray(list)) throw new Error(`Continuity.${key} 必须是数组。`);
    out[key] = list.map(item => {
      if (!isItem(item)) throw new Error(`Continuity.${key} 的条目必须是 {state, source_message_ids}。`);
      return { state: item.state, source_message_ids: item.source_message_ids.map(String) };
    });
  }
  return out;
}

// §6：模型给的 source id 必须由程序校验。不存在的 ID 一律剔除（strict 时直接拒绝），
// 绝不静默接受 hallucinated source IDs。条目若不含任何有效来源则整条丢弃。
export function sanitizeContinuity(state, allowedIds, { strict = false } = {}) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set([...allowedIds].map(String));
  const rejectedSourceIds = [];
  let droppedItems = 0;
  const clean = {};
  for (const key of FIELD_KEYS) {
    const items = [];
    for (const item of state[key]) {
      const kept = [];
      for (const id of item.source_message_ids) {
        if (allowed.has(id)) kept.push(id);
        else { rejectedSourceIds.push(id); if (strict) throw new Error(`Continuity 引用了不存在的 message_id：${id}`); }
      }
      if (kept.length) items.push({ state: item.state, source_message_ids: kept });
      else droppedItems++;
    }
    clean[key] = items;
  }
  return { state: clean, rejectedSourceIds, droppedItems };
}

// §8 Continuity 有界：rolling 必须是真正的状态更新，而不是 append-summary。
// 模型在合同下负责「取代 / 解决 / 作废」，这里做两件确定性的兜底，保证
// 「Continuity 大小与原文字数无关」这个 invariant 不依赖模型守规矩：
//   1) semantic dedupe —— 同一字段内 state 文本归一化后相同的条目合并（source 取并集）
//   2) 每字段条数上限 —— 超出则保留最新（rolling 中最新状态写在末尾）
const normalizeState = text => text.trim().replace(/\s+/g, ' ');

export function dedupeContinuity(state) {
  const out = {};
  let mergedItems = 0;
  for (const key of FIELD_KEYS) {
    const seen = new Map();
    const list = [];
    for (const item of state[key]) {
      const norm = normalizeState(item.state);
      const existing = seen.get(norm);
      if (existing) {
        for (const id of item.source_message_ids) if (!existing.source_message_ids.includes(id)) existing.source_message_ids.push(id);
        mergedItems++;
      } else {
        const copy = { state: item.state, source_message_ids: [...item.source_message_ids] };
        seen.set(norm, copy);
        list.push(copy);
      }
    }
    out[key] = list;
  }
  return { state: out, mergedItems };
}

// 淘汰方向不能全字段统一 FIFO：长期状态（身份/关系/稳定事实/决定/偏好）里最早建立的条目
// 往往最经久、最重要，keep-latest 会把「用户是谁」这类根状态误删。短期状态则相反，
// 只有最新才有意义。所以按字段语义定向保留。
export const FIELD_RETENTION = Object.freeze({
  identity: 'oldest', stableFacts: 'oldest', decisions: 'oldest', interactionPreferences: 'oldest',
  activeThreads: 'newest', openLoops: 'newest', recentChanges: 'newest',
});

export function boundContinuity(state, { maxItemsPerField = DEFAULT_MAX_ITEMS_PER_FIELD, retention = FIELD_RETENTION } = {}) {
  if (!Number.isSafeInteger(maxItemsPerField) || maxItemsPerField < 1) throw new Error('每字段条数上限必须是正整数。');
  const { state: deduped, mergedItems } = dedupeContinuity(state);
  const out = {};
  let evictedItems = 0;
  for (const key of FIELD_KEYS) {
    const list = deduped[key];
    if (list.length <= maxItemsPerField) { out[key] = list; continue; }
    evictedItems += list.length - maxItemsPerField;
    out[key] = retention[key] === 'oldest' ? list.slice(0, maxItemsPerField) : list.slice(-maxItemsPerField);
  }
  return { state: out, mergedItems, evictedItems };
}

// §5 chronological chunker：不得拆开单条 message、不得改变顺序、保留 messageId/role。
// 单条超过预算时只能自成一块——绝不切割 message。
export function chunkEntries(entries, { maxChars = DEFAULT_CHUNK_CHARS } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('分块预算必须是正整数。');
  const chunks = [];
  let current = { index: 0, entries: [], chars: 0, oversize: false };
  for (const entry of entries) {
    const size = countChars(entry.text);
    if (current.entries.length && current.chars + size > maxChars) {
      chunks.push(current);
      current = { index: 0, entries: [], chars: 0, oversize: false };
    }
    current.entries.push(entry);
    current.chars += size;
    if (size > maxChars) current.oversize = true;
  }
  if (current.entries.length) chunks.push(current);
  chunks.forEach((chunk, i) => { chunk.index = i + 1; });
  return chunks;
}

const publicEntry = entry => ({ messageId: String(entry.messageId), role: entry.role, content: entry.text });

// §9：模型只返回重要 message 的 id，exact 文本由程序从（canonical archive 派生的）clean
// entries 读取，模型不得改写原文。不存在的 id 被拒绝/剔除。
export function importantExact(entries, ids, { strict = false } = {}) {
  const byId = new Map(entries.map(entry => [String(entry.messageId), entry]));
  const items = [], unknownIds = [], seen = new Set();
  for (const raw of ids || []) {
    const id = String(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) { unknownIds.push(id); if (strict) throw new Error(`Important Exact 引用了不存在的 message_id：${id}`); continue; }
    items.push({ messageId: id, role: entry.role, content: entry.text });
  }
  return { items, unknownIds };
}

// §7 Rolling Forge + §8 Generational Forge：State[n+1] = update(State[n], Chunk[n])。
// 每轮模型只看到 previous state + 当前 chunk，绝不重发前面全部原文。
// 证据域（allowed）＝ 上一代 continuity 已验证的 source refs ∪ 本代已处理过的 id ∪ 当前 chunk 的 id。
// 关键：上一代 continuity 的 id 指向上游 Session，对本代仍然有效，绝不能因为「不在本代 messages 里」而被剔除。
export async function rollupForge({
  entries, previousContinuity = null, model,
  chunkChars = DEFAULT_CHUNK_CHARS, maxImportant = DEFAULT_MAX_IMPORTANT,
  maxItemsPerField = DEFAULT_MAX_ITEMS_PER_FIELD, strict = false, onChunk = null,
}) {
  if (typeof model !== 'function') throw new Error('rollupForge 需要一个 model 函数。');
  if (!Array.isArray(entries)) throw new Error('rollupForge 需要 clean entries 数组。');
  const chunks = chunkEntries(entries, { maxChars: chunkChars });
  let state = previousContinuity ? validateContinuity(previousContinuity) : emptyContinuity();
  const carriedIds = new Set();
  for (const key of FIELD_KEYS) for (const item of state[key]) for (const id of item.source_message_ids) carriedIds.add(id);
  const rejectedSourceIds = [];
  let droppedItems = 0, mergedItems = 0, evictedItems = 0;
  const processed = new Set();
  for (const chunk of chunks) {
    const response = await model({
      task: 'roll',
      chunk_index: chunk.index,
      chunk_count: chunks.length,
      previous_continuity: state,
      messages: chunk.entries.map(publicEntry),
      schema: schemaSkeleton(),
      contract: FORGE_UPDATER_CONTRACT,
    });
    const next = validateContinuity(response?.continuity);
    const allowed = new Set([...carriedIds, ...processed]);
    for (const entry of chunk.entries) allowed.add(String(entry.messageId));
    const cleaned = sanitizeContinuity(next, allowed, { strict });
    rejectedSourceIds.push(...cleaned.rejectedSourceIds);
    droppedItems += cleaned.droppedItems;
    const bounded = boundContinuity(cleaned.state, { maxItemsPerField });
    mergedItems += bounded.mergedItems;
    evictedItems += bounded.evictedItems;
    state = bounded.state;
    for (const entry of chunk.entries) processed.add(String(entry.messageId));
    // checkpoint 回调（可选，additive）：每块处理完交出当前状态，供 Web Forge 断点续跑。
    // 不改变任何引擎语义；回调自身抛错视为致命（调用方自包裹）。
    if (onChunk) await onChunk({ chunkIndex: chunk.index, chunkCount: chunks.length, continuity: state, processedMessageIds: [...processed].map(String) });
  }
  const selection = await model({
    task: 'important',
    continuity: state,
    messages: entries.map(publicEntry),
    max_important: maxImportant,
    contract: FORGE_IMPORTANT_CONTRACT,
  });
  const { items, unknownIds } = importantExact(entries, selection?.important_message_ids, { strict });
  return {
    continuity: state,
    importantMessageIds: items.map(item => item.messageId),
    importantExact: items,
    chunks: chunks.length,
    diagnostics: { rejectedSourceIds, droppedItems, mergedItems, evictedItems, unknownImportantIds: unknownIds },
  };
}

function renderContinuity(state) {
  const lines = [];
  for (const [key, label] of CONTINUITY_FIELDS) {
    const items = state[key];
    if (!items.length) continue;
    lines.push(`## ${label}`);
    for (const item of items) lines.push(`- ${item.state}（来源 #${item.source_message_ids.join(', #')}）`);
  }
  return lines.length ? lines.join('\n') : '（尚未建立连续性状态）';
}

const renderExactItem = item => `## ${item.role === 'user' ? '用户' : '助手'} #${item.messageId}\n\n${item.content}`;

// §11 Final Forge Packet：三段边界清晰；Important / Recent 是原文，不是模型复述。
export function buildForgePacket({ continuity, importantExact: importantItems = [], recentExact = '', framing = DEFAULT_FRAMING, outro = DEFAULT_OUTRO }) {
  return [
    framing, '',
    '[CONTINUITY STATE]', '',
    renderContinuity(continuity), '',
    '[IMPORTANT EXACT HISTORY]', '',
    importantItems.length ? importantItems.map(renderExactItem).join('\n\n') : '（无）', '',
    '[RECENT EXACT CONVERSATION]', '',
    recentExact || '（无）', '',
    outro,
  ].join('\n');
}

export function forgeStats({ fullExactChars = null, continuity, importantExact: importantItems = [], recentExact = '', packetChars = null }) {
  const packet = packetChars ?? countChars(buildForgePacket({ continuity, importantExact: importantItems, recentExact }));
  return {
    fullExactChars,
    continuityChars: countChars(renderContinuity(continuity)),
    importantChars: importantItems.reduce((sum, item) => sum + countChars(item.content), 0),
    recentChars: countChars(recentExact),
    packetChars: packet,
    compressionRatio: fullExactChars ? packet / fullExactChars : null,
  };
}

// §10/§12 三层去重：Recent Exact 优先级最高。Important Exact 里若与 Recent 重叠，
// 就不应再复制一遍——否则同一段原文在 packet 里出现两次，白白烧上下文。
// 这里按与 buildRecentExact 相同的「轮」划分规则（USER / 含 REQUEST 的消息起新轮）算出
// Recent 覆盖的 messageId，再据此排除 Important 中的重叠项。
export function recentMessageIds(analysis, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Recent Exact 轮数必须是正整数。');
  const turns = [];
  let current = null;
  for (const message of analysis.branch.messages) {
    const fragments = Array.isArray(message.fragments) ? message.fragments : [];
    const startsTurn = String(message.role || '').toUpperCase() === 'USER'
      || fragments.some(fragment => fragment.type === 'REQUEST');
    if (startsTurn) { current = []; turns.push(current); }
    const hasBody = fragments.some(fragment => ['REQUEST', 'RESPONSE'].includes(fragment.type) && typeof fragment.content === 'string');
    if (hasBody && current) current.push(String(message.messageId));
  }
  return [...new Set(turns.slice(-limit).flat())];
}

export function excludeRecentFromImportant(items, recentIds) {
  const recent = new Set([...recentIds].map(String));
  const kept = [], excludedIds = [];
  let excludedChars = 0;
  for (const item of items) {
    if (recent.has(item.messageId)) { excludedIds.push(item.messageId); excludedChars += countChars(item.content); }
    else kept.push(item);
  }
  return { items: kept, excludedIds, excludedChars };
}

// 侧栏接线用的便捷入口：给定当前分析结果 + 一份 continuity + 重要 id，组装 Forge packet。
// Recent 优先去重：先算 Recent 覆盖的 id，再把 Important 中的重叠剔除。
export function assembleForgePacket({ session, analysis, continuity, importantMessageIds = [], recentTurns = 20, fullExactChars = null }) {
  const recentExact = buildRecentExact(session, analysis, recentTurns);
  const recentIds = recentMessageIds(analysis, recentTurns);
  const selected = importantExact(analysis.entries, importantMessageIds);
  const { items, excludedIds, excludedChars } = excludeRecentFromImportant(selected.items, recentIds);
  const packet = buildForgePacket({ continuity, importantExact: items, recentExact });
  return {
    packet,
    importantExact: items,
    recentExact,
    unknownImportantIds: selected.unknownIds,
    excludedRecentOverlap: { ids: excludedIds, chars: excludedChars },
    stats: forgeStats({ fullExactChars, continuity, importantExact: items, recentExact, packetChars: countChars(packet) }),
  };
}
