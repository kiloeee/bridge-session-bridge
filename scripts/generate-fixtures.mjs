// QA only: local synthetic snapshots; never import these into a real archive.
// No network, browser, authentication, or model requests are used here.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sourcePath = resolve(extensionDir, '../evidence/phase0-session-source.md');
const chars = text => Array.from(text).length;

// This parser is deliberately limited to this known buildMarkdown export for QA.
// The renderer adds exactly two boundary newlines; body text is not trimmed.
export function loadSeed(path = sourcePath) {
  const markdown = readFileSync(path, 'utf8');
  const requests = [...markdown.matchAll(/(?:^|\n)## 提问\n\n([\s\S]*?)(?=\n\n(?:> ⚠ |<details><summary>思考|## 提问|## 回答|---\n\n## 分支 |### 未识别的 fragment)|\n?$)/g)];
  const responses = [...markdown.matchAll(/(?:^|\n)## 回答\n\n([\s\S]*?)(?=\n\n(?:## 提问|### 引用来源|> ⚠ |---\n\n## 分支 |### 未识别的 fragment)|\n?$)/g)];
  const thoughts = [...markdown.matchAll(/<details><summary>思考[^<]*<\/summary>\n\n([\s\S]*?)\n\n<\/details>/g)];
  const templates = [...markdown.matchAll(/### 未识别的 fragment 类型 TEMPLATE_RESPONSE\n\n```json\n([\s\S]*?)\n```/g)];
  const request = requests.map(match => match[1]);
  const response = responses.map(match => match[1]);
  const think = thoughts.map(match => match[1]);
  const template = templates.map(match => JSON.parse(match[1]).content);
  const fragments = [
    ...requests.map(match => ({ index: match.index, type: 'REQUEST', content: match[1] })),
    ...responses.map(match => ({ index: match.index, type: 'RESPONSE', content: match[1] })),
    ...thoughts.map(match => ({ index: match.index, type: 'THINK', content: match[1] })),
    ...templates.map(match => ({ index: match.index, type: 'TEMPLATE_RESPONSE', content: JSON.parse(match[1]).content })),
  ].sort((a, b) => a.index - b.index).map(({ index, ...fragment }) => fragment);
  if (!request.length || !response.length || !think.length || !template.length) throw new Error('QA seed extraction failed; expected the supplied known Markdown export.');
  return { request, response, think, template, fragments,
    source: 'User-supplied buildMarkdown export; body seeds only. Not raw history_messages JSON.',
    counts: Object.fromEntries(Object.entries({ request, response, think, template }).map(([key, values]) => [key, { fragments: values.length, chars: values.reduce((sum, text) => sum + chars(text), 0) }])) };
}

function shuffled(values, seed) {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function generateFixture(turns, seed) {
  if (!Number.isSafeInteger(turns) || turns < 1) throw new Error('QA fixture turns must be a positive integer.');
  const sessionId = `QA-SYNTHETIC-${turns}-TURNS-NOT-REAL`;
  const messages = [], staleDuplicates = [], entries = [], selectedIds = [];
  let branchId = turns * 2 + 1;
  let duplicateCount = 0;
  const fragment = (id, type, content, extra = {}) => ({ id, type, ...(content === undefined ? {} : { content }), references: null, ...extra });
  const message = (messageId, parentId, role, fragments) => ({ message_id: messageId, parent_id: parentId, role,
    status: 'FINISHED', inserted_at: 1700000000 + messageId, fragments, model: 'qa-synthetic',
    has_pending_fragment: false, accumulated_token_usage: null, qa_synthetic: true });
  for (let turn = 1; turn <= turns; turn++) {
    const userId = turn * 2 - 1, assistantId = turn * 2;
    const suffix = `\n\n[QA SYNTHETIC turn=${turn}]  \t😀 e\u0301\r\n\`inline\`  \n`;
    const userText = seed.request[(turn - 1) % seed.request.length] + suffix;
    const responseText = seed.response[(turn - 1) % seed.response.length] + suffix;
    const responsePoints = Array.from(responseText);
    const middle = Math.floor(responsePoints.length / 2);
    const userFragments = [fragment(1, 'REQUEST', userText)];
    if (turn % 19 === 0) userFragments.unshift(fragment(2, 'FILE', { qa: true, name: 'QA-only-file.dat' }, { file_id: `qa-file-${turn}`, file_size: 123 }));
    const responseFragments = [];
    if (turn % 3 === 0) responseFragments.push(fragment(1, 'THINK', seed.think[(turn - 1) % seed.think.length], { elapsed_secs: 1.5 }));
    responseFragments.push(fragment(2, 'RESPONSE', responsePoints.slice(0, middle).join('')));
    if (turn % 7 === 0) responseFragments.push(fragment(3, 'TOOL_SEARCH', undefined, { queries: [{ query: 'QA synthetic query' }], results: [{ title: 'QA tool payload', url: 'https://invalid.example/qa', snippet: 'not conversation body' }] }));
    responseFragments.push(fragment(4, 'RESPONSE', responsePoints.slice(middle).join('')));
    if (turn % 5 === 0) responseFragments.push(fragment(5, 'TIP', 'QA synthetic fixed tip'));
    if (turn % 11 === 0) responseFragments.push(fragment(6, 'TEMPLATE_RESPONSE', seed.template[(turn - 1) % seed.template.length]));
    if (turn % 13 === 0) responseFragments.push(fragment(7, 'SEARCH', 'QA synthetic search text'));
    if (turn % 23 === 0) responseFragments.push(fragment(8, 'TOOL_OPEN', null, { result: { title: 'QA tool-open result', url: 'https://invalid.example/qa' } }));
    messages.push(message(userId, userId === 1 ? null : userId - 1, 'USER', userFragments));
    messages.push(message(assistantId, userId, 'ASSISTANT', responseFragments));
    selectedIds.push(userId, assistantId);
    entries.push({ role: 'user', messageId: userId, text: userText }, { role: 'assistant', messageId: assistantId, text: responseText });
    if (turn % 17 === 0) {
      messages.push(message(branchId++, userId, 'ASSISTANT', [fragment(1, 'RESPONSE', `QA sibling response ${turn}; must be excluded from migration`)]));
      messages.push(message(branchId++, userId, 'ASSISTANT', [fragment(1, 'TEMPLATE_RESPONSE', seed.template[0])]));
    }
    if (turn % 29 === 0) {
      // Same ID with older content occurs before its authoritative final record.
      staleDuplicates.push(message(assistantId, userId, 'ASSISTANT', [fragment(1, 'RESPONSE', `QA STALE DUPLICATE ${turn}`)]));
      duplicateCount++;
    }
  }
  return {
    qa: { synthetic: true, purpose: 'Local implementation tests only; never evidence of DeepSeek Web context capacity or real migration E2E.',
      seedSource: seed.source, seedCounts: seed.counts, generatedIdsAndBranches: true,
      privateSeedText: true, doNotImportIntoProduction: true },
    turns, sessionId,
    session: { title: `[QA SYNTHETIC] ${turns} turns`, current_message_id: turns * 2, updated_at: 1700000000 + turns * 2 },
    chat_messages: [...shuffled(staleDuplicates, turns), ...shuffled(messages, turns + 1)],
    expected: { selectedIds, entries, uniqueMessages: messages.length, duplicateCount,
      excludedMessages: messages.length - turns * 2, forks: Math.floor(turns / 17),
      cleanBodyChars: entries.reduce((sum, entry) => sum + chars(entry.text), 0) },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const seed = loadSeed(process.argv[2] || sourcePath);
  writeFileSync(resolve(extensionDir, '../evidence/phase0-text-seed.json'), JSON.stringify({
    source: seed.source,
    explanation: 'Real exported fragment text in Markdown appearance order. Renderer boundary newlines removed without trimming. No per-message server messageId/parentId; not a canonical snapshot or general Markdown import.',
    counts: seed.counts, fragments: seed.fragments,
  }, null, 2), 'utf8');
  const outputDir = resolve(extensionDir, 'fixtures');
  mkdirSync(outputDir, { recursive: true });
  console.log('QA SYNTHETIC only; local files, no Web/model traffic. Seed counts:', JSON.stringify(seed.counts));
  for (const turns of [200, 1000, 3000]) {
    const fixture = generateFixture(turns, seed);
    const filename = resolve(outputDir, `qa-${turns}-turn.synthetic.json`);
    const text = JSON.stringify(fixture);
    writeFileSync(filename, text, 'utf8');
    console.log(`${turns} turns: ${fixture.chat_messages.length} rows (${fixture.expected.duplicateCount} repeated IDs), ${Buffer.byteLength(text)} bytes -> ${filename}`);
  }
}
