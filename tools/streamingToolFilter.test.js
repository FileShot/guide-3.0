'use strict';

const assert = require('assert');
const {
  createStripBasedStreamFilter,
  createCloudStreamFilters,
  shouldHoldToolBuffer,
} = require('./streamingToolFilter');
const { stripToolCallText } = require('./toolParser');

const PROSE_PREFIX = 'I will write the game file now.\n';
const WRITE_FILE_JSON = '{"tool":"write_file","params":{"filePath":"index.html","content":"<!DOCTYPE html><html><body>hi</body></html>"}}';
const LARGE = PROSE_PREFIX + WRITE_FILE_JSON;

let tokens = [];
const filter = createStripBasedStreamFilter({
  onToken: (t) => tokens.push(t),
  onStreamEvent: () => {},
});

const part1 = LARGE.slice(0, 80);
filter.processChunk(part1);
assert.strictEqual(tokens.join(''), '', 'partial tool JSON must not forward');
assert(shouldHoldToolBuffer(part1), 'partial buffer in hold');

filter.processChunk(LARGE.slice(80));
filter.flush();
const clean = stripToolCallText(LARGE);
assert(tokens.join('').includes('I will write'), 'prose prefix forwarded after flush');
assert(!tokens.join('').includes('"tool"'), 'tool JSON not in stream');
assert.strictEqual(stripToolCallText(tokens.join('')), clean);

// Thinking channel: hold partial ask_question JSON (screenshot-1 class leak)
const ASK_PREFIX = 'Now I will call ask_question with options.\n';
const ASK_JSON =
  '{"tool":"ask_question","params":{"title":"Pick","options":[{"id":"a","label":"One"},{"id":"b","label":"Two"}]}}';
const ASK_FULL = ASK_PREFIX + ASK_JSON;

let thinkTokens = [];
const cloud = createCloudStreamFilters({
  onToken: () => {},
  onThinkingToken: (t) => thinkTokens.push(t),
  onStreamEvent: () => {},
});

const askPart = ASK_FULL.slice(0, 120);
cloud.processThinkingChunk(askPart);
assert.strictEqual(thinkTokens.join(''), '', 'partial ask_question must not reach Thought UI');
assert(shouldHoldToolBuffer(askPart), 'partial ask_question in hold');

cloud.processThinkingChunk(ASK_FULL.slice(120));
cloud.flush();
assert(thinkTokens.join('').includes('Now I will call'), 'reasoning prose kept in thinking');
assert(!thinkTokens.join('').includes('"tool"'), 'executable tool JSON not in thinking stream');
assert.strictEqual(stripToolCallText(cloud.getThinkingCleanText()), thinkTokens.join(''));

console.log('streamingToolFilter.test.js: all passed');
