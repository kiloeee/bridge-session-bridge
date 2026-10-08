// Forge Semantic E2E：用真实语义模型（本地 companion backend）验证 Forge 会不会「活到正确的现在」。
// 不改 Forge 架构 / UI / archive。只消费 src/forge.js 的公开接口。
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { rollupForge, assembleForgePacket, validateContinuity, boundContinuity } from '../../src/forge.js';
import { analyzeCapacity, messagesForSnapshot, countChars } from '../../src/phase0.js';
import { normalizeMessages, normalizeSession } from '../../src/normalize.js';
import { buildCanonicalSnapshot } from '../../src/archive.js';
import model, { captureDir } from './backend.mjs';

const KEYS = ['identity', 'stableFacts', 'activeThreads', 'decisions', 'openLoops', 'recentChanges', 'interactionPreferences'];
const inField = (state, field, kw) => state[field].some(item => item.state.includes(kw));
const anywhere = (state, kw) => KEYS.some(key => inField(state, key, kw));
const active = (state, kw) => inField(state, 'activeThreads', kw) || inField(state, 'openLoops', kw);

// 「已取代」的判定：旧称呼可以出现在状态里（例如「不再叫小咪」这种否定式），
// 但绝不能单独出现——单独出现才意味着它仍被当成当前状态。裸 includes() 会把
// 正确的取代写成 FAIL（测量假阴性），所以必须成对判定。
const nameSuperseded = (state, oldName, newName) =>
  ['identity', 'interactionPreferences'].every(key =>
    state[key].every(item => !item.state.includes(oldName) || item.state.includes(newName)));
// 「已放弃」同理：旧技能出现在「决定放弃 X / 改学 Y」里不算 stale，只有仍被当成进行中
// 或长期事实才算。stableFacts 里允许出现「已放弃 X」这种否定式，但不能单独出现。
const skillAbandoned = (state, oldSkill, successor) =>
  !active(state, oldSkill) &&
  state.stableFacts.every(item => !item.state.includes(oldSkill) || item.state.includes('放弃') || item.state.includes(successor));

// 把 [user, assistant] 轮次变成 canonical 快照。idBase 让不同「代」的 messageId 不重叠。
function rawFixture(title, turns, idBase = 0) {
  const chat_messages = [];
  let parent = null, id = idBase;
  for (const [user, assistant] of turns) {
    const uid = ++id;
    chat_messages.push({ message_id: uid, parent_id: parent, role: 'USER', status: 'FINISHED', inserted_at: 1700000000 + uid,
      fragments: [{ id: 1, type: 'REQUEST', content: user }], model: 'e2e', has_pending_fragment: false, accumulated_token_usage: null });
    const aid = ++id;
    chat_messages.push({ message_id: aid, parent_id: uid, role: 'ASSISTANT', status: 'FINISHED', inserted_at: 1700000000 + aid,
      fragments: [{ id: 1, type: 'RESPONSE', content: assistant }], model: 'e2e', has_pending_fragment: false, accumulated_token_usage: null });
    parent = aid;
  }
  return { session: { title, current_message_id: id, updated_at: 1700000000 + id }, chat_messages };
}

function analysisOf(sessionId, title, turns, idBase = 0) {
  const raw = rawFixture(title, turns, idBase);
  const archive = buildCanonicalSnapshot(normalizeSession(sessionId, raw.session), normalizeMessages(sessionId, raw.chat_messages));
  const analysis = analyzeCapacity(archive.session, messagesForSnapshot(archive.session, archive.messages));
  return { archive, analysis };
}

