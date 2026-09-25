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
const { fitCloudHistory, inputBudgetTokens } = require('./tools/cloudContextFit');
const { resolveCloudOutputTokens } = require('./cloudLLMService');

const CLOUD_CORE_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'append_to_file', 'list_directory',
  'find_files', 'grep_search', 'run_command', 'write_todos', 'update_todo', 'ask_question',
];

function selectCloudToolDefs(defs, userMessage) {
  const text = String(userMessage || '').toLowerCase();
  const allow = new Set(CLOUD_CORE_TOOLS);
  if (/\b(browser|website|navigate|click|url|https?)\b/.test(text)) {
    for (const d of defs) if (String(d.name).startsWith('browser_')) allow.add(d.name);
  }
  if (/\bgit\b/.test(text)) {
    for (const d of defs) if (String(d.name).startsWith('git_')) allow.add(d.name);
  }
  if (/\b(memory|remember)\b/.test(text)) {
    allow.add('save_memory');
    allow.add('get_memory');
    allow.add('list_memories');
  }
  const picked = defs.filter((d) => allow.has(d.name));
  return picked.length ? picked : defs;
}

function createThinkTagSplitter({ onThinking, onContent }) {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let inThink = false;
  let buf = '';
  const holdPartial = (tag) => {
    const i = buf.lastIndexOf('<');
    if (i === -1) return false;
    const tail = buf.slice(i);
    if (!tag.startsWith(tail)) return false;
    return i;
  };
  return {
    push(token) {
      buf += String(token || '');
      for (;;) {
        if (!inThink) {
          const i = buf.indexOf(OPEN);
          if (i === -1) {
            const h = holdPartial(OPEN);
            if (h === false) {
              if (buf) onContent(buf);
              buf = '';
            } else if (h > 0) {
              onContent(buf.slice(0, h));
              buf = buf.slice(h);
            }
            return;
          }
          if (i > 0) onContent(buf.slice(0, i));
          buf = buf.slice(i + OPEN.length);
          inThink = true;
          continue;
        }
        const j = buf.indexOf(CLOSE);
        if (j === -1) {
          const h = holdPartial(CLOSE);
          if (h === false) {
            if (buf) onThinking(buf);
            buf = '';
          } else if (h > 0) {
            onThinking(buf.slice(0, h));
            buf = buf.slice(h);
          }
          return;
        }
        if (j > 0) onThinking(buf.slice(0, j));
        buf = buf.slice(j + CLOSE.length);
        inThink = false;
      }
    },
    flush() {
      if (!buf) return;
      if (inThink) onThinking(buf);
      else onContent(buf);
      buf = '';
    },
  };
}

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
  // Secrypt/P40 quality worker context is 24576 — use compact tool catalog.
  const isSecryptCloud = ['secrypt', 'cipher', 'graysoft', 'cerebras'].includes(
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
  let filteredDefs = filterToolDefinitions(allDefs, mode.allowedTools);
  if (isSecryptCloud && !mode.planning) {
    filteredDefs = selectCloudToolDefs(filteredDefs, userMessage);
  }

  const toolPromptOpts = { planning: mode.planning };
  let toolPrompt = '';
  if (mode.toolsActive) {
    if (isSecryptCloud) {
      // Compact + descriptions: full agent tool surface without blowing 16k prefill.
      toolPrompt = mcpToolServer
        .getCompactToolHint('default', {
          toolDefs: filteredDefs,
          planning: mode.planning,
          compactDescriptions: true,
        })
        .join('');
      toolPrompt +=
        '\nCRITICAL: When asked to build/create files, emit write_file/edit_file tool JSON in this turn. Do not only promise to build.\n';
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
    tightContext: false,
  });
  systemPrompt += buildAgentSystemPromptLayers({
    projectPath: settings.projectPath,
    guideInstructionsPath: settings.guideInstructionsPath,
    editorContext: settings.editorContext,
    editorDiagnostics: settings.editorDiagnostics,
  });
  if (mode.systemPromptAdditions) {
    systemPrompt += mode.systemPromptAdditions;
  }
  console.log(
    `[CloudAgentic] systemPrompt=${systemPrompt.length} chars secrypt=${isSecryptCloud} tools=${mode.toolsActive ? 'on' : 'off'} mode=${mode.planning ? 'plan' : mode.askOnly ? 'ask' : 'agent'}`,
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

  const requestedMax = settings.maxResponseTokens > 0
    ? settings.maxResponseTokens
    : (settings.maxTokens > 0 ? settings.maxTokens : 0);
  const activeGoal = settings.activeGoal && settings.activeGoal.objective && !settings.goalPaused
    ? settings.activeGoal
    : null;
  if (activeGoal) {
    systemPrompt += `\n\n## Active goal\n${activeGoal.objective}\n`;
  }

  const genBase = {
    provider: cloudProvider,
    model: cloudModel,
    systemPrompt,
    temperature: settings.temperature,
    maxTokens: requestedMax,
    topP: settings.topP,
    images,
    stream: true,
    enableThinking: settings.enableThinking !== false,
    thinkingMode: settings.thinkingMode || 'C',
  };

  let emptyLengthStops = 0;
  let shrinkTries = 0;
  const contextLimit = typeof cloudLLM._getModelContextLimit === 'function'
    ? cloudLLM._getModelContextLimit(cloudProvider, cloudModel)
    : 24576;
  const outputTokens = resolveCloudOutputTokens(requestedMax, contextLimit);

  const applyFit = (history, nextUser, budgetTokens) => {
    const fit = fitCloudHistory({
      systemPrompt,
      history,
      nextUser,
      contextLimit,
      outputTokens,
      budgetTokens,
    });
    if (fit.droppedCount > 0) {
      console.log(`[CloudAgentic] context rotate dropped=${fit.droppedCount} budget=${budgetTokens || inputBudgetTokens(contextLimit, outputTokens)}`);
      if (onStreamEvent) {
        onStreamEvent('generation-warning', {
          message: 'Condensing context — continuing task',
          suggestion: 'Older messages were summarized. The agent will keep working.',
        });
      }
    }
    return fit;
  };

  for (let iter = 0; iter < maxIter; iter++) {
    if (getCancelled?.()) {
      console.log('[CloudAgentic] cancelled');
      break;
    }

    const fitted = applyFit(conversationHistory, nextUserPrompt);
    conversationHistory.length = 0;
    conversationHistory.push(...fitted.history);
    nextUserPrompt = fitted.nextUser;

    streamFilters.resetRound();
    const thinkSplit = createThinkTagSplitter({
      onThinking: (token) => {
        streamTrace.trace('stream', 'cloud-thinking-token', { token, iter });
        streamFilters.processThinkingChunk(token);
      },
      onContent: (token) => {
        streamTrace.trace('stream', 'cloud-token', { token, iter });
        streamFilters.processContentChunk(token);
      },
    });

    let result;
    try {
      result = await cloudLLM.generate(nextUserPrompt, {
        ...genBase,
        conversationHistory,
        images: iter === 0 ? images : [],
        onToken: (token) => thinkSplit.push(token),
        onThinkingToken: (token) => {
          streamTrace.trace('stream', 'cloud-thinking-token', { token, iter });
          streamFilters.processThinkingChunk(token);
        },
      });
    } catch (err) {
      if (getCancelled?.() || err?.code === 'ABORTED') {
        console.log('[CloudAgentic] cancelled during generate');
        break;
      }
      const msg = String(err?.message || '');
      if (shrinkTries < 3 && /context size|context length|maximum context|exceeds the available context/i.test(msg)) {
        shrinkTries += 1;
        const tighter = applyFit(
          conversationHistory,
          nextUserPrompt,
          Math.max(512, Math.floor(inputBudgetTokens(contextLimit, outputTokens) * 0.6)),
        );
        conversationHistory.length = 0;
        conversationHistory.push(...tighter.history);
        nextUserPrompt = tighter.nextUser;
        console.log(`[CloudAgentic] context overflow — shrink ${shrinkTries}`);
        continue;
      }
      throw err;
    }

    if (getCancelled?.()) break;

    thinkSplit.flush();
    streamFilters.flush();

    if (result?.isQuotaError) {
      return { isQuotaError: true, error: '__QUOTA_EXCEEDED__', text: displayResponse || fullResponse, toolCallCount: totalToolCalls };
    }

    if (result?.stopReason === 'length' && iter < maxIter - 1) {
      const partialRaw = streamFilters.getCombinedRawBuffer() || result?.text || '';
      const partialProse = streamFilters.getProseCleanText() || stripToolCallText(result?.text || '');
      if (partialProse) displayResponse += partialProse;
      fullResponse += partialRaw;
      if (partialRaw.trim()) {
        conversationHistory.push({ role: 'assistant', content: partialRaw.slice(-8000) });
      }
      const rotated = applyFit(conversationHistory, 'Continue from where you stopped. Do not repeat completed work.');
      const shrunk = rotated.droppedCount > 0 || rotated.history.length < conversationHistory.length;
      if (!shrunk && partialRaw.trim().length < 80) {
        emptyLengthStops += 1;
        if (emptyLengthStops >= 2) break;
      } else {
        emptyLengthStops = 0;
      }
      conversationHistory.length = 0;
      conversationHistory.push(...rotated.history);
      nextUserPrompt = rotated.nextUser;
      console.log(`[CloudAgentic] length stop — rotated and continuing dropped=${rotated.droppedCount}`);
      continue;
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
        nextUserPrompt = userMessage;
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
        nextUserPrompt = userMessage;
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
        nextUserPrompt = userMessage;
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
        nextUserPrompt = userMessage;
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
        nextUserPrompt = userMessage;
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

    nextUserPrompt = userMessage;
  }

  let finalText = displayResponse || stripToolCallText(fullResponse);
  const goalComplete = !!(activeGoal && /GOAL_COMPLETE/.test(finalText));
  finalText = String(finalText || '').replace(/GOAL_COMPLETE/g, '').trim();
  return {
    text: finalText,
    toolCallCount: totalToolCalls,
    goalComplete,
    cancelled: !!getCancelled?.(),
  };
}

module.exports = { runCloudAgenticChat, selectCloudToolDefs, createThinkTagSplitter };
