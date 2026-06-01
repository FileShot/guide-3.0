'use strict';

const assert = require('assert');
const {
  stripToolCallText,
  collapseOrphanMarkdownFences,
  findToolCallRanges,
  isVisibleToolArtifact,
  isToolJsonContinuationFragment,
} = require('./toolParser');

// Log-accurate continuation tail (often starts with `"` then `,` after head was stripped)
const TAIL = '","reason":"Click Next to proceed with login"}}';
const FENCED = '```json\n{"tool":"browser_click","params":{"ref":"3","reason":"Click Next"}}\n```';
const PROSE = 'You are right — the username may be incorrect. I will ask before retrying.';
const PROSE_JSONISH = 'Use an object like { "key": "value" } in your config when documenting APIs.';

assert(isToolJsonContinuationFragment(TAIL), 'continuation tail');
assert(!isToolJsonContinuationFragment(PROSE), 'prose not fragment');
assert(!isToolJsonContinuationFragment(PROSE_JSONISH), 'prose with braces not fragment');

assert.strictEqual(stripToolCallText(TAIL), '');
assert.strictEqual(stripToolCallText(FENCED), '');
assert.strictEqual(stripToolCallText(PROSE), PROSE);
assert.strictEqual(stripToolCallText(PROSE_JSONISH), PROSE_JSONISH);

assert(isVisibleToolArtifact(TAIL));
assert(isVisibleToolArtifact(FENCED));
assert(!isVisibleToolArtifact(PROSE));

const mixed = `Some explanation.\n${TAIL}`;
const cleaned = stripToolCallText(mixed);
assert(!cleaned.includes('"reason"'), 'tail removed from mixed');
assert(cleaned.includes('Some explanation'), 'prose kept in mixed');

assert(findToolCallRanges(TAIL).length > 0);

const ORPHAN_FENCES = 'Intro prose.\n\n```\n\n```\n\n```json\n{"tool":"create_directory","params":{"path":".guide/plans"}}\n```\n\nMore.';
const ORPHAN_CLEANED = stripToolCallText(ORPHAN_FENCES);
assert(!ORPHAN_CLEANED.includes('```'), 'orphan fences removed after tool strip');
assert(ORPHAN_CLEANED.includes('Intro prose'), 'prose kept after orphan fence strip');
assert.strictEqual(collapseOrphanMarkdownFences('```\n\n```'), '');
assert.strictEqual(collapseOrphanMarkdownFences('line\n```json\n\n```\n'), 'line');

console.log('toolParser.strip.test.js: all passed');
