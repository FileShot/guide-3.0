'use strict';

const { parseToolCalls, repairToolCalls, stripToolCallText } = require('./tools/toolParser');
const { buildCloudSystemPrompt } = require('./chatEngine');
const {
  formatToolResultForInject,
  buildToolResultsUserMessage,
  sanitizeCloudConversationHistory,
} = require('./tools/toolResultInjection');
const { createStripBasedStreamFilter } = require('./tools/streamingToolFilter');
const {
  resolveAgentMode,
  filterToolDefinitions,
  filterPlanModeToolCalls,
} = require('./agentModeResolver');

const CLOUD_CONTINUE_PROMPT = 'Continue from the tool results above. Call more tools if needed, or give a concise final answer.';

const FILE_WRITE_OPS = new Set(['write_file', 'create_file', 'append_to_file']);

/**
 * Agentic cloud chat: same tool catalog and mode rules as local (via agentModeResolver).
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
  const enableSubAgents = !!(settings.enableSubAgents);
  const toolsEnabled = settings.toolsEnabled !== false;

  const mode = resolveAgentMode({
    askOnly: settings.askOnly,
    planMode: settings.planMode,
    chatMode: settings.chatMode,
    agentPhase: settings.agentPhase || 'planning',
    toolsEnabled,
    planReady: !!settings.planReady,
    planFileExists: !!settings.planFileExists,
  });

  mcpToolServer.setAgentContext({ planMode: mode.planMode, agentPhase: mode.agentPhase });

  const allDefs = mcpToolServer.getToolDefinitions();
  const filteredDefs = filterToolDefinitions(allDefs, mode.allowedTools);

  let toolPrompt = mode.toolsActive ? mcpToolServer.getToolPromptForTools(filteredDefs) : '';
  const compactToolParts = mode.toolsActive
    ? mcpToolServer.getCompactToolHint('default', { toolDefs: filteredDefs })
    : [];
  let compactToolPrompt = compactToolParts.join('');

  if (enableSubAgents && toolPrompt) {
    const subAgentTool = '\n- **spawn_subagent** — Delegate a focused sub-task to an isolated sub-agent (local model only; unavailable in cloud mode).';
    toolPrompt += subAgentTool;
    compactToolPrompt += '\n- spawn_subagent: not available in cloud mode\n';
  }

  let systemPrompt = buildCloudSystemPrompt({
    userSystemPrompt: settings.systemPrompt,
    customInstructions: settings.customInstructions,
    toolPrompt,
  });
  if (mode.systemPromptAdditions) {
    systemPrompt += mode.systemPromptAdditions;
  }

  const conversationHistory = sanitizeCloudConversationHistory(
    Array.isArray(initialHistory) ? initialHistory : [],
    { parseToolCalls, stripToolCallText }
  ).map((m) => ({ role: m.role, content: String(m.content || '') }));

  console.log(
    `[CloudAgentic] history: ${initialHistory?.length || 0} raw → ${conversationHistory.length} sanitized; mode=${mode.planning ? 'plan' : mode.askOnly ? 'ask' : 'agent'}`
  );

  const maxIter = settings.maxIterations > 0 ? settings.maxIterations : 25;
  let fullResponse = '';
  let displayResponse = '';
  let totalToolCalls = 0;
  let nextUserPrompt = userMessage;
  const contextTokens = settings.maxResponseTokens > 0 ? settings.maxResponseTokens : 8192;

  const streamFilter = createStripBasedStreamFilter({ onToken, onStreamEvent });

  const genBase = {
    provider: cloudProvider,
    model: cloudModel,
    systemPrompt,
    temperature: settings.temperature,
    maxTokens: settings.maxResponseTokens || -1,
    topP: settings.topP,
    images,
    onThinkingToken,
    stream: true,
  };

  for (let iter = 0; iter < maxIter; iter++) {
    if (getCancelled?.()) {
      console.log('[CloudAgentic] cancelled');
      break;
    }

    streamFilter.resetRound();
    const visibleAtRoundStart = streamFilter.getVisibleChars();

    const result = await cloudLLM.generate(nextUserPrompt, {
      ...genBase,
      conversationHistory,
      images: iter === 0 ? images : [],
      onToken: (token) => streamFilter.processChunk(token),
    });

    streamFilter.flush();

    if (result?.isQuotaError) {
      return { isQuotaError: true, error: '__QUOTA_EXCEEDED__', text: displayResponse || fullResponse, toolCallCount: totalToolCalls };
    }

    const roundText = result?.text || '';
    fullResponse += roundText;
    const roundClean = streamFilter.getCleanText() || stripToolCallText(roundText);
    displayResponse += roundClean;

    if (mode.askOnly || !mode.toolsActive || !executeToolFn) {
      break;
    }

    let parsedCalls = parseToolCalls(roundText);
    if (!parsedCalls.length) break;

    const { repaired } = repairToolCalls(parsedCalls, roundText);
    parsedCalls = repaired.filter((c) => c.tool !== 'spawn_subagent');

    if (mode.planning && parsedCalls.length > 0) {
      const { calls: planCalls, blocked } = filterPlanModeToolCalls(parsedCalls);
      if (blocked.length) {
        console.log(`[CloudAgentic] Plan mode blocked: ${blocked.map((c) => c.tool).join(', ')}`);
      }
      parsedCalls = planCalls;
    }

    if (!parsedCalls.length) break;

    const visibleAssistant = roundClean.trim();
    conversationHistory.push({ role: 'assistant', content: visibleAssistant || '(tool calls)' });

    const newVisibleChars = streamFilter.getVisibleChars() - visibleAtRoundStart;
    if (onStreamEvent && newVisibleChars > 0 && roundClean.length < newVisibleChars) {
      onStreamEvent('llm-replace-last', {
        originalLength: newVisibleChars,
        replacement: roundClean,
      });
    }

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

      if (FILE_WRITE_OPS.has(toolName) && call.params?.content && onStreamEvent) {
        const filePath = call.params.filePath || call.params.path || '';
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        onStreamEvent('file-content-block-complete', {
          filePath,
          fileName,
          language: ext,
          fileKey: filePath,
          content: String(call.params.content),
        });
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

      const injectResult = formatToolResultForInject(toolName, toolResult, { contextTokens });
      toolResultLines.push(`${toolName}: ${injectResult}`);
      console.log(`[CloudAgentic] tool ${toolName} done (${injectResult.length} chars inject)`);
    }

    if (!toolResultLines.length) break;

    const injectText = buildToolResultsUserMessage(toolResultLines);
    conversationHistory.push({ role: 'user', content: injectText });
    console.log(`[CloudAgentic] ─── TOOL RESULTS → MODEL ─── ${toolResultLines.length} result(s)`);

    nextUserPrompt = CLOUD_CONTINUE_PROMPT;
  }

  const finalText = displayResponse || stripToolCallText(fullResponse);
  return { text: finalText, toolCallCount: totalToolCalls };
}

module.exports = { runCloudAgenticChat };
