'use strict';

const assert = require('assert');
const { buildCloudSystemPrompt } = require('../chatEngine');
const { MCPToolServer } = require('../mcpToolServer');
const { resolveSlashSkill, listSkills, formatSkillsHelp } = require('../skills/registry');

const server = new MCPToolServer({});
const defs = server.getToolDefinitions();
const minimal = server.getCompactToolHint('default', {
  toolDefs: defs,
  planning: false,
  minimal: true,
  compactDescriptions: true,
}).join('');

const tight = buildCloudSystemPrompt({
  tightContext: true,
  toolPrompt: minimal,
  customInstructions: '',
});
assert.ok(tight.includes('write_file'), 'tight prompt must include write_file');
assert.ok(tight.includes('## Tools') || tight.includes('write_file'), 'tools present');
assert.ok(tight.length < 7200, `tight prompt must fit Secrypt budget, got ${tight.length}`);

const skills = listSkills();
assert.ok(skills.some((s) => s.id === 'goal'));
assert.ok(formatSkillsHelp().includes('/goal'));

const goal = resolveSlashSkill('/goal build a shop');
assert.strictEqual(goal.sendToModel, true);
assert.ok(goal.text.includes('GOAL'));
assert.ok(goal.text.includes('build a shop'));

const help = resolveSlashSkill('/skills');
assert.strictEqual(help.sendToModel, false);
assert.ok(help.localText.includes('/automate'));

const bad = resolveSlashSkill('/goal');
assert.ok(bad.error);

console.log('cloudTightPrompt+skills OK', { tightChars: tight.length, skills: skills.length });
