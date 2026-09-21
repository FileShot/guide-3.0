'use strict';

const {
  parseToolCalls,
  repairToolCalls,
  stripToolCallText,
  looksLikeToolAttempt,
  suggestClosestToolName,
} = require('./tools/toolParser');
const { buildCloudSystemPrompt, buildAgentSystemPromptLayers, buildTodoProgressHint } = require('./chatEngine');
const {
  formatToolResultForInject,
  buildToolResultsUserMessage,
  sanitizeCloudConversationHistory,
} = require('./tools/toolResultInjection');
const { createCloudStreamFilters } = require('./tools/streamingToolFilter');
const {
  resolveAgentMode,
  filterToolDefinitions,
  filterPlanModeToolCalls,
  shouldStreamFileContentForAgent,
} = require('./agentModeResolver');
const streamTrace = require('./streamTrace');

const CLOUD_CONTINUE_PROMPT = 'Continue from the tool results above. Call more tools if needed, or give a concise final answer.';

const CLOUD_FORCE_TOOLS_PROMPT =
  '[System: You claimed you would build/create files but emitted no tool calls. ' +
  'Immediately output write_file (and related) tool JSON to create the files. Do not apologize or repeat promises — call tools now.]';

const PLAN_BLOCKED_TOOLS_MSG =
  '[System: Plan mode — update_todo cannot mark items done/in-progress or edit non-plan files until Build. Use write_todos for planning; write_file/edit_file only for .guide/plans/*.plan.md. Do not repeat blocked tool JSON in your reply.]';