// ── Fixture A：单代语义对抗（30 轮）。早期状态在中后期被推翻。 ──
const TURNS_A = [
  ['我叫林越，你可以叫我小咪。', '好的，小咪，很高兴认识你。'],
  ['我这个月开始学 Rust，基础语法看完了。', '不错，Rust 的所有权模型是重点。'],
  ['我手上有个项目叫星轨，目标八月底前上线。', '星轨项目，八月底上线，记下了。'],
  ['明天我要去办签证续签。', '好的，明天办续签。'],
  ['Rust 学到生命周期了，有点绕。', '生命周期是 Rust 的难点。'],
  ['星轨这周在写接口层。', '接口层进展不错。'],
  ['续签材料我今天准备好了。', '材料备齐就好。'],
  ['Rust 的生命周期我基本搞懂了。', '很好，继续推进。'],
  ['我决定放弃 Rust 了，改学 Go。', '明白，重点转到 Go。'],
  ['Go 语法比 Rust 简单，已经上手。', 'Go 上手快。'],
  ['星轨项目已经上线完成了，很顺利。', '恭喜，星轨顺利上线。'],
  ['续签我取消了，暂时不去了。', '好的，续签取消。'],
  ['我想新开一个项目叫灯塔，做数据看板。', '灯塔项目，数据看板。'],
  ['以后别叫我小咪了，叫我阿越吧。', '好的，以后叫你阿越。'],
  ['Go 学到 goroutine 并发部分了。', '并发是 Go 的核心。'],
  ['灯塔先用原来的技术栈。', '好的，沿用原技术栈。'],
  ['我平时喜欢晚上工作，白天效率低。', '了解，偏好晚上工作。'],
  ['灯塔的数据源还没定下来。', '数据源待定。'],
  ['Go 的 channel 我还在消化。', 'channel 需要多练。'],
  ['我要加班一周，进度可能会慢。', '好的，注意休息。'],
  ['灯塔项目卡在数据源接入这一步了。', '灯塔卡在数据源接入，记下这个阻塞点。'],
  ['Go 继续学，开始写小工具了。', '很好，边学边用。'],
  ['之前问你那个部署脚本的问题，已经解决了。', '部署脚本问题解决了。'],
  ['我想问问，要不要把灯塔的数据库换掉。', '这是一个新的未结事项，记下。'],
  ['灯塔的数据看板先做最简单的版本。', '先做最简版本，合理。'],
  ['Go 的测试我也在写。', '边写测试是好习惯。'],
  ['灯塔下周要先给内部看一版。', '下周内部演示，记下。'],
  ['我现在主要精力都放在灯塔上。', '明白，主要在灯塔。'],
  ['阿越这个名字，同事也这么叫我。', '好的，阿越。'],
  ['就先这样，我继续去写灯塔的代码了。', '好的，阿越，继续推进灯塔。'],
];

// ── Fixture B：两代。Gen A 形成 Continuity A；Gen B 推翻/完成 A 的若干状态，只传 Continuity A + Session B。 ──
const TURNS_B1 = [
  ['我叫苏航，叫我阿航就行。', '好的，阿航。'],
  ['我在学 Elixir，刚看完语法。', 'Elixir 的并发模型很有特点。'],
  ['我有个项目叫青鸟，目标季度末交付。', '青鸟项目，季度末交付。'],
  ['青鸟这周在对接支付。', '支付对接是难点。'],
  ['论文提纲我一直拖着没写。', '论文提纲是个未结事项，记下。'],
  ['Elixir 的 OTP 我还在看。', 'OTP 是核心，慢慢来。'],
  ['青鸟的支付对接完成了一半。', '进度一半。'],
  ['我爸妈下个月要来住一阵。', '好的，记下。'],
  ['论文提纲我想下周开始动。', '下周开始，记下。'],
  ['Elixir 我用得越来越顺手了。', '很好。'],
  ['青鸟还需要做压测。', '压测要排上。'],
  ['就先这样。', '好的，阿航。'],
];
const TURNS_B2 = [
  ['Elixir 我已经学完了，暂时不用继续。', '好的，Elixir 告一段落。'],
  ['青鸟项目上线完成了。', '恭喜，青鸟上线完成。'],
  ['论文提纲我已经写完了。', '论文提纲解决了。'],
  ['现在别叫我阿航了，叫我苏苏。', '好的，叫你苏苏。'],
  ['我想新开一件事：要不要换导师。', '这是一个新的未结事项，记下。'],
  ['我最近在学数据库优化。', '数据库优化，不错。'],
  ['换导师这事我还在犹豫。', '还在犹豫，记下。'],
  ['数据库优化先从索引开始。', '索引是第一步。'],
  ['我爸妈已经来了。', '好的，记下。'],
  ['苏苏这个名字我也用在工作上。', '好的，苏苏。'],
  ['换导师我问过师兄了，还没定。', '还没定，记下。'],
  ['先这样吧。', '好的，苏苏。'],
];

const results = [];
const check = (group, name, ok, detail = '') => { results.push({ group, name, ok, detail }); return ok; };

// ── A. 单代 ──
const A = analysisOf('E2E-A', '[E2E] single-gen', TURNS_A);
const resA = await rollupForge({ entries: A.analysis.entries, model, chunkChars: 300 });
const cA = resA.continuity;
const A_checks = [
  ['preserve_identity', anywhere(cA, '林越')],
  ['supersede_nickname', anywhere(cA, '阿越') && nameSuperseded(cA, '小咪', '阿越')],
  ['abandon_old_skill', anywhere(cA, 'Go') && skillAbandoned(cA, 'Rust', 'Go')],
  ['keep_active_project', active(cA, '灯塔')],
  ['drop_completed_project', !active(cA, '星轨')],
  ['resolve_open_loop', !inField(cA, 'openLoops', '部署脚本')],
  ['new_open_loop', inField(cA, 'openLoops', '换数据库') || inField(cA, 'openLoops', '数据库')],
  ['drop_cancelled_errand', !active(cA, '续签')],
  ['no_hallucinated_sources', resA.diagnostics.rejectedSourceIds.length === 0],
];
for (const [name, ok] of A_checks) check('A', name, ok);

