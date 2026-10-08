// Outcome 分类器验证：全部用构造证据，不访问网络。证据优先顺序是本文件的主轴。
import assert from 'node:assert/strict';
import { classifyOutcome, summarizeRequestBody, OUTCOME_TYPES } from './src/outcome.js';

const FILTER_SSE = [
  'event: ready\ndata: {"request_message_id":1,"response_message_id":2}',
  '',
  'event: data\ndata: {"v":{"response":{"status":"WANT_TO_REPLY","fragments":[{"id":1,"type":"RESPONSE","content":"部分正文"}]}}}',
  '',
  'event: data\ndata: {"p":"response","o":"BATCH","v":[{"p":"status","v":"CONTENT_FILTER"},{"p":"fragments","v":[{"id":2,"type":"TEMPLATE_RESPONSE","content":"你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。"}]}]}',
  '',
].join('\n');

const FINISHED_SSE = [
  'event: ready\ndata: {"request_message_id":1,"response_message_id":2}',
  '',
  'event: data\ndata: {"v":{"response":{"status":"FINISHED","fragments":[{"id":1,"type":"RESPONSE","content":"好的。"}]}}}',
  '',
].join('\n');

const okHistory = { last: [{ role: 'USER', status: 'FINISHED', fragmentTypes: ['REQUEST'], requestChars: [11] }, { role: 'ASSISTANT', status: 'FINISHED', fragmentTypes: ['RESPONSE'], requestChars: [] }] };
const filterHistory = { last: [{ role: 'USER', status: 'FINISHED', fragmentTypes: ['REQUEST'], requestChars: [11] }, { role: 'ASSISTANT', status: 'CONTENT_FILTER', fragmentTypes: ['TEMPLATE_RESPONSE'], requestChars: [] }] };

assert.deepEqual(OUTCOME_TYPES, ['SUCCESS', 'CONTENT_FILTER', 'TOO_LONG', 'RATE_LIMITED', 'NETWORK_ERROR', 'TRANSPORT_ERROR', 'UNKNOWN']);

// ── requestBody 摘要：不保留正文，只留长度与形状 ──
{
  const s = summarizeRequestBody(JSON.stringify({ chat_session_id: 'abc', prompt: 'x'.repeat(100), ref_file_ids: ['file-1'], search_enabled: true }));
  assert.equal(s.promptChars, 100);
  assert.equal(s.refFileIdsCount, 1);
  assert.equal(s.chatSessionId, 'abc');
  assert(!('prompt' in s), '摘要绝不包含 prompt 正文');
  assert.deepEqual(summarizeRequestBody('not-json'), { chatSessionId: null, promptChars: null, refFileIdsCount: null, topKeys: [], parseError: true });
  console.log('PASS summarizeRequestBody：只有长度/形状，无正文');
}

// ── 1. 传输完整性优先级最高 ──
{
  let r = classifyOutcome({ draftChars: 100, request: { promptChars: 100, refFileIdsCount: 1, chatSessionId: 't' }, httpStatus: 200, sseText: FINISHED_SSE, history: okHistory, sawRequest: true, sendClicked: true });
  assert.equal(r.type, 'TRANSPORT_ERROR');
  assert(/FILE_CONVERSION/.test(r.detail));
  r = classifyOutcome({ draftChars: 100, request: { promptChars: 99, refFileIdsCount: 0, chatSessionId: 't' }, httpStatus: 200, sseText: FINISHED_SSE, history: okHistory, sawRequest: true, sendClicked: true });
  assert.equal(r.type, 'TRANSPORT_ERROR');
  assert(/PROMPT_MISMATCH/.test(r.detail));
  console.log('PASS 完整性：ref_file_ids>0 与 prompt 长度不匹配都不可能 SUCCESS');
}

