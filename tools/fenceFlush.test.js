'use strict';

const assert = require('assert');
const {
  _sfPreparePlainFenceFlushPayload,
  _sfIsPlainMarkdownFence,
  _sfFenceHeaderShouldStreamPlain,
  _sfFenceBufferLooksLikeToolJson,
} = require('../chatEngine');

// Code fences are not plain-markdown fast-path langs (legacy helper)
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

// Tool fence langs must NOT stream to prose
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```json\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```tool\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```tool_call\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```text\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```plaintext\n'), false);

// Closed tool fence — buffer/discards, not prose
const toolFence = '```json\n{"tool":"create_directory","params":{"path":".guide/plans"}}\n```';
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```json\n{"tool":"create_directory"'), false);
assert.ok(_sfFenceBufferLooksLikeToolJson(toolFence), 'closed tool fence is tool JSON');

// Code fences (html, css, js, …) stream live to chat
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```html\n<!DOCTYPE html>'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```css\nbody { margin: 0; }'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```javascript\nconst x = 1;'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```markdown\n# Title'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\nhello world'), true);

// Empty-lang fence: stream unless body is tool JSON
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```\n'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```\nhello'), true);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\n{"tool":"read_file","params":{"filePath":"x"}}'), false);

console.log('fenceFlush.test.js OK');
