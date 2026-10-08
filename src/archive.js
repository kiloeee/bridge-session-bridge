// Canonicalize one normalized server snapshot before using the existing DB.
// Last record wins by message identity; repeated wording is never a duplicate.
export function buildCanonicalSnapshot(session, messages) {
  if (typeof session?.sessionId !== 'string' || !session.sessionId.trim()) {
    throw new Error('归档缺少 sessionId。');
  }
  if (!Array.isArray(messages)) throw new Error('归档 messages 必须是数组。');
  const byId = new Map();
  for (const message of messages) {
    if (message?.sessionId !== session.sessionId) throw new Error('归档消息 sessionId 与当前会话不一致，已拒绝混合。');
    const id = message.messageId;
    if (!['string', 'number'].includes(typeof id) || !String(id).trim()
      || (typeof id === 'number' && !Number.isFinite(id))) {
      throw new Error('归档消息缺少有效 messageId。');
    }
    // Map retains first-seen ID order while set replaces that ID's contents.
    byId.set(String(id), message);
  }
  const canonicalMessages = [...byId.values()];
  return {
    session: { ...session,
      snapshotMessageIds: canonicalMessages.map(message => message.messageId),
      messageCount: canonicalMessages.length,
    },
    messages: canonicalMessages,
  };
}