// ── 2. 请求未发生 ──
{
  let r = classifyOutcome({ draftChars: 10, sawRequest: false, sendClicked: true });
  assert.equal(r.type, 'TRANSPORT_ERROR');
  r = classifyOutcome({ draftChars: 10, sawRequest: false, sendClicked: false });
  assert.equal(r.type, 'TRANSPORT_ERROR');
  console.log('PASS 无请求：TRANSPORT_ERROR（点击失败或未触发）');
}

// ── 3. HTTP 层 ──
{
  let r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: 429, sseText: '{"msg":"请求过于频繁"}', sawRequest: true });
  assert.equal(r.type, 'RATE_LIMITED');
  r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: 400, sseText: '{"msg":"prompt too long, context length exceeded"}', sawRequest: true });
  assert.equal(r.type, 'TOO_LONG');
  r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: 502, sseText: '', sawRequest: true });
  assert.equal(r.type, 'NETWORK_ERROR');
  r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: 403, sseText: '{"msg":"forbidden"}', sawRequest: true });
  assert.equal(r.type, 'UNKNOWN', '非上下文类 4xx 不猜原因');
  console.log('PASS HTTP 层：429→RATE_LIMITED，context→TOO_LONG，5xx→NETWORK_ERROR，其余→UNKNOWN');
}

// ── 4. SSE 层：先发送后擦除的 CONTENT_FILTER ──
{
  const r = classifyOutcome({ draftChars: 11, request: { promptChars: 11, refFileIdsCount: 0, chatSessionId: 't' }, httpStatus: 200, sseText: FILTER_SSE, sawRequest: true, sendClicked: true });
  assert.equal(r.type, 'CONTENT_FILTER');
  assert(/模板回复/.test(r.detail));
  console.log('PASS SSE 层：BATCH 覆盖帧识别 CONTENT_FILTER + 模板话术');
}

// ── 5. SUCCESS：完整证据链一致 ──
{
  const r = classifyOutcome({ draftChars: 11, request: { promptChars: 11, refFileIdsCount: 0, chatSessionId: 't' }, httpStatus: 200, sseText: FINISHED_SSE, sawRequest: true, sendClicked: true, history: okHistory });
  assert.equal(r.type, 'SUCCESS');
  assert.equal(r.ok, true);
  // SSE FINISHED 但 history CONTENT_FILTER：以更晚的擦除为准
  const r2 = classifyOutcome({ draftChars: 11, request: { promptChars: 11, refFileIdsCount: 0 }, httpStatus: 200, sseText: FINISHED_SSE, sawRequest: true, history: filterHistory });
  assert.equal(r2.type, 'CONTENT_FILTER');
  console.log('PASS SUCCESS 判定 + history 晚到 CONTENT_FILTER 优先');
}

// ── 6. TOO_LONG / RATE_LIMITED 关键词在 SSE 正文里 ──
{
  const longSse = 'event: data\ndata: {"v":"your context length is exceeded"}\n\n';
  let r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: 200, sseText: longSse, sawRequest: true });
  assert.equal(r.type, 'TOO_LONG');
  const rateSse = 'event: data\ndata: {"v":"请求过于频繁，请稍后再试"}\n\n';
  r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: 200, sseText: rateSse, sawRequest: true });
  assert.equal(r.type, 'RATE_LIMITED');
  console.log('PASS SSE 正文关键词：TOO_LONG / RATE_LIMITED');
}

// ── 7. 流中断 / 无响应 ──
{
  let r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: null, sseText: '', streamError: 'xhr-network-error', sawRequest: true });
  assert.equal(r.type, 'NETWORK_ERROR');
  r = classifyOutcome({ draftChars: 10, request: { promptChars: 10, refFileIdsCount: 0 }, httpStatus: 200, sseText: null, sawRequest: true });
  assert.equal(r.type, 'UNKNOWN', '有请求无响应不猜');
  console.log('PASS 流中断→NETWORK_ERROR；有请求无响应→UNKNOWN');
}

console.log('全部 PASS：outcome 分类器');
