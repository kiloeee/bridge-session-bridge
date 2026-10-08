import assert from 'node:assert/strict';
import { analyzeCapacity, buildCleanTranscript, countChars, messagesForSnapshot, formatCapacityReport } from './src/phase0.js';
import { normalizeMessages } from './src/normalize.js';

const fragment = (type, content, extra = {}) => ({ type, content, ...extra });
const message = (messageId, parentId, fragments, createdAt = messageId) => ({ messageId, parentId, createdAt, fragments });
const messages = [
  message(1, null, [fragment('REQUEST', '  你好\n😀  ')]),
  message(2, 1, [fragment('THINK', '思考'), fragment('RESPONSE', '旧回复，不应进入正文')]),
  message(3, 1, [fragment('THINK', '想'), fragment('RESPONSE', '原文\n'), fragment('RESPONSE', '继续  '),
    fragment('SEARCH', '搜索'), fragment('TOOL_SEARCH', '', { results: [{ title: '搜索附加字段' }] }),
    fragment('TOOL_OPEN', '工具'), fragment('TIP', '提示'), fragment('FILE', '文件')]),
  message(4, 3, [fragment('REQUEST', '下一问')]),
  message(5, 4, [fragment('RESPONSE', '下一答')]),
];
const session = { sessionId: 'fixture-only', title: 'fixture', currentMessageId: 5 };
const analysis = analyzeCapacity(session, messages);
assert.deepEqual(analysis.branch.messages.map(message => message.messageId), [1, 3, 4, 5]);
assert.equal(analysis.branch.excludedMessages, 1);
assert.equal(analysis.branch.inferred, false);
assert.equal(analysis.selected.cleanTextChars, countChars('  你好\n😀  原文\n继续  下一问下一答'));
assert.equal(analysis.selected.groups.TOOL.chars, 2);
assert.equal(analysis.selected.groups.TOOL.fragments, 2);
assert.equal(analysis.selected.groups.SEARCH.chars, 2);
assert.equal(analysis.totalTurns, 2);
assert.equal(analysis.recentTurns[0].chars, analysis.selected.cleanTextChars);
assert(analysis.otherJsonChars > 0);
assert.equal(analysis.normalizedJsonChars, analysis.otherJsonChars + analysis.encodedContentJsonChars);
const transcript = buildCleanTranscript(session, analysis);
assert(transcript.includes('  你好\n😀  '));
assert(transcript.includes('原文\n继续  '));
assert(!transcript.includes('旧回复'));
assert(!transcript.includes('搜索附加字段'));
assert(!transcript.includes('思考'));
assert.equal(countChars('😀汉\n'), 3);
assert.deepEqual(analysis.latestUser, { messageId: 4, bodyChars: 3 });
assert(formatCapacityReport(session, analysis).includes(`${countChars(transcript).toLocaleString('zh-CN')} 字符`));
console.log('PASS single branch, exact text, all fragment groups, JSON distinction, Unicode chars');

const many = [];
for (let turn = 0; turn < 45; turn++) {
  const id = turn * 2 + 1;
  many.push(message(id, id === 1 ? null : id - 1, [fragment('REQUEST', '问')]));
  many.push(message(id + 1, id, [fragment('RESPONSE', '回答')]));
}
const recent = analyzeCapacity({ currentMessageId: 90 }, many);
assert.deepEqual(recent.recentTurns.map(turns => turns.chars), [30, 60, 120]);
assert.equal(recent.selected.cleanTextChars, 135);
assert.equal(buildCleanTranscript({ title: 'all', sessionId: 'fixture' }, recent).match(/## 用户/g).length, 45);
console.log('PASS 10/20/40 turns and full export without clipping');

const fallback = analyzeCapacity({}, messages);
assert.equal(fallback.branch.inferred, true);
assert.equal(fallback.branch.selectedMessageId, 5);
assert.deepEqual(fallback.branch.messages.map(message => message.messageId), [1, 3, 4, 5]);
const broken = analyzeCapacity({ currentMessageId: 9 }, [message(9, 99, [fragment('RESPONSE', '孤立')])]);
assert.equal(broken.branch.warnings.length, 1);
assert.equal(broken.totalTurns, 0);
assert.equal(broken.unpairedAssistantChars, 2);
console.log('PASS inferred latest leaf and explicit incomplete parent-chain warning');

const snapshotSession = { ...session, snapshotMessageIds: [1, 3, 4, 5], messageCount: 4 };
assert.deepEqual(messagesForSnapshot(snapshotSession, messages).map(message => message.messageId), [1, 3, 4, 5]);
assert.throws(() => messagesForSnapshot({ ...snapshotSession, snapshotMessageIds: [1, 9] }, messages));
assert.throws(() => messagesForSnapshot(session, messages));
const nonText = analyzeCapacity({ currentMessageId: 1 }, [message(1, null, [fragment('REQUEST', { text: '不能假称原文' })])]);
assert.equal(nonText.selected.nonTextContents, 1);
assert.throws(() => buildCleanTranscript({ sessionId: 'fixture' }, nonText), /非字符串/);
const originalContents = ['  原文\n😀  ', 0, null, { text: '对象' }];
const normalized = normalizeMessages('fixture', [{ message_id: 1, fragments: originalContents.map(content => fragment('REQUEST', content)) }]);
assert.deepEqual(normalized[0].fragments.map(fragment => fragment.content), originalContents);
const missingToolContent = normalizeMessages('fixture', [{ message_id: 7, fragments: [{ type: 'TOOL_FIND', id: 1 }] }]);
assert.equal(missingToolContent[0].fragments[0].content, undefined);
assert.equal(analyzeCapacity({ currentMessageId: 7 }, missingToolContent).selected.groups.TOOL.chars, 0);
const fileOnly = analyzeCapacity({ currentMessageId: 2 }, [
  { ...message(1, null, [fragment('FILE', '文件')]), role: 'USER' },
  message(2, 1, [fragment('RESPONSE', '回答')]),
]);
assert.equal(fileOnly.totalTurns, 1);
assert.equal(fileOnly.recentTurns[0].chars, 2);
console.log('PASS latest snapshot excludes stale rows, nonstring text rejects export, file-only USER starts turn');
