'use strict';

const {
  parseToolCalls,
  repairToolCalls,
  stripToolCallText,
  looksLikeToolAttempt,
  suggestClosestToolName,
  _recoverWriteFileContent,
} = require('./tools/toolParser');
const { buildCloudSystemPrompt, buildAgentSystemPromptLayers, buildTodoProgressHint } = require('./chatEngine');
const {
  formatToolResultForInject,
  buildToolResultsUserMessage,
  sanitizeCloudConversationHistory,
} = require('./tools/toolResultInjection');
const { createCloudStreamFilters, isFormingFileWritePayload } = require('./tools/streamingToolFilter');
const {
  resolveAgentMode,
  filterToolDefinitions,
  filterPlanModeToolCalls,
  shouldStreamFileContentForAgent,
  getCloudAgentSystemPrompt,
} = require('./agentModeResolver');
const streamTrace = require('./streamTrace');
const { fitCloudHistory, inputBudgetTokens, estimateTokens, promptChars, measuredCost } = require('./tools/cloudContextFit');
const { upgradeRotatedHistoryWithFastSummary } = require('./tools/cloudContextSummarize');
const { resolveCloudOutputTokens, secryptQualitySampling } = require('./cloudLLMService');
const {
  INCOMPLETE_ROUND_CAP,
  CONTINUE_PARTIAL_MAX_CHARS,
  roundIsIncomplete,
  toolResultFailed,
  looksLikeReasoningFileDump,
  findReasoningContentFenceIndex,
  trailingIncompleteFenceOpenHold,
  scrubNarrationLinesFromFileBody,
} = require('./tools/agentRoundEnd');

/** After tool results (or a system repair) are already in history — do not re-ask the original user text. */
const NEXT_FROM_HISTORY = '';

function assistantHistoryContent(prose, raw, calls) {
  // Tool rounds: history carries the tool calls. Announce prose in history made the next
  // round restate the same intent (live board-check 2026-09-29). Final prose-only answers
  // still store the visible answer.
  if (Array.isArray(calls) && calls.length) {
    return calls.map((c) => JSON.stringify({ tool: c.tool, params: c.params || {} })).join('\n');
  }
  const visible = String(prose || '').trim();
  if (visible && visible !== '(tool calls)') return visible;
  const rawText = String(raw || '').trim();
  if (rawText) return rawText.slice(-4000);
  return '{"tool":"unknown","params":{}}';
}

function rememberUserRequest(history, text) {
  const body = String(text || '').trim();
  if (!body) return;
  const already = history.some((m) => m.role === 'user' && String(m.content || '').trim() === body);
  if (already) return;
  // Keep the original ask near the front of history (after any leading notice).
  let insertAt = 0;
  if (history[0] && /\[System: Session memory condensed\]/i.test(String(history[0].content || ''))) {
    insertAt = 1;
  }
  history.splice(insertAt, 0, { role: 'user', content: body });
}

