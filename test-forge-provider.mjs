// Forge provider + generational lineage: storage, JSON contract, retry, bootstrap exclusion.
// No network: fetch and chrome.storage are local stubs.
import assert from 'node:assert/strict';
import { DEFAULT_FORGE_MODEL, loadForgeConfig, saveForgeConfig, clearForgeConfig, createForgeModel } from './src/forge-provider.js';
import { getForgeState, saveForgeState, clearForgeState, armPendingMigration, takePendingMigration, excludeBootstrapEntry } from './src/forge-lineage.js';

const local = new Map();
const session = new Map();
const localWrites = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async key => ({ [key]: local.get(key) }),
      set: async patch => { for (const [key, value] of Object.entries(patch)) { localWrites.push(key); local.set(key, value); } },
      remove: async key => { local.delete(key); },
    },
    session: {
      get: async key => ({ [key]: session.get(key) }),
      set: async patch => { for (const [key, value] of Object.entries(patch)) session.set(key, value); },
      remove: async key => { session.delete(key); },
    },
  },
};

const replies = [];
globalThis.fetch = async () => {
  const next = replies.shift();
  if (next instanceof Error) throw next;
  return { ok: next.status < 400, status: next.status, json: async () => next.body };
};
const jsonReply = (content, status = 200) => ({ status, body: { choices: [{ message: { content } }] } });

// ── 配置存取 ────────────────────────────────────────────────────────────────
assert.equal(await loadForgeConfig(), null, '未配置时没有 Forge 配置');

await saveForgeConfig({ apiKey: '  sk-local  ' });
assert.deepEqual(await loadForgeConfig(), { apiKey: 'sk-local', model: DEFAULT_FORGE_MODEL, remember: true });
assert(local.has('forgeConfig') && !session.has('forgeConfig'), '「记住」写入 storage.local');

await saveForgeConfig({ apiKey: 'sk-temp', remember: false });
assert(!local.has('forgeConfig') && session.has('forgeSessionConfig'), '不勾选「记住」只写 storage.session');
assert.deepEqual(await loadForgeConfig(), { apiKey: 'sk-temp', model: DEFAULT_FORGE_MODEL, remember: false });

// 唯一的落点就是 forgeConfig：Key 不会写进别的 storage.local 记录（对话备份走 IndexedDB，不经过这里）。
assert.deepEqual([...new Set(localWrites)], ['forgeConfig'], 'storage.local 只被 forgeConfig 这个键写过');
assert(!JSON.stringify([...session.values()]).includes('sk-local'), '换写 session 时清掉了上一份 Key');

await clearForgeConfig();
assert.equal(await loadForgeConfig(), null, '移除后没有残留配置');

// ── 模型调用：JSON 解析 / 一次性重试 / 错误翻译 ─────────────────────────────
const config = { apiKey: 'sk-x', model: DEFAULT_FORGE_MODEL };
const rollPayload = { task: 'roll', chunk_index: 1, chunk_count: 2, previous_continuity: null, messages: [] };
const model = () => createForgeModel(config)(rollPayload);

replies.push(jsonReply(JSON.stringify({ continuity: { identity: [] } })));
assert.deepEqual(await model(), { continuity: { identity: [] } }, '返回的 continuity JSON 被解析出来');

replies.push(jsonReply(''), jsonReply(JSON.stringify({ continuity: { identity: [{ state: 'a' }] } })));
assert.deepEqual(await model(), { continuity: { identity: [{ state: 'a' }] } }, '空内容只重试一次并采用第二次结果');
assert.equal(replies.length, 0, '重试正好用掉一次额外请求');

replies.push(jsonReply('not json'), jsonReply(JSON.stringify({ continuity: null })));
await assert.rejects(model(), /没有生成有效结果/, '两次都拿不到有效 JSON 时给出可读错误');

replies.push(jsonReply('{}', 401));
await assert.rejects(model(), /API Key 无效/, '401 翻译成 Key 无效');
replies.push(jsonReply('{}', 402));
await assert.rejects(model(), /余额/, '402 指向账户余额');
replies.push(jsonReply('{}', 429));
await assert.rejects(model(), /稍后重试/, '429 让用户稍后重试');
replies.push(new Error('network down'));
await assert.rejects(model(), /无法连接 DeepSeek API/, '网络异常不暴露原始堆栈');

const important = createForgeModel(config);
replies.push(jsonReply(JSON.stringify({ important_message_ids: ['7', '9'] })));
assert.deepEqual(await important({ task: 'important', continuity: {}, messages: [] }), { important_message_ids: ['7', '9'] });
replies.push(jsonReply(JSON.stringify({ continuity: {} })), jsonReply(JSON.stringify({ continuity: {} })));
await assert.rejects(important({ task: 'important', continuity: {}, messages: [] }), /没有生成有效结果/, 'important 任务缺少 id 数组时不算有效结果');

// ── 代际状态 ────────────────────────────────────────────────────────────────
assert.equal(await getForgeState('B'), null);
await saveForgeState('B', { continuity: { identity: [] }, sourceSessionId: 'A', bootstrapMessageId: 'm1' });
assert.equal((await getForgeState('B')).sourceSessionId, 'A');
assert.equal((await getForgeState('B')).bootstrapMessageId, 'm1');
await clearForgeState('B');
assert.equal(await getForgeState('B'), null, '删除某一代后不再指向已消失的会话');

await armPendingMigration(42, { sourceSessionId: 'A', continuity: { identity: [] } });
assert.equal((await takePendingMigration(42)).sourceSessionId, 'A');
assert.equal(await takePendingMigration(42), null, '待绑定只认一次，之后不再重复绑定');
assert.equal(await takePendingMigration(null), null, '没有 tab id 时安全返回');

const entries = [{ messageId: 1, role: 'USER', text: 'a' }, { messageId: 2, role: 'ASSISTANT', text: 'b' }];
assert.deepEqual(excludeBootstrapEntry(entries, null).entries, entries, '没有上一代时不动入口');
const filtered = excludeBootstrapEntry(entries, '1');
assert.deepEqual(filtered.entries.map(entry => entry.messageId), [2]);
assert.equal(filtered.excluded, true, '上一代的迁移正文不会再被整理一遍');
assert.equal(excludeBootstrapEntry(entries, '99').excluded, false, '对不上任何消息时不误报');

console.log('PASS forge provider: local/session key storage, JSON contract, single retry, error translation, lineage bind, bootstrap exclusion');
