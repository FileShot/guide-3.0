'use strict';

const assert = require('assert');
const {
  createStripBasedStreamFilter,
  createCloudStreamFilters,
  shouldHoldToolBuffer,
} = require('./streamingToolFilter');
const { stripToolCallText } = require('./toolParser');

function simulateStream(filter, text, chunkSize = 8) {
  const tokens = [];
  const wrapped = createStripBasedStreamFilter({
    onToken: (t) => tokens.push(t),
    ...(typeof filter === 'object' && filter.onToken ? {} : {}),
  });
  const f = filter.processChunk ? filter : wrapped;
  const process = filter.processChunk ? (c) => filter.processChunk(c) : (c) => wrapped.processChunk(c);
  const flushFn = filter.flush ? () => filter.flush() : () => wrapped.flush();
  let visibleLen = 0;
  const track = createStripBasedStreamFilter({
    onToken: (t) => {
      tokens.push(t);
      visibleLen += t.length;
    },
  });
  for (let i = 0; i < text.length; i += chunkSize) {
    track.processChunk(text.slice(i, i + chunkSize));
  }
  track.flush();
  return { tokens: tokens.join(''), visibleLen: track.getVisibleChars() };
}

// ── Basic hold + forward after flush ──
const PROSE_PREFIX = 'I will write the game file now.\n';
const WRITE_FILE_JSON = '{"tool":"write_file","params":{"filePath":"index.html","content":"<!DOCTYPE html><html><body>hi</body></html>"}}';
const LARGE = PROSE_PREFIX + WRITE_FILE_JSON;

let tokens = [];
const filter = createStripBasedStreamFilter({
  onToken: (t) => tokens.push(t),
});

const part1 = LARGE.slice(0, 80);
filter.processChunk(part1);
assert.strictEqual(tokens.join(''), '', 'partial tool JSON must not forward');
assert(shouldHoldToolBuffer(part1), 'partial buffer in hold');

filter.processChunk(LARGE.slice(80));
filter.flush();
assert(tokens.join('').includes('I will write'), 'prose prefix forwarded after flush');
assert(!tokens.join('').includes('"tool"'), 'tool JSON not in stream');

// ── Monotonic visible length invariant ──
function assertMonotonicStream(label, streamFn) {
  let maxVisible = 0;
  const seen = [];
  const f = createStripBasedStreamFilter({
    onToken: (t) => {
      seen.push(t);
      const total = seen.join('').length;
      assert(total >= maxVisible, `${label}: visible length decreased ${maxVisible} -> ${total}`);
      maxVisible = total;
    },
  });
  streamFn(f);
  f.flush();
}

assertMonotonicStream('write_file burst', (f) => {
  for (let i = 0; i < LARGE.length; i += 5) f.processChunk(LARGE.slice(i, i + 5));
});

// ── Screenshot regression: prose prefix must survive tool JSON in same stream ──
const SCREENSHOT_PREFIX =
  'The multi-page website plan has been created. Now call ';
const SCREENSHOT_REHEARSAL = 'read_file. We need to produce the tool call JSON. ';
const UPDATE_TODO_JSON =
  '```json\n{"tool":"update_todo","params":{"id":1,"status":"done","text":"Define site structure"}}\n```';
const SCREENSHOT_STREAM = SCREENSHOT_PREFIX + SCREENSHOT_REHEARSAL + UPDATE_TODO_JSON;

let screenshotTokens = [];
const screenshotFilter = createStripBasedStreamFilter({
  onToken: (t) => screenshotTokens.push(t),
});
for (let i = 0; i < SCREENSHOT_STREAM.length; i += 12) {
  screenshotFilter.processChunk(SCREENSHOT_STREAM.slice(i, i + 12));
}
screenshotFilter.flush();
const screenshotVisible = screenshotTokens.join('');
assert(
  screenshotVisible.startsWith('The multi-page website plan'),
  `prose must not start mid-phrase; got: ${JSON.stringify(screenshotVisible.slice(0, 80))}`
);
assert(!screenshotVisible.includes('"tool"'), 'tool JSON not in visible stream');

// ── Thinking channel: hold partial ask_question JSON ──
const ASK_PREFIX = 'Now I will call ask_question with options.\n';
const ASK_JSON =
  '{"tool":"ask_question","params":{"title":"Pick","options":[{"id":"a","label":"One"},{"id":"b","label":"Two"}]}}';
const ASK_FULL = ASK_PREFIX + ASK_JSON;

let thinkTokens = [];
const cloud = createCloudStreamFilters({
  onToken: () => {},
  onThinkingToken: (t) => thinkTokens.push(t),
});

const askPart = ASK_FULL.slice(0, 120);
cloud.processThinkingChunk(askPart);
assert.strictEqual(thinkTokens.join(''), '', 'partial ask_question must not reach Thought UI');
assert(shouldHoldToolBuffer(askPart), 'partial ask_question in hold');

cloud.processThinkingChunk(ASK_FULL.slice(120));
cloud.flush();
assert(thinkTokens.join('').includes('Now I will call'), 'reasoning prose kept in thinking');
assert(!thinkTokens.join('').includes('"tool"'), 'executable tool JSON not in thinking stream');

console.log('streamingToolFilter.test.js: all passed');
