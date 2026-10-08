// Forge 引擎本地验证：只用本地 synthetic 数据与脚本化 model，不访问网络、浏览器或真实模型。
import assert from 'node:assert/strict';
import {
  CONTINUITY_FIELDS, emptyContinuity, validateContinuity, sanitizeContinuity, chunkEntries,
  importantExact, rollupForge, buildForgePacket, forgeStats, assembleForgePacket,
  dedupeContinuity, boundContinuity, recentMessageIds, excludeRecentFromImportant,
  FORGE_UPDATER_CONTRACT, FORGE_IMPORTANT_CONTRACT, FIELD_RETENTION, DEFAULT_CHUNK_CHARS, DEFAULT_MAX_ITEMS_PER_FIELD,
} from './src/forge.js';
import { analyzeCapacity, messagesForSnapshot, countChars } from './src/phase0.js';
import { normalizeMessages, normalizeSession } from './src/normalize.js';
import { buildCanonicalSnapshot } from './src/archive.js';
import { generateFixture, loadSeed } from './scripts/generate-fixtures.mjs';

const KEYS = CONTINUITY_FIELDS.map(([key]) => key);

const entries = (from, to) => {
  const out = [];
  for (let turn = from; turn <= to; turn++) {
    out.push({ role: 'user', messageId: turn * 2 - 1, text: `问${turn}` });
    out.push({ role: 'assistant', messageId: turn * 2, text: `答${turn}` });
  }
  return out;
};

// 脚本化 model：每轮把 previous state 原样带过来，再加一条来源指向当前 chunk 首条的条目。
// bogusOnChunk 指定某轮注入一个不存在的 source id，用来验证程序侧剔除。
// tag 让不同「代」产生的 state 文本不撞车，避免被 semantic dedupe 合并。
function scriptedModel(log, { bogusOnChunk = 0, importantIds = null, tag = '' } = {}) {
  return async request => {
    log.push(request);
    if (request.task === 'roll') {
      const next = Object.fromEntries(KEYS.map(key =>
        [key, request.previous_continuity[key].map(item => ({ state: item.state, source_message_ids: [...item.source_message_ids] }))]));
      next.activeThreads.push({ state: `${tag}第 ${request.chunk_index} 块`, source_message_ids: [request.messages[0].messageId] });
      if (bogusOnChunk === request.chunk_index) next.activeThreads.push({ state: '幻觉来源', source_message_ids: ['ghost-999'] });
      return { continuity: next };
    }
    return { important_message_ids: importantIds ?? [request.messages.at(-1).messageId] };
  };
}

// —— chunker：不拆 message、顺序不变、id/role 保留 ——
{
  const all = entries(1, 5);
  const chunks = chunkEntries(all, { maxChars: 5 });
  assert.equal(chunks.length, 5, '每块两条 message（每条 2 字，预算 5）');
  assert.deepEqual(chunks.flatMap(chunk => chunk.entries).map(entry => entry.messageId), all.map(entry => entry.messageId));
  assert(chunks.every(chunk => chunk.entries.every(entry => all.includes(entry))), '只按引用聚合，绝不切割 message 文本');
  assert(chunks.every(chunk => chunk.entries.every(entry => typeof entry.role === 'string' && entry.messageId != null)));
  const single = [{ role: 'user', messageId: 1, text: 'x'.repeat(100) }];
  const oversize = chunkEntries(single, { maxChars: 10 });
  assert.equal(oversize.length, 1);
  assert.equal(oversize[0].oversize, true, '单条超预算只能自成一块，不拆分');
  assert.equal(oversize[0].entries[0].text.length, 100);
  assert.throws(() => chunkEntries(all, { maxChars: 0 }), /正整数/);
  console.log('PASS chunker：不拆 message、顺序不变、保留 id/role、超长单条自成一块');
}