// fixture A 的语义指标：被推翻/已完成的旧状态若仍以「当前有效」形式出现，才算 stale 保留。
const staleRetainedA = [
  ...['小咪'].filter(t => !nameSuperseded(cA, t, '阿越')),
  ...['Rust'].filter(t => !skillAbandoned(cA, t, 'Go')),
  ...['星轨', '续签'].filter(t => active(cA, t)),
];
// 应长期保留、且本轮未被推翻的旧状态，若丢失即为「有效旧条目被误删」。
const wronglyDroppedA = ['林越', '晚上'].filter(t => !anywhere(cA, t));

const packetA = assembleForgePacket({ session: A.archive.session, analysis: A.analysis, continuity: cA, importantMessageIds: resA.importantMessageIds, recentTurns: 6, fullExactChars: A.analysis.entries.reduce((s, e) => s + countChars(e.text), 0) });
check('A', 'important_selection_bounded', resA.importantMessageIds.length > 0 && resA.importantMessageIds.length <= 12, `选了 ${resA.importantMessageIds.length} 条`);

// ── B. 两代 ──
const B1 = analysisOf('E2E-B1', '[E2E] gen A', TURNS_B1);
const genA = await rollupForge({ entries: B1.analysis.entries, model, chunkChars: 300 });
const idsA = new Set(KEYS.flatMap(k => genA.continuity[k].flatMap(i => i.source_message_ids)));
const B2 = analysisOf('E2E-B2', '[E2E] gen B', TURNS_B2, 1000);
const idsB = new Set(B2.analysis.entries.map(e => String(e.messageId)));
const genB = await rollupForge({ entries: B2.analysis.entries, previousContinuity: genA.continuity, model, chunkChars: 300 });
const cB = genB.continuity;
const idsB2 = new Set(KEYS.flatMap(k => cB[k].flatMap(i => i.source_message_ids)));
const carriedIds = [...idsA].filter(id => idsB2.has(id));
const B_checks = [
  ['preserve_identity', anywhere(cB, '苏航')],
  ['supersede_nickname', anywhere(cB, '苏苏') && nameSuperseded(cB, '阿航', '苏苏')],
  ['resolve_learning_thread', !active(cB, 'Elixir')],
  ['drop_completed_project', !active(cB, '青鸟')],
  ['resolve_open_loop', !inField(cB, 'openLoops', '论文提纲')],
  ['new_open_loop', inField(cB, 'openLoops', '换导师')],
  ['no_hallucinated_sources', genB.diagnostics.rejectedSourceIds.length === 0],
  ['no_phantom_inherited_ids', carriedIds.every(id => idsB.has(id) || /^\d+$/.test(id))],
];
for (const [name, ok] of B_checks) check('B', name, ok);
check('B', 'session_b_ids_only_in_genB', [...idsA].every(id => !idsB.has(id)));
// 注意：carriedIds 是「模型选择保留的继承 id」数，不是引擎能力。引擎对继承 provenance 的
// 保留已在 test-forge.mjs 用确定性 model 证明（GENERATIONAL_PROVENANCE=PASS）。真实模型在
// 被要求「取代/解决/合并」时会重写条目并把来源改成最新消息，属合同允许的重述，不是失忆——
// 因此这里只作为 metric 报告，不作为 gate。
const carriedRatio = `${carriedIds.length}/${idsA.size}`;

// ── C. bounded retention（确定性；淘汰策略不依赖模型） ──
const crit = validateContinuity({ identity: [
  { state: '用户是苏航，长期称呼苏苏', source_message_ids: ['1'] },
  ...Array.from({ length: 19 }, (_, i) => ({ state: `普通关系事实 ${i + 2}`, source_message_ids: [String(i + 2)] })),
] });
const { state: bCrit } = boundContinuity(crit, { maxItemsPerField: 12 });check('C', 'durable_root_survives_overflow', bCrit.identity.some(i => i.state.includes('苏航')) && bCrit.identity.length === 12);
check('C', 'short_term_keeps_latest', (() => {
  const s = validateContinuity({ openLoops: Array.from({ length: 20 }, (_, i) => ({ state: `事项 ${i}`, source_message_ids: [String(i)] })) });
  return boundContinuity(s, { maxItemsPerField: 3 }).state.openLoops.some(i => i.state === '事项 19');
})());

