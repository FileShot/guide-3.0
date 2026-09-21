'use strict';

const assert = require('assert');
const { buildCloudSystemPrompt } = require('../chatEngine');
const { MCPToolServer } = require('../mcpToolServer');
const { CloudLLMService, resolveCloudOutputTokens } = require('../cloudLLMService');
const { selectCloudToolDefs } = require('../cloudAgenticChat');
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
assert.strictEqual(llm._getModelContextLimit('secrypt', 'cipher-quality'), 32768);
assert.strictEqual(resolveCloudOutputTokens(0, 32768), 8192);
assert.strictEqual(resolveCloudOutputTokens(-1, 32768), 8192);
assert.strictEqual(resolveCloudOutputTokens(4096, 32768), 4096);
assert.ok(resolveCloudOutputTokens(2048, 32768) === 2048);
const cloudDefs = selectCloudToolDefs(defs, 'build a file sharing website');
assert.ok(cloudDefs.some((d) => d.name === 'write_file'));
assert.ok(!cloudDefs.some((d) => d.name === 'get_project_structure'));

const skills = listSkills();
assert.ok(skills.some((s) => s.id === 'goal'));
assert.ok(formatSkillsHelp().includes('/goal'));

const goal = resolveSlashSkill('/goal build a shop');
assert.strictEqual(goal.sendToModel, true);
assert.ok(goal.goal && goal.goal.objective === 'build a shop');
assert.ok(goal.text.toLowerCase().includes('goal'));

const help = resolveSlashSkill('/skills');
assert.strictEqual(help.sendToModel, false);

console.log('cloudTightPrompt+skills OK', {
  compactChars: compact.length,
  promptChars: prompt.length,
  skills: skills.length,
  secryptCtx: 32768,
});
