'use strict';

const assert = require('assert');
const {
  createStripBasedStreamFilter,
  createCloudStreamFilters,
  shouldHoldToolBuffer,
  extractFormingToolName,
  extractFormingToolParams,
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

// ── Thinking channel also holds tool JSON (WriteStripLeak1 — no leak into Thought) ──
const ASK_PREFIX = 'Now I will call ask_question with options.\n';
const ASK_JSON =
  '{"tool":"ask_question","params":{"title":"Pick","options":[{"id":"a","label":"One"},{"id":"b","label":"Two"}]}}';
const ASK_FULL = ASK_PREFIX + ASK_JSON;

let thinkTokens = [];
const thinkEvents = [];
const cloud = createCloudStreamFilters({
  onToken: () => {},
  onThinkingToken: (t) => thinkTokens.push(t),
  onStreamEvent: (evt, data) => thinkEvents.push({ evt, data }),
});

const askPart = ASK_FULL.slice(0, 120);
cloud.processThinkingChunk(askPart);
assert.strictEqual(thinkTokens.join(''), '', 'thinking must hold partial tool-shaped JSON');
assert(shouldHoldToolBuffer(askPart), 'hold detects partial ask_question');
// StreamLiveFix1: held thinking tool JSON must surface a tool card (divert, not hide).
assert(
  thinkEvents.some((e) => e.evt === 'tool-generating' || e.evt === 'tool-generating-progress'),
  'thinking hold must emit tool-generating (not blank chat)',
);
assert(
  cloud.getProseRawBuffer().includes('"tool"'),
  'held thinking tool JSON must mirror into prose buffer for parse',
);

cloud.processThinkingChunk(ASK_FULL.slice(120));
cloud.flush();
assert(thinkTokens.join('').includes('Now I will call ask_question'), 'thinking flush keeps prose prefix');
assert(!thinkTokens.join('').includes('"tool"'), 'thinking flush strips tool JSON');

// ── Markdown/HTML code fences must stream live (not held until round end) ──
const HTML_STREAM = 'Here is the page.\n```html\n<!DOCTYPE html>\n<html lang="en">\n<head><title>Hi</title></head>\n<body>\n';
let htmlTok = [];
const htmlFilter = createStripBasedStreamFilter({
  onToken: (t) => htmlTok.push(t),
});
for (let i = 0; i < HTML_STREAM.length; i += 6) {
  htmlFilter.processChunk(HTML_STREAM.slice(i, i + 6));
}
const htmlLive = htmlTok.join('');
assert(
  htmlLive.includes('<!DOCTYPE html>'),
  `html fence body must stream before flush; got ${JSON.stringify(htmlLive.slice(0, 120))}`,
);
assert(htmlLive.includes('```html'), 'html fence header must stream');
htmlFilter.flush();
assert(htmlTok.join('').includes('<title>Hi</title>'), 'html fence flush keeps body');

assert.strictEqual(stripToolCallText('</invoke>'), '', 'stray invoke tag is not chat text');
assert.strictEqual(stripToolCallText('(tool calls)'), '', 'history placeholder is not chat text');
assert.strictEqual(stripToolCallText('Read the directory.\n</invoke>'), 'Read the directory.', 'prose stays when a tag is stripped');

const invokeStream = simulateStream(createStripBasedStreamFilter({ onToken() {} }), '</invoke>', 3);
assert.strictEqual(invokeStream.tokens, '', 'invoke tag is not streamed to the chat');
const placeholderStream = simulateStream(createStripBasedStreamFilter({ onToken() {} }), '(tool calls)', 3);
assert.strictEqual(placeholderStream.tokens, '', 'placeholder is not streamed to the chat');
const helloStream = simulateStream(createStripBasedStreamFilter({ onToken() {} }), 'Hello there.', 4);
assert.strictEqual(helloStream.tokens, 'Hello there.', 'normal prose still streams');

const readCall = '{"tool":"read_file","params":{"filePath":"README.md"}}';
const readStream = simulateStream(createStripBasedStreamFilter({ onToken() {} }), readCall, 5);
assert.strictEqual(readStream.tokens, '', 'tool JSON streams as a card, not raw text');
assert(!readStream.tokens.includes('{"tool"'), 'raw tool text is absent');


// ── MultiToolCard1: last tool name + no filePath on update_todo ──
const multiBuf = '{"tool":"update_todo","params":{"id":"1","status":"done"}}'
  + '{"tool":"write_file","params":{"filePath":"index.html","content":"<!DOCTYPE html>x"}}';
assert.strictEqual(extractFormingToolName(multiBuf), 'write_file');
assert.strictEqual(extractFormingToolParams(multiBuf).filePath, 'index.html');
assert.strictEqual(extractFormingToolParams(multiBuf, 'update_todo').filePath, undefined);

console.log('streamingToolFilter.test.js: all passed');
