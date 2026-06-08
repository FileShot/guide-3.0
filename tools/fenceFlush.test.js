'use strict';

const assert = require('assert');
const {
  _sfPreparePlainFenceFlushPayload,
  _sfIsPlainMarkdownFence,
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

console.log('fenceFlush.test.js OK');
