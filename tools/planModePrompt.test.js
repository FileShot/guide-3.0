'use strict';

const assert = require('assert');
const { getPlanModePromptAddition } = require('../agentModeResolver');

const awaiting = getPlanModePromptAddition('awaiting_plan');
assert.match(awaiting, /PLAN MODE ACTIVE/i);
assert.match(awaiting, /write_file/i);
assert.match(awaiting, /\.guide\/plans/i);
assert.match(awaiting, /Do NOT deliver the finished product in chat/i);
assert.match(awaiting, /write_todos/i);
// General — not a file-type laundry list
assert.doesNotMatch(awaiting, /NEVER output HTML/i);

console.log('planModePrompt.test.js OK');
