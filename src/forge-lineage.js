// Generational Forge 的产品层接线：记住「这个会话是从哪个会话 Forge 出来的」。
// 不碰 IndexedDB，也不改 forge.js —— 只用一个 chrome.storage.local 里的映射，
// 把上一代的 Continuity 交给下一代，并记住对方那条 bootstrap 消息，避免它被重复处理。

const LINEAGE_KEY = 'forgeLineage';
const PENDING_KEY = 'forgePending';

async function readLineage() {
  const stored = await chrome.storage.local.get(LINEAGE_KEY);
  return stored[LINEAGE_KEY] && typeof stored[LINEAGE_KEY] === 'object' ? stored[LINEAGE_KEY] : {};
}

async function writeLineage(lineage) {
  await chrome.storage.local.set({ [LINEAGE_KEY]: lineage });
}

export async function getForgeState(sessionId) {
  if (!sessionId) return null;
  return (await readLineage())[sessionId] || null;
}

export async function saveForgeState(sessionId, { continuity, sourceSessionId = null, bootstrapMessageId = null }) {
  if (!sessionId) throw new Error('保存 Forge 代际状态需要会话 id。');
  const lineage = await readLineage();
  lineage[sessionId] = { continuity, sourceSessionId, bootstrapMessageId, updatedAt: Date.now() };
  await writeLineage(lineage);
  return lineage[sessionId];
}

// 删掉某一代时顺手清掉它的代际记录，避免指向已不存在的会话。
export async function clearForgeState(sessionId) {
  const lineage = await readLineage();
  if (!(sessionId in lineage)) return;
  delete lineage[sessionId];
  await writeLineage(lineage);
}

// 用户点「迁移」、新窗口刚打开时登记：那个 tab 一旦被读到新 sessionId，就绑定成下一代。
export async function armPendingMigration(tabId, { sourceSessionId, continuity }) {
  if (tabId == null) return;
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] && typeof stored[PENDING_KEY] === 'object' ? stored[PENDING_KEY] : {};
  pending[tabId] = { sourceSessionId, continuity, createdAt: Date.now() };
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
}

export async function takePendingMigration(tabId) {
  if (tabId == null) return null;
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY] && typeof stored[PENDING_KEY] === 'object' ? stored[PENDING_KEY] : {};
  const entry = pending[tabId];
  if (!entry) return null;
  delete pending[tabId];
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
  return entry;
}

// bootstrap 消息就是上一代迁移包那一条 user 消息：下一代 Forge 时不能再当新内容处理，
// 否则 Continuity A 会和「Continuity A 的文字版」一起被喂进去。
export function excludeBootstrapEntry(entries, bootstrapMessageId) {
  if (!bootstrapMessageId) return { entries, excluded: false };
  const id = String(bootstrapMessageId);
  const kept = entries.filter(entry => String(entry.messageId) !== id);
  return { entries: kept, excluded: kept.length !== entries.length };
}
