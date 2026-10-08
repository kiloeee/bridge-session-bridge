// Forge Semantic E2E 的本地 companion backend（测试专用，不属于扩展运行时）。
// 通过 --backend-module 由 forge-cli / rollupForge 注入；扩展本身不发任何模型请求。
// 凭证只从环境变量读取，绝不落盘、绝不进入扩展代码。
// 每次出站请求体都会写入 .capture/，用于验证「真正发出去的」合同与 schema。
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const captureDir = resolve(here, '.capture');

const BASE = process.env.ANTHROPIC_BASE_URL;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.FORGE_E2E_MODEL || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5';
const SESSION = `forge-e2e-${Date.now()}`;
let seq = 0;

const SYSTEM = [
  '你现在是 Forge 的语义状态更新器（本地测试 companion，不是产品运行时）。',
  '严格执行 FORGE_CONTRACT：把 previous_continuity 更新为「当前仍有效的状态」。',
  '允许并鼓励：取代、解决、作废、合并语义重复、删除 stale 条目。',
  '未被新证据推翻的长期状态必须保留；长期字段宁可少而准，也不要把整段历史堆进去。',
  '禁止：普通摘要、按时间复述、无脑追加、把猜测写成事实、引用不存在或捏造的 source_message_ids。',
  '只输出 JSON，不要 markdown 代码块，不要任何解释，不要展开推理。',
].join('\n');

function renderBody(request) {
  if (request.task === 'roll') {
    return [
      `任务：roll（第 ${request.chunk_index}/${request.chunk_count} 块）`,
      '',
      'FORGE_CONTRACT:',
      JSON.stringify(request.contract, null, 2),
      '',
      '输出 schema（字段必须原样使用）:',
      request.schema,
      '',
      'previous_continuity:',
      JSON.stringify(request.previous_continuity, null, 2),
      '',
      'messages（当前 chunk，按时间顺序）:',
      JSON.stringify(request.messages, null, 2),
      '',
      '只输出：{"continuity": {"identity": [], "stableFacts": [], "activeThreads": [], "decisions": [], "openLoops": [], "recentChanges": [], "interactionPreferences": []}}',
    ].join('\n');
  }
  return [
    '任务：important',
    '',
    'FORGE_IMPORTANT_CONTRACT:',
    JSON.stringify(request.contract, null, 2),
    '',
    'continuity（当前状态）:',
    JSON.stringify(request.continuity, null, 2),
    '',
    `messages（全部 clean entries，正文截断到 80 字；最多挑 ${request.max_important} 条最重要的 id）:`,
    JSON.stringify(request.messages.map(m => ({ messageId: m.messageId, role: m.role, text: String(m.content).slice(0, 80) })), null, 2),
    '',
    '只输出：{"important_message_ids": ["1"]}',
  ].join('\n');
}

export default async function (request) {
  if (!BASE || !KEY) throw new Error('缺少 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY（本地测试 backend 需要）。');
  const body = {
    model: MODEL, max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: renderBody(request) }],
  };
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(resolve(captureDir, `${String(++seq).padStart(2, '0')}-${request.task}.json`), JSON.stringify(body), 'utf8');
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'x-opencode-session': SESSION, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { lastError = new Error(`backend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); continue; }
    const json = await res.json();
    const blocks = json.content || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    // 推理模型偶尔把最终 JSON 留在 thinking 块里；text 为空时回退到 thinking。
    const source = text.trim() ? text : blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');
    const start = source.indexOf('{'), end = source.lastIndexOf('}');
    if (start < 0 || end < 0) { lastError = new Error(`backend 未返回 JSON（stop_reason=${json.stop_reason}, usage=${JSON.stringify(json.usage)}）：${source.slice(0, 160)}`); continue; }
    try { return JSON.parse(source.slice(start, end + 1)); }
    catch (error) { lastError = new Error(`backend 返回的 JSON 无法解析：${error.message} ← ${source.slice(start, start + 160)}`); }
  }
  throw lastError;
}
