// Draft / Run 模型验证：revision 链、source 不回写、PII 检测、报告隐私。
// IndexedDB 在 Node 不存在：使用内存级 IDB mock（proxy 到 Map），只验证调用契约。
import assert from 'node:assert/strict';

// 最小 IDB mock：覆盖 draft.js 用到的 API。getAll/get 返回 IDBRequest 形状（onsuccess 异步触发）。
const asRequest = value => {
  const req = {};
  setTimeout(() => { req.result = value; req.onsuccess && req.onsuccess(); }, 0);
  return req;
};
function fakeIdb() {
  const stores = new Map();
  const makeIndex = (storeName, field) => ({
    getAll: async range => {
      const rows = stores.get(storeName);
      const key = range?.lower ?? null;
      return rows.filter(r => String(r[field]) === String(key));
    },
  });
  const makeStore = name => {
    if (!stores.has(name)) stores.set(name, []);
    const rows = stores.get(name);
    const keyField = name === 'drafts' ? 'draftId' : 'runId';
    return {
      put: record => {
        const i = rows.findIndex(r => String(r[keyField]) === String(record[keyField]));
        if (i >= 0) rows[i] = record; else rows.push(record);
      },
      get: key => asRequest(rows.find(r => String(r[keyField]) === String(key))),
      index: field => ({
        getAll: range => asRequest(makeIndex(name, field === 'bySession' ? 'sourceSessionId' : 'draftId').getAll(range)),
      }),
    };
  };
  globalThis.indexedDB = {
    open: () => {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: names => {
            const t = { oncomplete: null, onerror: null, onabort: null };
            // put/get 都是同步的；下一个宏任务时置 complete，模拟真实事务收尾。
            setTimeout(() => t.oncomplete && t.oncomplete(), 0);
            t.objectStore = name => makeStore(Array.isArray(names) ? names[0] : name);
            return t;
          },
        };
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  globalThis.IDBKeyRange = { only: value => ({ lower: value }) };
  return stores;
}
const stores = fakeIdb();

const { createDraft, getDraft, latestDraftFor, listDraftsFor, createRun, updateRun, getRun, scanDraftPrivacy, buildMigrationReport, formatMigrationReport } = await import('./src/draft.js');

// ── Draft：revision 自动递增 + parentDraftId 链 ──
{
  const d1 = await createDraft({ sourceSessionId: 'sA', mode: 'exact', content: '原文草稿'.repeat(10) });
  assert.equal(d1.revision, 1);
  assert.equal(d1.parentDraftId, null);
  const d2 = await createDraft({ sourceSessionId: 'sA', mode: 'exact', content: '用户修改后的草稿' });
  assert.equal(d2.revision, 2);
  assert.equal(d2.parentDraftId, d1.draftId, '修订挂到上一版');
  const other = await createDraft({ sourceSessionId: 'sB', mode: 'rolling', content: '另一个会话' });
  assert.equal(other.revision, 1, '不同 source 的 revision 独立');
  assert.equal((await latestDraftFor('sA')).draftId, d2.draftId);
  assert.equal((await getDraft(d1.draftId)).content, '原文草稿'.repeat(10), '旧 revision 不被改写');
  await assert.rejects(() => createDraft({ sourceSessionId: 'sA', mode: 'exact', content: '' }), /为空/);
  await assert.rejects(() => createDraft({ sourceSessionId: 'sA', mode: 'bad', content: 'x' }), /mode/);
  console.log('PASS Draft：revision 链 + 旧版本不可变');
}

// ── Run：状态推进 + 不回写 source ──
{
  const draft = await latestDraftFor('sA');
  const run = await createRun({ draftId: draft.draftId, sourceSessionId: 'sA', mode: 'exact', transport: 'native-composer' });
  assert.equal(run.finalStatus, 'RUNNING');
  await updateRun(run.runId, {
    targetSessionId: 'target-1', requestPromptChars: draft.chars, refFileIdsCount: 0,
    finalStatus: 'SUCCESS', completedAt: Date.now(),
  });
  const done = await getRun(run.runId);
  assert.equal(done.finalStatus, 'SUCCESS');
  assert.equal(done.refFileIdsCount, 0);
  // SOURCE 不可变：draft/run 记录都不写 sessions/messages store
  assert(!stores.has('sessions') && !stores.has('messages'), '迁移过程绝不触碰 source archive store');
  console.log('PASS Run：终态落盘，source archive store 零写入');
}

// ── PII 本地检测：确定性格式，不做审查预测 ──
{
  const scan = scanDraftPrivacy('联系我 13812345678 或 foo@bar.com，证件 11010119900307861X，key sk-abcdefghijklmnop123456');
  const kinds = scan.hits.map(h => h.kind).join(',');
  assert(scan.found);
  assert(/手机号/.test(kinds) && /邮箱/.test(kinds) && /身份证/.test(kinds) && /凭据/.test(kinds));
  assert(!scan.hits.some(h => /\d{11}|@|sk-abc/.test(h.sample)), '样例必须打码');
  assert.equal(scanDraftPrivacy('完全无害的普通文本').found, false);
  console.log('PASS PII：四类格式检测 + 打码 + 误报为零基线');
}

// ── 报告：只含诊断元数据 ──
{
  const draft = await latestDraftFor('sA');
  const run = await getRun((await createRun({ draftId: draft.draftId, sourceSessionId: 'sA', mode: 'exact', transport: 'native-composer' })).runId);
  await updateRun(run.runId, { requestPromptChars: 123, refFileIdsCount: 0, finalStatus: 'SUCCESS', targetSessionId: 't', diagnostic: { status: 'FINISHED', quasiStatus: 'FINISHED', httpStatus: 200 } });
  const fresh = await getRun(run.runId);
  const meta = buildMigrationReport({ draft, run: fresh, sourceMeta: { messageCount: 42, cleanTextChars: 1000 } });
  const text = formatMigrationReport(meta);
  for (const field of ['mode', 'provider', 'source_message_count', 'draft_chars', 'transport', 'request_prompt_chars', 'ref_file_ids_count', 'target_session_created', 'outcome', 'status', 'started_at', 'completed_at']) {
    assert(field in meta, `报告缺少字段 ${field}`);
  }
  assert.equal(meta.source_message_count, 42);
  assert.equal(meta.outcome, 'SUCCESS');
  assert(!/原文草稿|用户修改后的草稿|聊天正文/.test(text), '报告绝不包含正文');
  console.log('PASS 报告：字段齐全、零正文');
}

console.log('全部 PASS：draft/run 模型');
