'use strict';

const assert = require('assert');
const { buildCloudSystemPrompt } = require('../chatEngine');
const { MCPToolServer } = require('../mcpToolServer');
const { CloudLLMService, resolveCloudOutputTokens, secryptQualitySampling } = require('../cloudLLMService');
const { getCloudAgentSystemPrompt } = require('../agentModeResolver');
const { resolveSlashSkill, listSkills, formatSkillsHelp } = require('../skills/registry');

const server = new MCPToolServer({});
const defs = server.getToolDefinitions();

const enabledMap = { read_file: true, browser_navigate: false };
const filteredByToggles = defs.filter((d) => enabledMap[d.name] === true);
assert.ok(filteredByToggles.some((d) => d.name === 'read_file'));
assert.ok(!filteredByToggles.some((d) => d.name === 'browser_navigate'));

const cloudIdentity = getCloudAgentSystemPrompt();
assert.ok(!cloudIdentity.includes('Pattern —'), 'cloud identity must not include Pattern — hand-holding');
assert.ok(cloudIdentity.includes('general-purpose'));
assert.ok(cloudIdentity.includes('call that tool in this response'));

const twoTools = defs.filter((d) => d.name === 'read_file' || d.name === 'web_search');
const listing = server
  .getCompactToolHint('default', {
    toolDefs: twoTools,
    planning: false,
    compactDescriptions: true,
  })
  .join('');
assert.ok(listing.includes('read_file'));
assert.ok(listing.includes('web_search'));
assert.ok(listing.includes('```json'), 'compact catalog must include JSON fence examples');
assert.ok(listing.includes('"tool"'), 'compact catalog must show tool JSON shape');
assert.ok(!listing.includes('Pattern —'));
assert.ok(!listing.includes('Common patterns'));

const prompt = buildCloudSystemPrompt({
  tightContext: false,
  baseSystemPrompt: cloudIdentity,
  toolPrompt: listing,
});
assert.ok(prompt.includes('read_file'));
assert.ok(prompt.includes('web_search'));
assert.ok(prompt.includes('general-purpose'));
assert.ok(prompt.includes('```json'));

const llm = new CloudLLMService();
assert.strictEqual(llm._getModelContextLimit('secrypt', 'cipher-quality'), 24576);
assert.strictEqual(resolveCloudOutputTokens(0, 32768), 8192);
assert.strictEqual(resolveCloudOutputTokens(-1, 32768), 8192);
assert.strictEqual(resolveCloudOutputTokens(4096, 32768), 4096);
assert.ok(resolveCloudOutputTokens(2048, 32768) === 2048);

const thinkSamp = secryptQualitySampling(true);
assert.strictEqual(thinkSamp.temperature, 1.0);
assert.strictEqual(thinkSamp.topP, 0.95);
assert.strictEqual(thinkSamp.topK, 20);
assert.strictEqual(thinkSamp.minP, 0);
assert.strictEqual(thinkSamp.presencePenalty, 0);
assert.strictEqual(thinkSamp.repeatPenalty, 1.0);
assert.strictEqual(thinkSamp.reasoningEffort, 'xhigh');

const instructSamp = secryptQualitySampling(false);
assert.strictEqual(instructSamp.temperature, 0.7);
assert.strictEqual(instructSamp.topP, 0.8);
assert.strictEqual(instructSamp.topK, 20);
assert.strictEqual(instructSamp.minP, 0);
assert.strictEqual(instructSamp.presencePenalty, 1.5);
assert.strictEqual(instructSamp.repeatPenalty, 1.0);
assert.strictEqual(instructSamp.reasoningEffort, 'low');

const skills = listSkills();
assert.ok(skills.some((s) => s.id === 'goal'));
assert.ok(formatSkillsHelp().includes('/goal'));

const goal = resolveSlashSkill('/goal build a shop');
assert.strictEqual(goal.sendToModel, true);
assert.ok(goal.goal && goal.goal.objective === 'build a shop');
assert.ok(goal.text.toLowerCase().includes('goal'));

const help = resolveSlashSkill('/skills');
assert.strictEqual(help.sendToModel, false);

const noImage = server
  .getCompactToolHint('default', {
    toolDefs: defs.filter((d) => d.name === 'generate_image' || d.name === 'read_file'),
    planning: false,
    compactDescriptions: true,
  })
  .join('');
assert.ok(noImage.includes('read_file'));

console.log('cloudTightPrompt+skills OK', {
  listingChars: listing.length,
  promptChars: prompt.length,
  skills: skills.length,
  secryptCtx: 24576,
});