function looksLikeEmptyBuildPromise(prose) {
  const t = String(prose || '');
  if (t.length < 8 || t.length > 1200) return false;
  return /\b(build(ing)?|creat(e|ing)|writ(e|ing)|implement(ing)?|let me (actually )?(do|build|create)|proceed|right now)\b/i.test(t)
    && !/```/.test(t);
}

const FILE_WRITE_OPS = new Set(['write_file', 'create_file', 'append_to_file']);
const FILE_EDIT_OPS = new Set(['edit_file', 'replace_in_file']);

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
  getActiveTodos,
}) {
  const enableSubAgents = !!(settings.enableSubAgents);
  const toolsEnabled = settings.toolsEnabled !== false;
  // Secrypt/P40 n_ctx≈8k — full tool catalog + agent prompt exceeds the hard truncate and
  // the model never sees write_file, so it only says "Building…" without calling tools.
  const tightContext = ['secrypt', 'cipher', 'graysoft', 'cerebras'].includes(
    String(cloudProvider || '').toLowerCase(),
  );

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

  const toolPromptOpts = { planning: mode.planning };
  let toolPrompt = '';
  if (mode.toolsActive) {
    if (tightContext) {
      toolPrompt = mcpToolServer
        .getCompactToolHint('default', {
          toolDefs: filteredDefs,
          planning: mode.planning,
          minimal: true,
          compactDescriptions: true,
        })
        .join('');
    } else {
      toolPrompt = mcpToolServer.getToolPromptForTools(filteredDefs, toolPromptOpts);
      if (enableSubAgents && toolPrompt) {
        toolPrompt +=
          '\n- **spawn_subagent** — Delegate a focused sub-task to an isolated sub-agent (local model only; unavailable in cloud mode).';
      }
    }
  }

  let systemPrompt = buildCloudSystemPrompt({
    userSystemPrompt: settings.systemPrompt,
    baseSystemPrompt: mode.baseSystemPrompt,
    customInstructions: settings.customInstructions,
    toolPrompt,
    tightContext,
  });
  if (!tightContext) {
    systemPrompt += buildAgentSystemPromptLayers({
      projectPath: settings.projectPath,
      guideInstructionsPath: settings.guideInstructionsPath,
      editorContext: settings.editorContext,
      editorDiagnostics: settings.editorDiagnostics,
    });
  } else if (settings.projectPath) {
    systemPrompt += `\nProject directory: ${settings.projectPath}\nAll file tools are relative to this directory.\n`;
  }
  if (mode.systemPromptAdditions) {
    systemPrompt += mode.systemPromptAdditions;
  }
  console.log(
    `[CloudAgentic] systemPrompt=${systemPrompt.length} chars tight=${tightContext} tools=${mode.toolsActive ? 'on' : 'off'} mode=${mode.planning ? 'plan' : mode.askOnly ? 'ask' : 'agent'}`,
  );

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

  const streamFilters = createCloudStreamFilters({ onToken, onThinkingToken, onStreamEvent });

  const genBase = {
    provider: cloudProvider,
    model: cloudModel,
    systemPrompt,
    temperature: settings.temperature,
    maxTokens: settings.maxResponseTokens || -1,
    topP: settings.topP,
    images,
    stream: true,
  };

  for (let iter = 0; iter < maxIter; iter++) {
    if (getCancelled?.()) {
      console.log('[CloudAgentic] cancelled');
      break;
    }

    streamFilters.resetRound();

    const result = await cloudLLM.generate(nextUserPrompt, {
      ...genBase,
      conversationHistory,
      images: iter === 0 ? images : [],
      onToken: (token) => {
        streamTrace.trace('stream', 'cloud-token', { token, iter });
        streamFilters.processContentChunk(token);
      },
      onThinkingToken: (token) => {
        streamTrace.trace('stream', 'cloud-thinking-token', { token, iter });
        streamFilters.processThinkingChunk(token);
      },
    });

    streamFilters.flush();

    if (result?.isQuotaError) {
      return { isQuotaError: true, error: '__QUOTA_EXCEEDED__', text: displayResponse || fullResponse, toolCallCount: totalToolCalls };
    }

    const roundTextContent = result?.text || '';
    const roundRawCombined = streamFilters.getCombinedRawBuffer() || roundTextContent;
    fullResponse += roundRawCombined;

    const roundCleanProse = streamFilters.getProseCleanText() || stripToolCallText(roundTextContent);
    displayResponse += roundCleanProse;

    if (mode.askOnly || !mode.toolsActive || !executeToolFn) {
      break;
    }

    let parsedCalls = parseToolCalls(roundRawCombined);
    if (!parsedCalls.length) {
      if (looksLikeToolAttempt(roundRawCombined)) {
        const closestHint = suggestClosestToolName(roundRawCombined);
        conversationHistory.push({
          role: 'assistant',
          content: roundCleanProse.trim() || '(tool calls)',
        });
        conversationHistory.push({
          role: 'user',
          content: `[System: Tool call could not be parsed. Retry with valid JSON: {"tool":"<name>","params":{...}}.${closestHint ? ` ${closestHint}` : ''}]`,
        });
        nextUserPrompt = CLOUD_CONTINUE_PROMPT;
        continue;
      }
      // Agent mode: model only promised action — nudge once to emit tools (common on tight Secrypt prompts).
      if (
        mode.toolsActive
        && !mode.askOnly
        && !mode.planning
        && looksLikeEmptyBuildPromise(roundCleanProse)
        && iter < maxIter - 1
        && !conversationHistory.some((m) => m.role === 'user' && String(m.content || '').includes('emitted no tool calls'))
      ) {
        conversationHistory.push({
          role: 'assistant',
          content: roundCleanProse.trim() || '(no tools)',
        });
        conversationHistory.push({ role: 'user', content: CLOUD_FORCE_TOOLS_PROMPT });
        nextUserPrompt = CLOUD_CONTINUE_PROMPT;
        console.log('[CloudAgentic] prose-only build promise — forcing tool call round');
        continue;
      }
      break;
    }

    const { repaired, issues } = repairToolCalls(parsedCalls, roundRawCombined);
    parsedCalls = repaired.filter((c) => c.tool !== 'spawn_subagent');

    let planBlockedAll = false;
    if (mode.planning && parsedCalls.length > 0) {
      const { calls: planCalls, blocked } = filterPlanModeToolCalls(parsedCalls);
      if (blocked.length) {
        console.log(`[CloudAgentic] Plan mode blocked: ${blocked.map((c) => c.tool).join(', ')}`);
      }
      if (parsedCalls.length > 0 && planCalls.length === 0 && blocked.length > 0) {
        planBlockedAll = true;
      }
      parsedCalls = planCalls;
    }

    if (!parsedCalls.length) {
      if (planBlockedAll) {
        conversationHistory.push({
          role: 'assistant',
          content: roundCleanProse.trim() || '(tool calls)',
        });
        conversationHistory.push({ role: 'user', content: PLAN_BLOCKED_TOOLS_MSG });
        nextUserPrompt = CLOUD_CONTINUE_PROMPT;
        continue;
      }
      if (issues?.length) {
        conversationHistory.push({
          role: 'assistant',
          content: roundCleanProse.trim() || '(tool calls)',
        });
        conversationHistory.push({
          role: 'user',
          content: `[System: Tool Validation Failed]\n${issues.join('\n')}\n\nRetry with valid tool parameters.`,
        });
        nextUserPrompt = CLOUD_CONTINUE_PROMPT;
        continue;
      }
      if (looksLikeToolAttempt(roundRawCombined)) {
        const closestHint = suggestClosestToolName(roundRawCombined);
        conversationHistory.push({
          role: 'assistant',
          content: roundCleanProse.trim() || '(tool calls)',
        });
        conversationHistory.push({
          role: 'user',
          content: `[System: Tool call could not be parsed. Retry with valid JSON: {"tool":"<name>","params":{...}}.${closestHint ? ` ${closestHint}` : ''}]`,
        });
        nextUserPrompt = CLOUD_CONTINUE_PROMPT;
        continue;
      }
      break;
    }

    const visibleAssistant = roundCleanProse.trim();
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

      if (
        FILE_WRITE_OPS.has(toolName)
        && call.params?.content
        && onStreamEvent
        && shouldStreamFileContentForAgent(settings, call.params.filePath || call.params.path || '')
      ) {
        const filePath = call.params.filePath || call.params.path || '';
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        onStreamEvent('file-content-block-complete', {
          filePath,
          fileName,
          language: ext,
          fileKey: filePath,
          content: String(call.params.content),
          op: 'write',
        });
      }
      if (
        FILE_EDIT_OPS.has(toolName)
        && call.params?.newText != null
        && onStreamEvent
        && shouldStreamFileContentForAgent(settings, call.params.filePath || call.params.path || '')
      ) {
        const filePath = call.params.filePath || call.params.path || '';
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        onStreamEvent('file-content-block-complete', {
          filePath,
          fileName,
          language: ext,
          fileKey: filePath,
          content: String(call.params.newText),
          op: 'edit',
          oldText: call.params.oldText != null ? String(call.params.oldText) : '',
          newText: String(call.params.newText),
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

    const activeTodos = typeof getActiveTodos === 'function' ? getActiveTodos() : [];
    const executedToolNames = parsedCalls.map((c) => c.tool);
    const todoListPrefix = buildTodoProgressHint(activeTodos, executedToolNames, 0);
    const injectText = buildToolResultsUserMessage(toolResultLines, { interruptPrefix: todoListPrefix });
    conversationHistory.push({ role: 'user', content: injectText });
    console.log(`[CloudAgentic] ─── TOOL RESULTS → MODEL ─── ${toolResultLines.length} result(s)`);

    nextUserPrompt = CLOUD_CONTINUE_PROMPT;
  }

  const finalText = displayResponse || stripToolCallText(fullResponse);
  return { text: finalText, toolCallCount: totalToolCalls };
}

module.exports = { runCloudAgenticChat };