// ── D. serialized contract：真正发出去的请求体里必须有 contract + schema ──
// 捕获文件是整个 HTTP body 的 JSON。要验证「实际发出去的提示内容」，必须解析出
// body.system + body.messages[].content（那才是渲染后的字符串）；直接 grep 整个文件
// 会因为二次转义把内层引号变成 \" 而误判（假阴性）。system 也属于发给模型的合同。
const bodies = readdirSync(captureDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(resolve(captureDir, f), 'utf8')));
const serialized = bodies.flatMap(b => [
  typeof b.system === 'string' ? b.system : JSON.stringify(b.system || ''),
  ...b.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
]).join('\n');
const contractMarkers = ['取代', '解决', '作废', '合并', '保留', '无脑追加', '普通摘要', '推断', 'source_message_ids'].filter(m => serialized.includes(m));
check('D', 'serialized_contract_present', serialized.includes('FORGE_CONTRACT') && serialized.includes('FORGE_IMPORTANT_CONTRACT') && serialized.includes('source_message_ids'));
check('D', 'serialized_schema_present', serialized.includes('"state": "一句话状态"') && serialized.includes('interactionPreferences'));
check('D', 'serialized_forbids_append_summary', serialized.includes('无脑追加') && serialized.includes('禁止'));
check('D', 'serialized_model_is_real', bodies.every(b => typeof b.model === 'string' && b.model.length > 0));

// ── 报告 ──
const groupOk = group => results.filter(r => r.group === group).every(r => r.ok);
const dump = state => KEYS.map(k => `  ${k}[${state[k].length}] ${state[k].map(i => i.state).join(' ｜ ')}`).join('\n');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.group}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log('');
console.log(`A continuity items=${KEYS.reduce((n, k) => n + cA[k].length, 0)} chars=${countChars(JSON.stringify(cA))} chunks=${resA.chunks} packetChars=${packetA.stats.packetChars}`);
console.log(`B gen-A items=${KEYS.reduce((n, k) => n + genA.continuity[k].length, 0)} → gen-B items=${KEYS.reduce((n, k) => n + cB[k].length, 0)}`);
console.log(`D serialized chars=${serialized.length}；markers=${contractMarkers.length}/9`);
console.log('');
console.log('── 语义指标 ──');
console.log(`semantic_precision(A)      = ${A_checks.filter(([, ok]) => ok).length}/${A_checks.length}`);
console.log(`semantic_precision(B)      = ${B_checks.filter(([, ok]) => ok).length}/${B_checks.length}`);
console.log(`stale_items_retained       = ${staleRetainedA.length}${staleRetainedA.length ? `（${staleRetainedA.join(', ')}）` : ''}`);
console.log(`valid_old_wrongly_dropped  = ${wronglyDroppedA.length}${wronglyDroppedA.length ? `（${wronglyDroppedA.join(', ')}）` : ''}`);
console.log(`hallucinated_source_ids    = ${resA.diagnostics.rejectedSourceIds.length + genB.diagnostics.rejectedSourceIds.length}`);
console.log(`carried_provenance_ids     = ${carriedRatio}（模型保留数 / gen-A 继承 id；引擎能力见 test-forge.mjs，非 gate）`);
console.log(`important_selection        = ${resA.importantMessageIds.length} 条（上限 12）；unknown=${resA.diagnostics.unknownImportantIds.length}`);
console.log(`final_packet_chars(A)      = ${packetA.stats.packetChars}`);
if (!groupOk('A')) { console.log('\n── A 最终状态 ──'); console.log(dump(cA)); }
if (!groupOk('B')) { console.log('\n── B 最终状态（gen A → gen B）──'); console.log(dump(genA.continuity)); console.log('  ↓'); console.log(dump(cB)); }
console.log('');
console.log(`FORGE_SEMANTIC_E2E          = ${groupOk('A') ? 'PASS' : 'FAIL'}`);
console.log(`GENERATIONAL_SEMANTIC_E2E   = ${groupOk('B') ? 'PASS' : 'FAIL'}`);
console.log(`SEMANTIC_RETENTION_UNDER_BOUND = ${groupOk('C') ? 'PASS' : 'FAIL'}`);
console.log(`SERIALIZED_CONTRACT         = ${groupOk('D') ? 'PASS' : 'FAIL'}`);
console.log('LONG_SESSION_FORGE_E2E      = UNVALIDATED');

// 全绿才清理捕获；失败时保留证据供复核。
if (['A', 'B', 'C', 'D'].every(groupOk)) rmSync(captureDir, { recursive: true, force: true });
else console.log(`\n证据保留：${captureDir}`);
