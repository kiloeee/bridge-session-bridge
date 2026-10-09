// Forge 语义模型 Provider（第一版只接 DeepSeek API）。
// 职责刻意很窄：存取配置、申请权限、测试连接、把 forge.js 交给 model() 的 payload
// 序列化成一次 API 调用，再把模型返回的 JSON 交回去。
// 这里不做 schema 校验、不改写结果——source id 校验、去重、有界化全部仍在 forge.js。

const LOCAL_KEY = 'forgeConfig';
const SESSION_KEY = 'forgeSessionConfig';
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODELS_ENDPOINT = 'https://api.deepseek.com/models';
const API_ORIGINS = { origins: ['https://api.deepseek.com/*'] };

export const DEFAULT_FORGE_MODEL = 'deepseek-flash';

// 「记住」写入 storage.local（跨浏览器会话）；取消勾选则写 storage.session（只活当前会话）。
export async function loadForgeConfig() {
  const local = await chrome.storage.local.get(LOCAL_KEY);
  if (local[LOCAL_KEY]?.apiKey) return { ...local[LOCAL_KEY], remember: true };
  const session = await chrome.storage.session.get(SESSION_KEY);
  if (session[SESSION_KEY]?.apiKey) return { ...session[SESSION_KEY], remember: false };
  return null;
}

export async function saveForgeConfig({ apiKey, model = DEFAULT_FORGE_MODEL, remember = true }) {
  const config = {
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim() || DEFAULT_FORGE_MODEL,
  };
  if (!config.apiKey) throw new Error('请填写 DeepSeek API Key。');
  await clearForgeConfig();
  await (remember ? chrome.storage.local : chrome.storage.session).set({ [remember ? LOCAL_KEY : SESSION_KEY]: config });
  return config;
}

export async function clearForgeConfig() {
  await chrome.storage.local.remove(LOCAL_KEY);
  await chrome.storage.session.remove(SESSION_KEY);
}

export function hasApiPermission() {
  return chrome.permissions.contains(API_ORIGINS);
}

export function requestApiPermission() {
  return chrome.permissions.request(API_ORIGINS);
}

async function readError(response) {
  let detail = '';
  try {
    const data = await response.json();
    detail = String(data?.error?.message || data?.message || '');
  } catch { /* 错误体不是 JSON 就算了 */ }
  if (response.status === 401 || response.status === 403) return 'API Key 无效，请重新检查。';
  if (response.status === 402) return '当前 API 无法调用，请检查 DeepSeek API 账户余额。';
  if (response.status === 429) return '请求过于频繁，请稍后重试。';
  if (response.status >= 500) return 'DeepSeek API 暂时不可用，请稍后重试。';
  return `DeepSeek API 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}。`;
}

async function callApi(config, body, signal) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('无法连接 DeepSeek API，请检查网络后重试。');
  }
  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

// 连接测试：先用免费的 /models 验证 Key，旧账号不支持时退化成一次最小补全。
export async function testConnection(config) {
  let response;
  try {
    response = await fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  } catch {
    throw new Error('无法连接 DeepSeek API，请检查网络后重试。');
  }
  if (response.ok) return true;
  if (response.status !== 404) throw new Error(await readError(response));
  await callApi(config, {
    model: config.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    thinking: { type: 'disabled' },
  }, null);
  return true;
}

const ROLL_SYSTEM = [
  '你在维护一份跨窗口延续用的「持续状态」。这是状态更新，不是摘要。',
  '只输出 JSON：{"continuity": {"identity": [...], "stableFacts": [...], "activeThreads": [...], "decisions": [...], "openLoops": [...], "recentChanges": [...], "interactionPreferences": [...]}, "important_message_ids": [...]}。',
  '每个字段是数组，每条形如 {"state": "一句话状态", "source_message_ids": ["消息id"]}。',
  '必须就地更新、取代、解决或作废已有条目，而不是每块都追加新条目；语义重复的条目合并，source_message_ids 取并集。',
  '新条目只能引用给的 previous_continuity 或本块 messages 里真实存在的 id，不得凭空捏造。',
  '不要写普通摘要，不要按时间顺序复述对话，不要把猜测写成事实。',
  '另外，在本块里挑出最多 2 条最值得逐字保留的消息，放进同一份 JSON 的 "important_message_ids"（只能给本块真实存在的 id，宁少勿多，可以给 0 条）。',
].join('\n');

const IMPORTANT_SYSTEM = [
  '你要从整段对话里挑出对后续对话仍然重要、值得逐字保留的消息 id。',
  '只输出 JSON：{"important_message_ids": ["消息id"]}。',
  '只返回已存在的 id，不要复述或改写正文，也不要返回正文文本。',
  '宁可少而准：最近的消息已经单独保留，不要把它们重复标成重要。',
].join('\n');

function userContent(payload) {
  if (payload.task === 'important') {
    return JSON.stringify({
      continuity: payload.continuity,
      messages: payload.messages,
      max_important: payload.max_important,
    });
  }
  return JSON.stringify({
    previous_continuity: payload.previous_continuity,
    messages: payload.messages,
  });
}

function parseModelJson(text, task) {
  if (!text.trim()) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (task === 'important') {
    return Array.isArray(data.important_message_ids) ? data : null;
  }
  return data.continuity && typeof data.continuity === 'object' ? data : null;
}

// 返回 forge.js 已经要求的那一个 model(payload)；它拿到的还是原来的 payload，权力没有变大。
export function createForgeModel(config, { signal = null, onProgress = null } = {}) {
  return async payload => {
    if (payload?.task === 'important') onProgress?.({ phase: 'important' });
    else onProgress?.({ phase: 'roll', index: payload?.chunk_index, total: payload?.chunk_count });

    const body = {
      model: config.model || DEFAULT_FORGE_MODEL,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        { role: 'system', content: payload?.task === 'important' ? IMPORTANT_SYSTEM : ROLL_SYSTEM },
        { role: 'user', content: userContent(payload) },
      ],
    };

    const parsed = parseModelJson(await callApi(config, body, signal), payload?.task);
    if (parsed) return parsed;
    // JSON Output 偶尔返回空内容：只重试一次，不做重试框架。
    const retried = parseModelJson(await callApi(config, body, signal), payload?.task);
    if (retried) return retried;
    throw new Error('Forge 这次没有生成有效结果，请重试。');
  };
}
