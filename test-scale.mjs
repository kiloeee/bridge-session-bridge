// QA only. No traffic to DeepSeek, any model, or a real user's archive DB.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateFixture, loadSeed } from './scripts/generate-fixtures.mjs';
import { normalizeSession, normalizeMessages } from './src/normalize.js';
import { buildCanonicalSnapshot } from './src/archive.js';
import { analyzeCapacity, buildCleanTranscript, buildRecentExact, buildExactPackets, buildForgePackage, messagesForSnapshot } from './src/phase0.js';

const extensionDir = dirname(fileURLToPath(import.meta.url));
const chars = text => Array.from(text).length;
const seed = loadSeed();
assert.deepEqual(seed.counts.request, { fragments: 8, chars: 542 });
assert.deepEqual(seed.counts.response, { fragments: 3, chars: 6541 });
assert.deepEqual(seed.counts.think, { fragments: 3, chars: 2289 });
assert.deepEqual(seed.counts.template, { fragments: 9, chars: 108 });
console.log('PASS supplied Markdown seed: REQUEST 542 / RESPONSE 6541 / THINK 2289, matching real report; not a raw server snapshot');

const results = [];
for (const turns of [200, 1000, 3000]) {
  const started = performance.now();
  const fixture = generateFixture(turns, seed);
  // JSON serialization/reload keeps fixture isolated from the real archive DB.
  const fixtureJson = JSON.stringify(fixture);
  const reloaded = JSON.parse(fixtureJson);
  assert.equal(reloaded.qa.synthetic, true);
  const generatedAt = performance.now();
  const normalizedSession = normalizeSession(reloaded.sessionId, reloaded.session);
  const normalizedMessages = normalizeMessages(reloaded.sessionId, reloaded.chat_messages);
  const archive = buildCanonicalSnapshot(normalizedSession, normalizedMessages);
  assert.equal(archive.messages.length, fixture.expected.uniqueMessages);
  assert.equal(archive.session.messageCount, fixture.expected.uniqueMessages);
  assert.equal(new Set(archive.session.snapshotMessageIds.map(String)).size, archive.messages.length);
  const canonicalJson = JSON.stringify(archive);
  const restoredArchive = JSON.parse(canonicalJson);
  const selectedSnapshot = messagesForSnapshot(restoredArchive.session, [
    ...restoredArchive.messages,
    { sessionId: archive.session.sessionId, messageId: 'qa-stale-row-not-in-snapshot', fragments: [{ type: 'REQUEST', content: 'must not enter snapshot' }] },
  ]);
  assert.deepEqual(selectedSnapshot, restoredArchive.messages);
  assert(archive.messages.some(message => message.fragments.some(fragment => fragment.type === 'FILE' && fragment.content.name === 'QA-only-file.dat')));
  assert(archive.messages.some(message => message.fragments.some(fragment => fragment.type === 'TOOL_SEARCH' && fragment.results[0].title === 'QA tool payload')));
  const archivedAt = performance.now();
  const analysis = analyzeCapacity(archive.session, selectedSnapshot);
  assert.deepEqual(analysis.branch.messages.map(message => message.messageId), fixture.expected.selectedIds);
  assert.equal(analysis.branch.inferred, false);
  assert.deepEqual(analysis.branch.warnings, []);
  assert.equal(analysis.branch.excludedMessages, fixture.expected.excludedMessages);
  assert.equal(analysis.branch.forkCount, fixture.expected.forks);
  assert.equal(analysis.totalTurns, turns);
  assert.deepEqual(analysis.entries, fixture.expected.entries);
  assert.equal(analysis.selected.cleanTextChars, fixture.expected.cleanBodyChars);
  const clean = buildCleanTranscript(archive.session, analysis);
  assert(!clean.includes('QA STALE DUPLICATE'));
  assert(!clean.includes('QA sibling response'));
  assert(!clean.includes('QA synthetic fixed tip'));
  assert(!clean.includes('QA tool payload'));
  assert.equal(clean.match(/^## 用户 #/gm).length, turns);
  assert.equal(clean.match(/^## 助手 #/gm).length, turns);
  assert(clean.includes('  \t😀 e\u0301\r\n`inline`  \n'));
  for (const limit of [10, 20, 40]) {
    const recent = buildRecentExact(archive.session, analysis, limit);
    assert.equal(recent.match(/^## 用户 #/gm).length, limit);
    assert.equal(recent.match(/^## 助手 #/gm).length, limit);
    const expectedEntries = fixture.expected.entries.slice(-limit * 2);
    for (const entry of expectedEntries) assert(recent.includes(entry.text));
    assert(!recent.includes(`[QA SYNTHETIC turn=${turns - limit}]`));
    const expectedChars = expectedEntries.reduce((sum, entry) => sum + chars(entry.text), 0);
    assert.equal(analysis.recentTurns.find(value => value.limit === limit).chars, expectedChars);
  }
  const cleanedAt = performance.now();
  const fullPlan = buildExactPackets(clean);
  assert.equal(fullPlan.mode, 'full');
  assert.equal(fullPlan.maxChars, null);
  assert.equal(fullPlan.packets.length, 1);
  assert.equal(fullPlan.packets[0].text, clean);
  // 16,384 is a chosen local fixture budget, not a claimed DeepSeek limit.
  const maxChars = 16384;
  const plan = buildExactPackets(clean, { maxChars });
  assert.equal(plan.mode, 'packetized');
  assert.equal(plan.packets.map(packet => packet.body).join(''), clean);
  assert.equal(plan.fullChars, chars(clean));
  for (const [index, packet] of plan.packets.entries()) {
    assert.equal(packet.index, index + 1);
    assert.equal(packet.total, plan.packets.length);
    assert.equal(packet.chars, chars(packet.text));
    assert(packet.chars <= maxChars);
    assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(packet.body));
  }
  const packetedAt = performance.now();
  if (turns === 200) {
    const forge = buildForgePackage(archive.session, archive.messages);
    assert.equal(forge.strategy, 'FULL_EXACT_FIRST');
    assert.equal(forge.cleanExact, clean);
    assert(forge.fullExact.includes(clean));
    assert(forge.fullExact.startsWith('【会话接续】'));
    assert(forge.fullExact.endsWith('不要解释或确认以上上下文，不要提及迁移本身。'));
    assert.equal(forge.packetPlan.packets.length, 1);
    assert.equal(forge.packetPlan.packets[0].body, forge.fullExact);
    assert.equal(forge.olderHistoryCompression, null);
    assert.equal(forge.recentTurns, 20);
  }
  const end = performance.now();
  const result = { turns, inputRows: fixture.chat_messages.length, uniqueMessages: archive.messages.length,
    duplicates: fixture.expected.duplicateCount, excludedMessages: analysis.branch.excludedMessages,
    fixtureBytes: Buffer.byteLength(fixtureJson), archiveBytes: Buffer.byteLength(canonicalJson),
    fragmentChars: analysis.selected.allFragmentChars, cleanBodyChars: analysis.selected.cleanTextChars,
    cleanRatio: analysis.cleanRatio, transcriptChars: plan.fullChars, packets: plan.packets.length,
    generateAndReloadMs: generatedAt - started, normalizeAndArchiveMs: archivedAt - generatedAt,
    cleanAndRecentMs: cleanedAt - archivedAt, packetMs: packetedAt - cleanedAt, totalMs: end - started };
  results.push(result);
  console.log(`PASS QA SYNTHETIC ${turns} turns: ${result.inputRows} rows -> ${result.uniqueMessages} IDs, ${result.excludedMessages} branch messages excluded; ${result.transcriptChars} transcript chars / ${result.packets} local packets; ${result.totalMs.toFixed(1)} ms`);
}

assert.throws(() => buildExactPackets('😀'.repeat(1000), { maxChars: 1 }), /预算不足/);
assert.throws(() => buildExactPackets('x', { maxChars: 1.5 }), /正整数/);
assert.throws(() => buildRecentExact({}, { branch: { messages: [] } }, 0), /正整数/);
assert.equal(buildExactPackets('', { maxChars: 1 }).packets[0].body, '');

const report = [
  '# 本地 Synthetic Fixture 验证报告', '',
  `执行时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（Asia/Shanghai）；Node ${process.version}。`, '',
  '本报告只验证本地归档、清洗和分包实现。它不证明 DeepSeek Web 的实际输入/上下文容量，也不表示真实长窗口迁移或跨端 E2E 已验收。测试未访问网络、浏览器、用户认证、模型或真实 IndexedDB。', '',
  '## Seed 来源与实测核对', '',
  '来源是用户提供的上游 buildMarkdown 导出（evidence/phase0-session-source.md），不是服务端原始 history_messages JSON。依据当前 src/markdown.js 的包装边界提取正文，仅移除 renderer 加入的两个边界换行；没有 trim 或改写。', '',
  '| 类型 | 导出正文片段 | Unicode 码点字符 | 与真实容量报告 |',
  '| --- | ---: | ---: | --- |',
  '| REQUEST | 8 | 542 | 一致 |',
  '| RESPONSE | 3 | 6,541 | 一致 |',
  '| THINK | 3 | 2,289 | 一致 |',
  '| TEMPLATE_RESPONSE | 9 | 108 | 与全快照 OTHER 一致；当前路径为 5 条/60 字符 |', '',
  '该实测会话是总 20 条消息，当前路径 16 条消息/8 turns；不能把消息条数当作 20 turns。Markdown 缺少各消息完整 messageId/parentId，不足以逐字段还原服务器快照。Fixture 循环使用上述真实正文作为 seed，再添加明确 QA 轮号、空白/emoji/Markdown 压力内容；所有消息 ID、父链、兄弟分支、工具字段、FILE 对象和重复记录均是合成的。', '',
  '## 本地结果', '',
  '| 合成 turns | 输入行 → 唯一 ID | 排除兄弟分支 | Clean 正文字符 | Clean 保留比例 | 全文字符 | 16,384 字符分包数 | 总耗时 ms |',
  '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...results.map(result => `| ${result.turns} | ${result.inputRows} → ${result.uniqueMessages} | ${result.excludedMessages} | ${result.cleanBodyChars.toLocaleString('en-US')} | ${(result.cleanRatio * 100).toFixed(2)}% | ${result.transcriptChars.toLocaleString('en-US')} | ${result.packets} | ${result.totalMs.toFixed(1)} |`), '',
  '16,384 是测试自行指定的本地 packet 字符预算，包含每包说明包装，不是网页上限。未指定预算时，全部原文保持一个 packet；指定预算时，每包包装后字符数在预算内，全部 body 按顺序拼接与原文逐字相等。分包不扩大会话总上下文容量。', '',
  '| 合成 turns | Fixture JSON bytes | Canonical JSON bytes | 生成/JSON重读 ms | 规范化/归档 ms | 清洗/Recent ms | 分包 ms |',
  '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...results.map(result => `| ${result.turns} | ${result.fixtureBytes.toLocaleString('en-US')} | ${result.archiveBytes.toLocaleString('en-US')} | ${result.generateAndReloadMs.toFixed(1)} | ${result.normalizeAndArchiveMs.toFixed(1)} | ${result.cleanAndRecentMs.toFixed(1)} | ${result.packetMs.toFixed(1)} |`), '',
  '耗时是本次机器执行的实测值，不设脆弱性能硬阈值。JSON 字节量含数据结构；clean 字符量是 Unicode 码点，不是 tokens。', '',
  '覆盖：同 ID 最后记录获胜、不同 ID 不按文本去重、打乱消息按父链恢复顺序、排除兄弟路径、快照 ID 列表排除旧行、原样保留结构化 FILE/TOOL 字段、JSON 保存重读、两段 RESPONSE 无损合并、原样空白/CRLF/组合字符/emoji/Markdown、排除 THINK/TIP/TOOL/TEMPLATE、最近 10/20/40 turns、无预算完整原文、分包包装预算和逐字重组、Full Exact Forge 包及空的 compression hook。', '',
  'fake-indexeddb 未安装，因此没有模拟或宣称验证实际 IndexedDB save/get。这份测试验证 canonical archive 和 JSON 往返；真实扩展归档仍通过原有 IndexedDB。', '',
  '## 重跑', '',
  '在 extension 目录执行：', '',
  '```text',
  'node scripts/generate-fixtures.mjs',
  'node test-scale.mjs',
  '```', '',
  'fixtures/qa-*.synthetic.json 均明确标记 QA，含用户原始文本 seed，供本地测试使用，不导入真实归档、不作为人格记忆、不放入发布包。', '',
];
const reportPath = resolve(extensionDir, '../LOCAL_FIXTURE_REPORT.md');
writeFileSync(reportPath, report.join('\n'), 'utf8');
console.log(`PASS local fixture tests; report: ${reportPath}`);
