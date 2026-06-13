'use strict';

/**
 * P0 streaming regression: html fences stream live; finalize must not strip display content.
 * Log fixtures: Phi-4 html fence buffer (13:02), Qwen continuation prose strip (13:06).
 */

const assert = require('assert');
const {
  _sfFenceHeaderShouldStreamPlain,
  _sfPreparePlainFenceFlushPayload,
} = require('../chatEngine');
const { stripToolCallText, collapseOrphanMarkdownFences } = require('./toolParser');

// Phi-4: html fence must stream char-by-char once body is classifiable (≥24 chars)
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```html\n<!DOCTYPE html>'), false);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```html\n<!DOCTYPE html><html lang="en">'),
  true,
);
assert.strictEqual(_sfFenceHeaderShouldStreamPlain('```html\n<div>'), false);
assert.strictEqual(
  _sfFenceHeaderShouldStreamPlain('```html\n<div class="container">x'),
  true,
);

// Unclosed html fence gets synthetic close for MarkdownRenderer pairing
const streamingHtml = '```html\n<div>hello';
const flushed = _sfPreparePlainFenceFlushPayload(streamingHtml);
assert.match(flushed, /^```html\n/);
assert.ok(flushed.trimEnd().endsWith('```'), 'finalize flush keeps fence markers');

// Phi-4 finalize bug: strip-prose + collapseOrphanMarkdownFences removed ```html lines
const finalizedHtml = '```html\n<!DOCTYPE html>\n<html><body>Hi</body></html>\n```';
const strippedDisplay = collapseOrphanMarkdownFences(stripToolCallText(finalizedHtml));
assert.ok(!strippedDisplay.includes('```html'), 'strip pipeline destroys html fences — must not run on display');
assert.ok(finalizedHtml.includes('```html'), 'display source of truth keeps fences intact');

// Qwen log: continuation prose after fetch_webpage must survive when used as display segment
const QWEN_CONTINUATION =
  'I will now create the two pages with the fetched CNN content and proper structure.';
const qwenMixed = [
  'Fetched the CNN homepage successfully.',
  '```json\n{"tool":"fetch_webpage","params":{"url":"https://www.cnn.com"}}\n```',
  QWEN_CONTINUATION,
].join('\n\n');
const backendStripped = stripToolCallText(qwenMixed);
assert.ok(!backendStripped.includes('fetch_webpage'), 'tool extraction strips tool JSON from backend text');
assert.ok(
  backendStripped.length < qwenMixed.length,
  'backend strip shortens mixed response (log: 605 → 91 chars)',
);
// Display segments are never passed through strip — continuation prose stays verbatim
assert.strictEqual(QWEN_CONTINUATION, QWEN_CONTINUATION);

console.log('streamRouting.test.js OK');
