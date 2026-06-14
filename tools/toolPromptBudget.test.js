'use strict';

const assert = require('assert');
const {
  buildBudgetProportionalToolPrompt,
  resolveAgentMinToolPromptChars,
  preferCompactToolCatalogForTier,
} = require('../chatEngine');
const { getAgentToolPromptHeader, getAgentToolCatalogRules, formatCompactToolLine } = require('../agentModeResolver');
const { MCPToolServer } = require('../mcpToolServer');
const { resolveAgentMode, filterToolDefinitions } = require('../agentModeResolver');

assert.strictEqual(resolveAgentMinToolPromptChars('tiny'), 0);
assert.strictEqual(resolveAgentMinToolPromptChars('small'), 2048);
assert.strictEqual(resolveAgentMinToolPromptChars('medium'), 4096);
assert.strictEqual(resolveAgentMinToolPromptChars('large'), 8192);
assert.strictEqual(resolveAgentMinToolPromptChars('xlarge'), 10000);

assert.strictEqual(preferCompactToolCatalogForTier('tiny'), true);
assert.strictEqual(preferCompactToolCatalogForTier('small'), true);
assert.strictEqual(preferCompactToolCatalogForTier('medium'), false);

const server = new MCPToolServer({ projectPath: process.cwd() });
const mode = resolveAgentMode({ toolsEnabled: true, agentPhase: 'building' });
const defs = filterToolDefinitions(server.getToolDefinitions(), mode.allowedTools);
const fullToolPrompt = server.getToolPromptForTools(defs, { planning: false });
const compactParts = server.getCompactToolHint('default', {
  toolDefs: defs,
  planning: false,
  compactDescriptions: true,
});
const compactPrompt = compactParts.join('');

assert(fullToolPrompt.length > 10000, `full tool prompt should be large (${fullToolPrompt.length})`);
assert(compactPrompt.length < fullToolPrompt.length / 2, `compact should be much smaller (${compactPrompt.length} vs ${fullToolPrompt.length})`);

const smallTierBudget = buildBudgetProportionalToolPrompt({
  contextTokens: 8192,
  basePromptChars: 5600,
  historyChars: 0,
  userMessageChars: 2916,
  toolPrompt: fullToolPrompt,
  compactToolParts: compactParts,
  agentMode: true,
  agentMinToolPromptChars: resolveAgentMinToolPromptChars('small'),
  preferCompactCatalog: true,
});

assert.notStrictEqual(smallTierBudget.mode, 'full', 'small tier should not inject full catalog');
assert(smallTierBudget.prompt.length < fullToolPrompt.length / 2, 'small tier prompt should be compact');
assert(smallTierBudget.prompt.includes('browser_navigate'), 'compact catalog keeps browser tools');
assert(smallTierBudget.prompt.includes('run_linter'), 'compact catalog lists all tools');
assert(smallTierBudget.prompt.includes('terminal_run'), 'compact catalog lists all tools');
assert(!smallTierBudget.prompt.includes('…and more tools available'), 'agent compact path never hides tools');
assert.strictEqual(smallTierBudget.mode, 'compact-all');
assert(smallTierBudget.tier0Ok, 'tier-0 browser tools present');

const allToolNames = defs.map((d) => d.name);
for (const name of allToolNames) {
  assert(smallTierBudget.prompt.includes(name), `compact catalog missing tool: ${name}`);
}

const largeTierBudget = buildBudgetProportionalToolPrompt({
  contextTokens: 32768,
  basePromptChars: 5600,
  historyChars: 0,
  userMessageChars: 500,
  toolPrompt: fullToolPrompt,
  compactToolParts: compactParts,
  agentMode: true,
  agentMinToolPromptChars: resolveAgentMinToolPromptChars('large'),
  preferCompactCatalog: false,
});

assert.strictEqual(largeTierBudget.mode, 'full', 'large tier with headroom uses full catalog');

const header = getAgentToolPromptHeader({ planning: false, compact: true });
assert(header.includes('## Tools'));
assert(header.includes('read_file'));

const rules = getAgentToolCatalogRules({ planning: false, compact: true });
assert(rules.includes('### Rules'));

const line = formatCompactToolLine(
  { name: 'read_file', description: 'Read a file. Returns content.', parameters: { filePath: { type: 'string', required: true } } },
  { compactDescriptions: true },
);
assert(line.includes('read_file'));
assert(!line.includes('Returns content'), 'compact line uses first sentence only when short');

console.log('toolPromptBudget.test.js OK');
