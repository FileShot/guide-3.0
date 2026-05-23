'use strict';

const { parseToolCalls, repairToolCalls, stripToolCallText } = require('./tools/toolParser');
const { buildCloudSystemPrompt } = require('./chatEngine');

const CLOUD_CONTINUE_PROMPT = 'Continue from the tool results above. Call more tools if needed, or give a concise final answer.';

/**
 * Agentic cloud chat: same tool catalog and system prompt as local (via buildCloudSystemPrompt),
 * prose JSON tool calls parsed like the local fallback path.
 */
async function runCloudAgenticChat({
  cloudLLM,
  mcpToolServer,
  ChatEngine,
  userMessage,
  cloudProvider,
  cloudModel,
  settings,
  conversationHistory: initialHistory,
  images,
  executeToolFn,
  onToken,
  onThinkingToken,
  onStreamEvent,
  getCancelled,
}) {
  const askOnly = !!(settings.askOnly);
  const planMode = !!(settings.planMode);
  const toolsEnabled = settings.toolsEnabled !== false;
  const enableSubAgents = !!(settings.enableSubAgents);

  let toolPrompt = (askOnly || planMode || !toolsEnabled) ? '' : mcpToolServer.getToolPrompt();
  const compactToolParts = (askOnly || planMode || !toolsEnabled) ? [] : mcpToolServer.getCompactToolHint('default');
  let compactToolPrompt = compactToolParts.join('');

  if (enableSubAgents && toolPrompt) {
    const subAgentTool = '\n- **spawn_subagent** — Delegate a focused sub-task to an isolated sub-agent (local model only; unavailable in cloud mode).';
    toolPrompt += subAgentTool;
    compactToolPrompt += '\n- spawn_subagent: not available in cloud mode\n';
  }

  const systemPrompt = buildCloudSystemPrompt({
    userSystemPrompt: settings.systemPrompt,
    customInstructions: settings.customInstructions,
    toolPrompt,
  });

  const conversationHistory = Array.isArray(initialHistory)
    ? initialHistory.map((m) => ({ role: m.role, content: String(m.content || '') }))
    : [];

  const maxIter = settings.maxIterations > 0 ? settings.maxIterations : 25;
  let fullResponse = '';
  let totalToolCalls = 0;
  let nextUserPrompt = userMessage;

  const genBase = {
    provider: cloudProvider,
    model: cloudModel,
    systemPrompt,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens || -1,
    topP: settings.topP,
    images,
    onToken,
    onThinkingToken,
    stream: true,
  };

  for (let iter = 0; iter < maxIter; iter++) {
    if (getCancelled?.()) {
      console.log('[CloudAgentic] cancelled');
      break;
    }

    const result = await cloudLLM.generate(nextUserPrompt, {
      ...genBase,
      conversationHistory,
      images: iter === 0 ? images : [],
    });

    if (result?.isQuotaError) {
      return { isQuotaError: true, error: '__QUOTA_EXCEEDED__', text: fullResponse, toolCallCount: totalToolCalls };
    }

    const roundText = result?.text || '';
    fullResponse += roundText;

    if (askOnly || planMode || !toolsEnabled || !executeToolFn) {
      break;
    }

    let parsedCalls = parseToolCalls(roundText);
    if (!parsedCalls.length) break;

    const { repaired } = repairToolCalls(parsedCalls, roundText);
    parsedCalls = repaired.filter((c) => c.tool !== 'spawn_subagent');

    if (!parsedCalls.length) break;

    const visibleAssistant = stripToolCallText(roundText).trim();
    conversationHistory.push({ role: 'assistant', content: visibleAssistant || '(tool calls)' });

    const toolResultLines = [];
    for (const call of parsedCalls) {
      if (getCancelled?.()) break;
      const toolName = call.tool;
      const toolParams = call.params || {};
      totalToolCalls++;

      if (onStreamEvent) {
        onStreamEvent('tool-generating', { tool: toolName });
        onStreamEvent('tool-executing', [{ tool: toolName, params: toolParams }]);
      }

      let toolResult;
      try {
        toolResult = await executeToolFn(toolName, toolParams);
      } catch (e) {
        toolResult = { success: false, error: e.message };
      }

      if (onStreamEvent) {
        onStreamEvent('mcp-tool-results', [{ tool: toolName, result: toolResult }]);
      }

      const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
      toolResultLines.push(`${toolName}: ${resultStr}`);
      console.log(`[CloudAgentic] tool ${toolName} done (${resultStr.length} chars)`);
    }

    if (!toolResultLines.length) break;

    const injectText = [
      '[System: Tool Results]',
      'The tools below have ALREADY been executed. Do not repeat them. Continue concisely.',
      '',
      ...toolResultLines,
      '',
      'Continue with remaining work or summarize results.',
    ].join('\n');

    conversationHistory.push({ role: 'user', content: injectText });
    nextUserPrompt = CLOUD_CONTINUE_PROMPT;
  }

  return { text: fullResponse, toolCallCount: totalToolCalls };
}

module.exports = { runCloudAgenticChat };
