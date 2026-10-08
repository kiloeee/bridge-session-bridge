// 统一迁移结果分类器。证据优先顺序：raw request → HTTP status → raw SSE → history_messages。
// 绝不根据页面中文文案猜测。所有结论都带 evidence，UNKNOWN 保留诊断不猜原因。
// 纯函数、无 Chrome 依赖，Node 测试直接跑。

import { replayStream } from './rebuild.js';

export const OUTCOME_TYPES = ['SUCCESS', 'CONTENT_FILTER', 'TOO_LONG', 'RATE_LIMITED', 'NETWORK_ERROR', 'TRANSPORT_ERROR', 'UNKNOWN'];

const CONTEXT_RE = /context (length|window|too)|too (long|large)|exceed|超出.{0,6}(长度|上限)|长度.{0,6}超出|超长/i;
const RATE_RE = /rate limit|too (many|frequent)|频繁|稍后再试|请求过快/i;

// 把 recorder 捕获的 requestBody 原始 JSON 摘成完整性证据。永不保留正文。
export function summarizeRequestBody(requestBody) {
  if (typeof requestBody !== 'string' || !requestBody) return null;
  try {
    const body = JSON.parse(requestBody);
    return {
      chatSessionId: typeof body.chat_session_id === 'string' ? body.chat_session_id : null,
      promptChars: typeof body.prompt === 'string' ? body.prompt.length : null,
      refFileIdsCount: Array.isArray(body.ref_file_ids) ? body.ref_file_ids.length : (body.ref_file_ids == null ? null : 1),
      topKeys: Object.keys(body),
    };
  } catch {
    return { chatSessionId: null, promptChars: null, refFileIdsCount: null, topKeys: [], parseError: true };
  }
}

function tooLongEvidence(text) {
  return CONTEXT_RE.test(String(text || ''));
}

function rateEvidence(text) {
  return RATE_RE.test(String(text || ''));
}

// inputs（全部可空，分类器负责处理残缺证据）：
//   draftChars         期望发出的字符数
//   request            summarizeRequestBody() 的结果 | null（没看到 completion 请求）
//   httpStatus         completion 的 HTTP status | null
//   sseText            原始 SSE 全文 | null
//   streamError        recorder 记录的流中断原因 | null
//   sawRequest         是否观察到请求（即使 requestBody 没抓到）
//   history            { last: [{role,status,fragmentTypes,requestChars}] } | null
//   sendClicked        是否成功触发了真实发送
export function classifyOutcome({
  draftChars = null, request = null, httpStatus = null, sseText = null,
  streamError = null, sawRequest = false, history = null, sendClicked = false,
}) {
  const evidence = { draftChars, request, httpStatus, streamError, historyStatus: null, historyFragmentTypes: null };
  const fail = (type, detail) => ({ type, ok: false, detail, evidence });

  // ── 1. 传输完整性：ref_file_ids 出现即 FILE_CONVERSION，绝不算成功 ──────────
  if (request && request.refFileIdsCount != null && request.refFileIdsCount > 0) {
    return fail('TRANSPORT_ERROR', `FILE_CONVERSION：请求带 ${request.refFileIdsCount} 个 ref_file_ids，正文未作为 prompt 发出`);
  }
  if (request && request.promptChars != null && draftChars != null && request.promptChars !== draftChars) {
    return fail('TRANSPORT_ERROR', `PROMPT_MISMATCH：请求 prompt ${request.promptChars} 字符 ≠ 迁移稿 ${draftChars} 字符`);
  }

  // ── 2. 请求根本没发生 ─────────────────────────────────────────────────────
  if (!sawRequest) {
    return fail('TRANSPORT_ERROR', sendClicked ? '已点击发送但未观察到 completion 请求' : '发送动作未完成，未观察到 completion 请求');
  }

  // ── 3. HTTP 层 ────────────────────────────────────────────────────────────
  if (httpStatus != null && httpStatus >= 400) {
    const body = String(sseText || '');
    let msg = '';
    try { msg = String(JSON.parse(body)?.msg || JSON.parse(body)?.message || ''); } catch { msg = body.slice(0, 200); }
    if (httpStatus === 429 || rateEvidence(msg)) return fail('RATE_LIMITED', `HTTP ${httpStatus}：${msg.slice(0, 120)}`);
    if (tooLongEvidence(msg) || httpStatus === 413) return fail('TOO_LONG', `HTTP ${httpStatus}：${msg.slice(0, 120)}`);
    if (httpStatus >= 500) return fail('NETWORK_ERROR', `HTTP ${httpStatus}（服务端异常）`);
    return fail('UNKNOWN', `HTTP ${httpStatus}：${msg.slice(0, 160)}`);
  }

  // ── 4. SSE 层（先发送、后擦除的 CONTENT_FILTER 也在这里抓到） ─────────────
  if (sseText) {
    let replay = null;
    try { replay = replayStream(sseText); } catch { replay = null; }
    if (replay) {
      evidence.status = replay.status;
      evidence.quasiStatus = replay.quasiStatus;
      if (replay.filtered) return fail('CONTENT_FILTER', replay.template ? `模板回复：${String(replay.template).slice(0, 60)}` : 'SSE 出现 CONTENT_FILTER');
      if (replay.status === 'FINISHED') return finishCheck({ history, evidence, httpStatus, sseText });
      if (tooLongEvidence(sseText)) return fail('TOO_LONG', 'SSE 中出现上下文长度错误');
      if (rateEvidence(sseText)) return fail('RATE_LIMITED', 'SSE 中出现频率限制');
    } else if (tooLongEvidence(sseText)) {
      return fail('TOO_LONG', '响应中出现上下文长度错误');
    } else if (rateEvidence(sseText)) {
      return fail('RATE_LIMITED', '响应中出现频率限制');
    }
  }

  if (streamError) return fail('NETWORK_ERROR', `流中断：${streamError}`);

  // ── 5. history 兜底（流没回放出来时最后一位证据） ─────────────────────────
  const last = history?.last?.[history.last.length - 1];
  if (last) {
    evidence.historyStatus = last.status;
    evidence.historyFragmentTypes = last.fragmentTypes;
    if (String(last.status || '').startsWith('CONTENT_FILTER')) return fail('CONTENT_FILTER', 'history 状态为 CONTENT_FILTER');
    if (last.status === 'FINISHED') {
      const integrity = request && request.promptChars != null && draftChars != null
        ? request.promptChars === draftChars : true;
      if (integrity) {
        return { type: 'SUCCESS', ok: true, detail: 'history FINISHED 且 prompt 完整', evidence };
      }
    }
  }

  return fail('UNKNOWN', sseText ? 'SSE 已收到但无法归类' : '未收到可归类的响应证据');
}

function finishCheck({ history, evidence, httpStatus, sseText }) {
  const last = history?.last?.[history.last.length - 1];
  if (last) {
    evidence.historyStatus = last.status;
    evidence.historyFragmentTypes = last.fragmentTypes;
    if (String(last.status || '').startsWith('CONTENT_FILTER')) return { type: 'CONTENT_FILTER', ok: false, detail: 'SSE FINISHED 但 history 状态为 CONTENT_FILTER', evidence };
    if (last.status && last.status !== 'FINISHED') {
      return { type: 'UNKNOWN', ok: false, detail: `SSE FINISHED 但 history 状态为 ${last.status}`, evidence };
    }
  }
  return { type: 'SUCCESS', ok: true, detail: 'SSE FINISHED 且历史一致', evidence };
}
