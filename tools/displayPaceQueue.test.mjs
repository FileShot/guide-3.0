import assert from 'assert';
import { createDisplayPaceQueue } from '../frontend/src/utils/displayPaceQueue.js';

const flushes = [];
const q = createDisplayPaceQueue({
  tokensPerSec: 50,
  onFlush: (channel, chunk) => flushes.push({ channel, chunk }),
});

q.enqueue('thinking', 'We need');
q.enqueue('text', 'nee');
q.enqueue('thinking', 'd to write');
q.enqueue('text', ' the plan');
q.flushNow();

assert.deepStrictEqual(flushes, [
  { channel: 'thinking', chunk: 'We need' },
  { channel: 'text', chunk: 'nee' },
  { channel: 'thinking', chunk: 'd to write' },
  { channel: 'text', chunk: ' the plan' },
]);

let total = 0;
const q2 = createDisplayPaceQueue({
  tokensPerSec: 50,
  onFlush: (_ch, chunk) => { total += chunk.length; },
});
q2.enqueue('text', 'hello');
q2.flushNow();
assert.strictEqual(total, 5);

const pacedEvents = [];
const toolOrderFlushes = [];
const q3 = createDisplayPaceQueue({
  tokensPerSec: 50,
  onFlush: (channel, chunk) => toolOrderFlushes.push({ channel, chunk }),
  onFlushEvent: (event, data) => pacedEvents.push({ event, data }),
});
q3.enqueue('thinking', 'reason ');
q3.enqueueEvent('tool-generating', { tool: 'ask_question' });
q3.enqueue('text', 'done');
q3.flushNow();
assert.strictEqual(pacedEvents.length, 1);
assert.strictEqual(pacedEvents[0].event, 'tool-generating');
assert.strictEqual(pacedEvents[0].data.tool, 'ask_question');
assert.deepStrictEqual(toolOrderFlushes, [
  { channel: 'thinking', chunk: 'reason ' },
  { channel: 'text', chunk: 'done' },
]);

console.log('displayPaceQueue.test.mjs: all passed');