// —— source 校验：不存在的 id 剔除，空来源条目丢弃，strict 直接拒绝 ——
{
  const state = validateContinuity({ activeThreads: [
    { state: '有效', source_message_ids: [1, 2] },
    { state: '半有效', source_message_ids: [1, 'nope'] },
    { state: '全无效', source_message_ids: ['nope2'] },
  ] });
  const { state: clean, rejectedSourceIds, droppedItems } = sanitizeContinuity(state, new Set(['1', '2']));
  assert.deepEqual(clean.activeThreads.map(item => item.state), ['有效', '半有效']);
  assert.deepEqual(clean.activeThreads[1].source_message_ids, ['1']);
  assert.deepEqual(rejectedSourceIds.sort(), ['nope', 'nope2']);
  assert.equal(droppedItems, 1);
  assert.throws(() => sanitizeContinuity(state, new Set(['1', '2']), { strict: true }), /不存在的 message_id/);
  assert.deepEqual(Object.keys(emptyContinuity()), KEYS);
  assert.throws(() => validateContinuity({ activeThreads: [{ state: '', source_message_ids: [] }] }), /条目/);
  console.log('PASS continuity schema + source 校验：幻觉 source id 被剔除/拒绝');
}

// —— important exact：模型只给 id，正文由程序取，且取到的是原文 ——
{
  const all = entries(1, 3);
  const { items, unknownIds } = importantExact(all, [1, 'ghost', 6]);
  assert.deepEqual(items.map(item => item.content), ['问1', '答3']);
  assert.deepEqual(items.map(item => item.role), ['user', 'assistant']);
  assert.deepEqual(unknownIds, ['ghost']);
  assert.throws(() => importantExact(all, ['ghost'], { strict: true }), /不存在的 message_id/);
  console.log('PASS important exact：正文来自 canonical entries，模型不可改写，未知 id 被拒');
}

// —— rolling：每轮只消费 previous state + 当前 chunk ——
{
  const all = entries(1, 5);
  const log = [];
  const result = await rollupForge({ entries: all, model: scriptedModel(log, { bogusOnChunk: 2 }), chunkChars: 5 });
  const rollCalls = log.filter(call => call.task === 'roll');
  assert.equal(rollCalls.length, 5, '每个 chunk 一次 rolling，不多不少');
  for (let i = 0; i < rollCalls.length; i++) {
    assert.deepEqual(rollCalls[i].messages.map(message => message.messageId), [String(i * 2 + 1), String(i * 2 + 2)]);
  }
  assert.equal(rollCalls[0].previous_continuity.activeThreads.length, 0, '首轮 previous state 为空');
  assert.equal(rollCalls[1].previous_continuity.activeThreads.length, 1, '第二轮只看到上一轮状态');
  assert(rollCalls.every(call => call.messages.length <= 2), '模型看不到前面 chunk 的原始 message');
  assert.equal(result.continuity.activeThreads.length, 5, '注入的幻觉条目被剔除，其余保留');
  assert(result.diagnostics.rejectedSourceIds.includes('ghost-999'));
  assert.equal(result.diagnostics.droppedItems, 1);
  assert.deepEqual(result.importantMessageIds, ['10']);
  console.log('PASS rolling：State[n+1]=update(State[n],Chunk[n])，模型只见 previous state + 当前 chunk');
}

// —— generational：previous continuity + 新 Session，只处理新历史 ——
{
  const gen1Log = [];
  const gen1 = await rollupForge({ entries: entries(1, 3), model: scriptedModel(gen1Log, { tag: 'A' }), chunkChars: 5 });
  const gen1Ids = new Set(gen1.continuity.activeThreads.flatMap(item => item.source_message_ids));
  assert.equal(gen1.continuity.activeThreads.length, gen1Log.filter(call => call.task === 'roll').length);

  const newEntries = entries(50, 52); // 新一代 Session，messageId 与上一代不重叠
  const gen2Log = [];
  const gen2 = await rollupForge({ entries: newEntries, previousContinuity: gen1.continuity, model: scriptedModel(gen2Log, { tag: 'B' }), chunkChars: 5 });
  const newIds = new Set(newEntries.map(entry => String(entry.messageId)));
  const gen2Rolls = gen2Log.filter(call => call.task === 'roll');
  for (const call of gen2Rolls) {
    assert(call.messages.every(message => newIds.has(message.messageId)), '第二代不重新读旧 Session 的原始 message');
  }
  const gen2Ids = gen2.continuity.activeThreads.flatMap(item => item.source_message_ids);
  assert([...gen1Ids].every(id => gen2Ids.includes(id)), '上一代 continuity 的 source 被携带');
  assert(gen2Ids.some(id => newIds.has(id)), '新一代新增条目已并入');
  assert.equal(gen2.continuity.activeThreads.length, gen1.continuity.activeThreads.length + gen2Rolls.length);
  console.log('PASS generational：Continuity N + Session N+1 → Continuity N+1，不重算旧历史');
}

