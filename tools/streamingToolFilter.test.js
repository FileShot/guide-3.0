'use strict';

const assert = require('assert');
const { createStripBasedStreamFilter, shouldHoldToolBuffer } = require('./streamingToolFilter');
const { stripToolCallText } = require('./toolParser');

const PROSE_PREFIX = 'I will write the game file now.\n';
const WRITE_FILE_JSON = '{"tool":"write_file","params":{"filePath":"index.html","content":"<!DOCTYPE html><html><body>hi</body></html>"}}';
const LARGE = PROSE_PREFIX + WRITE_FILE_JSON;

let tokens = [];
const filter = createStripBasedStreamFilter({
  onToken: (t) => tokens.push(t),
  onStreamEvent: () => {},
});

// Partial buffer: hold — no tokens until complete JSON arrives
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

console.log('streamingToolFilter.test.js: all passed');
