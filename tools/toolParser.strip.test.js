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

const PROSE_GLUE = 'Given tool usage:\n';
const RAW_WRITE = '{"tool":"write_file","params":{"filePath":"game.html","content":"' + 'x'.repeat(200) + '"}}';
const GLUED = PROSE_GLUE + RAW_WRITE;
const gluedClean = stripToolCallText(GLUED);
assert(gluedClean.includes('Given tool usage'), 'prose prefix kept for glued JSON');
assert(!gluedClean.includes('"tool"'), 'glued write_file JSON stripped');

const BIG_PREFIX = 'Starting implementation.\n';
const BIG_RAW = BIG_PREFIX + '{"tool":"write_file","params":{"filePath":"index.html","content":"' + 'A'.repeat(16000) + '"}}';
const bigClean = stripToolCallText(BIG_RAW);
assert(bigClean.includes('Starting implementation'), '16k write_file: prose prefix kept');
assert(!bigClean.includes('"tool"'), '16k write_file: JSON removed');

// Screenshot-2: glued prose + update_todo + trailing brace garbage
const GLUED_ACTIONS =
  'We will now perform the required actions.{"tool":"update_todo","params":{"todos":[{"id":"1","content":"x","status":"pending"}]}}}}}}}}';
const gluedActionsClean = stripToolCallText(GLUED_ACTIONS);
assert(gluedActionsClean.includes('We will now perform the required actions'), 'glued actions prose kept');
assert(!gluedActionsClean.includes('"tool"'), 'glued update_todo stripped');
assert(!/\}+\s*$/.test(gluedActionsClean.trim()), 'trailing } garbage removed');

console.log('toolParser.strip.test.js: all passed');
