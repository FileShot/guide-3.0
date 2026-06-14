'use strict';

const assert = require('assert');
const { getAgentToolPromptHeader, getAgentToolCatalogRules } = require('../agentModeResolver');
const { MCPToolServer } = require('../mcpToolServer');
const { resolveAgentMode, filterToolDefinitions } = require('../agentModeResolver');

const server = new MCPToolServer({ projectPath: process.cwd() });
const mode = resolveAgentMode({ toolsEnabled: true, agentPhase: 'building' });
const defs = filterToolDefinitions(server.getToolDefinitions(), mode.allowedTools);

const fullPrompt = server.getToolPromptForTools(defs, { planning: false });
const compactParts = server.getCompactToolHint('default', { toolDefs: defs, planning: false, compactDescriptions: true });
const compactPrompt = compactParts.join('');

const sharedHeader = getAgentToolPromptHeader({ planning: false, compact: false });
const sharedRules = getAgentToolCatalogRules({ planning: false, compact: false });

assert(fullPrompt.includes(sharedHeader.trim().slice(0, 40)), 'full prompt uses shared header');
assert(fullPrompt.includes('Use tool results as ground truth'), 'full prompt uses shared rules');
assert(compactPrompt.includes(getAgentToolPromptHeader({ planning: false, compact: true }).trim().slice(0, 30)), 'compact uses shared compact header');
assert(compactPrompt.includes('### Rules'), 'compact has rules section');

console.log('promptDedupe.test.js OK');
