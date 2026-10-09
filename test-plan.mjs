// plan.js 本地验证：两阶段纯决策 + 来源快照指纹。全部本地构造，无网络、无 chrome。
import assert from 'node:assert/strict';
import { analyzeCapacity, messagesForSnapshot, buildForgePackage, countChars } from './src/phase0.js';
import { planMigration, snapshotFingerprint, rollingOverheadChars, DEFAULT_RECENT_TURNS } from './src/plan.js';

// 造一段会话：turns 轮，每轮 user + assistant。text 按轮生成，便于控制长度。
function session(turns, { title = 'qa', text = turn => `第${turn}轮 很短的正文` } = {}) {
  const messages = [];
  let messageId = 0;
  for (let turn = 1; turn <= turns; turn++) {
    const userId = ++messageId, assistantId = ++messageId;
    messages.push({ messageId: userId, parentId: userId === 1 ? null : userId - 1, role: 'USER', fragments: [{ type: 'REQUEST', content: text(turn) }] });
    messages.push({ messageId: assistantId, parentId: userId, role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: text(turn) }] });
  }
  const s = { sessionId: `plan-${turns}`, title, currentMessageId: messageId, snapshotMessageIds: messages.map(message => message.messageId), messageCount: messages.length };
  const analysis = analyzeCapacity(s, messages);
  const forge = buildForgePackage(s, messagesForSnapshot(s, messages), { recentTurns: DEFAULT_RECENT_TURNS });
  return { session: s, analysis, fullExactChars: countChars(forge.fullExact) };
}

// ── pre：API 未配置 → 阻断，绝不擅自切到网页版 ───────────────────────────────
{
  const { session: s, analysis, fullExactChars } = session(60);
  const pre = planMigration({ phase: 'pre', requestedProvider: 'api', apiConfigured: false, session: s, analysis, fullExactChars });
  assert.equal(pre.action, 'blocked');
  assert.equal(pre.reason, 'API_NOT_CONFIGURED');
  assert.equal(pre.provider, 'api', 'provider 如实反映用户选择，不切换');
  console.log('PASS pre：API 未配置 → blocked / API_NOT_CONFIGURED，不擅自杀到网页版');
}

// ── pre：最近 N 轮已覆盖全部历史 → EXACT_NO_BENEFIT（零模型调用） ────────────
{
  const { session: s, analysis, fullExactChars } = session(3);
  const pre = planMigration({ phase: 'pre', requestedProvider: 'web', session: s, analysis, fullExactChars });
  assert.equal(pre.action, 'exact');
  assert.equal(pre.reason, 'EXACT_NO_BENEFIT');
  assert.equal(pre.provider, 'web');
  assert.equal(pre.outsideRecentCount, 0, '没有落在最近 N 轮之外的历史');
  console.log('PASS pre：短会话（全在最近窗口内）→ exact / EXACT_NO_BENEFIT');
}

// ── pre：固定开销 + 必留原文已不短于完整原文 → EXACT_NO_BENEFIT ──────────────
{
  const { session: s, analysis, fullExactChars } = session(DEFAULT_RECENT_TURNS + 1, { text: () => '短' });
  const pre = planMigration({ phase: 'pre', requestedProvider: 'web', session: s, analysis, fullExactChars });
  assert(pre.outsideRecentCount > 0, '确实有 1 轮在最近窗口之外');
  assert.equal(pre.action, 'exact', '多出的正文还抵不过固定接续开销');
  assert.equal(pre.reason, 'EXACT_NO_BENEFIT');
  assert(pre.minRollingChars >= pre.fullExactChars);
  console.log(`PASS pre：只有 1 轮在窗口外时，minRolling ${pre.minRollingChars} ≥ fullExact ${pre.fullExactChars} → exact`);
}

// ── pre：确有可压缩历史且下界低于完整原文 → ROLLING_ELIGIBLE ─────────────────
{
  const { session: s, analysis, fullExactChars } = session(60);
  const pre = planMigration({ phase: 'pre', requestedProvider: 'web', session: s, analysis, fullExactChars, fingerprint: 'abc' });
  assert.equal(pre.action, 'roll');
  assert.equal(pre.reason, 'ROLLING_ELIGIBLE');
  assert(pre.outsideRecentCount > 0);
  assert(pre.minRollingChars < pre.fullExactChars, '滚动稿有可证下界低于完整原文');
  assert.equal(pre.fingerprint, 'abc', '预判把来源指纹原样带出');
  console.log(`PASS pre：长会话 → roll / ROLLING_ELIGIBLE（下界 ${pre.minRollingChars} < 完整 ${pre.fullExactChars}）`);
}

