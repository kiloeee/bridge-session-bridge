// 迁移决策：两阶段纯函数。
//
// 整理前（pre）：只看调用方已经算好的来源会话，判断「能不能明确确定滚动压缩不划算」。
//   命中就直接走完整原文迁移——零模型调用、零工作会话。只判能确定的情形，其余一律
//   进入正常滚动整理（保守判断，不为了用压缩而丢弃可完整保留的对话）。
// 整理后（post）：滚动稿和完整原文用同一次快照比较，谁更短就发谁。API 与网页版共用这一决策。
//
// 无网络、无模型、无 chrome 依赖。provider 只反映用户实际选择，这里绝不擅自切换。

import { countChars, buildRecentExact } from './phase0.js';
import { recentMessageIds, buildForgePacket, emptyContinuity } from './forge.js';

export const DEFAULT_RECENT_TURNS = 20;

// 32 位 FNV-1a，两个不同种子拼成 64 位。纯本地、无 crypto 依赖，够用来抓「同长度但内容变了」。
function fnv1a32(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
const hex8 = value => (value >>> 0).toString(16).padStart(8, '0');

// 来源快照指纹：只用「消息顺序 + 角色 + id + 正文」连同来源会话 id 与代际来源生成稳定本地哈希。
// 只存指纹，不复制私人正文。正文参与哈希，所以「同长度内容被改写」也会改变指纹——
// 单靠 id 集合 + cleanTextChars 会漏检这种改动。
export function snapshotFingerprint({ sessionId = '', entries = [], lineageSourceId = '' } = {}) {
  const parts = [String(sessionId), String(lineageSourceId || '')];
  for (const entry of entries) {
    parts.push(`${entry.messageId}\u0001${entry.role}\u0001${countChars(entry.text)}\u0001${entry.text}`);
  }
  const payload = parts.join('\u0002');
  return `${hex8(fnv1a32(payload, 0x811c9dc5))}${hex8(fnv1a32(payload, 0x01000193))}`;
}


// 滚动稿不可能低于的下界：framing + OUTRO + 三个段标题 + 空的 Continuity / Important 占位。
// Important / Recent 只会在其上继续增加，所以这是「固定接续开销」的可证下界。
export function rollingOverheadChars() {
  return countChars(buildForgePacket({ continuity: emptyContinuity(), importantExact: [], recentExact: '' }));
}

export function planMigration(input) {
  const phase = input?.phase;
  if (phase === 'pre') return planPre(input);
  if (phase === 'post') return planPost(input);
  throw new Error('planMigration 需要 phase 为 "pre" 或 "post"。');
}

function normalizeProvider(value) {
  return value === 'api' ? 'api' : 'web';
}

function planPre({
  requestedProvider = 'web', apiConfigured = false,
  session, analysis, fullExactChars = null, recentTurns = DEFAULT_RECENT_TURNS, fingerprint = null,
}) {
  const provider = normalizeProvider(requestedProvider);
  // API 没配置就阻断，绝不擅自改用网页版。
  if (provider === 'api' && !apiConfigured) {
    return { phase: 'pre', action: 'blocked', provider, reason: 'API_NOT_CONFIGURED' };
  }
  if (!analysis?.entries) throw new Error('planMigration(pre) 需要分析结果。');

  const recentIds = new Set(recentMessageIds(analysis, recentTurns));
  const outsideRecentCount = analysis.entries.filter(entry => !recentIds.has(String(entry.messageId))).length;
  const recentExactChars = countChars(buildRecentExact(session, analysis, recentTurns));
  const minRollingChars = rollingOverheadChars() + recentExactChars;
  const exactChars = Number.isFinite(fullExactChars) ? fullExactChars : null;

  const base = {
    phase: 'pre', provider, fingerprint,
    recentExactChars, minRollingChars, fullExactChars: exactChars, outsideRecentCount,
  };
  // 最近 recentTurns 轮已经覆盖全部待处理历史：滚动压缩没有可整理的东西。
  if (outsideRecentCount === 0) return { ...base, action: 'exact', reason: 'EXACT_NO_BENEFIT' };
  // 固定接续开销 + 必须逐字保留的最近原文已经不短于完整原文：滚动只会更大。
  if (exactChars != null && minRollingChars >= exactChars) {
    return { ...base, action: 'exact', reason: 'EXACT_NO_BENEFIT' };
  }
  return { ...base, action: 'roll', reason: 'ROLLING_ELIGIBLE' };
}

function planPost({ requestedProvider = 'web', fullExactChars = null, rollingChars = null }) {
  const provider = normalizeProvider(requestedProvider);
  const smaller = Number.isFinite(rollingChars) && Number.isFinite(fullExactChars) && rollingChars < fullExactChars;
  return {
    phase: 'post', provider,
    action: smaller ? 'send-rolling' : 'send-exact',
    reason: smaller ? 'rolling-smaller' : 'rolling-not-smaller',
    fullExactChars: fullExactChars ?? null,
    rollingChars: rollingChars ?? null,
  };
}