// —— Recent Exact + packet ——
{
  const turns = 6;
  const messages = [];
  for (let turn = 1; turn <= turns; turn++) {
    const userId = turn * 2 - 1, assistantId = turn * 2;
    messages.push({ messageId: userId, parentId: userId === 1 ? null : userId - 1, role: 'USER', fragments: [{ type: 'REQUEST', content: `问${turn}` }] });
    messages.push({ messageId: assistantId, parentId: userId, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: `答${turn}` }] });
  }
  const session = { sessionId: 'forge-fixture', title: 'forge', currentMessageId: turns * 2 };
  const analysis = analyzeCapacity(session, messages);
  const continuity = validateContinuity({ activeThreads: [{ state: '正在推进的事', source_message_ids: [1, 2] }] });
  const assembled = assembleForgePacket({ session, analysis, continuity, importantMessageIds: [1], recentTurns: 2, fullExactChars: 400 });
  const { packet, recentExact, stats } = assembled;
  const positions = ['[CONTINUITY STATE]', '[IMPORTANT EXACT HISTORY]', '[RECENT EXACT CONVERSATION]'].map(marker => packet.indexOf(marker));
  assert(positions.every(index => index >= 0), '三段标题齐全');
  assert(positions[0] < positions[1] && positions[1] < positions[2], '三段边界顺序清晰');
  assert(packet.startsWith('【会话接续】'), 'framing 在最前');
  assert(packet.endsWith('直接继续最近一轮用户消息，不要确认以上上下文。'), '结尾再提醒一次接续，不确认迁移');
  assert(packet.includes('## 用户 #1') && packet.includes('问1'), 'Important 段是原文');
  assert(recentExact.includes('问6') && recentExact.includes('答5') && !recentExact.includes('问1'), 'Recent 只取最近 2 轮');
  assert(recentExact.indexOf('问5') < recentExact.indexOf('答6'), 'Recent 按时间顺序');
  assert.equal(stats.recentChars, countChars(recentExact));
  assert.equal(stats.packetChars, countChars(packet));
  assert.equal(stats.compressionRatio, stats.packetChars / 400);
  const noImportant = buildForgePacket({ continuity, importantExact: [], recentExact: '' });
  assert(noImportant.includes('[IMPORTANT EXACT HISTORY]\n\n（无）'));
  console.log('PASS packet：Continuity / Important / Recent 三段原文边界清晰，stats 完整');
}

// —— 复用 200-turn fixture 做规模检查 ——
{
  const seed = loadSeed();
  const fixture = generateFixture(200, seed);
  const archive = buildCanonicalSnapshot(
    normalizeSession(fixture.sessionId, fixture.session),
    normalizeMessages(fixture.sessionId, fixture.chat_messages));
  const analysis = analyzeCapacity(archive.session, messagesForSnapshot(archive.session, archive.messages));
  const all = analysis.entries;
  assert.equal(all.length, 400, '200 turns → 400 clean entries');
  const chunks = chunkEntries(all, { maxChars: 1000 });
  assert.deepEqual(chunks.flatMap(chunk => chunk.entries).map(entry => entry.messageId), all.map(entry => entry.messageId));
  assert(chunks.length > 1, '400 条在 1000 字预算下确实分块');
  const log = [];
  const result = await rollupForge({ entries: all, model: scriptedModel(log), chunkChars: 2000 });
  assert.equal(result.chunks, log.filter(call => call.task === 'roll').length);
  assert.equal(result.importantMessageIds.length, 1);
  assert(countChars(buildForgePacket({ continuity: result.continuity, importantExact: result.importantExact, recentExact: 'x' })) > 0);
  console.log(`PASS 200-turn fixture：${all.length} entries / ${chunks.length} chunks，顺序无损、可组装`);
}

