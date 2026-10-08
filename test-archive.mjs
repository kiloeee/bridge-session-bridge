import assert from 'node:assert/strict';
import { buildCanonicalSnapshot } from './src/archive.js';

const session = { sessionId: 'archive-fixture', title: 'fixture', snapshotCapturedAt: 123,
  snapshotMessageIds: ['old'], messageCount: 99 };
const message = (messageId, text, extra = {}) => ({ sessionId: session.sessionId, messageId,
  fragments: [{ type: 'REQUEST', content: text, customField: { preserved: true } }], ...extra });
const repeatedWords = [message(1, '同一句话'), message(2, '同一句话')];
const repeated = buildCanonicalSnapshot(session, repeatedWords);
assert.deepEqual(repeated.session.snapshotMessageIds, [1, 2]);
assert.equal(repeated.session.messageCount, 2);
assert.equal(repeated.session.snapshotCapturedAt, 123);
assert.equal(session.messageCount, 99);
assert.strictEqual(repeated.messages[0].fragments, repeatedWords[0].fragments);
console.log('PASS same words with different IDs are retained; fragment fields and capture time preserved');

const updated = message(1, '同 ID 的更新正文', { status: 'FINISHED' });
const snapshot = buildCanonicalSnapshot(session, [...repeatedWords, updated]);
assert.deepEqual(snapshot.session.snapshotMessageIds, [1, 2]);
assert.equal(snapshot.session.messageCount, 2);
assert.strictEqual(snapshot.messages[0], updated);
assert.strictEqual(snapshot.messages[1], repeatedWords[1]);
const idAsString = message('1', '最后一个同 ID 记录');
assert.strictEqual(buildCanonicalSnapshot(session, [updated, idAsString]).messages[0], idAsString);
console.log('PASS last record wins per message ID with stable first-seen ID order');

assert.throws(() => buildCanonicalSnapshot(session, [message(1, 'wrong', { sessionId: 'another-session' })]), /sessionId/);
assert.throws(() => buildCanonicalSnapshot(session, [message(undefined, 'missing ID')]), /messageId/);
assert.throws(() => buildCanonicalSnapshot(session, [message('', 'empty ID')]), /messageId/);
assert.equal(buildCanonicalSnapshot(session, []).session.messageCount, 0);
console.log('PASS other session and missing IDs rejected; empty snapshot remains valid');
