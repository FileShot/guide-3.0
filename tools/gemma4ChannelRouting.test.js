'use strict';

const assert = require('assert');
const { GENERATION_PROFILES } = require('../generationProfiles');
const { getModelProfile } = require('../modelProfiles');

const seg = GENERATION_PROFILES.gemma4?.jinjaThoughtSegments;
assert.ok(seg, 'gemma4 profile defines jinjaThoughtSegments');
assert.strictEqual(seg.thoughtTemplate, '<|channel>thought\n{{content}}<channel|>');
assert.strictEqual(seg.reopenThoughtAfterFunctionCalls, false);

const resolved = getModelProfile('gemma4', 4);
assert.ok(resolved.jinjaThoughtSegments, 'getModelProfile(gemma4) exposes jinjaThoughtSegments');

/** Minimal replay of chatEngine _sfThinkTagMatch + _sfForward (redacted_thinking matcher). */
function simulateThinkTagProse(input, rawThinkTagsEnabled) {
  const OPEN_TAG = '<think>';
  const CLOSE_TAG = '</think>';
  let match = '';
  let visible = '';

  const forward = (ch) => { visible += ch; };

  const process = (ch) => {
    if (rawThinkTagsEnabled && (match.length > 0 || ch === '<')) {
      match += ch;
      if (match === OPEN_TAG) {
        match = '';
        return;
      }
      if (match === CLOSE_TAG) {
        match = '';
        return;
      }
      if (!OPEN_TAG.startsWith(match) && !CLOSE_TAG.startsWith(match)) {
        const flush = match.slice(0, -1);
        match = '';
        if (flush) for (const c of flush) process(c);
      } else {
        return;
      }
    }
    forward(ch);
  };

  for (const ch of input) process(ch);
  return visible;
}

const FIXTURE = '<|channel>thought\n<channel|>Hello! How can I help you today?';

const corrupted = simulateThinkTagProse(FIXTURE, true);
assert.ok(corrupted.includes('ought'), 'false-positive: wrong matcher corrupts channel marker word');
assert.ok(!corrupted.includes('thought'), 'false-positive: th stripped from thought');

const preserved = simulateThinkTagProse(FIXTURE, false);
assert.strictEqual(preserved, FIXTURE, 'matcher off preserves full Gemma4 channel string');

const channelProfileDisablesMatcher = !!resolved.jinjaThoughtSegments;
assert.strictEqual(
  simulateThinkTagProse(FIXTURE, !channelProfileDisablesMatcher),
  FIXTURE,
  'channel profile disables raw matcher — no ought corruption',
);

const tpl = seg.thoughtTemplate;
const contentIdx = tpl.indexOf('{{content}}');
assert.ok(contentIdx > 0, 'thoughtTemplate has {{content}} placeholder');
assert.strictEqual(tpl.slice(0, contentIdx), '<|channel>thought\n');
assert.strictEqual(tpl.slice(contentIdx + '{{content}}'.length), '<channel|>');

console.log('gemma4ChannelRouting.test.js OK');
