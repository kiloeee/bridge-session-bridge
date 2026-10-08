// MigrationDraft / MigrationRun 域逻辑与隐私规则。
// SOURCE（archive）永远只读；本文件只管「这次准备发什么（Draft）」与「这次真发发生了什么（Run）」。
// 用户修改 Draft 产生新 revision（parentDraftId 链），绝不回写 source。
// IndexedDB 由 db.js 统一持有（版本所有权单一，避免多模块版本竞争死锁）。

import { putDraft, draftById, draftsBySession, putRun, runById, runsBySession } from './db.js';

const newId = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

// ── Draft ───────────────────────────────────────────────────────────────────
export async function createDraft({ sourceSessionId, mode, content, parentDraftId = null, metadata = {} }) {
  if (!sourceSessionId) throw new Error('Draft 需要 sourceSessionId。');
  if (!['exact', 'rolling'].includes(mode)) throw new Error('Draft mode 必须是 exact 或 rolling。');
  if (typeof content !== 'string' || !content.length) throw new Error('Draft 内容为空。');
  const latest = await latestDraftFor(sourceSessionId);
  const draft = {
    draftId: newId('draft'),
    sourceSessionId,
    mode,
    content,
    chars: content.length,
    createdAt: Date.now(),
    revision: (latest?.revision || 0) + 1,
    parentDraftId: parentDraftId || latest?.draftId || null,
    metadata,
  };
  await putDraft(draft);
  return draft;
}

export async function getDraft(draftId) {
  return draftById(draftId);
}

export async function latestDraftFor(sourceSessionId) {
  const drafts = await listDraftsFor(sourceSessionId);
  return drafts.length ? drafts[drafts.length - 1] : null;
}

export async function listDraftsFor(sourceSessionId) {
  return draftsBySession(sourceSessionId);
}

// ── Run ─────────────────────────────────────────────────────────────────────
export async function createRun({ draftId, sourceSessionId, mode, transport }) {
  if (!draftId) throw new Error('Run 需要 draftId。');
  const run = {
    runId: newId('run'),
    draftId,
    sourceSessionId,
    mode,
    transport,
    startedAt: Date.now(),
    completedAt: null,
    targetSessionId: null,
    requestPromptChars: null,
    refFileIdsCount: null,
    finalStatus: 'RUNNING',
    errorClass: null,
    revisionCount: 1,
    diagnostic: {},
  };
  await putRun(run);
  return run;
}

export async function updateRun(runId, patch) {
  const run = await runById(runId);
  if (!run) throw new Error(`Run ${runId} 不存在。`);
  const next = { ...run, ...patch };
  await putRun(next);
  return next;
}

export async function getRun(runId) {
  return runById(runId);
}

export async function listRunsFor(sourceSessionId) {
  return runsBySession(sourceSessionId);
}

// ── 本地隐私提醒（不是审查原因预测） ─────────────────────────────────────────
// 只做确定性格式检测；命中只报「类型 + 次数 + 打码样例」，正文永不离开本机。
const PII_PATTERNS = [
  { kind: '身份证号（18 位格式）', re: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
  { kind: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: '疑似 API Key / 凭据', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{16,})\b/g },
];

function maskSample(text) {
  if (text.length <= 6) return '•'.repeat(text.length);
  return `${text.slice(0, 3)}•••${text.slice(-2)}`;
}

export function scanDraftPrivacy(content) {
  const hits = [];
  for (const { kind, re } of PII_PATTERNS) {
    const matches = [...String(content || '').matchAll(re)];
    if (matches.length) hits.push({ kind, count: matches.length, sample: maskSample(matches[0][0]) });
  }
  return { found: hits.length > 0, hits };
}

// ── 迁移报告（只含诊断元数据，绝不含正文 / Key / token） ────────────────────
export function buildMigrationReport({ draft, run, sourceMeta = {} }) {
  return {
    mode: draft?.mode || run?.mode || null,
    provider: draft?.metadata?.provider || null,
    source_message_count: sourceMeta.messageCount ?? null,
    source_chars: sourceMeta.cleanTextChars ?? null,
    draft_chars: draft?.chars ?? null,
    draft_revision: draft?.revision ?? null,
    transport: run?.transport || 'native-composer',
    request_prompt_chars: run?.requestPromptChars ?? null,
    ref_file_ids_count: run?.refFileIdsCount ?? null,
    target_session_created: !!run?.targetSessionId,
    outcome: run?.finalStatus || null,
    status: run?.diagnostic?.status ?? null,
    quasi_status: run?.diagnostic?.quasiStatus ?? null,
    revision_count: draft?.revision ?? null,
    rolling_chunks: draft?.metadata?.chunks ?? null,
    worker_sessions_count: draft?.metadata?.workerSessions ?? null,
    started_at: run?.startedAt ? new Date(run.startedAt).toISOString() : null,
    completed_at: run?.completedAt ? new Date(run.completedAt).toISOString() : null,
  };
}

// 报告的人类可读版（复制给开发者排查用；同样只有元数据）
export function formatMigrationReport(meta) {
  const line = (label, value) => (value == null ? null : `${label}：${value}`);
  return [
    '桥 · 迁移诊断报告', '',
    line('方式', meta.mode === 'exact' ? '完整原文' : meta.mode === 'rolling' ? '滚动压缩' : meta.mode),
    line('整理提供方', meta.provider),
    line('源会话消息数', meta.source_message_count),
    line('源会话正文字符', meta.source_chars),
    line('迁移稿字符', meta.draft_chars),
    line('迁移稿版本', meta.draft_revision),
    line('传输', meta.transport),
    line('实际发出 prompt 字符', meta.request_prompt_chars),
    line('附件引用数', meta.ref_file_ids_count),
    line('新会话已建立', meta.target_session_created ? '是' : '否'),
    line('结果', meta.outcome),
    line('SSE status', meta.status),
    line('SSE quasi_status', meta.quasi_status),
    line('滚动分段数', meta.rolling_chunks),
    line('临时整理会话数', meta.worker_sessions_count),
    line('开始时间', meta.started_at),
    line('结束时间', meta.completed_at),
  ].filter(l => l !== null).join('\n');
}