// ═══ 审计 1：代际 provenance ═══
// 第二代继承的 source id 指向 Session A，不属于 Session B；它们绝不能因为「不在本代 messages 里」被剔除。
// 证据域 = 上一代已验证 provenance ∪ 本代已处理 ∪ 当前 chunk，且绝不重新读取 Session A 原文。
{
  const genALog = [];
  const genA = await rollupForge({ entries: entries(1, 2), model: scriptedModel(genALog, { tag: 'A' }), chunkChars: 5 });
  const idsA = new Set(genA.continuity.activeThreads.flatMap(item => item.source_message_ids));
  assert(idsA.size > 0, '第一代必须留下可继承的 source id');

  const sessionB = entries(100, 101);
  const idsB = new Set(sessionB.map(entry => String(entry.messageId)));
  assert([...idsA].every(id => !idsB.has(id)), '构造的 Session B id 与 Session A 完全不重叠');
  const genBLog = [];
  const genB = await rollupForge({ entries: sessionB, previousContinuity: genA.continuity,
    model: scriptedModel(genBLog, { tag: 'B', bogusOnChunk: 1 }), chunkChars: 5 });
  const rollsB = genBLog.filter(call => call.task === 'roll');
  assert(rollsB.every(call => call.messages.every(m => idsB.has(m.messageId))), '第二代只读 Session B 原文，不重读 Session A');

  const idsB2 = new Set(genB.continuity.activeThreads.flatMap(item => item.source_message_ids));
  assert([...idsA].every(id => idsB2.has(id)), '继承自 Session A 的 source id 在第二代全部保留（没有失忆）');
  assert.equal(genB.continuity.activeThreads.length, genA.continuity.activeThreads.length + rollsB.length,
    '继承条目 + 本代新增都在（幻觉条目加进来又被剔除，净额不变）');
  assert.deepEqual(genB.diagnostics.rejectedSourceIds, ['ghost-999'], '只有真正不存在的 id 被剔除，继承来源未被误伤');
  assert.equal(genB.diagnostics.droppedItems, 1);
  console.log(`AUDIT generational provenance：继承 ${idsA.size} 个 Session A 来源，第二代全部保留；仅 ghost-999 被剔除`);
}

