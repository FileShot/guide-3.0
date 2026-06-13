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

// jjson typo — never plain-stream (lang or body)
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```jjson\n{'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```jjson\n{"tool":"write_file"'), false);

// Closed tool fence — buffer/discards, not prose
const toolFence = '```json\n{"tool":"create_directory","params":{"path":".guide/plans"}}\n```';
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```json\n{"tool":"create_directory"'), false);
assert.ok(_sfFenceBufferLooksLikeToolJson(toolFence), 'closed tool fence is tool JSON');

// Code fences (html, css, js, …) stream live once body is classifiable (≥24 chars)
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```html\n<!DOCTYPE html>'), false);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```html\n<!DOCTYPE html><html lang="en">'),
  true,
);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```css\nbody { margin: 0; color: red; }'),
  true,
);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```javascript\nconst x = 1;'), false);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```javascript\nconst answer = 42;'),
  true,
);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```markdown\n# Title'), false);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```markdown\n# Title with enough body'),
  true,
);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\nhello world'), false);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```foo\nhello world and more text'),
  true,
);

// Empty-lang fence: defer until body long enough; block tool JSON
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```\n'), false);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```\nhello'), false);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```\nhello world with enough chars'),
  true,
);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```foo\n{"tool":"read_file","params":{"filePath":"x"}}'), false);

console.log('fenceFlush.test.js OK');
