'use strict';

const assert = require('assert');
const { splitMarkdownFences, isOrphanFenceChunk } = require('../markdownFenceUtils');

assert.strictEqual(isOrphanFenceChunk('```'), true);
assert.strictEqual(isOrphanFenceChunk('```\n\n'), true);
assert.strictEqual(isOrphanFenceChunk('Hello'), false);

const htmlFence = 'Intro\n```html\n<div>ok</div>\n```\nDone';
const split = splitMarkdownFences(htmlFence, false);
assert.strictEqual(split.chunks.length, 3);
assert.strictEqual(split.chunks[0].type, 'prose');
assert.strictEqual(split.chunks[1].type, 'code');
assert.strictEqual(split.chunks[1].lang, 'html');
assert.strictEqual(split.chunks[1].text.trim(), '<div>ok</div>');
assert.strictEqual(split.chunks[2].type, 'prose');
assert.strictEqual(split.openCode, null);

const orphan = splitMarkdownFences('line\n```json\n\n```\n', false);
const proseOnly = orphan.chunks.filter((c) => c.type === 'prose');
assert.ok(proseOnly.some((c) => c.text.includes('line')));
assert.ok(!orphan.chunks.some((c) => c.type === 'code' && !c.text.trim()));

const streaming = splitMarkdownFences('```html\n<div>', true);
assert.ok(streaming.openCode);
assert.strictEqual(streaming.openCode.lang, 'html');
assert.strictEqual(streaming.openCode.text, '<div>');

console.log('markdownFenceSplit.test.js: all passed');