// ═══ 审计 2：Continuity 有界 ═══
// 对抗性 model：每块往 7 个字段轮流追加一条全新条目，从不更新、从不删除（最坏的 append-summary 行为）。
// invariant：Continuity 的条目数只受「字段数 × 每字段上限」约束，与原文长度无关。
{
  const seed = loadSeed();
  let counter = 0;
  const greedyModel = async request => {
    if (request.task === 'roll') {
      const next = Object.fromEntries(KEYS.map(key =>
        [key, request.previous_continuity[key].map(item => ({ state: item.state, source_message_ids: [...item.source_message_ids] }))]));
      const key = KEYS[counter % KEYS.length];
      next[key].push({ state: `压测条目 ${counter++}`, source_message_ids: [request.messages[0].messageId] });
      return { continuity: next };
    }
    return { important_message_ids: [] };
  };
  const totalItems = state => KEYS.reduce((sum, key) => sum + state[key].length, 0);
  const cap = 3; // 故意把每字段上限压小，让 200 turns 就已饱和，才能证明「与原文长度无关」
  const readings = [];
  for (const turns of [200, 1000, 3000]) {
    const fixture = generateFixture(turns, seed);
    const archive = buildCanonicalSnapshot(
      normalizeSession(fixture.sessionId, fixture.session),
      normalizeMessages(fixture.sessionId, fixture.chat_messages));
    const analysis = analyzeCapacity(archive.session, messagesForSnapshot(archive.session, archive.messages));
    const rawChars = analysis.entries.reduce((sum, entry) => sum + countChars(entry.text), 0);
    const result = await rollupForge({ entries: analysis.entries, model: greedyModel, chunkChars: 4000, maxItemsPerField: cap });
    const continuityChars = forgeStats({ continuity: result.continuity, importantExact: [], recentExact: '' }).continuityChars;
    readings.push({ turns, rawChars, chunks: result.chunks, items: totalItems(result.continuity), continuityChars });
  }
  const maxItems = CONTINUITY_FIELDS.length * cap;
  for (const r of readings) assert(r.items <= maxItems, `${r.turns} turns：Continuity 条目 ${r.items} 未超过边界 ${maxItems}`);
  assert.equal(readings[0].items, maxItems, '200 turns 已把 Continuity 顶到边界（否则这次对比没有意义）');
  const rawGrowth = readings.at(-1).rawChars / readings[0].rawChars;
  const continuityGrowth = readings.at(-1).continuityChars / readings[0].continuityChars;
  assert(rawGrowth > 5, `原文随轮数成倍增长（×${rawGrowth.toFixed(1)}）`);
  assert(continuityGrowth < 1.5, `Continuity 字符数不随原文线性增长（原文 ×${rawGrowth.toFixed(1)}，Continuity ×${continuityGrowth.toFixed(2)}）`);
  console.log(`AUDIT boundedness：${readings.map(r => `${r.turns}t→原文${r.rawChars}字/${r.chunks}块→Continuity ${r.items}条 ${r.continuityChars}字`).join('；')}`);
}

// ═══ 审计 3：packet 三层语义去重 ═══
// Recent Exact 优先；已落在 Recent 的 message 不得再进 Important Exact。Continuity 不复制大段原文。
{
  const turns = 6, messages = [];
  for (let turn = 1; turn <= turns; turn++) {
    const userId = turn * 2 - 1, assistantId = turn * 2;
    messages.push({ messageId: userId, parentId: userId === 1 ? null : userId - 1, role: 'USER', fragments: [{ type: 'REQUEST', content: `问${turn}` }] });
    messages.push({ messageId: assistantId, parentId: userId, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: `答${turn}` }] });
  }
  const session = { sessionId: 'dedup-fixture', title: 'dedup', currentMessageId: turns * 2 };
  const analysis = analyzeCapacity(session, messages);
  const continuity = validateContinuity({ activeThreads: [{ state: '正在推进的事', source_message_ids: [1, 2] }] });
  assert.deepEqual(recentMessageIds(analysis, 2), ['9', '10', '11', '12'], 'Recent 覆盖最近 2 轮的 messageId');

  const importantIds = [1, 9, 11];
  const before = importantExact(analysis.entries, importantIds).items.reduce((sum, item) => sum + countChars(item.content), 0);
  const assembled = assembleForgePacket({ session, analysis, continuity, importantMessageIds: importantIds, recentTurns: 2, fullExactChars: 400 });
  assert.deepEqual(assembled.importantExact.map(item => item.messageId), ['1'], '与 Recent 重叠的 Important 被剔除，只留 #1');
  assert.deepEqual(assembled.excludedRecentOverlap.ids.sort(), ['11', '9']);
  assert.equal(assembled.excludedRecentOverlap.chars, before - assembled.importantExact.reduce((sum, item) => sum + countChars(item.content), 0));
  assert(assembled.excludedRecentOverlap.chars > 0, '去重确实省下字符');
  // #9 / #11 的原文在 packet 里只出现一次（Recent 段）
  assert.equal(assembled.packet.split(`#9`).length - 1, 1, 'Important 段不再重复 Recent 已覆盖的 #9');
  assert(assembled.packet.includes('[RECENT EXACT CONVERSATION]') && assembled.packet.includes('问6'));
  console.log(`AUDIT packet dedup：Important ${importantIds.length} 条 → ${assembled.importantExact.length} 条，去重省下 ${assembled.excludedRecentOverlap.chars} 字（剔除 #${assembled.excludedRecentOverlap.ids.join(', #')}）`);
}