// ── pre：provider 归一化 —— 只认 'api'，其余一律网页版，绝不擅自切换 ─────────
{
  const { session: s, analysis, fullExactChars } = session(60);
  for (const requested of ['web', 'api']) {
    const pre = planMigration({ phase: 'pre', requestedProvider: requested, apiConfigured: true, session: s, analysis, fullExactChars });
    assert.equal(pre.provider, requested);
  }
  const weird = planMigration({ phase: 'pre', requestedProvider: 'nonsense', apiConfigured: true, session: s, analysis, fullExactChars });
  assert.equal(weird.provider, 'web');
  console.log('PASS pre：provider 只认 api，其余归为网页版');
}

// ── post：谁更短发谁；相等也发完整原文（不硬塞更大的滚动稿） ─────────────────
{
  const rolling = planMigration({ phase: 'post', requestedProvider: 'api', fullExactChars: 1000, rollingChars: 800 });
  assert.equal(rolling.action, 'send-rolling');
  assert.equal(rolling.reason, 'rolling-smaller');
  assert.equal(rolling.provider, 'api');

  const notSmaller = planMigration({ phase: 'post', requestedProvider: 'web', fullExactChars: 1000, rollingChars: 1200 });
  assert.equal(notSmaller.action, 'send-exact');
  assert.equal(notSmaller.reason, 'rolling-not-smaller');

  const equal = planMigration({ phase: 'post', requestedProvider: 'web', fullExactChars: 1000, rollingChars: 1000 });
  assert.equal(equal.action, 'send-exact', '相等时宁可用完整原文');
  assert.equal(planMigration({ phase: 'post', fullExactChars: 1000, rollingChars: null }).action, 'send-exact', '缺数字时保守发完整原文');
  console.log('PASS post：rolling < full → 发滚动稿，否则自动发完整原文');
}

// ── phase 校验 ──────────────────────────────────────────────────────────────
{
  assert.throws(() => planMigration({ phase: 'mid' }), /pre.*post|post.*pre/);
  assert(rollingOverheadChars() > 0, '固定接续开销是正数（含 framing / outro / 段标题）');
  console.log('PASS：非法 phase 报错；固定开销为正');
}

// ── 指纹：确定、对内容敏感、对顺序/角色/来源敏感、只输出十六进制 ─────────────
{
  const entries = [
    { messageId: 1, role: 'user', text: '你好' },
    { messageId: 2, role: 'assistant', text: '在的' },
  ];
  const base = snapshotFingerprint({ sessionId: 's1', entries, lineageSourceId: 'g0' });
  assert.match(base, /^[0-9a-f]{16}$/, '64 位十六进制');
  assert.equal(snapshotFingerprint({ sessionId: 's1', entries, lineageSourceId: 'g0' }), base, '同输入同输出');

  // 同长度、只改一个字符：必须变。这正是「id 集合 + 字数」会漏掉的情形。
  const tweaked = [{ ...entries[0], text: '你号' }, entries[1]];
  assert.notEqual(snapshotFingerprint({ sessionId: 's1', entries: tweaked, lineageSourceId: 'g0' }), base,
    '正文被改写（长度不变）也会改变指纹');

  const swapped = [entries[1], entries[0]];
  assert.notEqual(snapshotFingerprint({ sessionId: 's1', entries: swapped, lineageSourceId: 'g0' }), base, '消息顺序参与指纹');

  const roleChanged = [{ ...entries[0], role: 'assistant' }, entries[1]];
  assert.notEqual(snapshotFingerprint({ sessionId: 's1', entries: roleChanged, lineageSourceId: 'g0' }), base, '角色参与指纹');

  const idChanged = [{ ...entries[0], messageId: 9 }, entries[1]];
  assert.notEqual(snapshotFingerprint({ sessionId: 's1', entries: idChanged, lineageSourceId: 'g0' }), base, 'messageId 参与指纹');

  assert.notEqual(snapshotFingerprint({ sessionId: 's2', entries, lineageSourceId: 'g0' }), base, '来源会话参与指纹');
  assert.notEqual(snapshotFingerprint({ sessionId: 's1', entries, lineageSourceId: 'g1' }), base, '代际来源参与指纹');
  console.log('PASS 指纹：稳定 64 位十六进制；正文改写 / 顺序 / 角色 / id / 来源任一变化都会变');
}

console.log('全部 PASS：plan 两阶段决策 + 来源快照指纹');
