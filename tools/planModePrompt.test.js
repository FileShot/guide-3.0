'use strict';

const assert = require('assert');
const {
  getAgentSystemPrompt,
  getPlanSystemPrompt,
  getPlanModePromptAddition,
  resolveAgentMode,
} = require('../agentModeResolver');

const agent = getAgentSystemPrompt();
assert.doesNotMatch(agent, /## Planning/i);
assert.doesNotMatch(agent, /\.guide\/plans/i);
assert.match(agent, /project root/i);
assert.match(agent, /write_file/i);

const plan = getPlanSystemPrompt();
assert.match(plan, /Plan mode/i);
assert.match(plan, /create_directory/i);
assert.match(plan, /\.guide\/plans/i);
assert.match(plan, /write_todos/i);
assert.match(plan, /Do NOT deliver the finished product in chat/i);
assert.doesNotMatch(plan, /browser_navigate/i);

const awaiting = getPlanModePromptAddition('awaiting_plan');
assert.match(awaiting, /awaiting plan/i);
assert.match(awaiting, /Tier A/i);
assert.match(awaiting, /Tier B/i);
assert.doesNotMatch(awaiting, /PLAN MODE ACTIVE — READ FIRST/i);

const ready = getPlanModePromptAddition('plan_ready');
assert.match(ready, /plan ready/i);

const resolvedPlan = resolveAgentMode({ planMode: true, chatMode: 'plan', agentPhase: 'planning' });
assert.strictEqual(resolvedPlan.planning, true);
assert.match(resolvedPlan.baseSystemPrompt, /Plan mode/i);
assert.doesNotMatch(resolvedPlan.baseSystemPrompt, /browser_navigate/i);
assert.match(resolvedPlan.systemPromptAdditions, /awaiting plan/i);

const resolvedAgent = resolveAgentMode({ chatMode: 'agent', agentPhase: 'planning' });
assert.match(resolvedAgent.baseSystemPrompt, /write_file/i);
assert.doesNotMatch(resolvedAgent.baseSystemPrompt, /## Plan mode — READ FIRST/i);

console.log('planModePrompt.test.js OK');
