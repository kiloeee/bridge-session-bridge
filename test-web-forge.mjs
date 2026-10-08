// WebForgeProvider 合同验证：prompt 渲染、JSON 提取、错误类别传递、checkpoint 恢复。
// 全部本地构造，无网络、无 chrome。
import assert from 'node:assert/strict';
import { renderForgePrompt, extractModelJson, createWebForgeModel, initialForgeJob, resumeForgeInput } from './src/web-forge.js';
import { emptyContinuity } from './src/forge.js';

// ── prompt 渲染：roll 任务带 previous_continuity + messages，important 带 max_important ──
{
  const continuity = emptyContinuity();
  continuity.identity.push({ state: '用户是工程师', source_message_ids: ['1'] });
  const payload = {
    task: 'roll', chunk_index: 2, chunk_count: 5, previous_continuity: continuity,
    messages: [{ messageId: '3', role: 'user', content: '问题' }],
  };
  const prompt = renderForgePrompt(payload);
  assert(prompt.includes('持续状态') && prompt.includes('状态更新'), '合同要点在 prompt 里');
  assert(prompt.includes('"previous_continuity"') && prompt.includes('"messages"'), 'payload 序列化完整');
  assert(prompt.includes('important_message_ids') === false, 'roll 任务不混入 important 指令');
  const ip = renderForgePrompt({ task: 'important', continuity, messages: [{ messageId: '3', role: 'user', content: 'x' }], max_important: 12 });
  assert(ip.includes('important_message_ids') && ip.includes('"max_important":12'));
  assert(!ip.includes('previous_continuity'), 'important 任务不带 previous_continuity');
  console.log('PASS renderForgePrompt：两种任务渲染各自的合同');
}

// ── RESPONSE → JSON 提取：容忍围栏与闲话，形状校验 ──
{
  const good = '好的，以下是结果：\n```json\n{"continuity": {"identity": [{"state": "x", "source_message_ids": ["1"]}]}}\n```\n以上。';
  const parsed = extractModelJson(good, 'roll');
  assert(parsed?.continuity?.identity?.length === 1);
  assert.equal(extractModelJson('{"important_message_ids": ["3"]}', 'important')?.important_message_ids[0], '3');
  assert.equal(extractModelJson('{"important_message_ids": "3"}', 'important'), null, '形状不对返回 null');
  assert.equal(extractModelJson('{"continuity": []}', 'roll'), null, 'continuity 必须是对象');
  assert.equal(extractModelJson('没有 JSON', 'roll'), null);
  assert.equal(extractModelJson('', 'roll'), null);
  console.log('PASS extractModelJson：围栏/闲话容忍 + 形状校验');
}

// ── createWebForgeModel：成功路径 / 重试一次 / 错误类别透传 ──
{
  const continuityJson = JSON.stringify({ continuity: emptyContinuity() });
  const replies = ['这不是 JSON 输出', continuityJson]; // 第一次解析失败，第二次成功
  const calls = [];
  const model = createWebForgeModel({ call: async input => { calls.push(input); return { ok: true, response: replies[calls.length - 1] ?? continuityJson }; } });
  const out = await model({ task: 'roll', previous_continuity: emptyContinuity(), messages: [] });
  assert(out.continuity);
  assert.equal(calls.length, 2, '解析失败恰好重试一次');

  const errModel = createWebForgeModel({ call: async () => ({ ok: false, errorClass: 'CONTENT_FILTER', detail: '被拦' }) });
  await assert.rejects(() => errModel({ task: 'roll', previous_continuity: emptyContinuity(), messages: [] }),
    err => err.errorClass === 'CONTENT_FILTER', 'worker CONTENT_FILTER 透传给 runner');

  const rateModel = createWebForgeModel({ call: async () => ({ ok: false, errorClass: 'RATE_LIMITED', detail: '429' }) });
  await assert.rejects(() => rateModel({ task: 'roll', previous_continuity: emptyContinuity(), messages: [] }),
    err => err.errorClass === 'RATE_LIMITED');
  console.log('PASS createWebForgeModel：重试一次 + 错误类别透传');
}

// ── checkpoint 恢复：只喂未处理 entries，continuity 接续 ──
{
  const job = initialForgeJob({ sourceSessionId: 's1', chunkChars: 12000 });
  job.chunkIndex = 3;
  job.chunkCount = 9;
  job.processedMessageIds = ['1', '2', '3', '4'];
  const continuity = emptyContinuity();
  continuity.identity.push({ state: '已处理到第3块', source_message_ids: ['4'] });
  job.continuity = continuity;
  const entries = [
    { messageId: '3', role: 'user', text: '已处理' },
    { messageId: '4', role: 'assistant', text: '已处理' },
    { messageId: '5', role: 'user', text: '待处理' },
    { messageId: '6', role: 'assistant', text: '待处理' },
  ];
  const { remaining, previousContinuity, resumedFromChunk } = resumeForgeInput(job, entries);
  assert.deepEqual(remaining.map(e => e.messageId), ['5', '6'], '已处理的块绝不重跑');
  assert.equal(previousContinuity.identity[0].state, '已处理到第3块');
  assert.equal(resumedFromChunk, 3, '段计数接续，不从头跑');
  console.log('PASS resumeForgeInput：断点续跑只喂剩余 entries');
}

console.log('全部 PASS：web-forge 合同');
