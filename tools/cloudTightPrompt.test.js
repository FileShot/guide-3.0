'use strict';

const assert = require('assert');
const { buildCloudSystemPrompt } = require('../chatEngine');
const { MCPToolServer } = require('../mcpToolServer');
const { CloudLLMService } = require('../cloudLLMService');
const { resolveSlashSkill, listSkills, formatSkillsHelp } = require('../skills/registry');

const server = new MCPToolServer({});
const defs = server.getToolDefinitions();
const compact = server.getCompactToolHint('default', {
  toolDefs: defs,
  planning: false,
  compactDescriptions: true,
}).join('');

const prompt = buildCloudSystemPrompt({
  tightContext: false,
  toolPrompt: compact + '\nCRITICAL: emit write_file when building.\n',
});
assert.ok(prompt.includes('write_file'), 'prompt must include write_file');
assert.ok(compact.length > 5000, 'compact catalog should be fuller than minimal');

const llm = new CloudLLMService();
assert.strictEqual(llm._getModelContextLimit('secrypt', 'cipher-quality'), 16384);

const skills = listSkills();
assert.ok(skills.some((s) => s.id === 'goal'));
assert.ok(formatSkillsHelp().includes('/goal'));

const goal = resolveSlashSkill('/goal build a shop');
assert.strictEqual(goal.sendToModel, true);
assert.ok(goal.text.includes('GOAL'));

const help = resolveSlashSkill('/skills');
assert.strictEqual(help.sendToModel, false);

console.log('cloudTightPrompt+skills OK', {
  compactChars: compact.length,
  promptChars: prompt.length,
  skills: skills.length,
  secryptCtx: 16384,
});
