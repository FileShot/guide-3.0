'use strict';

const assert = require('assert');
const {
  _sfPreparePlainFenceFlushPayload,
  _sfIsPlainMarkdownFence,
  _sfFenceHeaderShouldStreamPlain,
  _sfFenceBufferLooksLikeToolJson,
} = require('../chatEngine');

// Plain ```html fences are chat prose, not tool JSON
assert.strictEqual(_sfIsPlainMarkdownFence('```html\n<!DOCTYPE html>'), true);
assert.strictEqual(_sfIsPlainMarkdownFence('```json\n{"tool":"write_file"}'), false);

// Unclosed fence gets a closing ``` so MarkdownRenderer can pair it
const unclosed = '```html\n<div>hello</div>';
const closed = _sfPreparePlainFenceFlushPayload(unclosed);
assert.match(closed, /^```html\n/);
assert.ok(closed.trimEnd().endsWith('```'), 'should append closing fence');

// Already closed — unchanged aside from trim
const already = '```html\n<div></div>\n```';
assert.strictEqual(_sfPreparePlainFenceFlushPayload(already), already);

// v0.4.23 regression: ```json header with empty body must NOT stream to prose
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```json\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```tool\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```tool_call\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```\n'), false);

// Closed tool fence — buffer/discards, not prose
const toolFence = '```json\n{"tool":"create_directory","params":{"path":".guide/plans"}}\n```';
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```json\n{"tool":"create_directory"'), false);
assert.ok(_sfFenceBufferLooksLikeToolJson(toolFence), 'closed tool fence is tool JSON');

// Plain markdown fences still stream to chat (v0.4.23 HTML fix preserved)
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```html\n<!DOCTYPE html>'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```css\nbody { margin: 0; }'), true);

// Unknown lang with non-tool body streams; tool body buffers
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\nhello world'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\n{"tool":"read_file","params":{"filePath":"x"}}'), false);

console.log('fenceFlush.test.js OK');
