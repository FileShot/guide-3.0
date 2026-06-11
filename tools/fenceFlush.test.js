'use strict';

const assert = require('assert');
const {
  _sfPreparePlainFenceFlushPayload,
  _sfIsPlainMarkdownFence,
  _sfFenceHeaderShouldStreamPlain,
  _sfFenceBufferLooksLikeToolJson,
} = require('../chatEngine');

// Code fences are not plain-markdown fast-path langs
assert.strictEqual(_sfIsPlainMarkdownFence('```html\n<!DOCTYPE html>'), false);
assert.strictEqual(_sfIsPlainMarkdownFence('```json\n{"tool":"write_file"}'), false);
assert.strictEqual(_sfIsPlainMarkdownFence('```markdown\n# hello'), true);

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

// Code fences buffer until close (render as CodeBlock), not naked prose stream
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```html\n<!DOCTYPE html>'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```css\nbody { margin: 0; }'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```javascript\nconst x = 1;'), false);

// Markdown prose fences may still stream live
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```markdown\n# Title'), true);

// Unknown lang with non-tool body buffers (not plain stream)
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\nhello world'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\n{"tool":"read_file","params":{"filePath":"x"}}'), false);

console.log('fenceFlush.test.js OK');