function writtenFilesNote(projectPath, relPaths) {
  const fs = require('fs');
  const path = require('path');
  if (!Array.isArray(relPaths) || !relPaths.length) return '';
  const lines = [];
  let budget = 4000;
  const seen = new Set();
  for (const rel of relPaths) {
    const key = String(rel || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const abs = path.isAbsolute(key) ? key : path.join(String(projectPath || ''), key);
    let size = 0;
    let tail = '';
    try {
      size = fs.statSync(abs).size;
      const parts = fs.readFileSync(abs).toString('utf8').split(/\r?\n/);
      const kept = [];
      for (let i = parts.length - 1; i >= 0 && budget > 0; i -= 1) {
        kept.unshift(parts[i]);
        budget -= parts[i].length + 1;
      }
      tail = kept.join('\n');
    } catch (e) {
      tail = `(unreadable: ${e.message})`;
    }
    lines.push(`- ${key} (${size} bytes)\n${tail}`);
  }
  return lines.join('\n');
}

/** Coerce any non-user/assistant roles so Jinja never sees a mid-list system message. */
function sanitizeHistoryRoles(history) {
  if (!Array.isArray(history)) return;
  for (const m of history) {
    if (!m) continue;
    const role = String(m.role || '').toLowerCase();
    if (role === 'system' || (role && role !== 'user' && role !== 'assistant')) {
      m.role = 'user';
    }
  }
}

/**
 * VisionNative3: do NOT Gemini-caption and pretend Cipher already saw the image.
 * Operator rejected caption fallback (2026-09-30). Native path = Secrypt mmproj.
 * On upstream vision fail after retries: honest inject only.
 */
async function compressImagesForVisionRetry(imageList) {
  // Passthrough size gate — Electron may attach multi-MB PNGs that stress the proxy.
  // Prefer JPEG data-URLs under ~1.5MB when Buffer is available; else return originals.
  const out = [];
  for (const img of imageList || []) {
    try {
      const raw = typeof img === 'string' ? img : (img?.data || img?.dataUrl || '');
      const mime = (typeof img === 'object' && img?.mimeType) ? img.mimeType : 'image/png';
      const s = String(raw || '');
      if (!s || s.length < 1_500_000) {
        out.push(img);
        continue;
      }
      // Strip data-url prefix for length log; keep original payload (no decode lib here).
      console.warn(`[CloudAgentic] vision image large chars=${s.length} mime=${mime} — retrying as-is after mmproj path`);
      out.push(img);
    } catch {
      out.push(img);
    }
  }
  return out;
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
  /** Drop protocol close tags when not inside a think block; keep surrounding prose. */
  const stripOrphanCloses = (text) => {
    if (!text || !text.includes(CLOSE)) return text;
    return text.split(CLOSE).join('');
  };
  return {
    push(token) {
      buf += String(token || '');
      for (;;) {
        if (!inThink) {
          const i = buf.indexOf(OPEN);
          if (i === -1) {
            const closeIdx = buf.indexOf(CLOSE);
            if (closeIdx !== -1) {
              if (closeIdx > 0) onContent(buf.slice(0, closeIdx));
              buf = buf.slice(closeIdx + CLOSE.length);
              continue;
            }
            const hClose = holdPartial(CLOSE);
            if (hClose !== false) {
              if (hClose > 0) {
                onContent(buf.slice(0, hClose));
                buf = buf.slice(hClose);
              }
              return;
            }
            const h = holdPartial(OPEN);
            if (h === false) {
              if (buf) onContent(stripOrphanCloses(buf));
              buf = '';
            } else if (h > 0) {
              onContent(buf.slice(0, h));
              buf = buf.slice(h);
            }
            return;
          }
          if (i > 0) onContent(stripOrphanCloses(buf.slice(0, i)));
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
      else onContent(stripOrphanCloses(buf));
      buf = '';
      inThink = false;
    },
  };
}

const PLAN_BLOCKED_TOOLS_MSG =
  '[System: Plan mode — update_todo cannot mark items done/in-progress or edit non-plan files until Build. Use write_todos for planning; write_file/edit_file only for .guide/plans/*.plan.md. Do not repeat blocked tool JSON in your reply.]';

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
  onContextUsage,
  getCancelled,
  getActiveTodos,
}) {
  const enableSubAgents = !!(settings.enableSubAgents);
  const toolsEnabled = settings.toolsEnabled !== false;
  // Secrypt/P40 quality worker context is 131072.
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

  if (!mode.askOnly && !mode.planning) {
    mode.baseSystemPrompt = getCloudAgentSystemPrompt();
  }

  mcpToolServer.setAgentContext({ planMode: mode.planMode, agentPhase: mode.agentPhase });
  if (typeof mcpToolServer.resetWebSearchDedup === 'function') {
    mcpToolServer.resetWebSearchDedup();
  } else {
    mcpToolServer._webSearchQueryCounts = new Map();
  }

  const allDefs = mcpToolServer.getToolDefinitions();
  let filteredDefs = filterToolDefinitions(allDefs, mode.allowedTools);
  filteredDefs = filteredDefs.filter((d) => d.name !== 'generate_image');
  if (settings.enabledTools && typeof settings.enabledTools === 'object') {
    filteredDefs = filteredDefs.filter((d) => settings.enabledTools[d.name] === true);
  }

  let toolPrompt = '';
  if (mode.toolsActive) {
    // Restore compact catalog with JSON fence examples (pre-0.4.94). Settings filter stays via toolDefs.
    toolPrompt = mcpToolServer
      .getCompactToolHint('default', {
        toolDefs: filteredDefs,
        planning: mode.planning,
        compactDescriptions: true,
      })
      .join('');
    if (enableSubAgents && !isSecryptCloud && toolPrompt) {
      toolPrompt +=
        '\n- **spawn_subagent** — Delegate a focused sub-task to an isolated sub-agent (local model only; unavailable in cloud mode).';
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
    `[CloudAgentic] systemPrompt=${systemPrompt.length} chars secrypt=${isSecryptCloud} tools=${mode.toolsActive ? 'on' : 'off'} mode=${mode.planning ? 'plan' : mode.askOnly ? 'ask' : 'agent'} toolCount=${filteredDefs.length}`,
  );

  const conversationHistory = sanitizeCloudConversationHistory(
    Array.isArray(initialHistory) ? initialHistory : [],
    { parseToolCalls, stripToolCallText }
  ).map((m) => ({ role: m.role, content: String(m.content || '') }));

  console.log(
    `[CloudAgentic] history: ${initialHistory?.length || 0} raw → ${conversationHistory.length} sanitized; mode=${mode.planning ? 'plan' : mode.askOnly ? 'ask' : 'agent'}`
  );

  let fullResponse = '';
  let displayResponse = '';
  let totalToolCalls = 0;
  let nextUserPrompt = userMessage;

  let routeContentToThinking = false; // retired sticky (UnstickThink1) — kept false; native channel only
  const streamFilters = createCloudStreamFilters({
    onToken,
    onThinkingToken,
    onStreamEvent,
  });

  const requestedMax = settings.maxResponseTokens > 0
    ? settings.maxResponseTokens
    : (settings.maxTokens > 0 ? settings.maxTokens : 0);
  const activeGoal = settings.activeGoal && settings.activeGoal.objective && !settings.goalPaused
    ? settings.activeGoal
    : null;
  if (activeGoal) {
    systemPrompt += `\n\n## Active goal\n${activeGoal.objective}\n`;
  }

  const thinkingOn = settings.enableThinking !== false && settings.thinkingMode !== 'off';
  const qualitySampling = isSecryptCloud ? secryptQualitySampling(thinkingOn) : null;
  const genBase = {
    provider: cloudProvider,
    model: cloudModel,
    systemPrompt,
    temperature: qualitySampling ? qualitySampling.temperature : settings.temperature,
    maxTokens: requestedMax,
    topP: qualitySampling ? qualitySampling.topP : settings.topP,
    topK: qualitySampling ? qualitySampling.topK : settings.topK,
    minP: qualitySampling ? qualitySampling.minP : settings.minP,
    presencePenalty: qualitySampling ? qualitySampling.presencePenalty : settings.presencePenalty,
    repeatPenalty: qualitySampling ? qualitySampling.repeatPenalty : settings.repeatPenalty,
    reasoningEffort: qualitySampling ? qualitySampling.reasoningEffort : settings.reasoningEffort,
    images,
    stream: true,
    enableThinking: settings.enableThinking !== false,
    thinkingMode: settings.thinkingMode || 'C',
    projectPath: settings.projectPath || process.cwd(),
    getCancelled,
  };

  let stallResumes = 0;
  let preemptResumes = 0;
  let rateResumes = 0;
  let incompleteRounds = 0;
  let emptyGenStreak = 0;
  let emptyRecoveries = 0;
  let jinjaResumes = 0;
  let overflowResumes = 0;
  let lastToolResultsMessage = null;
  let lastEmptyStreamDiag = null;
  let unparsedToolAttemptStreak = 0;
  let shrinkTries = 0;
  let toolsUsedThisTurn = 0;
  let todoLedgerTouchedThisTurn = false;
  let lastToolBatchFailed = false;
  const filesWrittenThisTurn = [];
  let continuePartial = null;
  let continueCount = 0;
  const CONTINUE_CAP = 8;
  let continueInThinking = false;
  let thinkSplit = null;
  let trailingChannel = 'none';
  let thinkingChars = 0;
  let proseCharsLive = 0;
  // ThinkFenceDivert1: hold/divert state across continuePartial; reset each fresh generate.
  let thinkHold = '';
  let divertThinkingToProse = false;
  let routeThinkingToken = null;
  let noteThinking = null;
  let noteProse = null;
  // ImgHist1: attachments stay on every request of this turn (tool rounds, continues, recoveries).
  let pendingImages = Array.isArray(images) ? images.slice() : [];
  let imagesDelivered = false;
  let visionCaptionTries = 0;
  const EMPTY_RECOVERY_MAX = 2;
  const JINJA_RESUME_MAX = 6;
  const OVERFLOW_RESUME_MAX = 2;
  const OVERFLOW_TOOL_RESULT_CHARS = 12000;
  // OpenTodoNoAbort1: context-fit recoveries while ledger still has open work (never abort mid-task).
  let openTodoFitRecoveries = 0;
  const OPEN_TODO_FIT_RECOVERY_MAX = 8;

  const truncateToolResultsInHistory = (history, cap) => {
    if (!Array.isArray(history) || history.length === 0) return;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const m = history[i];
      if (!m || m.role !== 'user') continue;
      const text = String(m.content || '');
      if (!/\[System: Tool Results\]/i.test(text)) continue;
      if (text.length <= cap) break;
      m.content = `${text.slice(0, cap)}\n[... tool result truncated after context overflow; continue with text above]`;
      break;
    }
    if (lastToolResultsMessage && String(lastToolResultsMessage).length > cap) {
      lastToolResultsMessage = `${String(lastToolResultsMessage).slice(0, cap)}\n[... tool result truncated after context overflow; continue with text above]`;
    }
  };
  if (typeof cloudLLM.loadP40Windows === 'function') await cloudLLM.loadP40Windows();
  const contextLimit = typeof cloudLLM._getModelContextLimit === 'function'
    ? cloudLLM._getModelContextLimit(cloudProvider, cloudModel)
    : 131072;
  /** Inject caps must use the live model window — never maxResponseTokens (0 → false 8k). */
  const contextTokens = contextLimit > 0 ? contextLimit : 131072;
  const outputTokens = resolveCloudOutputTokens(requestedMax, contextLimit);
  // ThinkStreamLive1: effort is the lever — no client thinkingChars divert/cap.

  // Server-measured prompt size from the last reply. Carried across messages only for the same
  // provider/model and the same first history message, so another chat never borrows its ratio.
  const measureKey = `${cloudProvider}|${cloudModel}`;
  const historyHead = (history) => {
    const m = Array.isArray(history) ? history[0] : null;
    if (!m) return '';
    const text = String(m.content || '');
    return `${m.role}:${text.length}:${text.slice(0, 512)}`;
  };
  const carried = cloudLLM._measuredPrompt;
  let measuredPrompt = carried && carried.key === measureKey && carried.head
    && carried.head === historyHead(conversationHistory)
    ? carried
    : null;

  const emitContextUsage = (history, nextUser) => {
    const used = measuredCost(
      measuredPrompt,
      promptChars(systemPrompt, history, nextUser),
      estimateTokens(systemPrompt)
        + estimateTokens(nextUser)
        + (Array.isArray(history) ? history.reduce((sum, m) => sum + estimateTokens(m?.content), 0) : 0),
    );
    const payload = { used: Math.min(used, contextTokens), total: contextTokens };
    if (typeof onContextUsage === 'function') onContextUsage(payload);
    else if (onStreamEvent) onStreamEvent('context-usage', payload);
  };

  // Seed ring immediately so Cipher matches local (ring visible before first token).
  emitContextUsage([], userMessage);

  const applyFit = async (history, nextUser, budgetTokens) => {
    const todosNow = typeof getActiveTodos === 'function' ? getActiveTodos() : [];
    const pinned = new Set();
    const orig = String(userMessage || '').trim();
    for (const m of history) {
      if (!m) continue;
      if (orig && m.role === 'user' && String(m.content || '').trim() === orig) pinned.add(m);
      if (lastToolResultsMessage && m.content === lastToolResultsMessage) pinned.add(m);
    }
    const fit = fitCloudHistory({
      systemPrompt,
      history,
      nextUser,
      contextLimit,
      outputTokens,
      budgetTokens,
      activeTodos: todosNow,
      measured: measuredPrompt,
      pinned,
      writtenNote: writtenFilesNote(settings.projectPath, filesWrittenThisTurn),
    });
    if (fit.droppedCount <= 0) {
      emitContextUsage(fit.history, fit.nextUser);
      return fit;
    }

    console.log(`[CloudAgentic] context rotate dropped=${fit.droppedCount} budget=${budgetTokens || inputBudgetTokens(contextLimit, outputTokens)}`);
    if (onStreamEvent) {
      onStreamEvent('generation-warning', {
        message: 'Condensing context — continuing task',
        suggestion: 'Older messages were summarized. The agent will keep working.',
      });
    }

    const upgraded = await upgradeRotatedHistoryWithFastSummary({
      cloudLLM,
      history: fit.history,
      droppedText: fit.droppedText,
      keptTailText: fit.keptTailText,
      droppedCount: fit.droppedCount,
      taskHint: fit.nextUser || nextUser,
      activeTodos: todosNow,
      provider: cloudProvider,
      getCancelled,
      onPhase: (phase, text) => {
        if (!onStreamEvent) return;
        onStreamEvent('context-summarize', {
          phase,
          text: text ? String(text) : '',
          droppedCount: fit.droppedCount,
        });
      },
    });
    const out = {
      ...fit,
      history: upgraded.history,
      summarizedWithLlm: !!upgraded.usedLlm,
    };
    emitContextUsage(out.history, out.nextUser);
    return out;
  };

  for (let iter = 0; ; iter++) {
    if (getCancelled?.()) {
      console.log('[CloudAgentic] cancelled');
      break;
    }

    if (!continuePartial) {
    const fitted = await applyFit(conversationHistory, nextUserPrompt);
    conversationHistory.length = 0;
    conversationHistory.push(...fitted.history);
    nextUserPrompt = fitted.nextUser;

    streamFilters.resetRound();
    trailingChannel = 'none';
    thinkingChars = 0;
    proseCharsLive = 0;
    // UnstickThink1: never sticky-route content→thinking across a round. Qwen rarely
    // emits </think> in the content channel after stall/vision resume; sticky trapped
    // prose + tool cards inside the Thought dropdown (operator 2026-09-30).
    routeContentToThinking = false;
    noteThinking = (token) => {
      const n = String(token || '').length;
      if (!n) return;
      thinkingChars += n;
      trailingChannel = 'thinking';
    };
    noteProse = (token) => {
      const n = String(token || '').length;
      if (!n) return;
      proseCharsLive += n;
      trailingChannel = 'prose';
    };
    // ThinkStreamLive1: reasoning_content ALWAYS streams to Thought live.
    // Never divert to silent/prose (that froze UI then jutted outline-as-file).
    // Hold at most incomplete \`\`\` opener chars (1–3), never prose.
    thinkHold = '';
    divertThinkingToProse = false;
    routeThinkingToken = (token) => {
      const t = String(token || '');
      if (!t) return;
      const combined = thinkHold + t;
      const holdN = trailingIncompleteFenceOpenHold(combined);
      if (holdN > 0 && holdN < combined.length) {
        const flush = combined.slice(0, -holdN);
        thinkHold = combined.slice(-holdN);
        noteThinking(flush);
        streamTrace.trace('stream', 'cloud-thinking-token', { token: flush, iter });
        streamFilters.processThinkingChunk(flush);
      } else if (holdN > 0) {
        thinkHold = combined;
      } else {
        thinkHold = '';
        noteThinking(combined);
        streamTrace.trace('stream', 'cloud-thinking-token', { token: combined, iter });
        streamFilters.processThinkingChunk(combined);
      }
    };
    thinkSplit = createThinkTagSplitter({
      onThinking: (token) => {
        routeThinkingToken(token);
      },
      onContent: (token) => {
        noteProse(token);
        streamTrace.trace('stream', 'cloud-token', { token, iter });
        streamFilters.processContentChunk(token);
      },
    });
    }

    let result;
    try {
      result = await cloudLLM.generate(nextUserPrompt, {
        ...genBase,
        conversationHistory,
        measuredPrompt,
        continuePartial: continuePartial || undefined,
        continueInThinking: continueInThinking || undefined,
        images: pendingImages,
        imageAnchorText: pendingImages.length ? userMessage : undefined,
        onToken: (token) => thinkSplit.push(token),
        onThinkingToken: (token) => {
          if (routeThinkingToken) routeThinkingToken(token);
          else {
            noteThinking(token);
            streamTrace.trace('stream', 'cloud-thinking-token', { token, iter });
            streamFilters.processThinkingChunk(token);
          }
        },
        // StreamWaitLive1 + WaitCopy1: prefill/mid-stream quiet paint in chat.
        // After tools / later iters this is NOT "first token" — prior content already exists.
        onStreamQuiet: ({ ageMs, phase } = {}) => {
          const secs = Math.max(0, Math.round((ageMs || 0) / 1000));
          const isFirstByte = phase === 'first-byte';
          // WaitCopy1: ignore sub-5s first-byte noise (HTTP connect ≠ waiting for tokens).
          if (isFirstByte && secs < 5) return;
          console.log(
            `[CloudAgentic] silenceWatch phase=${isFirstByte ? 'first-byte' : 'mid-stream'} `
            + `age=${secs}s iter=${iter} tools=${toolsUsedThisTurn}`,
          );
          // ThinkStreamLive1: flush thinkHold to Thought only (never silent).
          if (!isFirstByte && thinkHold && typeof noteThinking === 'function') {
            const left = thinkHold;
            thinkHold = '';
            noteThinking(left);
            streamFilters.processThinkingChunk(left);
          }
          if (onStreamEvent) {
            const afterPrior = iter > 0 || toolsUsedThisTurn > 0;
            let message;
            let suggestion;
            // PrefillWaitBar1: short StatusBar copy only (App clears transcript status).
            if (isFirstByte) {
              message = afterPrior
                ? `Prefilling context — ${secs}s`
                : `Prefilling — ${secs}s`;
              suggestion = '';
            } else {
              message = `Stream quiet — ${Math.max(1, secs)}s`;
              suggestion = '';
            }
            onStreamEvent('generation-warning', {
              phase: isFirstByte ? 'first-byte' : 'mid-stream',
              message,
              suggestion,
            });
          }
        },
      });
    } catch (err) {
      if (getCancelled?.()) {
        console.log('[CloudAgentic] cancelled during generate');
        break;
      }
      const partialNow = streamFilters.getCombinedRawBuffer();
      const errMsg = String(err?.message || '');
      const cutByTransport = err?.code === 'ABORTED'
        || /Generation cancelled/i.test(errMsg)
        || /Stream stalled|idle timeout|no data for|Connection timeout|Socket timeout|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|socket hang up/i.test(errMsg)
        || /No response from .+ within \d+s/i.test(errMsg)
        || /Stream timeout:\s*no SSE/i.test(errMsg);
      if (cutByTransport && partialNow && partialNow.trim() && continueCount < CONTINUE_CAP) {
        // ThinkDumpBail2: never continuePartial a reasoning/file dump (leaks mid-thought into
        // chat when continueInThinking=0; giant dumps stall first-byte → 900s Generation Error).
        if (
          looksLikeReasoningFileDump(partialNow, thinkingChars)
          || partialNow.length > CONTINUE_PARTIAL_MAX_CHARS
        ) {
          console.log(
            `[CloudAgentic] ThinkDumpBail2: refuse transport-continue chars=${partialNow.length} `
            + `thinkingChars=${thinkingChars} — soft-recover salvage/fresh tool round`,
          );
          continuePartial = null;
          continueInThinking = false;
          if (String(nextUserPrompt || '').trim()) {
            conversationHistory.push({ role: 'user', content: String(nextUserPrompt) });
            nextUserPrompt = NEXT_FROM_HISTORY;
          }
          result = {
            stopReason: 'length',
            text: '',
            softDumpRecover: true,
            streamDiag: { softDumpRecover: true, err: errMsg.slice(0, 160) },
          };
          // Exit catch into round-end processing (no Generation Error paint).
        } else {
          continueCount += 1;
          continuePartial = partialNow;
          if (trailingChannel === 'thinking') {
            continueInThinking = true;
          } else {
            continueInThinking = false;
          }
          console.log(
            `[CloudAgentic] continuePartial #${continueCount} chars=${partialNow.length} via transport`
            + (continueInThinking ? ' continueInThinking=1' : ''),
          );
          continue;
        }
      }
      if (!result?.softDumpRecover) {
      // Round 0 carries the user's text only in nextUserPrompt; every resume path below rewrites it.
      if (String(nextUserPrompt || '').trim()) {
        conversationHistory.push({ role: 'user', content: String(nextUserPrompt) });
        nextUserPrompt = NEXT_FROM_HISTORY;
      }
      const msg = String(err?.message || '');
      const isOrphanAbort =
        err?.code === 'ABORTED'
        || /Generation cancelled/i.test(msg);

      // Summarizer orphan abort / queue preempt must NOT end the agent turn (no user Stop).
      if (isOrphanAbort && preemptResumes < 4) {
        preemptResumes += 1;
        nextUserPrompt = NEXT_FROM_HISTORY;
        console.log(`[CloudAgentic] preempt/orphan resume #${preemptResumes}: ${msg.slice(0, 120)}`);
        if (onStreamEvent) {
          onStreamEvent('generation-warning', {
            message: 'Stream interrupted — continuing automatically',
            suggestion: `Recovery ${preemptResumes}/4. No Stop needed; resuming the same task.`,
          });
        }
        await new Promise((r) => setTimeout(r, 300 * preemptResumes));
        continue;
      }

      const isCtxOverflow =
        /exceeds the available context|available context size|context size is too small|prompt is too long|context size|context length|maximum context/i.test(msg);
      // NEVER treat bare "upstream 400" as context overflow — that retry path dropped=0,
      // re-hit the same 400, and painted Generation Error after duplicating a finished answer.

      // VisionNative3: cipher-quality vision = P40 mmproj (not Gemini caption).
      // On upstream 500/400 with images: one retry after size note, then honest fail — never
      // inject fake "you have already seen this image" captions (operator 2026-09-30).
      // After one successful round with these images the projector is proven; later 500/400s are not vision.
      const isVisionUpstreamFail = pendingImages.length > 0 && !imagesDelivered
        && /upstream 500|upstream 400/i.test(msg);
      if (isVisionUpstreamFail && visionCaptionTries < 2) {
        visionCaptionTries += 1;
        console.log(
          `[CloudAgentic] vision upstream fail — native retry ${visionCaptionTries}/2 `
          + `(${pendingImages.length} image(s); no caption fallback)`,
        );
        if (onStreamEvent) {
          onStreamEvent('generation-warning', {
            message: 'Image path hit a server error — retrying native vision',
            suggestion: 'Cipher quality vision failed upstream. Retrying the same images on Secrypt (mmproj). No text caption substitute.',
          });
        }
        pendingImages = await compressImagesForVisionRetry(pendingImages);
        continue;
      }
      if (isVisionUpstreamFail) {
        console.error(`[CloudAgentic] vision upstream exhausted after ${visionCaptionTries} tries: ${msg.slice(0, 160)}`);
        pendingImages = [];
        const block = '[Image attachment could not be read by Cipher quality vision (upstream error after retries). Tell the user native vision failed and ask them to describe the image or retry after the Secrypt vision projector is confirmed loaded.]';
        if (String(nextUserPrompt || '').trim() && nextUserPrompt !== NEXT_FROM_HISTORY) {
          nextUserPrompt = `${nextUserPrompt}\n\n${block}`;
        } else {
          conversationHistory.push({ role: 'user', content: block });
          nextUserPrompt = NEXT_FROM_HISTORY;
        }
        continue;
      }

      if (isCtxOverflow && overflowResumes < OVERFLOW_RESUME_MAX) {
        overflowResumes += 1;
        shrinkTries += 1;
        truncateToolResultsInHistory(conversationHistory, OVERFLOW_TOOL_RESULT_CHARS);
        const tightBudget = Math.max(2048, Math.floor(inputBudgetTokens(contextLimit, outputTokens) * 0.55));
        const tighter = await applyFit(conversationHistory, nextUserPrompt, tightBudget);
        conversationHistory.length = 0;
        conversationHistory.push(...tighter.history);
        nextUserPrompt = tighter.nextUser || NEXT_FROM_HISTORY;
        console.log(
          `[CloudAgentic] contextOverflow resume #${overflowResumes}: dropped=${tighter.droppedCount || 0} `
          + `budget=${tightBudget} ${msg.slice(0, 120)}`,
        );
        if (onStreamEvent) {
          onStreamEvent('generation-warning', {
            message: 'Context full — condensing and continuing',
            suggestion: `Overflow recovery ${overflowResumes}/${OVERFLOW_RESUME_MAX}. Shrinking history, then resuming the same task.`,
          });
        }
        continue;
      }

      if (
        (/System message must be at the beginning|Jinja Exception|upstream 500/i.test(msg)
          || (err?.upstreamError && /Jinja|System message must be at the beginning|upstream 500/i.test(msg)))
        && !isCtxOverflow
        && !isVisionUpstreamFail
        && jinjaResumes < JINJA_RESUME_MAX
      ) {
        jinjaResumes += 1;
        sanitizeHistoryRoles(conversationHistory);
        if (lastToolResultsMessage) {
          const hasToolResults = conversationHistory.some(
            (m) => m.role === 'user' && /\[System: Tool Results\]/i.test(String(m.content || '')),
          );
          if (!hasToolResults) {
            conversationHistory.push({ role: 'user', content: lastToolResultsMessage });
          }
        }
        nextUserPrompt = NEXT_FROM_HISTORY;
        console.log(`[CloudAgentic] jinja/upstream resume #${jinjaResumes}: ${msg.slice(0, 160)}`);
        if (onStreamEvent) {
          onStreamEvent('generation-warning', {
            message: 'Model template error — repairing message order and continuing',
            suggestion: `Retry ${jinjaResumes}/${JINJA_RESUME_MAX}. Open todos stay active.`,
          });
        }
        await new Promise((r) => setTimeout(r, 400 * jinjaResumes));
        continue;
      }
      // ProxyNetResume1: DNS/name failures (ENOTFOUND graysoft.dev) are the same class as
      // stream stalls — never burn an in-flight agent turn into Generation Error while work remains.
      const isTransportStall = /Stream stalled|idle timeout|no data for|Connection timeout|Socket timeout|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|socket hang up|No response from .+ within \d+s|Stream timeout:\s*no SSE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|getaddrinfo/i.test(msg)
        || /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i.test(String(err?.code || ''));
      if (isTransportStall) {
        const openNow = (typeof getActiveTodos === 'function' ? getActiveTodos() : [])
          .filter((t) => t && (t.status === 'pending' || t.status === 'in-progress')).length;
        // stallnever1: while the plan/todos are still open, keep resuming — never burn the turn
        // into a Generation Error card after 4 quiet windows (live 2026-09-28 msgs≈100 / 600s idle).
        const STALL_RESUME_SOFT = 4;
        const STALL_RESUME_HARD = 40;
        const allowResume = stallResumes < STALL_RESUME_SOFT
          || (openNow > 0 && stallResumes < STALL_RESUME_HARD)
          || (toolsUsedThisTurn > 0 && stallResumes < STALL_RESUME_HARD);
        if (!allowResume) {
          throw err;
        }
        stallResumes += 1;
        nextUserPrompt = NEXT_FROM_HISTORY;
        const isDns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg) || /ENOTFOUND|EAI_AGAIN/i.test(String(err?.code || ''));
        const waitMs = isDns ? Math.min(60000, 5000 * Math.min(stallResumes, 8)) : 0;
        console.log(
          `[CloudAgentic] streamStall resume #${stallResumes}`
          + ` openTodos=${openNow} toolsUsedThisTurn=${toolsUsedThisTurn}`
          + (isDns ? ` dnsWait=${waitMs}ms` : '')
          + `: ${msg.slice(0, 120)}`,
        );
        if (onStreamEvent) {
          onStreamEvent('generation-warning', {
            phase: isDns ? 'dns' : 'mid-stream',
            message: isDns
              ? `Proxy DNS/network blip — retrying in ${Math.round(waitMs / 1000)}s (todos still open)`
              : 'Stream stalled — continuing from cutoff',
            suggestion: isDns
              ? 'graysoft.dev was briefly unreachable. Host will keep retrying; turn will not end as Generation Error while todos remain.'
              : 'The proxy went quiet. Resuming the same reply from where it stopped.',
          });
        }
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          if (getCancelled?.()) {
            console.log('[CloudAgentic] cancelled during DNS/net wait');
            break;
          }
        }
        continue;
      }
      const rateLimited = err?.isQuotaError || /\brate limited\b|\b429\b|quota_exceeded/i.test(msg);
      if (rateLimited && rateResumes < 4) {
        rateResumes += 1;
        const waitMs = 15000 * rateResumes;
        console.log(`[CloudAgentic] rateLimit resume #${rateResumes} wait=${waitMs}ms: ${msg.slice(0, 120)}`);
        if (onStreamEvent) {
          onStreamEvent('generation-warning', {
            message: 'Rate limited — continuing task',
            suggestion: 'Cipher 7 hit a rate limit. Waiting, then resuming the same task.',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (getCancelled?.()) {
          console.log('[CloudAgentic] cancelled during rate-limit wait');
          break;
        }
        continue;
      }
      throw err;
      } // end if (!result?.softDumpRecover)
    }

    if (getCancelled?.()) break;

    if (String(result?.stopReason || '') === 'length') {
      const proseNow = (typeof streamFilters.getProseRawBuffer === 'function'
        ? streamFilters.getProseRawBuffer()
        : '') || '';
      const rawNow = streamFilters.getCombinedRawBuffer() || result?.text || '';
      // FileToolLengthContinue1: incomplete tool JSON (write/append/grep/…) is not a
      // reasoning dump — continuePartial that buffer even when it contains HTML/`</script>`
      // or exceeds CONTINUE_PARTIAL_MAX_CHARS. ThinkDumpBail2 still blocks pure scratchpads.
      const formingTool = !!(proseNow.trim()
        && (looksLikeToolAttempt(proseNow) || isFormingFileWritePayload(proseNow)));
      const dump = !formingTool && (
        looksLikeReasoningFileDump(rawNow, thinkingChars)
        || String(rawNow).length > CONTINUE_PARTIAL_MAX_CHARS
      );
      if (dump) {
        // ThinkDumpBail2: abort length-continue of reasoning dumps.
        // Bail1 dropped continueInThinking → remainder painted as chat (image3: Thought
        // "foot (3" / chat "74,336)"). Keep continuing grew 22k→42k→62k then 900s first-byte hang.
        console.log(
          `[CloudAgentic] ThinkDumpBail2: refuse length-continue chars=${String(rawNow).length} `
          + `thinkingChars=${thinkingChars} trailing=${trailingChannel}`,
        );
        continuePartial = null;
        continueInThinking = false;
        // Fall through to flush + round-end salvage / incomplete fresh tool round.
      } else if ((formingTool ? proseNow : rawNow).trim() && continueCount < CONTINUE_CAP) {
        continueCount += 1;
        continuePartial = formingTool ? proseNow : rawNow;
        if (!formingTool && trailingChannel === 'thinking') {
          continueInThinking = true;
        } else {
          continueInThinking = false;
        }
        console.log(
          `[CloudAgentic] continuePartial #${continueCount} chars=${continuePartial.length} stop=length`
          + (formingTool ? ' formingTool=1' : '')
          + (continueInThinking ? ' continueInThinking=1' : ''),
        );
        continue;
      } else {
        console.log(`[CloudAgentic] continuePartial cap=${CONTINUE_CAP}`);
      }
    } else {
      continuePartial = null;
      continueCount = 0;
      continueInThinking = false;
    }

    if (thinkHold) {
      const left = thinkHold;
      thinkHold = '';
      if (typeof noteThinking === 'function') {
        noteThinking(left);
        streamFilters.processThinkingChunk(left);
      }
    }
    thinkSplit.flush();
    streamFilters.flush();

    if (pendingImages.length && !imagesDelivered) {
      imagesDelivered = true;
      console.log(`[CloudAgentic] ImgHist1: ${pendingImages.length} image(s) delivered; kept for the rest of this turn`);
    }

    if (result?.isQuotaError) {
      return { isQuotaError: true, error: '__QUOTA_EXCEEDED__', text: displayResponse || fullResponse, toolCallCount: totalToolCalls };
    }

    if (result && result.promptTokens > 0 && result.promptChars > 0) {
      measuredPrompt = {
        key: measureKey,
        head: historyHead(conversationHistory),
        promptTokens: result.promptTokens,
        promptChars: result.promptChars,
      };
      cloudLLM._measuredPrompt = measuredPrompt;
    }

    const roundTextContent = result?.text || '';
    // ThinkBleed1: parse tools from prose/content channel only — never prose+thinking concat.
    const roundRawForTools = (typeof streamFilters.getProseRawBuffer === 'function'
      ? streamFilters.getProseRawBuffer()
      : '') || streamFilters.getCombinedRawBuffer() || roundTextContent;
    const roundRawCombined = streamFilters.getCombinedRawBuffer() || roundTextContent;
    const roundCleanProse = (streamFilters.getProseCleanText() || stripToolCallText(roundTextContent) || '').trim();
    let previewCalls = parseToolCalls(roundRawForTools);
    // ThinkDumpBail1 salvage: tools-on round dumped a fence/HTML body with no write_file JSON.
    if (
      !mode.askOnly && mode.toolsActive && !!executeToolFn
      && previewCalls.length === 0
      && looksLikeReasoningFileDump(roundRawForTools, thinkingChars)
    ) {
      const recovered = _recoverWriteFileContent(roundRawForTools);
      if (recovered && recovered.params?.content) {
        const scrubbed = scrubNarrationLinesFromFileBody(String(recovered.params.content));
        const body = scrubbed.trim();
        // ThinkStreamLive1: never salvage a markdown outline as .html (live game.html 30 lines).
        const looksCode = /<!DOCTYPE\s+html/i.test(body)
          || /<html[\s>]/i.test(body)
          || /<svg[\s>]/i.test(body)
          || (/[{};]|\bfunction\b|\bconst\b|\bimport\b/.test(body) && body.length >= 80);
        const outlineOnly = !looksCode
          && ((body.match(/^\s*[-*]\s+/gm) || []).length >= 4 || /^[\w.-]+\.(html|css|js)\s*$/m.test(body));
        if (body.length >= 50 && looksCode && !outlineOnly) {
          recovered.params.content = scrubbed;
          if (!recovered.params.filePath || recovered.params.filePath === 'file.txt') {
            recovered.params.filePath = 'index.html';
          }
          previewCalls = [recovered];
          console.log(
            `[CloudAgentic] ThinkDumpBail1 salvage write_file path=${recovered.params.filePath} `
            + `chars=${scrubbed.length}`,
          );
        } else if (body.length >= 50) {
          console.log(
            `[CloudAgentic] ThinkStreamLive1: skip salvage outline/non-code chars=${body.length} `
            + `path=${recovered.params.filePath || ''}`,
          );
        }
      }
    }
    console.log(
      `[CloudAgentic] round end iter=${iter} stopReason=${result?.stopReason || 'unknown'} `
      + `toolsParsed=${previewCalls.length} proseChars=${roundCleanProse.length} proseLive=${proseCharsLive} `
      + `thinkingChars=${thinkingChars} trailing=${trailingChannel} `
      + `promptLen=${String(nextUserPrompt || '').length} `
      + `serverPromptTokens=${result?.promptTokens || 0} promptChars=${result?.promptChars || 0}`,
    );

    rememberUserRequest(conversationHistory, userMessage);

    const toolsOn = !mode.askOnly && mode.toolsActive && !!executeToolFn;
    const activeTodosNow = typeof getActiveTodos === 'function' ? getActiveTodos() : [];
    const openTodoCount = activeTodosNow.filter((t) => t.status === 'pending' || t.status === 'in-progress').length;
    const incomplete = toolsOn && roundIsIncomplete({
      toolCount: previewCalls.length,
      proseChars: roundCleanProse.length,
      thinkingChars,
      trailingChannel,
      stopReason: result?.stopReason || '',
      openTodoCount,
      lastToolBatchFailed,
    });

    if (incomplete) {
      incompleteRounds += 1;
      // DupProse1: do NOT concatenate incomplete-round prose into displayResponse.
      // Tokens already streamed to the UI; appending here doubles (or triples) the final bubble
      // when FailBatchContinue / open-todo continues fire after a long answer.
      fullResponse += roundRawCombined;
      // ThinkDumpBail2: never poison the next generate with a 20k–60k reasoning scratchpad.
      const dumpHist = looksLikeReasoningFileDump(roundRawCombined, thinkingChars)
        || roundRawCombined.length > CONTINUE_PARTIAL_MAX_CHARS;
      if (roundRawCombined.trim() && !dumpHist) {
        conversationHistory.push({ role: 'assistant', content: roundRawCombined });
      } else if (dumpHist) {
        console.log(
          `[CloudAgentic] ThinkDumpBail2: skip history inject of dump chars=${roundRawCombined.length}`,
        );
      }
      // One-shot FailBatchContinue: clear after the continue is scheduled so a later
      // delivered answer is not forced incomplete again (no prose-length detector).
      const failedBatchOnly = lastToolBatchFailed && openTodoCount === 0;
      if (failedBatchOnly) {
        lastToolBatchFailed = false;
      }
      console.log(
        `[CloudAgentic] incompleteRound #${incompleteRounds} stop=${result?.stopReason || 'unknown'} `
        + `trailing=${trailingChannel} openTodos=${openTodoCount} `
        + `lastToolBatchFailed=${failedBatchOnly ? 1 : 0} `
        + `toolsUsedThisTurn=${toolsUsedThisTurn} ledgerTouched=${todoLedgerTouchedThisTurn ? 1 : 0}`,
      );
      if (incompleteRounds >= INCOMPLETE_ROUND_CAP) {
        // OpenTodoNoAbort1: never end the turn while the ledger still has open work.
        // Cap only aborts when openTodoCount===0 (prevents empty-ledger think loops).
        // With open todos: structural context fit + reset counter (RULES §2 / §3 Rule 4 —
        // do not use a retry cap to abort mid-task).
        if (openTodoCount > 0) {
          if (openTodoFitRecoveries < OPEN_TODO_FIT_RECOVERY_MAX) {
            openTodoFitRecoveries += 1;
            incompleteRounds = 0;
            const tightBudget = Math.max(2048, Math.floor(inputBudgetTokens(contextLimit, outputTokens) * 0.55));
            const recovered = await applyFit(conversationHistory, NEXT_FROM_HISTORY, tightBudget);
            conversationHistory.length = 0;
            conversationHistory.push(...recovered.history);
            const hasToolResults = conversationHistory.some(
              (m) => m.role === 'user' && /\[System: Tool Results\]/i.test(String(m.content || '')),
            );
            if (lastToolResultsMessage && !hasToolResults) {
              conversationHistory.push({ role: 'user', content: lastToolResultsMessage });
            }
            const ledger = buildTodoProgressHint(activeTodosNow, [], 0);
            const separator = String(ledger || '').trim()
              || (lastToolResultsMessage ? String(lastToolResultsMessage) : '[System]');
            conversationHistory.push({ role: 'user', content: separator });
            console.log(
              `[CloudAgentic] OpenTodoNoAbort1 fit-recover #${openTodoFitRecoveries}`
              + ` openTodos=${openTodoCount} budget=${tightBudget}`,
            );
            if (onStreamEvent) {
              onStreamEvent('generation-warning', {
                message: `Still working — ${openTodoCount} todo(s) open; condensing context and continuing`,
                suggestion: `Fit recovery ${openTodoFitRecoveries}/${OPEN_TODO_FIT_RECOVERY_MAX}`,
              });
            }
            nextUserPrompt = NEXT_FROM_HISTORY;
            continue;
          }
          // Fits exhausted: still do not abort — reset streak and silent-continue.
          incompleteRounds = 0;
          const ledger = buildTodoProgressHint(activeTodosNow, [], 0);
          const separator = String(ledger || '').trim()
            || (lastToolResultsMessage ? String(lastToolResultsMessage) : '[System]');
          conversationHistory.push({ role: 'user', content: separator });
          console.log(
            `[CloudAgentic] OpenTodoNoAbort1 fit-exhausted — silent-continue openTodos=${openTodoCount}`,
          );
          if (onStreamEvent) {
            onStreamEvent('generation-warning', {
              message: `${openTodoCount} todo(s) still open — continuing without abort`,
              suggestion: 'Context fit recoveries used; host will keep looping until ledger clears or you stop.',
            });
          }
          nextUserPrompt = NEXT_FROM_HISTORY;
          continue;
        }
        console.log(
          `[CloudAgentic] incompleteRound cap=${INCOMPLETE_ROUND_CAP} — stopping`
          + ` openTodos=${openTodoCount}`,
        );
        if (roundCleanProse && !displayResponse) displayResponse = roundCleanProse;
        if (onStreamEvent) {
          onStreamEvent('generation-warning', {
            message: 'Turn stopped after repeated incomplete rounds',
            suggestion: 'The model kept ending in reasoning without a tool or a chat answer. Send another message to continue.',
          });
        }
        break;
      }
      // Mid-think length-cut only when the buffer is still a short plan — not a file dump.
      if (
        String(result?.stopReason || '') === 'length'
        && trailingChannel === 'thinking'
        && proseCharsLive === 0
        && thinkingChars > 0
        && !looksLikeReasoningFileDump(roundRawCombined, thinkingChars)
      ) {
        continueInThinking = true;
      } else if (!continuePartial) {
        continueInThinking = false;
      }
      routeContentToThinking = false;

      const emptyRound = !String(roundRawCombined || '').trim() && thinkingChars === 0;
      if (emptyRound && result?.streamDiag) {
        lastEmptyStreamDiag = result.streamDiag;
        console.warn(`[CloudAgentic] empty stream diag ${JSON.stringify(result.streamDiag)}`);
      }

      // emptygenrecover1: recover mid-task — do NOT open-todo-nudge on empty (that spun forever).
      if (emptyRound) {
        emptyGenStreak += 1;
        if (emptyRecoveries < EMPTY_RECOVERY_MAX) {
          emptyRecoveries += 1;
          emptyGenStreak = 0;
          const tightBudget = Math.max(2048, Math.floor(inputBudgetTokens(contextLimit, outputTokens) * 0.55));
          const recovered = await applyFit(conversationHistory, NEXT_FROM_HISTORY, tightBudget);
          conversationHistory.length = 0;
          conversationHistory.push(...recovered.history);
          const hasToolResults = conversationHistory.some(
            (m) => m.role === 'user' && /\[System: Tool Results\]/i.test(String(m.content || '')),
          );
          if (lastToolResultsMessage && !hasToolResults) {
            conversationHistory.push({ role: 'user', content: lastToolResultsMessage });
          }
          console.log(`[CloudAgentic] emptygenrecover recovery #${emptyRecoveries} budget=${tightBudget}`);
          if (onStreamEvent) {
            onStreamEvent('generation-warning', {
              message: 'Empty model reply — condensing context and continuing the task',
              suggestion: `Recovery ${emptyRecoveries}/${EMPTY_RECOVERY_MAX}`,
            });
          }
          nextUserPrompt = NEXT_FROM_HISTORY;
          continue;
        }
        console.log('[CloudAgentic] emptygenrecover exhausted — stopping with diagnosis');
        if (onStreamEvent) {
          const d = lastEmptyStreamDiag || result?.streamDiag || {};
          const openLeft = openTodoCount;
          onStreamEvent('generation-warning', {
            message: openLeft > 0
              ? `Turn paused with ${openLeft} open todo(s) — empty replies after recovery`
              : 'Turn stopped: model returned empty replies after tools',
            suggestion: `Recoveries exhausted. sawSse=${d.sawSse} rawBodyLen=${d.rawBodyLen} finish=${d.finish_reason || 'none'} http=${d.httpStatus}. Send another message to continue.`,
          });
        }
        break;
      }

      emptyGenStreak = 0;
      // Structural continues only (RULES §11): tool-JSON shape repair, or silent history continue.
      // Never English “keep going / emit a tool / do not end” coaching — roundIsIncomplete +
      // open-todo ledger + finish_reason=length / continuePartial already decide the loop.
      const toolAttempt = looksLikeToolAttempt(roundRawCombined);
      if (toolAttempt && String(result?.stopReason || '') !== 'length') {
        unparsedToolAttemptStreak += 1;
        const proseRaw = (typeof streamFilters.getProseRawBuffer === 'function'
          ? streamFilters.getProseRawBuffer()
          : '') || '';
        const head = String(proseRaw || roundRawCombined).slice(0, 400).replace(/\s+/g, ' ');
        const tail = String(proseRaw || roundRawCombined).slice(-200).replace(/\s+/g, ' ');
        console.log(
          `[CloudAgentic] unparsed tool attempt repair #${unparsedToolAttemptStreak}`
          + ` proseRawLen=${proseRaw.length} combinedLen=${String(roundRawCombined || '').length}`
          + ` head=${JSON.stringify(head)} tail=${JSON.stringify(tail)}`,
        );
        const closestHint = suggestClosestToolName(roundRawCombined);
        conversationHistory.push({
          role: 'user',
          content: `[System: Tool call could not be parsed. Retry with valid JSON: {"tool":"<name>","params":{...}}.${closestHint ? ` ${closestHint}` : ''}]`,
        });
      } else {
        unparsedToolAttemptStreak = 0;
        // Role separator required: history just gained an assistant turn. Empty NEXT_FROM_HISTORY
        // with trailing assistant → Cipher Jinja upstream 400 (live 2026-09-29 19:34).
        const ledger = buildTodoProgressHint(activeTodosNow, [], 0);
        const separator = String(ledger || '').trim()
          || (lastToolResultsMessage ? String(lastToolResultsMessage) : '[System]');
        conversationHistory.push({ role: 'user', content: separator });
        console.log(
          `[CloudAgentic] incompleteRound silent-continue openTodos=${openTodoCount}`
          + ` lastToolBatchFailed=${failedBatchOnly ? 1 : 0}`
          + ` stop=${result?.stopReason || 'unknown'} trailing=${trailingChannel}`
          + ` roleSep=1`,
        );
      }
      nextUserPrompt = NEXT_FROM_HISTORY;
      continue;
    }

    if (previewCalls.length > 0) {
      incompleteRounds = 0;
      openTodoFitRecoveries = 0;
      routeContentToThinking = false;
      unparsedToolAttemptStreak = 0;
    }

    fullResponse += roundRawCombined;
    if (roundCleanProse) {
      // Prefer the latest complete-round prose as the return text (stream already painted mid-turn).
      displayResponse = roundCleanProse;
    }

    if (!toolsOn) {
      break;
    }

    let parsedCalls = previewCalls;
    if (!parsedCalls.length) {
      if (looksLikeToolAttempt(roundRawCombined)) {
        const closestHint = suggestClosestToolName(roundRawCombined);
        conversationHistory.push({
          role: 'assistant',
          content: assistantHistoryContent(roundCleanProse, roundRawCombined),
        });
        conversationHistory.push({
          role: 'user',
          content: `[System: Tool call could not be parsed. Retry with valid JSON: {"tool":"<name>","params":{...}}.${closestHint ? ` ${closestHint}` : ''}]`,
        });
        nextUserPrompt = NEXT_FROM_HISTORY;
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
          content: assistantHistoryContent(roundCleanProse, roundRawCombined),
        });
        conversationHistory.push({ role: 'user', content: PLAN_BLOCKED_TOOLS_MSG });
        nextUserPrompt = NEXT_FROM_HISTORY;
        continue;
      }
      if (issues?.length) {
        conversationHistory.push({
          role: 'assistant',
          content: assistantHistoryContent(roundCleanProse, roundRawCombined),
        });
        conversationHistory.push({
          role: 'user',
          content: `[System: Tool Validation Failed]\n${issues.join('\n')}\n\nRetry with valid tool parameters.`,
        });
        nextUserPrompt = NEXT_FROM_HISTORY;
        continue;
      }
      if (looksLikeToolAttempt(roundRawCombined)) {
        const closestHint = suggestClosestToolName(roundRawCombined);
        conversationHistory.push({
          role: 'assistant',
          content: assistantHistoryContent(roundCleanProse, roundRawCombined),
        });
        conversationHistory.push({
          role: 'user',
          content: `[System: Tool call could not be parsed. Retry with valid JSON: {"tool":"<name>","params":{...}}.${closestHint ? ` ${closestHint}` : ''}]`,
        });
        nextUserPrompt = NEXT_FROM_HISTORY;
        continue;
      }
      break;
    }

    const visibleAssistant = roundCleanProse.trim();
    conversationHistory.push({ role: 'assistant', content: assistantHistoryContent(visibleAssistant, roundRawCombined, parsedCalls) });

    const promptTokensUsed = measuredPrompt && measuredPrompt.promptTokens > 0
      ? measuredPrompt.promptTokens
      : measuredCost(
        measuredPrompt,
        promptChars(systemPrompt, conversationHistory, ''),
        estimateTokens(systemPrompt)
          + conversationHistory.reduce((sum, m) => sum + estimateTokens(m?.content), 0),
      );
    const roundInjectBudget = Math.max(2000, Math.floor(12000 / Math.max(1, parsedCalls.length)));
    const toolResultLines = [];
    let batchHadFailure = false;
    for (const call of parsedCalls) {
      if (getCancelled?.()) break;
      const toolName = call.tool;
      const toolParams = call.params || {};
      totalToolCalls++;

      // ToolCallId1: do not emit tool-generating here — stream already opened cards.
      // A second generating row left stuck "Generating…" after execute matched the first card.
      const toolCallId = `exec-${Date.now()}-${totalToolCalls}`;
      if (onStreamEvent) {
        onStreamEvent('tool-executing', [{ tool: toolName, params: toolParams, toolCallId }]);
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

      if (toolResultFailed(toolResult)) batchHadFailure = true;

      toolsUsedThisTurn += 1;
      if (FILE_WRITE_OPS.has(toolName)) {
        const wrote = toolParams.filePath || toolParams.path;
        if (wrote) filesWrittenThisTurn.push(String(wrote));
      }
      if (toolName === 'write_todos' || toolName === 'update_todo') {
        todoLedgerTouchedThisTurn = true;
      }

      if (onStreamEvent) {
        onStreamEvent('mcp-tool-results', [{ tool: toolName, result: toolResult, toolCallId }]);
      }

      const injectResult = formatToolResultForInject(toolName, toolResult, {
        contextTokens,
        promptTokensUsed,
        injectBudgetChars: roundInjectBudget,
      });
      toolResultLines.push(`${toolName}: ${injectResult}`);
      console.log(`[CloudAgentic] tool ${toolName} done (${injectResult.length} chars inject)`);
    }

    if (!toolResultLines.length) break;

    // Structural: failed batch → next prose-only stop is incomplete until a clean batch succeeds.
    lastToolBatchFailed = batchHadFailure;
    if (batchHadFailure) {
      console.log(`[CloudAgentic] lastToolBatchFailed=1 tools=${toolResultLines.length}`);
    }

    const activeTodos = typeof getActiveTodos === 'function' ? getActiveTodos() : [];
    const executedToolNames = parsedCalls.map((c) => c.tool);
    const todoListPrefix = buildTodoProgressHint(activeTodos, executedToolNames, 0);
    const injectText = buildToolResultsUserMessage(toolResultLines, { interruptPrefix: todoListPrefix });
    lastToolResultsMessage = injectText;
    emptyRecoveries = 0;
    emptyGenStreak = 0;
    conversationHistory.push({ role: 'user', content: injectText });
    console.log(`[CloudAgentic] ─── TOOL RESULTS → MODEL ─── ${toolResultLines.length} result(s)`);
    emitContextUsage(conversationHistory, '');

    nextUserPrompt = NEXT_FROM_HISTORY;
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

module.exports = { runCloudAgenticChat, createThinkTagSplitter, assistantHistoryContent };
