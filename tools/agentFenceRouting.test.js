'use strict';

const assert = require('assert');
const {
  _sfShouldRouteAgentCodeFence,
  _sfInferAgentFenceFilePath,
  _sfIsAgentFileFenceMode,
  _sfRerouteThinkContentToFile,
} = require('../chatEngine');

const agentOpts = { chatMode: 'agent' };
const planOpts = { chatMode: 'plan', agentPhase: 'planning' };
const askOpts = { chatMode: 'ask' };

// Agent mode routes code fences to FileContentBlock (not prose)
const htmlFence = '```html\n<!DOCTYPE html><html lang="en"><head>';
assert.strictEqual(_sfShouldRouteAgentCodeFence(htmlFence, agentOpts), true);
assert.strictEqual(_sfInferAgentFenceFilePath(htmlFence), 'index.html');

const pyFence = '```python\ndef main():\n    print("hi")';
assert.strictEqual(_sfShouldRouteAgentCodeFence(pyFence, agentOpts), true);
assert.strictEqual(_sfInferAgentFenceFilePath(pyFence), 'script.py');

const rustFence = '```rust\nfn main() {\n    println!("hi");\n}';
assert.strictEqual(_sfShouldRouteAgentCodeFence(rustFence, agentOpts), true);
assert.strictEqual(_sfInferAgentFenceFilePath(rustFence), 'main.rs');

// Markdown stays prose
const mdFence = '```markdown\n# Notes with enough body text here';
assert.strictEqual(_sfShouldRouteAgentCodeFence(mdFence, agentOpts), false);

// Tool-json stays tool-buffer path
const toolFence = '```json\n{"tool":"write_file","params":{"filePath":"x.js","content":"const a = 1; // enough chars"}}';
assert.strictEqual(_sfShouldRouteAgentCodeFence(toolFence, agentOpts), false);

// Plan planning phase does not route
assert.strictEqual(_sfShouldRouteAgentCodeFence(htmlFence, planOpts), false);
assert.strictEqual(_sfIsAgentFileFenceMode(planOpts), false);
assert.strictEqual(_sfIsAgentFileFenceMode(agentOpts), true);
assert.strictEqual(_sfIsAgentFileFenceMode(askOpts), false);

// Think-buffer HTML reroutes to file-content
const thinkHtml = '<!DOCTYPE html><html><body>Hi</body></html>",';
const reroute = _sfRerouteThinkContentToFile(thinkHtml, agentOpts);
assert.ok(reroute);
assert.strictEqual(reroute.filePath, 'index.html');
assert.ok(reroute.content.includes('<!DOCTYPE'));

console.log('agentFenceRouting.test.js OK');
