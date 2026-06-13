'use strict';

const assert = require('assert');
const { _sfStripPlainCodeFencesFromProse } = require('../chatEngine');

const htmlFence = '\n\n```html\n<!DOCTYPE html><html lang="en"><body>Hi</body></html>\n```\n\nDone.';
const stripped = _sfStripPlainCodeFencesFromProse(htmlFence);
assert.ok(!stripped.includes('<!DOCTYPE'), 'html fence body removed from prose catch-up target');
assert.ok(!stripped.includes('```html'), 'fence markers removed');
assert.ok(stripped.includes('Done'), 'trailing prose preserved');

const mdFence = '```markdown\n# Notes with enough body text here\n```\nAfter.';
const mdKept = _sfStripPlainCodeFencesFromProse(mdFence);
assert.ok(mdKept.includes('# Notes'), 'markdown fences stay in prose catch-up target');
assert.ok(mdKept.includes('After'), 'prose after md fence kept');

console.log('catchUpProse.test.js OK');