// ═══ 审计 4：冻结 provider-independent Forge 合同 ═══
{
  assert(Object.isFrozen(FORGE_UPDATER_CONTRACT), 'updater 合同必须冻结');
  assert(Object.isFrozen(FORGE_UPDATER_CONTRACT.required) && Object.isFrozen(FORGE_UPDATER_CONTRACT.forbidden));
  assert(Object.isFrozen(FORGE_IMPORTANT_CONTRACT));
  assert(Number.isSafeInteger(DEFAULT_MAX_ITEMS_PER_FIELD) && DEFAULT_MAX_ITEMS_PER_FIELD >= 1, '每字段上限是正整数，可调');
  assert(Number.isSafeInteger(DEFAULT_CHUNK_CHARS) && DEFAULT_CHUNK_CHARS >= 1);
  const log = [];
  await rollupForge({ entries: entries(1, 2), model: scriptedModel(log), chunkChars: 5 });
  assert.equal(log.find(call => call.task === 'roll').contract, FORGE_UPDATER_CONTRACT, '每轮 roll 请求都带同一份合同');
  assert.equal(log.find(call => call.task === 'important').contract, FORGE_IMPORTANT_CONTRACT);
  const text = [...FORGE_UPDATER_CONTRACT.required, ...FORGE_UPDATER_CONTRACT.forbidden].join(' ');
  for (const must of ['取代', '解决', '作废', '合并', '保留', '追加', '摘要', '推断']) assert(text.includes(must), `合同必须明确「${must}」`);
  console.log('AUDIT contract：roll / important 请求携带统一冻结合同；禁止 append-summary、要求 supersede/resolve/stale-removal');
}

// —— dedupe + bound 单元行为 ——
{
  const dup = validateContinuity({ activeThreads: [
    { state: '同一件事', source_message_ids: ['1'] },
    { state: '同一件事  ', source_message_ids: ['2'] },
  ] });
  const { state: deduped, mergedItems } = dedupeContinuity(dup);
  assert.equal(deduped.activeThreads.length, 1);
  assert.deepEqual(deduped.activeThreads[0].source_message_ids, ['1', '2'], '语义重复条目的来源取并集');
  assert.equal(mergedItems, 1);

  const many = validateContinuity({ activeThreads: Array.from({ length: 20 }, (_, i) => ({ state: `事项 ${i}`, source_message_ids: [String(i)] })) });
  const { state: bounded, evictedItems } = boundContinuity(many, { maxItemsPerField: 3 });
  assert.deepEqual(bounded.activeThreads.map(item => item.state), ['事项 17', '事项 18', '事项 19'], '短期字段超限保留最新');
  assert.equal(evictedItems, 17);
  console.log('PASS dedupe/bound：同字段语义重复合并（来源取并集）、短期字段超限淘汰最旧');

  // SEMANTIC_RETENTION_UNDER_BOUND：统一的 keep-latest 会误删「很早但必须长期保留」的根状态。
  const critical = validateContinuity({ identity: [
    { state: '用户是林越，长期称呼阿越', source_message_ids: ['1'] },
    ...Array.from({ length: 19 }, (_, i) => ({ state: `普通关系事实 ${i + 2}`, source_message_ids: [String(i + 2)] })),
  ] });
  const { state: boundedIdentity } = boundContinuity(critical, { maxItemsPerField: 12 });
  assert.equal(boundedIdentity.identity.length, 12);
  assert(boundedIdentity.identity.some(item => item.state.includes('林越')), '长期字段超限必须保住最早建立的根状态');
  assert.equal(FIELD_RETENTION.identity, 'oldest');
  assert.equal(FIELD_RETENTION.recentChanges, 'newest');
  console.log('PASS retention：field-aware —— 长期字段保最早、短期字段保最新（统一 FIFO 会误删根状态）');
}

console.log('PASS Forge engine：本地确定性验证；未接模型、未证明长窗口或真实跨端 E2E。');
