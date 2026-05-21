'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { parseToolCalls, repairToolCalls, stripToolCallText } = require('./tools/toolParser');
const { visionServer } = require('./visionServer');
const { detectFamily, detectFamilyFromArch, detectParamSize } = require('./modelDetection');
const { getModelProfile } = require('./modelProfiles');

/** Base max chars of each tool result injected into chat history.
 *  Actual cap is computed at runtime proportional to the model's context size
 *  (Rule 9: no hardcoded context numbers) so it works for any model from 2K to 128K context.
 */
const BASE_TOOL_RESULT_INJECT_CHARS = 32000;
// PL2: Per-tool-type multipliers (fraction of context-based cap).
// Browser tools need more because snapshots contain both element refs and page text.
// File/web tools need less because the model can re-read or re-fetch.
const TOOL_INJECT_MULTIPLIERS = {
  browser_snapshot: 1.5, browser_navigate: 1.5, browser_click: 1.5,
  browser_type: 1.5, browser_screenshot: 0.5,
  read_file: 0.5, fetch_webpage: 0.5, web_search: 0.25,
};

// Pre-compiled regex patterns for the streaming tool call filter.
// These are tested on line boundaries only — never on every character.
const RE_FENCE_HEADER = /^```\s*(\w*)\r?\n/;
// Tightened: only match tool-call schema, not arbitrary JSON with "tool" or "name" keys
const RE_TOOL_KEY = /"tool"\s*:\s*"[a-zA-Z0-9_]+"/;          // {"tool":"write_file"} or {"tool":"vscode_askQuestions"} — requires string value
const RE_NAME_KEY = /"name"\s*:\s*"[a-zA-Z0-9_]+(?:_[a-zA-Z0-9_]+)*"/; // {"name":"read_file"} or mixed-case
const RE_PARAMS_KEY = /"(?:params|parameters|arguments)"\s*:\s*\{/; // {"params":{ — strong tool-call signal
const RE_FILE_WRITE_TOOLS = /write_file|create_file|append_to_file/;
const RE_CONTENT_START = /"content"\s*:\s*"$/;
const RE_FILE_PATH = /"(?:filePath|path)"\s*:\s*"([^"]*)"/;
const RE_TOOL_OR_SYSTEM_INJECT = /^\[(?:Tool Results|System)\]/i;

/** Web-facing tools â€” if these share a batch with workspace navigation tools, drop the latter (structural conflict rule). */
const WEB_TOOL_BATCH = new Set(['web_search', 'fetch_webpage', 'http_request']);
const WORKSPACE_NAV_TOOLS = new Set(['list_directory', 'get_project_structure']);

function filterWebWorkspaceToolConflict(calls) {
  if (!calls?.length) return calls;
  const hasWeb = calls.some((c) => WEB_TOOL_BATCH.has(c.tool));
  const hasWs = calls.some((c) => WORKSPACE_NAV_TOOLS.has(c.tool));
  if (!hasWeb || !hasWs) return calls;
  const dropped = calls.filter((c) => WORKSPACE_NAV_TOOLS.has(c.tool));
  const kept = calls.filter((c) => !WORKSPACE_NAV_TOOLS.has(c.tool));
  console.log(
    `[ChatEngine] Same-batch conflict: dropped workspace tool(s) ${dropped.map((d) => d.tool).join(', ')} because web tool(s) are present`,
  );
  return kept;
}

/** Hard floor for context window (aligned with llama.cpp 256-token alignment). */
const MIN_CONTEXT_FLOOR = 2048;
/** When requireMinContextForGpu is true, prefer at least this before accepting GPU offload. */
const MIN_CONTEXT_WHEN_GPU_REQUIRED = 4096;
/** VRAM reserved for activations, CUDA context, and allocator overhead during generation. */
const VRAM_GENERATION_OVERHEAD = 512 * 1024 * 1024;
/** Safety buffer subtracted from free VRAM before KV allocation. */
const VRAM_KV_BUFFER = 256 * 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

/**
 * Runtime minimum usable context for auto mode — tiered by total VRAM (bytes), not GPU model.
 */
function computeAutoTargetContext({ vramTotal, vramFree, kvBytesPerToken, desiredMaxContext, trainMaxContext }) {
  let tierTarget = 4096;
  if (vramTotal >= 48 * GiB) tierTarget = 65536;
  else if (vramTotal >= 24 * GiB) tierTarget = 32768;
  else if (vramTotal >= 8 * GiB) tierTarget = 8192;

  let cap = tierTarget;
  if (trainMaxContext != null) cap = Math.min(cap, trainMaxContext);
  cap = Math.min(cap, desiredMaxContext);

  if (kvBytesPerToken > 0 && vramFree > 0) {
    const kvBudget = Math.max(0, vramFree - VRAM_GENERATION_OVERHEAD - VRAM_KV_BUFFER);
    const vramBounded = Math.floor(kvBudget / kvBytesPerToken / 2);
    if (vramBounded > 0) cap = Math.min(cap, vramBounded);
  }

  return Math.max(MIN_CONTEXT_FLOOR, cap);
}

/** Descending unique context targets for step-down when VRAM is tight. */
function buildContextTargetSteps(autoTarget, minContext) {
  const seen = new Set();
  const targets = [];
  for (const t of [autoTarget, MIN_CONTEXT_WHEN_GPU_REQUIRED, MIN_CONTEXT_FLOOR, minContext]) {
    const v = Math.floor(t);
    if (v > 0 && !seen.has(v)) {
      seen.add(v);
      targets.push(v);
    }
  }
  return targets.sort((a, b) => b - a);
}

/**
 * For one gpuLayers count: max context that fits in vramFree, or null.
 * @returns {{ gpuLayers: number, maxCtx: number, contextSize: number } | null}
 */
function computeLayerVramFit({
  vramFree,
  modelSizeBytes,
  totalLayers,
  gpuLayers,
  kvBytesPerToken,
  desiredMaxContext,
  minContext,
  vramOverheadBytes,
  vramBufferBytes,
  gpuConstrainedContext,
  weightsAlreadyLoaded = false,
}) {
  if (!vramFree || vramFree <= 0 || !totalLayers || !modelSizeBytes || !kvBytesPerToken) {
    return null;
  }
  const bytesPerLayer = modelSizeBytes / totalLayers;
  const gpuRatio = totalLayers > 0 ? gpuLayers / totalLayers : 0;
  const modelVram = weightsAlreadyLoaded ? 0 : gpuLayers * bytesPerLayer;
  const availForKv = vramFree - modelVram - vramOverheadBytes - vramBufferBytes;
  if (availForKv <= 0) return null;

  let maxCtx;
  if (gpuRatio > 0) {
    maxCtx = Math.floor(availForKv / (kvBytesPerToken * gpuRatio));
    if (gpuConstrainedContext && gpuRatio < 0.3) {
      const vramBoundedCtx = Math.floor(availForKv / kvBytesPerToken);
      if (vramBoundedCtx > 0) maxCtx = Math.min(maxCtx, vramBoundedCtx);
    }
  } else {
    maxCtx = Math.floor(availForKv / kvBytesPerToken);
  }

  const contextSize = Math.max(minContext, Math.min(maxCtx, desiredMaxContext));
  const kvOnGpu = kvBytesPerToken * contextSize * gpuRatio;
  if (modelVram + kvOnGpu + vramOverheadBytes > vramFree) return null;

  return { gpuLayers, maxCtx, contextSize };
}

/**
 * Unified VRAM budget: pick (gpuLayers, contextSize) from runtime VRAM + GGUF metadata.
 * Post-load (fixedGpuLayers): context only. Pre-load: mode from vramBalance setting.
 *
 * @returns {{ gpuLayers: number, contextSize: number, budgetMeta?: object }}
 */
function computeUnifiedVramBudget({
  vramFree,
  vramTotal = 0,
  modelSizeBytes,
  totalLayers,
  kvBytesPerToken,
  desiredMaxContext,
  minContext = MIN_CONTEXT_FLOOR,
  vramOverheadBytes = VRAM_GENERATION_OVERHEAD,
  vramBufferBytes = VRAM_KV_BUFFER,
  gpuConstrainedContext = true,
  fixedGpuLayers = null,
  vramBalance = 'balanced',
  trainMaxContext = null,
}) {
  const fallback = {
    gpuLayers: fixedGpuLayers ?? 0,
    contextSize: Math.max(minContext, Math.min(desiredMaxContext, minContext)),
  };
  if (!vramFree || vramFree <= 0 || !totalLayers || totalLayers <= 0 || !modelSizeBytes) {
    return fallback;
  }
  if (!kvBytesPerToken || kvBytesPerToken <= 0) {
    return {
      gpuLayers: fixedGpuLayers ?? totalLayers,
      contextSize: desiredMaxContext,
    };
  }

  const fitParams = {
    vramFree,
    modelSizeBytes,
    totalLayers,
    kvBytesPerToken,
    desiredMaxContext,
    minContext,
    vramOverheadBytes,
    vramBufferBytes,
    gpuConstrainedContext,
  };

  // Post-load: layers locked, weights already in VRAM — maximize context for available memory.
  if (fixedGpuLayers != null) {
    const fit = computeLayerVramFit({ ...fitParams, gpuLayers: fixedGpuLayers, weightsAlreadyLoaded: true });
    return {
      gpuLayers: fixedGpuLayers,
      contextSize: fit?.contextSize ?? fallback.contextSize,
    };
  }

  const mode = vramBalance === 'speed' || vramBalance === 'context' ? vramBalance : 'balanced';
  const autoTarget = computeAutoTargetContext({
    vramTotal: vramTotal || vramFree,
    vramFree,
    kvBytesPerToken,
    desiredMaxContext,
    trainMaxContext,
  });
  const targetSteps = buildContextTargetSteps(autoTarget, minContext);

  // Speed: v0.3.87 layer-dominant scoring (unchanged behavior for speed mode).
  if (mode === 'speed') {
    let bestPartial = null;
    let bestCpuOnly = null;
    for (let gpuLayers = totalLayers; gpuLayers >= 0; gpuLayers--) {
      const fit = computeLayerVramFit({ ...fitParams, gpuLayers });
      if (!fit) continue;
      if (gpuLayers > 0) {
        const score = gpuLayers * 1_000_000 + fit.contextSize;
        if (!bestPartial || score > bestPartial.score) {
          bestPartial = { ...fit, score };
        }
      } else {
        const score = fit.contextSize;
        if (!bestCpuOnly || score > bestCpuOnly.score) {
          bestCpuOnly = { ...fit, score };
        }
      }
    }
    if (bestPartial) {
      return {
        gpuLayers: bestPartial.gpuLayers,
        contextSize: bestPartial.contextSize,
        budgetMeta: { mode, autoTarget, targetUsed: null },
      };
    }
    if (bestCpuOnly) {
      return {
        gpuLayers: 0,
        contextSize: bestCpuOnly.contextSize,
        budgetMeta: { mode, autoTarget, targetUsed: null },
      };
    }
    return { ...fallback, budgetMeta: { mode, autoTarget, targetUsed: null } };
  }

  // Context: maximize contextSize among fits meeting target; tie-break higher gpuLayers.
  if (mode === 'context') {
    for (const target of targetSteps) {
      let best = null;
      for (let gpuLayers = 1; gpuLayers <= totalLayers; gpuLayers++) {
        const fit = computeLayerVramFit({ ...fitParams, gpuLayers });
        if (!fit || fit.maxCtx < target) continue;
        if (!best || fit.contextSize > best.contextSize
          || (fit.contextSize === best.contextSize && fit.gpuLayers > best.gpuLayers)) {
          best = { ...fit, targetUsed: target };
        }
      }
      if (best) {
        return {
          gpuLayers: best.gpuLayers,
          contextSize: best.contextSize,
          budgetMeta: { mode, autoTarget, targetUsed: best.targetUsed },
        };
      }
    }
    const cpuFit = computeLayerVramFit({ ...fitParams, gpuLayers: 0 });
    if (cpuFit) {
      return {
        gpuLayers: 0,
        contextSize: cpuFit.contextSize,
        budgetMeta: { mode, autoTarget, targetUsed: MIN_CONTEXT_FLOOR, cpuFallback: true },
      };
    }
    return { ...fallback, budgetMeta: { mode, autoTarget, targetUsed: null } };
  }

  // Balanced (default): highest gpuLayers where maxCtx >= target; step down target if needed.
  for (const target of targetSteps) {
    for (let gpuLayers = totalLayers; gpuLayers >= 1; gpuLayers--) {
      const fit = computeLayerVramFit({ ...fitParams, gpuLayers });
      if (!fit || fit.maxCtx < target) continue;
      const contextSize = Math.max(minContext, Math.min(fit.maxCtx, desiredMaxContext));
      return {
        gpuLayers,
        contextSize,
        budgetMeta: {
          mode,
          autoTarget,
          targetUsed: target,
          targetSteppedDown: target < autoTarget,
        },
      };
    }
  }

  const cpuFit = computeLayerVramFit({ ...fitParams, gpuLayers: 0 });
  if (cpuFit) {
    return {
      gpuLayers: 0,
      contextSize: cpuFit.contextSize,
      budgetMeta: { mode, autoTarget, targetUsed: null, cpuFallback: true },
    };
  }
  return { ...fallback, budgetMeta: { mode, autoTarget, targetUsed: null } };
}

/** Approximate chars per token for English tool prompts. */
const TOOL_PROMPT_CHARS_PER_TOKEN = 3.5;

/**
 * Size tool catalog to remaining prompt budget (Bug 5).
 * Appends compact category parts until budget exhausted; falls back to full if it fits.
 */
function buildBudgetProportionalToolPrompt({
  contextTokens,
  basePromptChars,
  historyChars = 0,
  userMessageChars = 0,
  toolPrompt = '',
  compactToolParts = null,
  compactToolPrompt = '',
  minGenerationReserve = 512,
  maxToolBudgetPct = 0.35,
  maxToolBudgetTokens = 4096,
}) {
  const consumedTokens = Math.ceil((basePromptChars + historyChars + userMessageChars) / TOOL_PROMPT_CHARS_PER_TOKEN);
  const promptBudgetTokens = Math.max(256, contextTokens - minGenerationReserve - consumedTokens);
  const maxToolTokens = Math.min(
    Math.floor(promptBudgetTokens * maxToolBudgetPct),
    maxToolBudgetTokens,
  );
  const maxToolChars = Math.floor(maxToolTokens * TOOL_PROMPT_CHARS_PER_TOKEN);

  const fullToolTokens = Math.ceil((toolPrompt?.length || 0) / TOOL_PROMPT_CHARS_PER_TOKEN);
  if (toolPrompt && fullToolTokens <= maxToolTokens) {
    return { prompt: toolPrompt, mode: 'full', budgetTokens: maxToolTokens, usedTokens: fullToolTokens };
  }

  const parts = Array.isArray(compactToolParts) && compactToolParts.length > 0
    ? compactToolParts
    : (compactToolPrompt ? [compactToolPrompt] : []);

  if (parts.length === 0) {
    const trimmed = toolPrompt && toolPrompt.length > maxToolChars
      ? toolPrompt.slice(0, maxToolChars) + '\n…and more tools available\n'
      : (toolPrompt || '');
    return { prompt: trimmed, mode: 'trimmed-full', budgetTokens: maxToolTokens, usedTokens: Math.ceil(trimmed.length / TOOL_PROMPT_CHARS_PER_TOKEN) };
  }

  let built = '';
  let partsUsed = 0;
  const headerPart = parts[0] || '';
  for (const part of parts) {
    const next = built + part;
    if (next.length > maxToolChars && built.length > 0) break;
    built = next;
    partsUsed++;
  }
  if (!built && headerPart) {
    built = headerPart.length > maxToolChars ? headerPart.slice(0, maxToolChars) : headerPart;
    partsUsed = 1;
  } else if (headerPart && !built.startsWith(headerPart)) {
    // Always preserve format header even when budget is tight
    const body = built.slice(headerPart.length);
    const maxBody = Math.max(0, maxToolChars - headerPart.length);
    built = headerPart + (maxBody > 0 ? body.slice(0, maxBody) : '');
    partsUsed = Math.max(partsUsed, 1);
  }
  if (partsUsed < parts.length) {
    built += '\n…and more tools available\n';
  }
  return {
    prompt: built,
    mode: 'budget-parts',
    budgetTokens: maxToolTokens,
    partsUsed,
    usedTokens: Math.ceil(built.length / TOOL_PROMPT_CHARS_PER_TOKEN),
  };
}

/**
 * Normalize settings / IPC payload for model load. Matches settingsManager defaults when fields are missing.
 * @param {object} raw
 * @returns {{ gpuPreference: 'auto'|'cpu', gpuLayers: number, contextSize: number, requireMinContextForGpu: boolean }}
 */
/**
 * Absolute floor for the computed hardware context cap when GGUF metadata is
 * missing (so we cannot compute a KV-derived cap). Equal to the llama.cpp-aligned
 * minimum — used only as a last resort; the normal path computes from architecture.
 */
const CONTEXT_MAX_FALLBACK_NO_GGUF_FLOOR = 2048;

/**
 * Estimate KV-cache bytes per token from GGUF architecture metadata.
 * Transformer-standard, architecture-agnostic:
 *   KV per token = n_layer * n_head_kv * (key_length + value_length) * bytes_per_element
 * Assumes fp16 KV cache (2 bytes/element), the llama.cpp default.
 *
 * GGUF metadata shape (llama.cpp convention):
 *   architectureMetadata.block_count        → n_layer
 *   architectureMetadata.attention.head_count_kv   → n_head_kv
 *   architectureMetadata.attention.head_count      → n_head (fallback)
 *   architectureMetadata.attention.key_length      → head_dim_k
 *   architectureMetadata.attention.value_length    → head_dim_v
 *   architectureMetadata.embedding_length          → embedding dim (fallback)
 */
function estimateKvBytesPerToken(am, kvCacheType) {
  if (!am) return null;
  const nLayer = am.block_count;
  if (!nLayer) return null;
  const att = am.attention || {};
  const nHeadKv = att.head_count_kv || att.head_count;
  if (!nHeadKv) return null;
  let keyLen = att.key_length;
  let valLen = att.value_length;
  // Fallback: derive head_dim from embedding_length / head_count if per-head lengths missing
  if ((!keyLen || !valLen) && am.embedding_length && att.head_count) {
    const headDim = am.embedding_length / att.head_count;
    if (Number.isFinite(headDim) && headDim > 0) {
      if (!keyLen) keyLen = headDim;
      if (!valLen) valLen = headDim;
    }
  }
  if (!keyLen || !valLen) return null;
  // Bytes per element depends on KV cache quantization type:
  //   f16  = 2 bytes/element (no compression)
  //   q8_0 = 1 byte/element  (2x compression)
  //   q4_0 = 0.5 bytes/element (4x compression)
  const bytesPerElement = kvCacheType === 'q3_0' ? 0.375
    : kvCacheType === 'q4_0' ? 0.5
    : kvCacheType === 'q4_1' ? 0.5625
    : kvCacheType === 'q5_0' ? 0.625
    : kvCacheType === 'q5_1' ? 0.6875
    : kvCacheType === 'q8_0' ? 1
    : 2; // f16 or default
  return nLayer * nHeadKv * (keyLen + valLen) * bytesPerElement;
}

function buildEngineLoadSettings(raw = {}) {
  const gpuPreference = raw.gpuPreference === 'cpu' ? 'cpu' : 'auto';
  const gpuLayers = typeof raw.gpuLayers === 'number' ? raw.gpuLayers : -1;
  const ctx = Number(raw.contextSize);
  // 0 = auto â€” use model train cap (and VRAM) as upper bound, not a fixed 16k default
  const contextSize = !Number.isFinite(ctx) || ctx < 0 ? 0 : Math.floor(ctx);
  return {
    gpuPreference,
    gpuLayers,
    contextSize,
    requireMinContextForGpu: !!raw.requireMinContextForGpu,
    gpuConstrainedContext: raw.gpuConstrainedContext !== false, // default true
    vramBalance: raw.vramBalance === 'speed' || raw.vramBalance === 'context' ? raw.vramBalance : 'balanced',
    kvCacheType: raw.kvCacheType || 'f16',
    enableThinking: raw.enableThinking !== false, // default true
  };
}

// Agent identity prompt — behavior and grounding only; tool format/catalog live in getToolPrompt()
const SYSTEM_PROMPT = `You are guIDE, an AI assistant embedded in a general-purpose IDE. You help users with software projects: reading and writing code, running commands, searching the web, using the browser, and answering questions.

## How to respond
- If the user's message is conversational (greetings, thanks, clarifying questions, opinions) and needs no action, reply in plain prose only. Do not call tools.
- If the user asks you to do something you cannot do with text alone — create or change files, run commands, search the project or web, use the browser, inspect git state, etc. — use the appropriate tool from the ## Tools section below.
- You have real tools. When action is required, use them. Do not say you cannot access files, the terminal, or the network when a tool can perform the task.

## Tools (required reading)
Tool definitions, call format, parameter schemas, and examples are in the ## Tools section appended below this message. Follow that section exactly for tool names, parameter names, and JSON format. Do not invent tool names or parameter names.

After calling a tool, wait for the result before continuing. Never output fabricated tool results or blocks labeled [Tool Results] or [System: Tool Results] — the system injects real results.

## Grounding
- Base answers on tool results, file contents, and user-provided context — not assumptions.
- If you need information only the user can provide, ask in prose or use ask_question when offered in ## Tools.
- If a tool fails, read the error, adjust, and retry once with corrected parameters; then explain or ask the user.

## Images
When you receive an image description from the vision system, treat it as what you observed. Do not use read_file on image files to "see" them.

## Planning
For multi-step work, you may use planning tools from ## Tools when they fit the task. For simple requests, act directly without unnecessary planning overhead.`;

class ChatEngine extends EventEmitter {
  constructor() {
    super();
    console.log('[ChatEngine] constructor START');
    this.isReady = false;
    this.isLoading = false;
    /** @type {'idle'|'loading'|'ready'|'disposing'} */
    this._loadState = 'idle';
    this._loadPromise = null;
    this.modelInfo = null;
    this.currentModelPath = null;
    this.gpuPreference = 'auto';
    this._projectPath = null;

    this._llama = null;
    this._model = null;
    this._context = null;
    this._sequence = null;
    this._chat = null;
    this._chatHistory = [];
    this._lastEvaluation = null;
    this._abortController = null;
    this._pendingUserMessage = null; // injected by user interrupt during tool loop
    this._templateSupportsThinking = false;
    this._thinkingCapable = false;
    this._recentlyWrittenFiles = new Map(); // filePath → content written in current chat() call
    this._sessionId = 0; // increments on resetSession to detect stale tool results
    console.log('[ChatEngine] constructor DONE');
  }

  async waitForReady() {
    if (this._loadPromise) {
      try { await this._loadPromise; } catch (_) { /* load failed */ }
    }
    return this.isReady && this._loadState === 'ready';
  }

  /**
   * @param {string} modelPath
   * @param {object} [rawLoadSettings] — from settingsManager.get() (gpuPreference, gpuLayers, contextSize, requireMinContextForGpu)
   */
  async initialize(modelPath, rawLoadSettings) {
    // If a load is already in progress, wait for it to finish, then proceed with this new request.
    // This prevents "Already loading a model" errors when the user switches models quickly.
    if (this._loadPromise) {
      console.log('[ChatEngine] Model load already in progress — queuing new request');
      try { await this._loadPromise; } catch (_) { /* previous load failed — proceed */ }
    }

    // Build a new promise for this load so subsequent requests can await it
    this._loadPromise = this._doInitialize(modelPath, rawLoadSettings);
    try {
      return await this._loadPromise;
    } finally {
      this._loadPromise = null;
    }
  }

  async _doInitialize(modelPath, rawLoadSettings) {
    this._loadState = 'loading';
    this.isLoading = true;
    this.isReady = false;
    this.emit('status', { state: 'loading', message: 'Loading model...' });

    try {
      const llamaCppPath = this._getNodeLlamaCppPath();
      const { getLlama, LlamaChat, readGgufFileInfo, JinjaTemplateChatWrapper } = await import(pathToFileURL(llamaCppPath).href);

      const s = buildEngineLoadSettings(rawLoadSettings || {});
      this.gpuPreference = s.gpuPreference;

      if (this._model) {
        this._loadState = 'disposing';
        await this._dispose();
        this._loadState = 'loading';
      }

      let trainMaxContext = null;
      let totalLayersFromGguf = null;
      let ggufArchMeta = null;
      let ggufArchString = null; // metadata.general.architecture (e.g. "chatglm", "qwen35", "gemma3")
      let ggufChatTemplate = null; // tokenizer.chat_template — Jinja template string from GGUF metadata
      try {
        const gguf = await readGgufFileInfo(modelPath, { readTensorInfo: false, logWarnings: false });
        const am = gguf.architectureMetadata;
        ggufArchMeta = am || null;
        if (gguf.metadata?.general?.architecture) ggufArchString = gguf.metadata.general.architecture;
        if (am && typeof am.context_length === 'number') trainMaxContext = am.context_length;
        if (am && typeof am.block_count === 'number') totalLayersFromGguf = am.block_count;
        // Tier 1: Extract chat template from GGUF metadata for auto-detection.
        // tokenizer.chat_template is a Jinja2 string embedded in the GGUF file.
        // It's the authoritative source for what the model's chat format supports.
        // Models with thinking capability include `enable_thinking` as a Jinja variable.
        if (gguf.metadata?.tokenizer?.chat_template) {
          ggufChatTemplate = gguf.metadata.tokenizer.chat_template;
        }
      } catch (e) {
        console.warn(`[ChatEngine] readGgufFileInfo: ${e.message}`);
      }

      // Initialize llama runtime early so we can query VRAM state before context sizing.
      this._llama = await getLlama({
        gpu: s.gpuPreference === 'cpu' ? false : 'auto',
      });

      const modelStats = fs.statSync(modelPath);

      // ─── Hardware-aware context ceiling computation ───
      // Compute the maximum context window that the user's hardware can realistically support,
      // derived from GGUF architecture + available memory. No hardcoded ceilings.
      const kvBytesPerToken = estimateKvBytesPerToken(ggufArchMeta, s.kvCacheType);
      let hardwareCap = null;
      let kvSourceMem = 'none';
      let vramTotal = 0;
      let vramFree = 0;
      // Diagnostic: log raw GGUF architecture metadata for KV estimate verification
      if (ggufArchMeta) {
        const att = ggufArchMeta.attention || {};
        console.log(`[ChatEngine] GGUF arch metadata: block_count=${ggufArchMeta.block_count}, head_count_kv=${att.head_count_kv}, head_count=${att.head_count}, key_length=${att.key_length}, value_length=${att.value_length}, embedding_length=${ggufArchMeta.embedding_length}, kvCacheType=${s.kvCacheType}, kvBytesPerToken=${kvBytesPerToken}`);
      }
      if (kvBytesPerToken) {
        // Compute hwCap from both VRAM and RAM, pick whichever gives larger context.
        // Previously we preferred VRAM whenever possible, but for small models that
        // nearly fill VRAM, this gave tiny contexts (e.g. 12K) when RAM would give 32K+.
        let vramHwCap = null;
        let ramHwCap = null;
        if (s.gpuPreference !== 'cpu') {
          try {
            const vramState = await this._llama.getVramState();
            vramTotal = vramState?.total || 0;
            vramFree = vramState?.free || 0;
          } catch (e) { console.warn('[ChatEngine] VRAM state query failed:', e.message); }
        }
        // VRAM path: free VRAM minus model weights, half reserved for KV
        if (vramFree > modelStats.size) {
          const vramAvail = vramFree - modelStats.size;
          const vramKvBudget = vramAvail / 2;
          vramHwCap = Math.max(MIN_CONTEXT_FLOOR, Math.floor(vramKvBudget / kvBytesPerToken));
        }
        // RAM path. useMmap=true (line 445) means model weights are
        // memory-mapped and shared with the OS page cache, NOT consuming
        // anonymous RAM upfront. Deriving from os.freemem() and subtracting
        // modelStats.size double-counts on every OS with mmap and collapses
        // to MIN_CONTEXT_FLOOR when free memory is tight at load time.
        // Use os.totalmem() (deterministic upper bound, independent of
        // transient memory state) minus the model file size minus a fixed
        // runtime overhead for activations, the JS/Electron heap, sub-agent
        // context, and OS slack. A precise computation would need gpuLayers,
        // which is computed AFTER hardwareCap (chicken-and-egg) — fixed
        // constant is the right tradeoff here.
        const RAM_RUNTIME_OVERHEAD = 1.5 * 1024 * 1024 * 1024;
        const ramAvail = Math.max(0, os.totalmem() - modelStats.size - RAM_RUNTIME_OVERHEAD);
        const ramKvBudget = ramAvail / 2;
        ramHwCap = Math.max(MIN_CONTEXT_FLOOR, Math.floor(ramKvBudget / kvBytesPerToken));

        // Pick whichever source gives the larger context
        if (vramHwCap != null && vramHwCap >= ramHwCap) {
          hardwareCap = vramHwCap;
          kvSourceMem = 'vram';
        } else {
          hardwareCap = ramHwCap;
          kvSourceMem = 'ram';
        }
        console.log(`[ChatEngine] Memory diagnostic: vramTotal=${(vramTotal/1e9).toFixed(2)}GB, vramFree=${(vramFree/1e9).toFixed(2)}GB, freeRam=${(os.freemem()/1e9).toFixed(2)}GB, modelSize=${(modelStats.size/1e9).toFixed(2)}GB, vramHwCap=${vramHwCap}, ramHwCap=${ramHwCap}, source=${kvSourceMem}, hwCap=${hardwareCap}`);
      }

      const testMaxCtx = parseInt(process.env.TEST_MAX_CONTEXT, 10) || 0;
      let desiredMax;
      if (testMaxCtx > 0) {
        desiredMax = testMaxCtx;
      } else if (s.contextSize <= 0) {
        // P4: Auto sizing uses only hardware cap and train cap (no hardcoded ceiling).
        // Per RULES.md Rule 9: never hardcode context numbers — compute from actual resources.
        // The hardware cap already accounts for VRAM/RAM headroom, so it self-limits to safe sizes.
        if (hardwareCap != null && trainMaxContext != null) {
          desiredMax = Math.min(hardwareCap, trainMaxContext);
        } else if (hardwareCap != null) {
          desiredMax = hardwareCap;
        } else if (trainMaxContext != null) {
          desiredMax = trainMaxContext;
        } else {
          desiredMax = CONTEXT_MAX_FALLBACK_NO_GGUF_FLOOR;
        }
      } else {
        desiredMax = s.contextSize;
        if (trainMaxContext != null) desiredMax = Math.min(desiredMax, trainMaxContext);
        desiredMax = Math.max(MIN_CONTEXT_FLOOR, desiredMax);
      }

      const minBase = s.requireMinContextForGpu ? MIN_CONTEXT_WHEN_GPU_REQUIRED : MIN_CONTEXT_FLOOR;
      let contextMin = Math.min(minBase, desiredMax);

      // When model weights exceed VRAM, RAM hwCap can inflate desiredMax to 100K+ and the
      // unified budget picks gpuLayers=0 with a mega KV cache. Cap desiredMax from VRAM so
      // partial GPU offload remains viable on 4GB GPUs.
      if (s.gpuPreference !== 'cpu' && kvBytesPerToken > 0 && modelStats.size > vramFree * 0.85) {
        const vramKvBudget = vramFree - VRAM_GENERATION_OVERHEAD - VRAM_KV_BUFFER;
        const vramCtxCap = Math.max(MIN_CONTEXT_FLOOR, Math.floor(vramKvBudget / kvBytesPerToken));
        if (desiredMax > vramCtxCap) {
          console.log(`[ChatEngine] Model (${(modelStats.size / 1e9).toFixed(2)}GB) exceeds VRAM (${(vramFree / 1e9).toFixed(2)}GB free) — capping desiredMax ${desiredMax} → ${vramCtxCap} to preserve GPU layer budget`);
          desiredMax = vramCtxCap;
          contextMin = Math.min(minBase, desiredMax);
        }
      }

      console.log(
        `[ChatEngine] Context sizing: train=${trainMaxContext}, hwCap=${hardwareCap} (source=${kvSourceMem}, kvBytesPerToken=${kvBytesPerToken}), user=${s.contextSize <= 0 ? 'auto' : s.contextSize}, test=${testMaxCtx || 'none'} → desiredMax=${desiredMax}`,
      );

      // Pre-flight validation: catch undefined variables before they cause runtime errors
      const _preflightVars = { kvBytesPerToken, hardwareCap, kvSourceMem, vramTotal, vramFree, trainMaxContext, totalLayersFromGguf, ggufArchMeta, desiredMax, contextMin, modelStats };
      for (const [name, val] of Object.entries(_preflightVars)) {
        if (val === undefined) {
          throw new Error(`Internal error: ${name} is undefined at loadModel. This is a bug — please report.`);
        }
      }

      const loadModelOpts = {
        modelPath,
        defaultContextFlashAttention: s.gpuPreference !== 'cpu',
        ignoreMemorySafetyChecks: true,
        useMmap: true,
        // Lock model pages in RAM to prevent OS from swapping them to disk (causes stalls)
        useMlock: os.totalmem() > modelStats.size * 2,
        onLoadProgress: (p) => {
          this.emit('status', { state: 'loading', message: `Loading model... ${Math.round(p * 100)}%`, progress: p });
        },
      };

      // KV cache quantization: resolve BEFORE loadModel so we can adjust fitContext.
      // Default 'f16' matches llama.cpp upstream and enables the fastest fused flash-attention
      // kernel path on consumer NVIDIA GPUs (this is what LM Studio / llama-server use). Lower
      // precision options (q8_0, q4_0, q4_1, q5_0, q5_1, q3_0) are user-selectable for trading
      // VRAM headroom against generation speed. 'currentQuant' lets node-llama-cpp match the
      // model's weight quantization (legacy behaviour, retained for explicit selection).
      const ALLOWED_KV_TYPES = new Set(['currentQuant', 'q3_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_0', 'f16']);
      const rawKvType = rawLoadSettings.kvCacheType || 'f16';
      const kvCacheType = ALLOWED_KV_TYPES.has(rawKvType) ? rawKvType : undefined;

      if (s.gpuPreference === 'cpu') {
        loadModelOpts.gpuLayers = 0;
      } else if (s.gpuLayers >= 0) {
        loadModelOpts.gpuLayers = s.gpuLayers;
      } else {
        // Unified VRAM budget: pick gpuLayers + estimated context in one pass (Bug 4).
        const totalLayers = totalLayersFromGguf || 32;
        const budget = computeUnifiedVramBudget({
          vramFree,
          vramTotal,
          modelSizeBytes: modelStats.size,
          totalLayers,
          kvBytesPerToken: kvBytesPerToken || 0,
          desiredMaxContext: desiredMax,
          minContext: contextMin,
          gpuConstrainedContext: s.gpuConstrainedContext !== false,
          vramBalance: s.vramBalance,
          trainMaxContext: trainMaxContext ?? null,
        });
        const kvOnGpuFinal = (kvBytesPerToken || 0) * budget.contextSize * (budget.gpuLayers / totalLayers);
        const meta = budget.budgetMeta;
        const metaStr = meta
          ? `, mode=${meta.mode}, autoTarget=${meta.autoTarget}${meta.targetUsed != null ? `, targetUsed=${meta.targetUsed}` : ''}${meta.targetSteppedDown ? ', targetSteppedDown=true' : ''}${meta.cpuFallback ? ', cpuFallback=true' : ''}`
          : '';
        console.log(`[ChatEngine] Unified VRAM budget: vramFree=${(vramFree / 1e9).toFixed(2)}GB, vramTotal=${(vramTotal / 1e9).toFixed(2)}GB, gpuLayers=${budget.gpuLayers}/${totalLayers}, estCtx=${budget.contextSize}, kvOnGpu=${(kvOnGpuFinal / 1e6).toFixed(1)}MB, overhead=${(VRAM_GENERATION_OVERHEAD / 1e9).toFixed(2)}GB${metaStr}`);
        loadModelOpts.gpuLayers = budget.gpuLayers;
        this._preLoadContextEstimate = budget.contextSize;
      }

      this._model = await this._llama.loadModel(loadModelOpts);

      // P1: Use node-llama-cpp's cpuMathCores (probed by llama.cpp from actual CPU topology)
      // instead of os.cpus().length / 2 which was wrong on:
      //   - AMD Ryzen without SMT (formula halved usable cores)
      //   - Apple Silicon (no hyperthreading — formula halved usable cores)
      //   - Intel with E-cores (formula misclassified E-cores)
      // Falls back to os.cpus().length if cpuMathCores is missing or zero.
      const cpuMathCores = (typeof this._llama.cpuMathCores === 'number' && this._llama.cpuMathCores > 0)
        ? this._llama.cpuMathCores
        : os.cpus().length;
      const threadCount = Math.max(1, cpuMathCores);

      // P2: Adaptive batchSize from actual VRAM headroom after model load.
      // Larger batchSize = faster prompt processing (prefill). Output tok/s unchanged.
      // Measured free VRAM determines safe upper bound. CPU stays conservative.
      let vramFreeAfterModel = vramFree;
      if (s.gpuPreference !== 'cpu') {
        try {
          const vs = await this._llama.getVramState();
          vramFreeAfterModel = vs?.free || vramFree;
        } catch (e) { console.warn('[ChatEngine] VRAM query (batchSize) failed:', e.message); }
      }
      let batchSize;
      if (s.gpuPreference === 'cpu') batchSize = 512;
      else if (vramFreeAfterModel < 2 * 1024 * 1024 * 1024) batchSize = 1024;
      else if (vramFreeAfterModel < 4 * 1024 * 1024 * 1024) batchSize = 2048;
      else batchSize = 4096;
      console.log(`[ChatEngine] Perf: cpuMathCores=${cpuMathCores} (threads=${threadCount}), vramFreeAfterModel=${(vramFreeAfterModel/1e9).toFixed(2)}GB, batchSize=${batchSize}`);

      // P5: SWA models (Gemma, Mistral with sliding window) — set swaFullCache to enable
      // prefix reuse on multi-turn chats. Without this, multi-turn re-evaluates entire history.
      const swaSize = this._model?.fileInsights?.swaSize || 0;
      const swaFullCache = swaSize > 0;
      if (swaFullCache) console.log(`[ChatEngine] P5: SWA detected (swaSize=${swaSize}) — swaFullCache enabled for prefix reuse`);

      // Compute exact context size after model loading.
      // node-llama-cpp's createContext with { min, max } uses f16 for KV estimation,
      // which inflates 4x when using q4_0, causing all retries to fail and collapse
      // to the minimum (2048). We bypass this by computing the exact size ourselves
      // using actual post-load VRAM measurements and q4_0-aware KV estimates,
      // then passing a single number to createContext.
      const actualGpuLayers = this._model.gpuLayers || 0;
      const totalLayersForCtx = totalLayersFromGguf || 32;
      const gpuLayerRatio = totalLayersForCtx > 0 ? actualGpuLayers / totalLayersForCtx : 0;
      let computedCtxSize = desiredMax;

      if (kvBytesPerToken > 0 && s.gpuPreference !== 'cpu') {
        // Post-load: refine context using measured VRAM and locked gpuLayers (same unified budget).
        const postBudget = computeUnifiedVramBudget({
          vramFree: vramFreeAfterModel,
          vramTotal,
          modelSizeBytes: modelStats.size,
          totalLayers: totalLayersForCtx,
          kvBytesPerToken,
          desiredMaxContext: desiredMax,
          minContext: contextMin,
          gpuConstrainedContext: s.gpuConstrainedContext !== false,
          fixedGpuLayers: actualGpuLayers,
          trainMaxContext: trainMaxContext ?? null,
        });
        computedCtxSize = postBudget.contextSize;
        console.log(`[ChatEngine] Post-load unified context: vramFreeAfterModel=${(vramFreeAfterModel/1e9).toFixed(2)}GB, kvBpt=${kvBytesPerToken}, gpuRatio=${gpuLayerRatio.toFixed(2)}, computedCtxSize=${computedCtxSize}${this._preLoadContextEstimate != null ? `, preLoadEst=${this._preLoadContextEstimate}` : ''}`);
        this._preLoadContextEstimate = null;
      }

      // Build createContext options. Only attach experimentalKvCacheKeyType / ValueType when
      // the user has selected a non-f16 KV type. Passing 'f16' explicitly is supported by
      // node-llama-cpp but bypasses the upstream-default code path; omitting the override lets
      // llama.cpp pick the fastest fused flash-attention kernel for the model + GPU combination.
      const baseCtxOpts = {
        contextSize: computedCtxSize,
        flashAttention: s.gpuPreference !== 'cpu',
        ignoreMemorySafetyChecks: true,
        batchSize,
        threads: { ideal: threadCount, min: Math.max(1, threadCount - 1) },
        swaFullCache,
      };
      if (kvCacheType && kvCacheType !== 'f16') {
        baseCtxOpts.experimentalKvCacheKeyType = kvCacheType;
        baseCtxOpts.experimentalKvCacheValueType = kvCacheType;
      }

      // Create context with computed single-number size (bypasses f16-based fitting)
      try {
        this._context = await this._model.createContext(baseCtxOpts);
      } catch (ctxErr) {
        // Fallback: if a quantised KV type isn't actually applied by llama.cpp for this model,
        // the real KV size is f16 (up to 4x larger). Recompute with f16 estimate and retry.
        // vramFreeAfterModel was already measured above; reuse it.
        if (kvBytesPerToken > 0 && s.gpuPreference !== 'cpu') {
          const kvBytesF16 = kvBytesPerToken * 4;
          const fallbackBudget = computeUnifiedVramBudget({
            vramFree: vramFreeAfterModel,
            vramTotal,
            modelSizeBytes: modelStats.size,
            totalLayers: totalLayersForCtx,
            kvBytesPerToken: kvBytesF16,
            desiredMaxContext: desiredMax,
            minContext: contextMin,
            gpuConstrainedContext: s.gpuConstrainedContext !== false,
            fixedGpuLayers: actualGpuLayers,
            trainMaxContext: trainMaxContext ?? null,
          });
          const fallbackCtxSize = fallbackBudget.contextSize;
          console.warn(`[ChatEngine] Context creation at ${computedCtxSize} failed (${ctxErr.message}), retrying with f16 KV estimate: ${fallbackCtxSize}`);
          const fallbackOpts = { ...baseCtxOpts, contextSize: fallbackCtxSize };
          this._context = await this._model.createContext(fallbackOpts);
        } else {
          throw ctxErr;
        }
      }

      // Diagnostic: verify context creation
      const actualCtxSize = this._context?.contextSize;
      console.log(`[ChatEngine] Context created: ctx=${actualCtxSize}, gpuLayers=${actualGpuLayers}, flashAttn=${s.gpuPreference !== 'cpu'}, batchSize=${batchSize}, threads=${threadCount}, swaFullCache=${swaFullCache}, kvCacheType=${kvCacheType || 'default'}, requestedSize=${computedCtxSize}`);

      // Graceful context degradation: log exact reason and suggest action
      const ctxDegradation = actualCtxSize < desiredMax * 0.8;
      if (ctxDegradation) {
        const ratio = actualCtxSize / desiredMax;
        const reason = ratio < 0.1
          ? `Context collapsed to ${actualCtxSize} (${(ratio * 100).toFixed(1)}% of desired ${desiredMax}). Likely cause: GPU layers consumed too much VRAM, leaving none for KV cache.`
          : `Context reduced to ${actualCtxSize} (${(ratio * 100).toFixed(1)}% of desired ${desiredMax}). GPU layers (${actualGpuLayers}) may be consuming VRAM needed for KV cache.`;
        const suggestion = actualGpuLayers > 0
          ? `Try: reduce GPU layers in settings, or set a smaller context size manually.`
          : `Try: increase context size in settings, or switch to a smaller model.`;
        console.warn(`[ChatEngine] Context degradation: ${reason} ${suggestion}`);
      }

      this._sequence = this._context.getSequence();

      const actualCtx = this._context.contextSize || 0;
      // Estimate parameter count from GGUF metadata or filename (e.g. "Qwen3.5-4B" → 4B)
      let paramCount = ggufArchMeta?.totalParameterCount || null;
      if (!paramCount) {
        const sizeMatch = path.basename(modelPath).match(/(\d+(?:\.\d+)?)\s*[Bb]/);
        if (sizeMatch) paramCount = Math.round(parseFloat(sizeMatch[1]) * 1e9);
      }
      this.modelInfo = {
        path: modelPath,
        name: path.basename(modelPath),
        size: modelStats.size,
        parameterCount: paramCount,
        contextSize: actualCtx,
        contextSizeRequested: s.contextSize <= 0 ? 'auto' : s.contextSize,
        contextSizeCap: desiredMax,
        contextTrainMax: trainMaxContext,
        contextHardwareCap: hardwareCap,
        kvBytesPerToken: kvBytesPerToken,
        kvMemSource: kvSourceMem,
        totalLayers: totalLayersFromGguf != null ? totalLayersFromGguf : undefined,
        gpuLayers: this._model.gpuLayers || 0,
        gpuMode: s.gpuPreference === 'cpu' ? false : 'auto',
      };

      // ─── Three-Tier Model Profile Resolution ───
      // Tier 1: GGUF metadata auto-detection (what the file tells us about itself)
      // Tier 2: Vendor profile overrides (curated settings from model vendor documentation)
      // Tier 3: BASE_DEFAULTS (neutral fallback when neither source provides info)
      //
      // This system is future-proof: a brand-new model with an unknown architecture
      // string and unknown filename will still work correctly because Tier 1 detects
      // capabilities directly from the GGUF file's embedded chat template, and Tier 3
      // provides neutral defaults. Vendor profiles (Tier 2) are optional enhancements
      // that optimize sampling for families with documented vendor recommendations.

      // Tier 1: Auto-detect thinking support from the GGUF chat template.
      // The Jinja chat template is embedded in every GGUF file under tokenizer.chat_template.
      // If it contains `enable_thinking` as a variable, the model supports thinking mode.
      // This is future-proof: any model that adds thinking will include this variable.
      // No manual profile entry is required for thinking to work on new models.
      const _templateSupportsThinking = ggufChatTemplate
        ? /enable_thinking/.test(ggufChatTemplate)
        : false;
      this._templateSupportsThinking = _templateSupportsThinking;
      console.log(`[ChatEngine] Tier 1: chat_template auto-detect — templatePresent=${!!ggufChatTemplate}, supportsThinking=${_templateSupportsThinking}`);

      // Tier 2: Family detection — GGUF architecture metadata (primary) then filename (fallback).
      // GGUF metadata.general.architecture is authoritative (e.g. "chatglm", "qwen35", "gemma3").
      // Filename detection is kept as fallback for corrupted/missing metadata.
      const _archFamily = detectFamilyFromArch(ggufArchString);
      const _fileFamily = detectFamily(modelPath);
      const _detectedFamily = _archFamily || _fileFamily;
      const _detectedSizeB = paramCount ? paramCount / 1e9 : detectParamSize(modelPath);
      this._modelProfile = getModelProfile(_detectedFamily, _detectedSizeB);

      // Merge Tier 1 auto-detection into the profile.
      // Template wins when it declares enable_thinking but profile says none.
      // When template lacks enable_thinking, instruct-family profiles are downgraded to none
      // (native-segment families deepseek/qwen/glm/gemma keep profile budget for segment API).
      const _profileThinkMode = this._modelProfile?.thinkTokens?.mode;
      if (_templateSupportsThinking && _profileThinkMode === 'none') {
        // Template says thinking is supported but profile says none — template wins
        this._modelProfile.thinkTokens.mode = 'budget';
        this._modelProfile.thinkTokens.budget = this._modelProfile.thinkTokens.budget || 2048;
        console.log(`[ChatEngine] Tier 1 override: chat_template supports thinking but profile said 'none' — upgraded to 'budget'`);
      } else if (_templateSupportsThinking && _profileThinkMode !== 'budget' && _profileThinkMode !== 'strip') {
        // Unknown model with template thinking support — activate budget mode
        this._modelProfile.thinkTokens.mode = 'budget';
        this._modelProfile.thinkTokens.budget = this._modelProfile.thinkTokens.budget || 2048;
        console.log(`[ChatEngine] Tier 1 auto-detect: chat_template supports thinking — set thinkTokens.mode='budget'`);
      } else if (!_templateSupportsThinking && _profileThinkMode !== 'none') {
        // Instruct models (phi, llama, mistral, etc.) must not get thought budgets when the
        // GGUF chat template has no enable_thinking variable. Native-segment families keep budget.
        const _NATIVE_THINK_FAMILIES = new Set(['deepseek', 'qwen', 'glm', 'gemma']);
        if (!_NATIVE_THINK_FAMILIES.has(_detectedFamily)) {
          this._modelProfile.thinkTokens.mode = 'none';
          this._modelProfile.thinkTokens.budget = 0;
          console.log(`[ChatEngine] Template has no enable_thinking — disabled think budget for instruct family '${_detectedFamily}'`);
        }
      }

      // Pass enable_thinking to chat template kwargs ONLY when the GGUF template declares it.
      // Never pass enable_thinking=true to instruct models whose templates lack the variable
      // (e.g. Phi-4-mini-instruct) — that corrupts generation and wastes context on fake "thinking".
      const _resolvedThinkMode = this._modelProfile?.thinkTokens?.mode;
      this._thinkingCapable = _resolvedThinkMode !== 'none';
      const _chatTemplateKwargs = {};
      if (s.enableThinking && _templateSupportsThinking && _resolvedThinkMode !== 'none') {
        _chatTemplateKwargs.enable_thinking = true;
      } else {
        _chatTemplateKwargs.enable_thinking = false;
      }
      this._chatTemplateKwargs = _chatTemplateKwargs;
      this._ggufChatTemplate = ggufChatTemplate;

      // LlamaChatOptions has no chatTemplateKwargs field — passing it to the constructor
      // was silently ignored. Only override 'auto' when we must wire enable_thinking into
      // Jinja additionalRenderParameters. All other models keep node-llama-cpp auto resolution
      // (QwenChatWrapper, DeepSeekChatWrapper, etc.) unchanged.
      let chatWrapperOpt = 'auto';
      const needsThinkingJinja = ggufChatTemplate && _templateSupportsThinking && _chatTemplateKwargs.enable_thinking;

      if (needsThinkingJinja) {
        const jinjaOpts = {
          template: ggufChatTemplate,
          tokenizer: this._model.tokenizer,
          additionalRenderParameters: { ..._chatTemplateKwargs },
          segments: {
            thoughtTemplate: '<think>{{content}}</think>',
            reopenThoughtAfterFunctionCalls: false,
          },
        };
        try {
          chatWrapperOpt = new JinjaTemplateChatWrapper(jinjaOpts);
          const thoughtSeg = chatWrapperOpt.settings?.segments?.thought;
          console.log(`[ChatEngine] Custom Jinja wrapper (thinking): enable_thinking=true, thoughtSegment=${!!thoughtSeg}, reopenAfterFC=${thoughtSeg?.reopenAfterFunctionCalls ?? false}`);
        } catch (jinjaErr) {
          console.warn(`[ChatEngine] Custom Jinja wrapper failed — falling back to auto: ${jinjaErr.message}`);
          chatWrapperOpt = 'auto';
        }
      } else {
        console.log(`[ChatEngine] chatWrapper=auto (node-llama-cpp resolves specialized wrapper); enable_thinking=${_chatTemplateKwargs.enable_thinking}`);
      }
      this._chatWrapper = chatWrapperOpt;
      this._chat = new LlamaChat({ contextSequence: this._sequence, chatWrapper: chatWrapperOpt });
      console.log(`[ChatEngine] chatTemplateKwargs=${JSON.stringify(_chatTemplateKwargs)}, wrapper=${chatWrapperOpt === 'auto' ? 'auto' : chatWrapperOpt.wrapperName}, resolvedThinkMode=${_resolvedThinkMode}, enableThinking=${s.enableThinking}, templateSupportsThinking=${_templateSupportsThinking}`);

      this._chatHistory = [{ type: 'system', text: SYSTEM_PROMPT }];
      this._lastEvaluation = null;
      this.modelInfo.family = _detectedFamily;
      this.modelInfo.sizeB = _detectedSizeB;
      this.modelInfo.tier = this._modelProfile._meta.tier;
      console.log(`[ChatEngine] P3: Model profile resolved — family=${_detectedFamily} (arch=${ggufArchString || 'n/a'} → ${_archFamily || 'fallback'}, file=${_fileFamily}), sizeB=${_detectedSizeB.toFixed(2)}, tier=${this._modelProfile._meta.tier}, sampling=${JSON.stringify(this._modelProfile.sampling)}`);

      this.currentModelPath = modelPath;
      this.isReady = true;
      this.isLoading = false;
      this._loadState = 'ready';

      // Check vision availability — do NOT auto-start. Vision starts on-demand when an image needs captioning.
      try {
        const visionCheck = visionServer.checkAvailability(modelPath, {
          embeddingLength: ggufArchMeta?.embedding_length ?? null,
        });
        if (visionCheck.available) {
          console.log(`[ChatEngine] Vision: mmproj found at ${visionCheck.mmprojPath} — vision available (will start on first image)`);
          this.modelInfo.visionAvailable = true;
        } else {
          console.log(`[ChatEngine] Vision: ${visionCheck.reason} — vision unavailable for this model`);
          this.modelInfo.visionAvailable = false;
        }
      } catch (visionErr) {
        console.error(`[ChatEngine] Vision check error: ${visionErr.message}`);
        this.modelInfo.visionAvailable = false;
      }

      console.log(
        `[ChatEngine] Model ready: ctx=${actualCtx} (${s.contextSize <= 0 ? 'auto' : `fixed ${s.contextSize}`}, cap ${desiredMax}${trainMaxContext != null ? `, train ${trainMaxContext}` : ''}), gpuLayers=${this.modelInfo.gpuLayers}`,
      );

      this.emit('status', { state: 'ready', message: `Model ready: ${this.modelInfo.name}`, modelInfo: this.modelInfo });
      return this.modelInfo;
    } catch (err) {
      this.isLoading = false;
      this.isReady = false;
      this._loadState = 'idle';
      // Detect "unknown model architecture" failures from llama.cpp and surface
      // an actionable message instead of the raw C++ error. Matches messages like:
      //   "unknown model architecture: 'gemma4'"
      //   "unknown architecture 'qwen3'"
      // The bundled llama.cpp build only knows the architectures present at the
      // node-llama-cpp release time. New model families (e.g. gemma4 released
      // after our build) cannot be loaded until the runtime is updated.
      const archMatch = /unknown\s+(?:model\s+)?architecture[:\s]*['"]?([A-Za-z0-9_.-]+)['"]?/i.exec(err.message || '');
      let userMessage = err.message;
      if (archMatch) {
        const arch = archMatch[1];
        userMessage =
          `Model architecture "${arch}" is not supported by the bundled llama.cpp runtime. ` +
          `Update guIDE to a newer release, or rebuild the runtime with ` +
          `'npx -n node-llama-cpp source download --release latest'. ` +
          `(Original error: ${err.message})`;
        console.error(`[ChatEngine] Unsupported architecture detected: ${arch}`);
      }
      this.emit('status', { state: 'error', message: userMessage });
      throw err;
    }
  }

  // Redact passwords/credentials from text before storing in chat history
  _redactCredentials(text) {
    console.log(`[ChatEngine] _redactCredentials: input=${text?.length || 0} chars`);
    if (!text || typeof text !== 'string') return text;
    const redacted = text
      .replace(/(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?([^\s"'`,;}\]]{3,})/gi,
        (m, val) => m.replace(val, '[REDACTED]'))
      .replace(/(?:password|passwd|pwd|secret|token|api[_-]?key)["']\s*:\s*["']([^"']{3,})["']/gi,
        (m, val) => m.replace(val, '[REDACTED]'));
    console.log(`[ChatEngine] _redactCredentials: redacted=${redacted.length} chars`);
    return redacted;
  }

  async chat(userMessage, options = {}) {
    if (this._loadState === 'loading' || this._loadState === 'disposing') {
      throw new Error('Model is loading — please wait a moment and try again.');
    }
    if (!this.isReady || !this._chat) throw new Error('Model not ready');

    const { onToken, onComplete, onContextUsage, onToolCall, onStreamEvent, systemPrompt, functions, toolPrompt, compactToolPrompt, compactToolParts, executeToolFn, guideInstructionsPath } = options;

      // Inject attachment content into user message
      const attachments = Array.isArray(options.attachments) ? options.attachments : [];
      let effectiveUserMessage = String(userMessage ?? '');
      this._recentlyWrittenFiles.clear(); // reset per chat() call
      this._toolRoundCount = 0;
      console.log(`[ChatEngine] ═══ USER MESSAGE ═══ "${String(userMessage)}"`);
      if (attachments.length > 0) {
        console.log(`[ChatEngine] Attachments: ${attachments.length} (${attachments.map(a => `${a.name||'?'} ${a.mimeType||a.type||'?'}`).join(', ')})`);
      }
      console.log(`[ChatEngine] Processing ${attachments.length} attachment(s)`);
      if (attachments.length > 0) {
        const textParts = [];
        for (let ai = 0; ai < attachments.length; ai++) {
          const a = attachments[ai];
          console.log(`[ChatEngine] Attachment #${ai}: name=${a?.name || '?'}, mime=${a?.mimeType || a?.type || '?'}, hasData=${!!a?.data}`);
          if (!a?.data) {
            console.warn(`[ChatEngine] Attachment #${ai} has no data — skipping`);
            continue;
          }
          const mime = (a.mimeType || a.type || '').toLowerCase();
          if (mime.startsWith('image/')) {
            console.log(`[ChatEngine] Attachment #${ai} is image, visionAvailable=${!!this.modelInfo?.visionAvailable}`);
            // Vision captioning: captionImage() handles load-on-demand internally
            // (starts server if needed, captions, then unloads to free VRAM)
            let captioned = false;
            if (this.modelInfo?.visionAvailable) {
              console.log(`[ChatEngine] Calling visionServer.captionImage for attachment #${ai}`);
              try {
                const caption = await visionServer.captionImage(
                  a.data, mime,
                  'Describe this image in detail. List all visible text, UI elements, content, and any information shown.'
                );
                if (caption) {
                  textParts.push(`[VISION ANALYSIS — You have already seen this image via your vision system. This is what you observed:\n${caption}\nEND VISION ANALYSIS]`);
                  console.log(`[ChatEngine] Image attachment #${ai} captioned: ${caption.length} chars`);
                  captioned = true;
                } else {
                  console.warn(`[ChatEngine] visionServer.captionImage returned empty caption for attachment #${ai}`);
                }
              } catch (visionErr) {
                console.error(`[ChatEngine] Vision caption for attachment #${ai} failed: ${visionErr.message}`);
              }
            } else {
              console.warn(`[ChatEngine] Vision not available for attachment #${ai} — skipping caption`);
            }
            if (!captioned) {
              // Vision unavailable — tell the model explicitly that the image cannot be processed.
              // Do NOT inject raw attachment metadata like "[Attached context] filename.png"
              // because the model echoes it verbatim as its response instead of answering the user.
              console.log(`[ChatEngine] Attachment #${ai} not captioned — injecting fallback message`);
              textParts.push(`[Image attachment "${a.name || 'image'}" could not be processed by vision engine. Tell the user you cannot see the image and ask them to describe its contents.]`);
            }
            continue;
          }
          try {
            const decoded = Buffer.from(a.data, 'base64').toString('utf8');
            textParts.push(`[Attached file: ${a.name || 'file'}]\n${decoded}`);
            console.log(`[ChatEngine] Attachment #${ai} decoded as text: ${decoded.length} chars`);
          } catch (e) {
            console.warn(`[ChatEngine] Attachment #${ai} decode failed: ${e.message}`);
          }
        }
        if (textParts.length > 0) {
          effectiveUserMessage = effectiveUserMessage + '\n\n' + textParts.join('\n\n---\n\n');
          console.log(`[ChatEngine] Final effectiveUserMessage length: ${effectiveUserMessage.length} chars`);
        } else {
          console.warn(`[ChatEngine] No text parts produced from ${attachments.length} attachment(s)`);
        }
      }

    // ─── Context Assembly Pipeline (6-layer ordered injection) ───
    // Same architecture as Windsurf Cascade: Rules → Memories → Editor → RAG → Tools → History
    // Each layer is appended in order so the model sees them in priority sequence.
    const contextTokens = this._context?.contextSize || 8192;
    let basePrompt = systemPrompt || SYSTEM_PROMPT;

    // Layer 1: System prompt (identity, behavior rules, tool calling format)
    // (already set above as basePrompt)

    // Thinking: Qwen 3.5 models are reasoning models that emit thinking natively via the
    // chat wrapper segment handling. Do NOT force thinking via prompt instructions - it
    // interferes with the native segment API and can cause premature EOG stops.
    // The raw-text detection in _sfProcessChunk still routes any thinking content to
    // llm-thinking-token events when the model does produce it.

    // Layer 2: Project rules & environment context (date, OS, project path, guide instructions)
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];
    const platform = `${os.type()} ${os.release()} (${os.platform()})`;
    basePrompt += `\n\nCurrent date: ${dateStr}\nCurrent time: ${timeStr}\nOperating system: ${platform}`;
    if (this._projectPath) {
      basePrompt += `\nProject directory: ${this._projectPath}\nAll file tools operate relative to this directory.`;
    }
    // Project instructions file (AGENTS.md / guide rules)
    if (guideInstructionsPath) {
      try {
        const fs = require('fs');
        const instrPath = path.isAbsolute(guideInstructionsPath)
          ? guideInstructionsPath
          : path.join(this._projectPath || process.cwd(), guideInstructionsPath);
        if (fs.existsSync(instrPath)) {
          const guideContent = fs.readFileSync(instrPath, 'utf-8').trim();
          if (guideContent) {
            basePrompt += `\n\n## Project Instructions (from ${guideInstructionsPath})\n${guideContent}`;
          }
        }
      } catch (e) { console.warn('[ChatEngine] Guide instructions load failed:', e.message); }
    }
    // Custom instructions from settings — user-defined behavior overrides
    const customInstructions = options.customInstructions;
    if (customInstructions && customInstructions.trim()) {
      basePrompt += `\n\n## Custom Instructions\n${customInstructions.trim()}`;
    }

    // Layer 3: Editor context (active file, cursor position, recent saves, diagnostics)
    // This is the "real-time action context" layer — model knows what user is doing
    if (this._ctx?.editorContext) {
      const ec = this._ctx.editorContext;
      const parts = [];
      if (ec.activeFilePath) {
        const rel = this._projectPath ? ec.activeFilePath.replace(this._projectPath.replace(/\\/g, '/'), '').replace(/^\//, '') : ec.activeFilePath;
        let ctxLine = `Active file: ${rel}`;
        if (ec.cursorLine) ctxLine += ` (cursor at line ${ec.cursorLine})`;
        parts.push(ctxLine);
      }
      if (ec.recentSaves?.length > 0) {
        const saveNames = ec.recentSaves
          .map(s => this._projectPath ? s.filePath.replace(this._projectPath.replace(/\\/g, '/'), '').replace(/^\//, '') : s.filePath)
          .filter(Boolean);
        if (saveNames.length > 0) parts.push(`Recently saved: ${saveNames.join(', ')}`);
      }
      // Include global diagnostics summary if there are errors
      const diagStore = this._ctx.editorDiagnostics;
      if (diagStore) {
        let totalErrors = 0, totalWarnings = 0, errorFiles = [];
        for (const [fp, d] of Object.entries(diagStore)) {
          if (d.errors > 0) {
            totalErrors += d.errors;
            const rel = this._projectPath ? fp.replace(this._projectPath.replace(/\\/g, '/').toLowerCase(), '').replace(/^\//, '') : fp;
            errorFiles.push(`${rel} (${d.errors} errors)`);
          }
          totalWarnings += d.warnings || 0;
        }
        if (totalErrors > 0) {
          parts.push(`Diagnostics: ${totalErrors} errors in ${errorFiles.slice(0, 5).join(', ')}`);
        }
      }
      if (parts.length > 0) {
        basePrompt += `\n\n## Editor Context\n${parts.join('\n')}`;
      }
    }
    // Mode overrides: inject behavioral instructions before tool prompt
    if (options.planMode) {
      basePrompt += '\n\n## PLAN MODE ACTIVE\nBefore modifying or creating any files, you MUST:\n1. Use read_file, list_directory, grep_search, and git_status to fully understand scope.\n2. Write a complete, numbered implementation plan to a file called "GUIDE_PLAN.md" using write_file.\n3. STOP after writing the plan file. Do NOT modify source files in this turn.\n4. The user will review the plan and say "proceed" when ready for execution.\nIn Plan Mode: read-only tools and write_file (for GUIDE_PLAN.md only) are permitted. Do NOT run commands, modify source code, or install packages.';
      console.log('[ChatEngine] Plan mode — model will write GUIDE_PLAN.md before executing');
    }
    if (options.askOnly) {
      basePrompt += '\n\n## ASK MODE ACTIVE\nYou are in Q&A mode. Answer the user\'s question directly in text. Do NOT call any tools or make any file or system changes.';
      console.log('[ChatEngine] Ask mode — tool prompt suppressed, model responds conversationally');
    }

    // Layer 4: Tool prompt (available tools and their descriptions)
    // Hoist useCompact and effectiveToolPrompt so they're accessible in the
    // generation-space trimming section (line ~1746) regardless of which
    // branch sets them. Without this, ReferenceError when toolPrompt is absent.
    let useCompact = false;
    let effectiveToolPrompt = '';

    if (options.askOnly) {
      // Ask mode: no tools available — just set the base prompt with mode instruction
      this._chatHistory[0].text = basePrompt;
    } else if (toolPrompt) {
      const historyChars = this._chatHistory.slice(1).reduce((sum, m) => sum + (String(m.text || '').length), 0);
      const userMessageChars = effectiveUserMessage.length;
      const budgetResult = buildBudgetProportionalToolPrompt({
        contextTokens,
        basePromptChars: basePrompt.length,
        historyChars,
        userMessageChars,
        toolPrompt,
        compactToolParts,
        compactToolPrompt,
      });
      effectiveToolPrompt = budgetResult.prompt;
      useCompact = budgetResult.mode !== 'full';

      const finalPct = Math.round((budgetResult.usedTokens / contextTokens) * 100);
      const toolPromptTokens = Math.ceil(toolPrompt.length / TOOL_PROMPT_CHARS_PER_TOKEN);
      const toolPct = Math.round((toolPromptTokens / contextTokens) * 100);

      if (toolPct > 50 && onStreamEvent) {
        onStreamEvent('generation-warning', {
          message: `Full tool catalog would use ${toolPct}% of context (${toolPromptTokens.toLocaleString()}/${contextTokens.toLocaleString()} tokens)`,
          suggestion: 'Using budget-proportional tool list. Try a smaller model, reduce context in settings, or start a new session.',
        });
      }

      this._chatHistory[0].text = basePrompt + '\n\n' + effectiveToolPrompt;
      console.log(`[ChatEngine] Tool prompt injected (${effectiveToolPrompt.length} chars, mode=${budgetResult.mode}, budget=${budgetResult.budgetTokens} tok, ctx=${contextTokens}, finalPct=${finalPct}%, parts=${budgetResult.partsUsed ?? 'n/a'})`);
      console.log(`[ChatEngine] Prompt assembly: systemChars=${basePrompt.length}, toolChars=${effectiveToolPrompt.length}, totalSystemChars=${basePrompt.length + effectiveToolPrompt.length}, historyMsgs=${this._chatHistory.length - 1}`);
    } else if (functions && Object.keys(functions).length > 0) {
      this._chatHistory[0].text = basePrompt + this._buildToolPrompt(functions);
      console.log(`[ChatEngine] Functions provided (fallback): ${Object.keys(functions).length} tools`);
    } else if (systemPrompt) {
      this._chatHistory[0].text = systemPrompt;
    } else {
      // No tool prompt, functions, or custom systemPrompt — set basePrompt directly
      this._chatHistory[0].text = basePrompt;
    }

    this._chatHistory.push({ type: 'user', text: effectiveUserMessage });
    console.log(`[ChatEngine] chat() generation START: userMsg=${effectiveUserMessage.length} chars, history=${this._chatHistory.length} msgs`);

    this._abortController = new AbortController();
    let fullResponse = '';
    let tokensSinceLastUsageReport = 0;
    let totalToolCalls = 0;
    const genStartTime = Date.now();
    let genTokenCount = 0;

    try {
      console.log(`[ChatEngine] chat() try block ENTER: abortController=${!!this._abortController}`);
      // â”€â”€ Streaming tool call filter â”€â”€
      // Two-layer suppression of tool call JSON from the UI:
      //
      // Layer 1 (real-time): This filter processes each token character-by-character.
      //   - When `{` appears at a line boundary, buffer it. If `"tool":` appears
      //     within the first 80 chars, keep buffering silently until braces close.
      //   - When ``` appears at a line boundary, enter fence mode. If the fence
      //     content starts with `{` and contains `"tool":`, suppress the entire fence.
      //
      // Layer 2 (post-generation): stripToolCallText() catches anything the
      //   streaming filter missed (e.g., XML <tool_call> tags).
      //
      // Result: tool call JSON never appears in the chat as raw text.

      let _sfBuf = '';           // pending buffer
      let _sfDepth = 0;         // brace depth
      let _sfActive = false;    // inside a potential raw JSON tool call
      let _sfConfirmed = false; // buffer confirmed to contain "tool":
      let _sfInStr = false;     // inside a JSON string
      let _sfEscaped = false;   // previous char was backslash inside string
      let _sfLastCharWasNewlineOrStart = true;

      // Fence tracking: ```json ... ```
      let _sfInFence = false;    // inside a code fence
      let _sfFenceBuf = '';      // accumulated fence content (markers + body)
      let _sfFenceTickCount = 0; // tracks consecutive backticks
      /** When true, fence body is plain markdown code (html, etc.) — stream to UI instead of buffering until ``` */
      let _sfFenceStreamPlain = false;
      let _sfFencePlainTick = 0; // backticks while streaming plain fence (closing ```)

      // Real-time file content streaming state — detects write_file/create_file/append_to_file
      // content fields inside tool call JSON and streams them to the UI as they arrive
      let _sfFileWriteDetected = false;
      let _sfToolCallNotified = false;  // tracks whether tool-generating event was emitted for current fence
      let _sfContentStreamActive = false;
      let _sfContentDone = false;
      let _sfContentEsc = false;
      let _sfContentBuf = '';
      let _sfContentFilePath = '';
      let _sfUnicodeCount = 0;
      let _sfUnicodeChars = '';

      // enableThinkingFilter — when true, suppress thinking tokens from UI output
      const _thinkingFilterEnabled = !!options.enableThinkingFilter;

      // Think-tag tracking for reasoning models.
      // These models output <think>...</think> in raw text (LlamaCompletion mode).
      // Without detection, thinking text gets sent as regular prose to the UI.
      // We track <think> open/close tags and route thinking content to llm-thinking-token events
      // so it appears in thinking blocks instead of as regular prose.
      let _sfInThink = false;       // currently inside <think>...</think>
      let _sfThinkBuf = '';         // buffer for detecting <think> and </think> tags across chunk boundaries
      let _sfThinkTagMatch = '';    // partial match for think tags
      // B4: When the chat wrapper emits thinking via native onResponseChunk segments
      // (Qwen, DeepSeek-R1, etc.), suppress raw-text <think> detection to avoid double-emit.
      // Flag flips true on the first native segment observed in this generation.
      let _sfNativeThinkActive = false;
      let _sfNativeThinkChars = 0; // B03: native thought segment chars (not in fullResponse)
      const _sfStreamedFileWrites = new Set();
      let _sfVisibleChars = 0; // tracks chars forwarded to frontend (after filter removes tool JSON)
      let _sfPostFenceSuppress = false; // Fix 4: suppress hallucinated prose after confirmed tool fence closes
      let _sfFenceInThink = false; // Fix 4: fence that opened inside think mode

      const _sfForward = (text) => {
        _sfVisibleChars += text.length;
        if (onToken) onToken(text);
      };

      const _sfFlush = () => {
        if (_sfContentStreamActive && onStreamEvent) {
          if (_sfContentBuf) {
            onStreamEvent('file-content-token', _sfContentBuf);
            _sfContentBuf = '';
          }
          onStreamEvent('file-content-end', { filePath: _sfContentFilePath, fileKey: _sfContentFilePath });
          _sfContentStreamActive = false;
        } else if (_sfBuf) {
          _sfForward(_sfBuf);
        }
        _sfBuf = '';
        _sfDepth = 0;
        _sfActive = false;
        _sfConfirmed = false;
        _sfInStr = false;
        _sfEscaped = false;
        _sfFileWriteDetected = false;
        _sfToolCallNotified = false;
        _sfContentDone = false;
        _sfContentEsc = false;
        _sfUnicodeCount = 0;
        _sfUnicodeChars = '';
        _sfThinkTagMatch = '';
        _sfInThink = false;     // ensure think-state never bleeds into the next generation
        _sfThinkBuf = '';
        _sfPostFenceSuppress = false; // Fix 4: reset on flush
      };

      const _sfFlushFence = () => {
        if (_sfContentStreamActive && onStreamEvent) {
          if (_sfContentBuf) {
            onStreamEvent('file-content-token', _sfContentBuf);
            _sfContentBuf = '';
          }
          onStreamEvent('file-content-end', { filePath: _sfContentFilePath, fileKey: _sfContentFilePath });
          _sfContentStreamActive = false;
        }
        if (_sfFenceBuf) {
          _sfForward(_sfFenceBuf);
          _sfFenceBuf = '';
        }
        _sfInFence = false;
        _sfFenceStreamPlain = false;
        _sfFencePlainTick = 0;
        _sfFenceTickCount = 0;
        _sfFileWriteDetected = false;
        _sfToolCallNotified = false;
        _sfContentDone = false;
        _sfContentEsc = false;
        _sfUnicodeCount = 0;
        _sfUnicodeChars = '';
        _sfInThink = false;     // ensure think-state never bleeds into the next generation
        _sfThinkBuf = '';
        _sfFenceInThink = false; // Fix 4: fence that opened inside think mode
        _sfPostFenceSuppress = false; // Fix 4: reset on fence flush
      };

      const _sfProcessChunk = (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk[i];

          // Think-tag detection for reasoning models.
          // These models output thinking in raw text (LlamaCompletion mode).
          // We detect these tags and route thinking content to llm-thinking-token events
          // so it appears in thinking blocks instead of as regular prose.
          if (_sfInThink) {
            _sfThinkBuf += ch;
            // Plan A: thinking chars route ONLY to llm-thinking-token events.
            // The previous design dual-emitted to onToken (visible stream), which leaked the
            // </think> bytes as visible text byte-by-byte before the close-tag check fired.
            // Check for close tag </think> first.
            if (_sfThinkBuf.length >= 8 && _sfThinkBuf.endsWith('</think>')) {
              const thinkContent = _sfThinkBuf.slice(0, -8);
              // B4: Suppress raw-text emit if native segment path already handled this content.
              if (thinkContent && onStreamEvent && !_thinkingFilterEnabled && !_sfNativeThinkActive) {
                onStreamEvent('llm-thinking-token', thinkContent);
                onStreamEvent('llm-thinking-end', {
                  position: _sfVisibleChars,
                  length: thinkContent.length,
                  content: thinkContent
                });
              }
              console.log(`[ChatEngine] </think> closed — thinking block: ${(thinkContent || '').length} chars${_sfNativeThinkActive ? ' (raw-text emit suppressed by B4 — native segment active)' : ''}`);
              _sfInThink = false;
              _sfThinkBuf = '';
              continue;
            }
            // Plan I: detect code fence ``` inside think mode.
            // The model may be (a) emitting a tool call without closing think, OR
            // (b) demonstrating thinking tags as examples inside a code fence.
            // For (a): implicit close + route as tool call. For (b): keep thinking open.
            // We defer the decision until the fence closes and we can inspect its content.
            if (_sfThinkBuf.endsWith('\n```') || _sfThinkBuf === '```') {
              const fenceStart = _sfThinkBuf.lastIndexOf('```');
              const thinkBeforeFence = _sfThinkBuf.slice(0, fenceStart).replace(/\n$/, '');
              // Flush any thinking content before the fence
              if (thinkBeforeFence && onStreamEvent && !_thinkingFilterEnabled && !_sfNativeThinkActive) {
                onStreamEvent('llm-thinking-token', thinkBeforeFence);
              }
              console.log('[ChatEngine] code fence inside  thinking — deferring close decision until fence content is known');
              _sfFenceInThink = true;
              _sfThinkBuf = '';
              _sfInFence = true;
              _sfFenceBuf = '```';
              _sfFenceStreamPlain = false;
              _sfFenceTickCount = 0;
              continue;
            }
            // Flush periodically to avoid unbounded buffer.
            // Preserve the last 7 chars (len('</think>')-1) so a close tag
            // that starts near the boundary is never split across two flushes.
            // Threshold lowered from 200 to 32 for responsive thinking-stream UI now that
            // thinking chars route exclusively through llm-thinking-token events.
            if (_sfThinkBuf.length > 32) {
              const CLOSE_TAG_TAIL = 7; // '</think>'.length - 1
              const toEmit = _sfThinkBuf.slice(0, -CLOSE_TAG_TAIL);
              const toKeep = _sfThinkBuf.slice(-CLOSE_TAG_TAIL);
              // B4: Suppress raw-text emit if native segment path already handled this content.
              if (toEmit && onStreamEvent && !_thinkingFilterEnabled && !_sfNativeThinkActive) {
                onStreamEvent('llm-thinking-token', toEmit);
              }
              _sfThinkBuf = toKeep;
            }
            continue;
          }

          // Check for <think> open or </think> close tag — buffer chars so the tag itself isn't forwarded to UI.
          // Plan A: matching </think> in normal mode silently consumes orphan close tags so they don't leak
          // to the visible chat stream when the model emits </think> without a preceding <think>.
          if (_sfThinkTagMatch.length > 0 || ch === '<') {
            _sfThinkTagMatch += ch;
            const OPEN_TAG = '<think>';
            const CLOSE_TAG = '</think>';
            if (_sfThinkTagMatch === OPEN_TAG) {
              _sfThinkTagMatch = '';
              if (_sfNativeThinkActive) {
                console.log('[ChatEngine] <think> open tag consumed (native segments active — tag stripped)');
                continue;
              }
              // Full open match — enter thinking mode, discard the tag
              _sfInThink = true;
              _sfThinkBuf = '';
              if (onStreamEvent && !_thinkingFilterEnabled) {
                onStreamEvent('llm-thinking-start', { position: _sfVisibleChars });
              }
              console.log('[ChatEngine] <think> tag detected — routing to llm-thinking-token (raw text path)');
              continue;
            } else if (_sfThinkTagMatch === CLOSE_TAG) {
              _sfThinkTagMatch = '';
              if (_sfNativeThinkActive) {
                console.log('[ChatEngine] orphan </think> consumed (native segments active — tag stripped, no retroactive move)');
                continue;
              }
              // Orphan close-think tag — model emitted reasoning without open tag (pre-native-segment path).
              console.log('[ChatEngine] orphan </think> consumed — retroactively marking preceding text as thinking');
              if (_sfVisibleChars > 0 && onStreamEvent) {
                onStreamEvent('llm-thinking-retroactive', { length: _sfVisibleChars });
              }
              _sfVisibleChars = 0;
              continue;
            } else if (!OPEN_TAG.startsWith(_sfThinkTagMatch) && !CLOSE_TAG.startsWith(_sfThinkTagMatch)) {
              // Not matching either tag — flush buffered chars to normal processing
              const flush = _sfThinkTagMatch.slice(0, -1);
              _sfThinkTagMatch = '';
              // Re-process flushed chars + current char through normal filter path
              if (flush) _sfProcessChunk(flush);
              // fall through with current ch below
            } else {
              // Partial match for one or both tags — keep buffering
              continue;
            }
          }

          // â”€â”€ Fence mode: accumulating content inside ```...``` â”€â”€
          if (_sfInFence) {
            // Stream normal markdown code fences (```html, ```css, â€¦) to the UI immediately.
            // Only JSON tool-call fences stay buffered until close (so we can strip/suppress).
            if (_sfFenceStreamPlain) {
              if (ch === '`') {
                _sfFencePlainTick++;
                if (_sfFencePlainTick >= 3) {
                  _sfForward('```');
                  _sfInFence = false;
                  _sfFenceStreamPlain = false;
                  _sfFencePlainTick = 0;
                  _sfFenceBuf = '';
                  _sfLastCharWasNewlineOrStart = (ch === '\n' || ch === '\r');
                }
              } else {
                if (_sfFencePlainTick > 0) {
                  _sfForward('`'.repeat(_sfFencePlainTick));
                  _sfFencePlainTick = 0;
                }
                _sfForward(ch);
              }
              continue;
            }

            _sfFenceBuf += ch;

            if (!_sfFenceStreamPlain && !_sfFileWriteDetected && !_sfContentStreamActive && RE_FENCE_HEADER.test(_sfFenceBuf)) {
              const hm = _sfFenceBuf.match(RE_FENCE_HEADER);
              const lang = (hm[1] || '').toLowerCase();
              const afterHeader = _sfFenceBuf.slice(hm[0].length);
              const PLAIN_LANGS = new Set([
                'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'javascript', 'jsx', 'mjs', 'cjs',
                'ts', 'tsx', 'vue', 'svelte', 'md', 'markdown', 'py', 'python', 'bash', 'sh', 'shell',
                'yaml', 'yml', 'xml', 'svg', 'go', 'rust', 'rs', 'java', 'cpp', 'c', 'h', 'cs', 'php',
                'rb', 'swift', 'kt', 'txt', 'plaintext', 'sql', 'jsonl',
              ]);
              if (PLAIN_LANGS.has(lang)) {
                _sfFenceStreamPlain = true;
                _sfForward(_sfFenceBuf);
                _sfFenceBuf = '';
                continue;
              }
              if (lang === 'json' || lang === '') {
                if (RE_TOOL_KEY.test(afterHeader.slice(0, 6000))) {
                  /* keep buffering â€” tool JSON fence */
                } else if (afterHeader.length >= 100) {
                  _sfFenceStreamPlain = true;
                  _sfForward(_sfFenceBuf);
                  _sfFenceBuf = '';
                  continue;
                }
              }
            }

            // Real-time content streaming from WITHIN a fenced tool call.
            // Uses the same shared state variables as the raw JSON path.
            if (_sfContentStreamActive) {
              if (_sfUnicodeCount > 0) {
                _sfUnicodeChars += ch;
                _sfUnicodeCount--;
                if (_sfUnicodeCount === 0) {
                  try { _sfContentBuf += String.fromCharCode(parseInt(_sfUnicodeChars, 16)); }
                  catch { _sfContentBuf += '\\u' + _sfUnicodeChars; }
                }
              } else if (_sfContentEsc) {
                let decoded;
                switch (ch) {
                  case 'n': decoded = '\n'; break;
                  case 't': decoded = '\t'; break;
                  case 'r': decoded = '\r'; break;
                  case '"': decoded = '"'; break;
                  case '\\': decoded = '\\'; break;
                  case '/': decoded = '/'; break;
                  case 'b': decoded = '\b'; break;
                  case 'f': decoded = '\f'; break;
                  case 'u': _sfUnicodeCount = 4; _sfUnicodeChars = ''; decoded = null; break;
                  default: decoded = ch;
                }
                _sfContentEsc = false;
                if (decoded !== null) _sfContentBuf += decoded;
              } else if (ch === '\\') {
                _sfContentEsc = true;
              } else if (ch === '"') {
                _sfContentStreamActive = false;
                _sfContentDone = true;
                if (_sfContentBuf && onStreamEvent) {
                  onStreamEvent('file-content-token', _sfContentBuf);
                  _sfContentBuf = '';
                }
                if (onStreamEvent) {
                  onStreamEvent('file-content-end', { filePath: _sfContentFilePath, fileKey: _sfContentFilePath });
                }
              } else {
                _sfContentBuf += ch;
              }
              if (_sfContentStreamActive && _sfContentBuf.length >= 40) {
                if (onStreamEvent) {
                  onStreamEvent('file-content-token', _sfContentBuf);
                  _sfContentBuf = '';
                }
              }
            } else if (_sfFileWriteDetected && !_sfContentDone) {
              if (ch === '"' && RE_CONTENT_START.test(_sfFenceBuf)) {
                _sfContentStreamActive = true;
                const fpMatch = _sfFenceBuf.match(RE_FILE_PATH);
                _sfContentFilePath = fpMatch ? fpMatch[1] : '';
                const fileName = _sfContentFilePath.split(/[\\/]/).pop() || _sfContentFilePath;
                const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
                if (onStreamEvent) {
                  onStreamEvent('file-content-start', { filePath: _sfContentFilePath, fileName, language: ext, fileKey: _sfContentFilePath });
                }
                _sfStreamedFileWrites.add(_sfContentFilePath);
              }
            }
            // Emit tool-generating for ANY tool call inside a fence (not just file-write)
            if (!_sfToolCallNotified && _sfFenceBuf.length > 30) {
              if (RE_TOOL_KEY.test(_sfFenceBuf) || (RE_NAME_KEY.test(_sfFenceBuf) && RE_PARAMS_KEY.test(_sfFenceBuf))) {
                _sfToolCallNotified = true;
                if (onStreamEvent) {
                  const toolNameMatch = _sfFenceBuf.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/);
                  onStreamEvent('tool-generating', { tool: toolNameMatch ? toolNameMatch[1] : 'unknown' });
                }
              }
            }
            // File-write detection is separate — only for content streaming
            if (!_sfFileWriteDetected && _sfFenceBuf.length > 30) {
              if (RE_FILE_WRITE_TOOLS.test(_sfFenceBuf) &&
                  (RE_TOOL_KEY.test(_sfFenceBuf) || RE_NAME_KEY.test(_sfFenceBuf))) {
                _sfFileWriteDetected = true;
              }
            }

            // Detect closing ``` — but NOT while inside the content string
            if (_sfContentStreamActive || _sfContentEsc || _sfUnicodeCount > 0) {
              _sfFenceTickCount = 0;
            } else if (ch === '`') {
              _sfFenceTickCount++;
            } else {
              _sfFenceTickCount = 0;
            }

            if (_sfFenceTickCount >= 3) {
              // Closing fence found — flush any pending content
              if (_sfContentStreamActive && onStreamEvent) {
                if (_sfContentBuf) {
                  onStreamEvent('file-content-token', _sfContentBuf);
                  _sfContentBuf = '';
                }
                onStreamEvent('file-content-end', { filePath: _sfContentFilePath, fileKey: _sfContentFilePath });
                _sfContentStreamActive = false;
              }
              // Fix 4: If this fence opened inside a thinking block, decide based on content.
              if (_sfFenceInThink) {
                _sfFenceInThink = false;
                const isToolFence = RE_TOOL_KEY.test(_sfFenceBuf) || (RE_NAME_KEY.test(_sfFenceBuf) && RE_PARAMS_KEY.test(_sfFenceBuf));
                if (isToolFence) {
                  // Case (a): tool call inside think — implicit close, route as tool call
                  console.log('[ChatEngine] fence-in-think: tool call detected — implicit think close');
                  if (_sfThinkBuf && onStreamEvent && !_thinkingFilterEnabled && !_sfNativeThinkActive) {
                    onStreamEvent('llm-thinking-token', _sfThinkBuf);
                    onStreamEvent('llm-thinking-end', { position: _sfVisibleChars, length: _sfThinkBuf.length, content: _sfThinkBuf });
                  }
                  _sfInThink = false;
                  _sfThinkBuf = '';
                  _sfFenceBuf = '';
                  _sfPostFenceSuppress = true;
                } else {
                  // Case (b): prose fence inside think — emit as thinking content, stay in think
                  console.log('[ChatEngine] fence-in-think: non-tool fence — emitting as thinking content');
                  if (onStreamEvent && !_thinkingFilterEnabled && !_sfNativeThinkActive) {
                    onStreamEvent('llm-thinking-token', _sfFenceBuf);
                  }
                  _sfFenceBuf = '';
                  // Stay in think mode — _sfInThink remains true
                }
              } else {
                // Normal fence close (not inside think)
                if (RE_TOOL_KEY.test(_sfFenceBuf) || (RE_NAME_KEY.test(_sfFenceBuf) && RE_PARAMS_KEY.test(_sfFenceBuf))) {
                  _sfFenceBuf = '';
                  _sfPostFenceSuppress = true;
                } else {
                  _sfFlushFence();
                }
              }
              _sfInFence = false;
              _sfFileWriteDetected = false;
              _sfToolCallNotified = false;
              _sfContentDone = false;
              _sfContentEsc = false;
              _sfLastCharWasNewlineOrStart = (ch === '\n' || ch === '\r');
              continue;
            }
            continue;
          }

          // ── Normal mode ──
          if (!_sfActive) {
            // Fix 4: Post-fence suppression — after a confirmed tool fence closes,
            // suppress hallucinated prose until a new fence or raw JSON opens.
            // This preserves multi-tool sequences (multiple tool calls per generation)
            // while hiding the model's "Please wait..." / "I'll now..." filler text.
            if (_sfPostFenceSuppress) {
              // Check for new fence opening (multi-tool continuation)
              if (ch === '`' && _sfLastCharWasNewlineOrStart) {
                _sfFenceTickCount++;
                if (_sfFenceTickCount >= 3) {
                  // New tool fence — stop suppressing, enter fence mode
                  _sfPostFenceSuppress = false;
                  _sfInFence = true;
                  _sfFenceBuf = '```';
                  _sfFenceTickCount = 0;
                  _sfFenceStreamPlain = false;
                  _sfFencePlainTick = 0;
                  _sfLastCharWasNewlineOrStart = false;
                  continue;
                }
                continue; // keep buffering backticks
              }
              if (_sfFenceTickCount > 0 && ch !== '`') {
                // Not enough backticks for a fence — this is suppressed prose
                _sfFenceTickCount = 0;
              }
              // Check for raw JSON tool call opening (multi-tool continuation)
              if (ch === '{' && _sfLastCharWasNewlineOrStart) {
                _sfPostFenceSuppress = false;
                _sfActive = true;
                _sfBuf = '{';
                _sfDepth = 1;
                _sfConfirmed = false;
                _sfInStr = false;
                _sfEscaped = false;
                _sfLastCharWasNewlineOrStart = false;
                continue;
              }
              // Suppress this character (hallucinated prose after tool fence)
              _sfLastCharWasNewlineOrStart = (ch === '\n' || ch === '\r');
              if (ch === ' ' || ch === '\t') { /* keep the flag */ }
              else if (ch !== '\n' && ch !== '\r') _sfLastCharWasNewlineOrStart = false;
              continue;
            }

            // Detect opening ``` at line start
            if (ch === '`' && _sfLastCharWasNewlineOrStart) {
              _sfFenceTickCount++;
              if (_sfFenceTickCount >= 3) {
                _sfInFence = true;
                _sfFenceBuf = '```';
                _sfFenceTickCount = 0;
                _sfFenceStreamPlain = false;
                _sfFencePlainTick = 0;
                _sfLastCharWasNewlineOrStart = false;
                continue;
              }
              continue;
            }
            // If we had 1-2 backticks but not 3, flush them
            if (_sfFenceTickCount > 0 && ch !== '`') {
              _sfForward('`'.repeat(_sfFenceTickCount));
              _sfFenceTickCount = 0;
            }

            // Look for `{` at line start (or after only whitespace on the line)
            if (ch === '{' && _sfLastCharWasNewlineOrStart) {
              _sfActive = true;
              _sfBuf = '{';
              _sfDepth = 1;
              _sfConfirmed = false;
              _sfInStr = false;
              _sfEscaped = false;
              _sfLastCharWasNewlineOrStart = false;
              continue;
            }
            _sfLastCharWasNewlineOrStart = (ch === '\n' || ch === '\r');
            if (ch === ' ' || ch === '\t') { /* keep the flag */ }
            else if (ch !== '\n' && ch !== '\r') _sfLastCharWasNewlineOrStart = false;
            _sfForward(ch);
            continue;
          }

          // â”€â”€ Inside a potential raw JSON tool call â”€â”€
          _sfBuf += ch;

          // â”€â”€ Real-time file content streaming â”€â”€
          // When inside a confirmed file-write tool call, intercept the "content"
          // field value and stream decoded characters to file-content-token events.
          if (_sfContentStreamActive) {
            if (_sfUnicodeCount > 0) {
              _sfUnicodeChars += ch;
              _sfUnicodeCount--;
              if (_sfUnicodeCount === 0) {
                try { _sfContentBuf += String.fromCharCode(parseInt(_sfUnicodeChars, 16)); }
                catch { _sfContentBuf += '\\u' + _sfUnicodeChars; }
              }
            } else if (_sfContentEsc) {
              let decoded;
              switch (ch) {
                case 'n': decoded = '\n'; break;
                case 't': decoded = '\t'; break;
                case 'r': decoded = '\r'; break;
                case '"': decoded = '"'; break;
                case '\\': decoded = '\\'; break;
                case '/': decoded = '/'; break;
                case 'b': decoded = '\b'; break;
                case 'f': decoded = '\f'; break;
                case 'u': _sfUnicodeCount = 4; _sfUnicodeChars = ''; decoded = null; break;
                default: decoded = ch;
              }
              _sfContentEsc = false;
              if (decoded !== null) _sfContentBuf += decoded;
            } else if (ch === '\\') {
              _sfContentEsc = true;
            } else if (ch === '"') {
              _sfContentStreamActive = false;
              _sfContentDone = true;
              if (_sfContentBuf && onStreamEvent) {
                onStreamEvent('file-content-token', _sfContentBuf);
                _sfContentBuf = '';
              }
              if (onStreamEvent) {
                onStreamEvent('file-content-end', { filePath: _sfContentFilePath, fileKey: _sfContentFilePath });
              }
            } else {
              _sfContentBuf += ch;
            }
            if (_sfContentStreamActive && _sfContentBuf.length >= 40) {
              if (onStreamEvent) {
                onStreamEvent('file-content-token', _sfContentBuf);
                _sfContentBuf = '';
              }
            }
          } else if (_sfConfirmed && _sfFileWriteDetected && !_sfContentDone) {
            if (ch === '"' && RE_CONTENT_START.test(_sfBuf)) {
              _sfContentStreamActive = true;
              const fpMatch = _sfBuf.match(RE_FILE_PATH);
              _sfContentFilePath = fpMatch ? fpMatch[1] : '';
              const fileName = _sfContentFilePath.split(/[\\/]/).pop() || _sfContentFilePath;
              const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
              if (onStreamEvent) {
                onStreamEvent('file-content-start', { filePath: _sfContentFilePath, fileName, language: ext, fileKey: _sfContentFilePath });
              }
              _sfStreamedFileWrites.add(_sfContentFilePath);
            }
          }
          if (_sfConfirmed && !_sfFileWriteDetected && _sfBuf.length > 15) {
            if (RE_FILE_WRITE_TOOLS.test(_sfBuf)) {
              _sfFileWriteDetected = true;
            }
          }

          if (_sfEscaped) { _sfEscaped = false; continue; }
          if (ch === '\\' && _sfInStr) { _sfEscaped = true; continue; }
          if (ch === '"') { _sfInStr = !_sfInStr; continue; }
          if (_sfInStr) continue;

          if (ch === '{') _sfDepth++;
          else if (ch === '}') _sfDepth--;

          if (!_sfConfirmed && _sfBuf.length <= 80) {
            if (RE_TOOL_KEY.test(_sfBuf) || RE_NAME_KEY.test(_sfBuf)) {
              _sfConfirmed = true;
              // Notify UI that a tool call is being generated (so it's not blank)
              if (onStreamEvent) {
                const toolNameMatch = _sfBuf.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/);
                onStreamEvent('tool-generating', { tool: toolNameMatch ? toolNameMatch[1] : 'unknown' });
              }
            }
          }

          if (!_sfConfirmed && _sfBuf.length > 80) {
            _sfFlush();
            _sfLastCharWasNewlineOrStart = false;
            continue;
          }

          if (_sfDepth === 0) {
            if (_sfConfirmed) {
              if (_sfContentBuf && _sfContentStreamActive && onStreamEvent) {
                onStreamEvent('file-content-token', _sfContentBuf);
                _sfContentBuf = '';
              }
              _sfBuf = '';
              _sfPostFenceSuppress = true; // Fix 4: suppress hallucinated prose after raw JSON tool call too
            } else {
              // Unconfirmed buffer reached depth 0 — flush as normal prose
              _sfFlush();
            }
            _sfActive = false;
            _sfConfirmed = false;
            _sfFileWriteDetected = false;
            _sfContentDone = false;
            _sfLastCharWasNewlineOrStart = false;
          }
        }
      };

      // Build common generation options
      // S5: reasoningEffort maps to thinkingBudget when thinkingBudget is 0 (auto)
      // Fix 7: Respect profile thinkTokens mode — 'none' disables thinking, 'budget' provides default
      const profileThinkMode = this._modelProfile?.thinkTokens?.mode;
      const profileThinkBudget = this._modelProfile?.thinkTokens?.budget;
      let thinkBudget = options.thinkingBudget;
      const reasoningEffort = options.reasoningEffort;
      // No thought budget on models that don't support thinking (template + profile gate at load)
      if (!this._thinkingCapable || profileThinkMode === 'none') {
        thinkBudget = 0;
      } else if ((!thinkBudget || thinkBudget === 0) && profileThinkMode === 'budget' && profileThinkBudget) {
        // Use profile's budget as default when user hasn't set one
        thinkBudget = profileThinkBudget;
      }
      if ((!thinkBudget || thinkBudget === 0) && reasoningEffort && profileThinkMode !== 'none') {
        if (reasoningEffort === 'low') thinkBudget = 512;
        else if (reasoningEffort === 'medium') thinkBudget = 2048;
        else if (reasoningEffort === 'high') thinkBudget = 8192;
      }
      // Fix C: Adaptive sampling — when thinking is NOT active (budget=0 or mode=none),
      // use samplingInstruct profile if the model family provides one. This ensures
      // Qwen models get presencePenalty=1.5 in instruct mode (preventing loops) and
      // presencePenalty=0 in thinking mode (per official vendor recommendations).
      const _thinkingActive = thinkBudget > 0 && profileThinkMode !== 'none';
      const _samplingProfile = (!_thinkingActive && this._modelProfile?.samplingInstruct)
        ? this._modelProfile.samplingInstruct
        : this._modelProfile?.sampling;
      const genOptions = {
        signal: this._abortController.signal,
        stopOnAbortSignal: true,
        // P3 + Fix C: Per-family/tier sampling defaults from modelProfiles.js. Caller's options override.
        // When thinking is off, samplingInstruct is used (if defined) for instruct-mode settings.
        temperature: options.temperature ?? _samplingProfile?.temperature ?? 0.4,
        topP: options.topP ?? _samplingProfile?.topP,
        topK: options.topK ?? _samplingProfile?.topK,
        repeatPenalty: {
          penalty: options.repeatPenalty ?? _samplingProfile?.repeatPenalty ?? 1.1,
          frequencyPenalty: options.frequencyPenalty ?? _samplingProfile?.frequencyPenalty ?? 0,
          presencePenalty: options.presencePenalty ?? _samplingProfile?.presencePenalty ?? 0,
          lastTokens: _samplingProfile?.lastTokensPenaltyCount ?? 128,
        },
        seed: options.seed ?? undefined,
        contextShift: { strategy: this._contextShiftStrategy.bind(this) },
        onTextChunk: (chunk) => {
          fullResponse += chunk;
          _sfProcessChunk(chunk);
          tokensSinceLastUsageReport++;
          genTokenCount++;
          if (onContextUsage && tokensSinceLastUsageReport >= 50) {
            tokensSinceLastUsageReport = 0;
            const used = this._sequence.nextTokenIndex;
            const total = this._context.contextSize;
            onContextUsage({ used, total });
          }
        },
        onResponseChunk: (chunk) => {
          if (_thinkingFilterEnabled) return;
          if (chunk.type !== 'segment') return;

          const text = chunk.text || '';
          if (chunk.segmentType === 'thought') {
            _sfNativeThinkActive = true;
            if (text) _sfNativeThinkChars += text.length;
            if (chunk.segmentStartTime && onStreamEvent) {
              onStreamEvent('llm-thinking-start', { position: _sfVisibleChars });
            }
            if (text && onStreamEvent) {
              onStreamEvent('llm-thinking-token', text);
            }
            if (chunk.segmentEndTime && onStreamEvent) {
              onStreamEvent('llm-thinking-end', {
                position: _sfVisibleChars,
                length: 0,
                content: '',
              });
            }
            if (!this._nativeThinkLogged) {
              this._nativeThinkLogged = true;
              console.log('[ChatEngine] ✓ B4: Native onResponseChunk thought segments active — raw-text <think> emission suppressed for this generation');
            }
            return;
          }

          if (text) {
            fullResponse += text;
            _sfProcessChunk(text);
          }
        },
      };
      this._nativeThinkLogged = false; // reset per generation

      // Thinking budget: -1 = unlimited, 0 = auto (node-llama-cpp default), >0 = exact cap
      if (thinkBudget != null && thinkBudget !== 0) {
        genOptions.budgets = {
          thoughtTokens: thinkBudget === -1 ? Infinity : thinkBudget,
        };
        console.log(`[ChatEngine] Thinking budget: ${thinkBudget === -1 ? 'unlimited' : thinkBudget + ' tokens'}`);
      } else {
        console.log('[ChatEngine] Thinking budget: 0 (auto) — native thinking NOT explicitly enabled');
      }

      // Grammar-constrained generation: when enableGrammar is true, use
      // node-llama-cpp's LlamaJsonSchemaGrammar to force valid JSON tool calls.
      // Disabled by default — small models may loop or hang with grammar constraints.
      // User has total control via settings toggle.
      if (options.enableGrammar && functions && Object.keys(functions).length > 0) {
        try {
          const llamaCppPath = this._getNodeLlamaCppPath();
          const { LlamaJsonSchemaGrammar } = await import(pathToFileURL(llamaCppPath).href);
          const schema = {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: Object.keys(functions) },
              params: { type: 'object' },
            },
            required: ['tool', 'params'],
          };
          genOptions.grammar = new LlamaJsonSchemaGrammar(this._llama, schema);
          console.log('[ChatEngine] Grammar-constrained generation enabled — tool calls forced to valid JSON schema');
        } catch (grammarErr) {
          console.warn(`[ChatEngine] Grammar setup failed (node-llama-cpp may not support it): ${grammarErr.message}`);
        }
      }

      // Add lastEvaluation context window if available
      if (this._lastEvaluation) {
        genOptions.lastEvaluationContextWindow = {
          contextWindow: this._lastEvaluation.contextWindow,
          contextShiftMetadata: this._lastEvaluation.contextShiftMetadata,
        };
      }

      // ─── Minimum generation token reservation ───
      // ROOT CAUSE of "model says I'll check then hits EOS": the prompt consumes
      // the entire context window, leaving zero tokens for generation. The model
      // can't output tool call JSON because there's literally no room.
      // Fix: ensure at least MIN_GENERATION_TOKENS of generation space remain.
      // If not enough space, progressively trim the prompt BEFORE generation.
      const MIN_GENERATION_TOKENS = 512;
      const contextSize = this._context.contextSize;
      const usedTokens = this._sequence.nextTokenIndex;
      const availableForGeneration = contextSize - usedTokens;

      if (availableForGeneration < MIN_GENERATION_TOKENS) {
        console.warn(`[ChatEngine] ⚠ GENERATION SPACE CRITICAL: ${availableForGeneration}/${contextSize} tokens available, need ${MIN_GENERATION_TOKENS}. Trimming prompt.`);
        console.warn(`[ChatEngine]   ctx state: usedTokens=${usedTokens}, contextSize=${contextSize}, chatHistory=${this._chatHistory.length} msgs`);

        // Progressive trimming: try compact prompt first, then trim compact, then trim history
        if (compactToolPrompt && !useCompact) {
          // Step 1: Switch to compact prompt
          const compactTokens = Math.ceil(compactToolPrompt.length / 3.5);
          const savedTokens = Math.ceil(effectiveToolPrompt.length / 3.5) - compactTokens;
          if (savedTokens > 0) {
            effectiveToolPrompt = compactToolPrompt;
            this._chatHistory[0].text = basePrompt + '\n\n' + effectiveToolPrompt;
            console.log(`[ChatEngine] Switched to compact prompt, saved ~${savedTokens} tokens`);
          }
        }

        // Step 2: If still too large, trim compact prompt aggressively
        if (typeof effectiveToolPrompt === 'string' && effectiveToolPrompt.length > 500) {
          const lines = effectiveToolPrompt.split('\n');
          const toolLineIdx = [];
          lines.forEach((l, i) => { if (l.startsWith('- **')) toolLineIdx.push(i); });
          // Keep only first 4 tool descriptions + header
          if (toolLineIdx.length > 4) {
            effectiveToolPrompt = lines.slice(0, toolLineIdx[4]).join('\n') + '\n…and more tools available\n';
            this._chatHistory[0].text = basePrompt + '\n\n' + effectiveToolPrompt;
            console.log(`[ChatEngine] Trimmed tool prompt to 4 tools (${effectiveToolPrompt.length} chars)`);
          }
        }

        // Step 3: If STILL not enough, trim conversation history from the middle
        const recheckAvailable = contextSize - this._sequence.nextTokenIndex;
        if (recheckAvailable < MIN_GENERATION_TOKENS && this._chatHistory.length > 4) {
          // Remove oldest exchanges (keep system prompt + last user message)
          const systemMsg = this._chatHistory[0];
          const lastUserMsg = this._chatHistory[this._chatHistory.length - 1];
          const recentMsgs = this._chatHistory.slice(Math.max(1, this._chatHistory.length - 4));
          this._chatHistory.length = 0;
          this._chatHistory.push(systemMsg, ...recentMsgs);
          // Ensure last message is still the user message
          if (this._chatHistory[this._chatHistory.length - 1] !== lastUserMsg) {
            this._chatHistory.push(lastUserMsg);
          }
          console.log(`[ChatEngine] Trimmed history to ${this._chatHistory.length} messages for generation space`);
        }
      }

      // Set maxTokens to guarantee generation space (node-llama-cpp will use remaining context)
      // This ensures the model always has room to output tool calls
      // S4: Respect user-set maxResponseTokens (passed as options.maxTokens) as a cap
      const userMaxTokens = (options.maxTokens > 0) ? options.maxTokens : Infinity;
      genOptions.maxTokens = Math.max(MIN_GENERATION_TOKENS, Math.min(availableForGeneration, userMaxTokens));
      // Log generation setup for diagnostics
      console.log(`[ChatEngine] Generation setup: maxTokens=${genOptions.maxTokens}, contextSize=${contextSize}, usedTokens=${usedTokens}, available=${availableForGeneration}, chatHistory=${this._chatHistory.length} msgs, temperature=${genOptions.temperature}`);

      // Generate response — model outputs text which may contain tool call JSON blocks
      const roundStartTime = Date.now();
      const ctxUsedBefore = this._sequence?.nextTokenIndex || 0;
      console.log(`[ChatEngine] Calling generateResponse #1: history=${this._chatHistory.length} msgs, ctxUsedBefore=${ctxUsedBefore}`);

      let result = await this._chat.generateResponse(this._chatHistory, genOptions);
      console.log(`[ChatEngine] generateResponse #1 returned`);
      const roundElapsed = (Date.now() - roundStartTime) / 1000;
      const roundTokens = result.metadata?.totalTokens ?? result.response?.length ?? 0;
      const roundTokPerSec = roundElapsed > 0 ? (roundTokens / roundElapsed).toFixed(1) : '?';
      const ctxUsedAfter = this._sequence?.nextTokenIndex || 0;
      const currentGpuLayers = this._model?.gpuLayers ?? '?';
      console.log(`[ChatEngine] generateResponse returned: stopReason=${result.metadata?.stopReason}, tokens=${roundTokens}, time=${roundElapsed.toFixed(1)}s, tok/s=${roundTokPerSec}, ctxUsed=${ctxUsedAfter}/${contextSize}, gpuLayers=${currentGpuLayers}`);
      // EOG DIAGNOSTIC: When stopReason is eogToken, log detailed context for root cause analysis.
      // Token count is read from `roundTokens` (computed above) which already falls back across
      // metadata.totalTokens / response.length. The previous version read `eogMeta.totalTokens`
      // which is undefined in this metadata shape, so every diagnostic printed "?" and 0.0%.
      if (result.metadata?.stopReason === 'eogToken') {
        const eogMeta = result.metadata || {};
        const respText = result.response || '';
        const lastChars = respText.length > 80 ? respText.slice(-80) : respText;
        const trimmedTail = respText.trim();
        const ctxPct = ((ctxUsedAfter / contextSize) * 100).toFixed(1);
        const genPct = (((roundTokens || 0) / (genOptions.maxTokens || 1)) * 100).toFixed(1);
        const truncatedMidWord = /\w$/.test(trimmedTail);
        // Diagnostic-only signal — never used to drive retries or any auto-recovery.
        // "Mid-word" = response ended with a letter/digit (not punctuation/whitespace),
        // which usually indicates the stop token fired before the model finished a word.
        console.warn(`[ChatEngine] EOG DIAGNOSTIC ── stopReason=eogToken`);
        console.warn(`  tokens generated: ${roundTokens}, maxTokens budget: ${genOptions.maxTokens}, used ${genPct}%`);
        console.warn(`  context: ${ctxUsedAfter}/${contextSize} (${ctxPct}%), gpuLayers=${currentGpuLayers}`);
        console.warn(`  last 80 chars of response: "${lastChars}"`);
        console.warn(`  response truncated mid-word: ${truncatedMidWord}`);
        console.warn(`  stopGenerationTriggers: ${JSON.stringify(eogMeta.stopGenerationTriggers || 'N/A')}`);
        console.warn(`  full metadata keys: ${Object.keys(eogMeta).join(', ')}`);
        // Log the chat wrapper name so we know which wrapper is active
        console.warn(`  chatWrapper: ${this._chat?.chatWrapper?.wrapperName ?? 'unknown'}`);
      }
      // Log thinking/reasoning tags separately for debugging model decision-making
      const _rawResp = result.response || '';
      const _thinkMatch = _rawResp.match(/<think>([\s\S]*?)<\/think>/) || _rawResp.match(/<reasoning>([\s\S]*?)<\/reasoning>/) || _rawResp.match(/<reflection>([\s\S]*?)<\/reflection>/);
      if (_thinkMatch) {
        console.log(`[ChatEngine] ─── MODEL THINKING ─── "${_thinkMatch[1]}"`);
      }
      console.log(`[ChatEngine] ─── MODEL RESPONSE ─── "${_rawResp}"`);

      const _genStopReason = result.metadata?.stopReason;
      const _userAbortedGeneration = _genStopReason === 'abort' || _genStopReason === 'cancelled';

      // Raw-text tool call loop: parse tool calls from model output, execute, continue
      if (executeToolFn && !_userAbortedGeneration) {
        // Flush any buffered content from the streaming filter before parsing
        _sfFlush();
        _sfFlushFence();

        let roundStart = 0;
        let parsedCalls = []; // Hoisted to function scope for refusal correction access
        parsedCalls = parseToolCalls(fullResponse);
        console.log(`[ChatEngine] Tool parse: found ${parsedCalls.length} tool call(s) in ${fullResponse.length} chars of model output`);
        // When 0 calls found, log response preview for diagnostics
        if (parsedCalls.length === 0 && fullResponse.length > 20) {
          console.warn(`[ChatEngine] ⚠ 0 tool calls parsed — model output preview: "${fullResponse.replace(/\n/g, '\\n')}"`);
        }
        if (parsedCalls.length > 0) {
          const { repaired, issues } = repairToolCalls(parsedCalls, fullResponse);
          if (repaired.length === 0 && issues.length > 0) {
            console.warn(`[ChatEngine] All ${parsedCalls.length} tool call(s) failed validation — feeding errors back to model`);
            this._chatHistory.push({
              type: 'user',
              text: `[System: Tool Validation Failed]\n${issues.join('\n')}\n\nRetry with valid tool parameters.`,
            });
          }
          parsedCalls = filterWebWorkspaceToolConflict(repaired);
          console.log(`[ChatEngine] Tool calls after repair/filter: ${parsedCalls.length} — [${parsedCalls.map(c => c.tool).join(', ')}]`);
        }

        // Safety net: if the streaming filter missed any tool JSON (e.g., fenced blocks),
        // strip it from the UI now via llm-replace-last.
        // CRITICAL: use _sfVisibleChars (chars actually sent to frontend) not fullResponse.length.
        // fullResponse includes suppressed tool JSON that the frontend never received.
        // Using fullResponse.length causes keepLen=0 in the frontend, destroying ALL previous prose.
        if (parsedCalls.length > 0 && onStreamEvent) {
          const cleanText = stripToolCallText(fullResponse);
          if (cleanText.length < _sfVisibleChars) {
            onStreamEvent('llm-replace-last', { originalLength: _sfVisibleChars, replacement: cleanText });
          }
        }

        // Hoisted outside while loop — avoids reallocating a new Set on every tool-call iteration
        const FILE_MODIFY_OPS_SET = new Set(['write_file', 'create_file', 'append_to_file', 'edit_file', 'replace_in_file']);
        const FILE_WRITE_OPS = new Set(['write_file', 'create_file', 'append_to_file']);

        // Ask mode: discard any tool calls — model should only be responding conversationally
        if (options.askOnly && parsedCalls.length > 0) {
          console.log(`[ChatEngine] Ask mode — discarding ${parsedCalls.length} tool call(s) from model output`);
          parsedCalls = [];
        }

        console.log(`[ChatEngine] Tool loop ENTER: ${parsedCalls.length} parsed call(s)`);
        while (parsedCalls.length > 0) {
          const sessionAtStart = this._sessionId;
          console.log(`[ChatEngine] Tool loop ITERATION: ${parsedCalls.length} call(s), sessionId=${sessionAtStart}`);
          // Notify UI so ToolCallCards appear for each tool call (spinner state)
          if (onStreamEvent) {
            onStreamEvent('tool-executing', parsedCalls.map(c => ({ tool: c.tool, params: c.params })));
          }

          const toolResultLines = [];
          // fileReadResults drives the structural "related files" injection below —
          // when the model reads a source file, we follow its imports so it can see
          // the dependencies without having to issue extra read_file calls. This is
          // a content channel, not a guard clause.
          const fileReadResults = []; // { filePath, content }

          for (const call of parsedCalls) {
            console.log(`[ChatEngine] Tool loop processing: ${call.tool}`);
            // No iteration cap — context window naturally bounds the loop
            totalToolCalls++;

            console.log(`[ChatEngine] Tool call #${totalToolCalls}: ${call.tool}(${JSON.stringify(call.params)})`);
            const _toolExecStart = Date.now();

            // Diagnostic: log browser click details to trace repeated-click loops
            if (call.tool === 'browser_click') {
              const refVal = call.params.elementRef || call.params.elementId || call.params.ref || call.params.selector || call.params.id || '?';
              console.log(`[ChatEngine] browser_click detail: ref=${refVal}, text="${call.params.text || ''}"`);
            }

            // Emit file-content events for file write operations so the UI
            // can show a FileContentBlock with syntax highlighting
            if (FILE_WRITE_OPS.has(call.tool) && call.params?.content && onStreamEvent) {
              const filePath = call.params.filePath || call.params.path || '';
              if (!_sfStreamedFileWrites.has(filePath)) {
                const fileName = filePath.split(/[\\/]/).pop() || filePath;
                const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
                onStreamEvent('file-content-start', { filePath, fileName, language: ext, fileKey: filePath });
                onStreamEvent('file-content-token', call.params.content);
                onStreamEvent('file-content-end', { filePath, fileKey: filePath });
              }
            }

            let toolResult;
            console.log(`[ChatEngine] Executing toolFn: ${call.tool}`);
            try {
              toolResult = await executeToolFn(call.tool, call.params);
              console.log(`[ChatEngine] ToolFn ${call.tool} succeeded`);
            } catch (toolErr) {
              console.error(`[ChatEngine] ToolFn ${call.tool} threw: ${toolErr.message}`);
              toolResult = { success: false, error: toolErr.message };
            }
            const _toolExecMs = Date.now() - _toolExecStart;
            console.log(`[ChatEngine] Tool #${totalToolCalls} ${call.tool} executed in ${_toolExecMs}ms, success=${toolResult?.success !== false}`);


            // Track recently-written files so we can inject content on run_command failure.
            // Root cause of write_file loop: _writeFile returns {success:true} with NO content.
            // After run_command SyntaxError, model has zero visibility into actual file content
            // and re-writes identical broken code. Injecting the content closes the information gap.
            if (FILE_WRITE_OPS.has(call.tool) && toolResult?.success !== false && call.params?.content) {
              const writtenPath = call.params.filePath || call.params.path || toolResult?.path || '';
              if (writtenPath) {
                this._recentlyWrittenFiles.set(writtenPath, call.params.content);
              }
            }
            // On run_command failure, check if the command references a recently-written file.
            // If so, inject the file's actual content so the model can see what's wrong.
            if (call.tool === 'run_command' && toolResult?.success === false && this._recentlyWrittenFiles.size > 0) {
              const cmdStr = (call.params?.command || '').toLowerCase();
              for (const [fp, content] of this._recentlyWrittenFiles) {
                const fileName = fp.split(/[\\/]/).pop() || '';
                if (cmdStr.includes(fileName.toLowerCase()) || cmdStr.includes(fp.toLowerCase().replace(/\\/g, '/'))) {
                  const MAX_CONTENT_INJECT = 3000;
                  const snippet = content.length > MAX_CONTENT_INJECT
                    ? content.slice(0, MAX_CONTENT_INJECT) + '\n... [truncated]'
                    : content;
                  const inject = `\n\n[SYSTEM: The file "${fileName}" was just written by you and the command failed. Here is the ACTUAL content currently in the file — compare it with what you intended to write]:\n${snippet}`;
                  if (typeof toolResult.message === 'string') {
                    toolResult.message += inject;
                  } else if (typeof toolResult.error === 'string') {
                    toolResult.error += inject;
                  } else if (typeof toolResult.output === 'string') {
                    toolResult.output += inject;
                  }
                  console.log(`[ChatEngine] Injected recently-written file content for ${fileName} into run_command failure result`);
                  break;
                }
              }
            }

            // Log browser click results for diagnostics
            if (call.tool === 'browser_click' && toolResult?.success) {
              console.log(`[ChatEngine] browser_click result: clicked="${toolResult.clicked || '?'}", navigated=${toolResult.navigated}, newTab=${toolResult.newTab || false}, url=${toolResult.url || '?'}`);
            }

            // Collect file read results for multi-file context awareness
            if ((call.tool === 'read_file' || call.tool === 'edit_file') && toolResult?.success !== false) {
              const filePath = call.params?.filePath || call.params?.path || '';
              const content = typeof toolResult === 'string' ? toolResult
                : (toolResult?.content || toolResult?.data || JSON.stringify(toolResult));
              if (filePath && content) {
                fileReadResults.push({ filePath, content: String(content) });
              }
            }

            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            console.log(`[ChatEngine] Tool result for ${call.tool}: ${resultStr}`);
            if (onToolCall) onToolCall({ name: call.tool, params: call.params, result: toolResult });

            // Update ToolCallCard with result (check mark or error)
            if (onStreamEvent) {
              onStreamEvent('mcp-tool-results', [{ tool: call.tool, result: toolResult }]);
            }

            let injectResult = resultStr;
            // Lint auto-fix — if any file-modification tool returned diagnostic errors,
            // inject a human-readable correction instruction AND emit a frontend event for the UI pill.
            if (FILE_MODIFY_OPS_SET.has(call.tool) && toolResult?.diagnostics?.errors > 0 && options.autoLintFix !== false) {
              const { errors, details } = toolResult.diagnostics;
              const detailStr = details?.length ? details.join('; ') : `${errors} error(s)`;
              const filePath = call.params?.filePath || call.params?.path || 'file';
              injectResult += `\n[LINT ERRORS IN ${filePath} — MUST FIX IMMEDIATELY: ${detailStr}. Fix ALL errors before proceeding.]`;
              if (onStreamEvent) {
                onStreamEvent('file-content-lint', {
                  filePath,
                  diagnostics: toolResult.diagnostics,
                });
              }
              console.log(`[ChatEngine] Lint auto-fix: ${errors} error(s) in ${filePath} — correction injected into tool result`);
            }
            // Screenshot handling: try vision captioning first, otherwise compact note
            // Vision server loads on demand via captionImage() → _ensureRunning(),
            // then unloads after captioning to free VRAM. No need to check isReady.
            if (call.tool === 'browser_screenshot' && toolResult?.success && toolResult?.screenshot) {
              if (this.modelInfo?.visionAvailable) {
                try {
                  const caption = await visionServer.captionImage(
                    toolResult.screenshot,
                    toolResult.mimeType || 'image/png',
                    'Describe this screenshot in detail. List all visible text, buttons, links, input fields, and interactive elements with their labels.'
                  );
                  if (caption) {
                    injectResult = JSON.stringify({ success: true, visionCaption: caption });
                    console.log(`[ChatEngine] Screenshot captioned via vision server: ${caption.length} chars`);
                  } else {
                    injectResult = '{"success":true,"note":"Screenshot captured. Use browser_snapshot for a detailed text description of the page."}';
                  }
                } catch (visionErr) {
                  console.error(`[ChatEngine] Vision caption failed: ${visionErr.message}`);
                  injectResult = '{"success":true,"note":"Screenshot captured. Use browser_snapshot for a detailed text description of the page."}';
                }
              } else {
                injectResult = '{"success":true,"note":"Screenshot captured. Use browser_snapshot for a detailed text description of the page."}';
              }
            }
            // PL2: Compute inject cap proportional to model context size (Rule 9: no hardcoded context numbers).
            // Approx 4 chars per token; cap at 25% of context as chars (leaves 75% for prompt + history).
            // Minimum floor of 8000 chars so tiny contexts still get usable results.
            const ctxTokens = this._contextSize || this.modelInfo?.contextSize || 8192;
            const ctxChars = ctxTokens * 4;
            const baseCap = Math.max(8000, Math.floor(ctxChars * 0.25));
            const multiplier = TOOL_INJECT_MULTIPLIERS[call.tool] || 1.0;
            const injectCap = Math.floor(baseCap * multiplier);
            if (injectResult.length > injectCap) {
              // PL1: Smart truncation for browser snapshots — preserve ALL interactive elements
              // (the model needs every ref to make correct decisions) and truncate only the page text.
              // For non-browser tools, use the original flat cap.
              if (call.tool === 'browser_snapshot' || call.tool === 'browser_navigate' || call.tool === 'browser_click' || call.tool === 'browser_type') {
                const pageTextIdx = injectResult.indexOf('\nPage text:\n');
                if (pageTextIdx !== -1) {
                  const elementSection = injectResult.substring(0, pageTextIdx + 12);
                  const textSection = injectResult.substring(pageTextIdx + 12);
                  const budgetForText = injectCap - elementSection.length;
                  if (budgetForText > 500) {
                    const headSize = Math.floor(budgetForText * 0.7);
                    const tailSize = budgetForText - headSize - 60;
                    injectResult = elementSection + textSection.substring(0, headSize)
                      + '\n[... middle section omitted for context size — call browser_scroll to see more]\n'
                      + textSection.substring(Math.max(headSize, textSection.length - tailSize));
                  } else {
                    injectResult = elementSection + textSection.substring(0, budgetForText)
                      + '\n[... result truncated — call browser_scroll to see more content]';
                  }
                } else {
                  injectResult = injectResult.slice(0, injectCap)
                    + '\n[... result truncated by system for context size; use browser_scroll to see more]';
                }
              } else {
                injectResult = injectResult.slice(0, injectCap)
                  + '\n[... result truncated by system for context size; use only text above]';
              }
            }
            toolResultLines.push(`${call.tool}: ${injectResult}`);
          }


          // Update evaluation state and chat history from last generation
          this._lastEvaluation = result.lastEvaluation;
          if (result.lastEvaluation?.cleanHistory) {
            this._chatHistory = result.lastEvaluation.cleanHistory;
          }

          // Feed tool results back to the model so it knows what happened.
          //
          // ARCHITECTURE NOTE: there is intentionally NO conditional "grounding"
          // paragraph, NO "all calls failed" directive, NO "browser failures"
          // directive, NO "new tab opened" directive, NO fetch URL list, and NO
          // file-read warning appended to this message. Every previous version
          // of those paragraphs was a detection-driven band-aid that fixed what
          // happened AFTER the model got confused. Each tool result line already
          // contains its own success/error text (`tool: {"success": false, ...}`),
          // so the model can see exactly what failed without us re-explaining it
          // every round. The general response strategy ("after web_search, fetch
          // top results"; "after browser_navigate, snapshot"; "do not narrate
          // failures to the user") lives in SYSTEM_PROMPT once, not in every
          // tool-results turn. See `## When to use tools` and `## BROWSER
          // WORKFLOW` in the system prompt for the canonical guidance.

          // ─── Multi-file context awareness ───
          // After read_file or edit_file, parse the file's imports and inject
          // related files into the tool results. This gives the model visibility
          // into imported modules without it having to explicitly read each one.
          // Capped at 3 files × MAX_FILE_CONTEXT chars to avoid context bloat.
          const MAX_RELATED_FILES = 3;
          const MAX_FILE_CONTEXT = 4000;
          const relatedFileLines = [];
          const seenRelatedPaths = new Set();

          for (const { filePath, content } of fileReadResults) {
            if (!filePath || !content) continue;

            // Language-agnostic import detection
            const importPatterns = [
              /(?:import\s+.*?\s+from\s+['"])([^'"]+)(?:['"])/g,           // ES modules
              /(?:import\s+['"])([^'"]+)(?:['"])/g,                         // side-effect imports
              /(?:require\s*\(\s*['"])([^'"]+)(?:['"]\s*\))/g,            // CommonJS
              /(?:#include\s+[<"])([^>"]+)(?:[>"])/g,                       // C/C++
              /(?:from\s+([a-zA-Z_][\w.]*)\s+import)/g,                    // Python
            ];

            const importPaths = new Set();
            for (const pat of importPatterns) {
              pat.lastIndex = 0;
              let m;
              while ((m = pat.exec(content)) !== null) {
                const imp = m[1];
                // Skip node built-ins and package imports (no path separator)
                if (imp && (imp.startsWith('.') || imp.startsWith('/')) && !seenRelatedPaths.has(imp)) {
                  importPaths.add(imp);
                }
              }
            }

            // Try to resolve and read each import (up to MAX_RELATED_FILES total)
            for (const relPath of importPaths) {
              if (relatedFileLines.length >= MAX_RELATED_FILES) break;
              seenRelatedPaths.add(relPath);
              try {
                const resolvedPath = path.resolve(path.dirname(filePath), relPath);
                // Try with common extensions if the import has no extension
                const candidates = [resolvedPath];
                if (!path.extname(resolvedPath)) {
                  candidates.push(
                    resolvedPath + '.js', resolvedPath + '.jsx', resolvedPath + '.ts',
                    resolvedPath + '.tsx', resolvedPath + '.py', resolvedPath + '.json',
                    resolvedPath + '.css', resolvedPath + '.html',
                    path.join(resolvedPath, 'index.js'), path.join(resolvedPath, 'index.ts'),
                    path.join(resolvedPath, 'index.jsx'), path.join(resolvedPath, 'index.tsx'),
                  );
                }
                for (const candidate of candidates) {
                  if (relatedFileLines.length >= MAX_RELATED_FILES) break;
                  try {
                    const stat = fs.statSync(candidate);
                    if (stat.isFile() && stat.size < 100000) { // skip huge files
                      let relContent = fs.readFileSync(candidate, 'utf8');
                      if (relContent.length > MAX_FILE_CONTEXT) {
                        relContent = relContent.slice(0, MAX_FILE_CONTEXT) + '\n… [truncated]';
                      }
                      relatedFileLines.push(`[Related file: ${candidate}]\n${relContent}`);
                      break;
                    }
                            } catch (e) { /* file doesn't exist, try next candidate */ }
                }
              } catch (e) { /* path resolution failed, skip */ }
            }
          }

          const relatedSection = relatedFileLines.length > 0
            ? '\n\n--- Related files (auto-injected for context) ---\n' + relatedFileLines.join('\n\n---\n\n')
            : '';

          // Inject any pending user interrupt message into the tool results.
          // The interrupt is the user's most recent direction. It is delivered ONCE,
          // at the head of the next [Tool Results] message, and then cleared. We do
          // NOT re-echo the user's original or interrupt message back into context on
          // any subsequent round — the chat history already preserves user turns at
          // their natural positions, and re-injecting them creates recursive attention
          // patterns that cause the model to ignore newer user messages and to emit
          // <|im_end|> at the same offsets as the echoes (mid-word truncation).
          let userInterruptPrefix = '';
          if (this._pendingUserMessage) {
            userInterruptPrefix = `[USER INTERRUPT — OBEY THIS IMMEDIATELY]: ${this._pendingUserMessage}\n\n`;
            this._toolRoundCount = 0; // reset round count when user redirects mid-loop
            this._pendingUserMessage = null;
          }
          this._toolRoundCount++;

          if (this._sessionId !== sessionAtStart) {
            console.warn(`[ChatEngine] Session changed during tool execution (was ${sessionAtStart}, now ${this._sessionId}) — dropping stale tool results`);
            break;
          }

          this._chatHistory.push({
            type: 'user',
            text: `${userInterruptPrefix}[System: Tool Results]\nThe tools below have ALREADY been executed. Do not repeat these actions or re-narrate work that is already complete. Summarize outcomes or proceed to the next step only.\n\n${toolResultLines.join('\n')}${relatedSection}\n\nContinue with any remaining steps. Call the next tool if more work is needed, or explain the result if the task is complete.`
          });
          console.log(`[ChatEngine] ─── TOOL RESULTS → MODEL ─── ${toolResultLines.length} result(s), ${relatedFileLines.length} related file(s), interrupt=${!!this._pendingUserMessage}`);
          // Log compact summaries — browser snapshots bloat logs with full DOM
          const compactSummaries = toolResultLines.map(line => {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) return line;
            const toolName = line.substring(0, colonIdx);
            if (toolName === 'browser_snapshot' || toolName === 'browser_navigate') {
              try {
                const resultStr = line.substring(colonIdx + 1).trim();
                const parsed = JSON.parse(resultStr);
                return `${toolName}: URL=${parsed.url || '?'}, title="${(parsed.title || '').slice(0, 80)}", elements=${parsed.elements?.length || 0}`;
              } catch { return `${toolName}: (snapshot — see full result in tool output)`; }
            }
            return line.length > 200 ? line.substring(0, 200) + '...' : line;
          });
          console.log(`[ChatEngine] Tool result summary: ${compactSummaries.join(' | ')}`);

          // ─── Context compaction between tool rounds ───
          // Root cause of slow prefill: each round re-prefills the ENTIRE history.
          // Browser snapshots are the worst offender — 5-10KB of page DOM per result.
          // The model only needs the CURRENT page state, not full DOMs from 5 pages ago.
          // Solution: strip snapshot text from old results, keep only URL/title/status.
          // Only the most recent tool result message retains full content.
          if (this._chatHistory.length > 6) {
            const toolResultIndices = [];
            for (let i = 0; i < this._chatHistory.length; i++) {
              if (this._chatHistory[i].type === 'user' && (this._chatHistory[i].text.startsWith('[System: Tool Results]') || this._chatHistory[i].text.startsWith('[Tool Results]'))) {
                toolResultIndices.push(i);
              }
            }
            // Process all but the most recent tool result message
            if (toolResultIndices.length > 1) {
              for (let j = 0; j < toolResultIndices.length - 1; j++) {
                const idx = toolResultIndices[j];
                const full = this._chatHistory[idx].text;
                if (full.length > 500) {
                  const lines = full.split('\n');
                  const summaryLines = lines.filter(l => /^[a-z_]+:/.test(l)).map(l => {
                    const colonIdx = l.indexOf(':');
                    const toolName = l.substring(0, colonIdx);
                    const result = l.substring(colonIdx + 1).trim();
                    const isErr = result.startsWith('{"success":false') || result.includes('"error"');
                    // Browser snapshots: strip full page DOM, keep only URL + title
                    if (toolName === 'browser_snapshot' && !isErr) {
                      try {
                        const parsed = JSON.parse(result);
                        const url = parsed.url || '';
                        const title = parsed.title || '';
                        return `browser_snapshot: URL=${url}, title=${title} (page content removed — already on a different page)`;
                      } catch { return `browser_snapshot: OK (old page)`; }
                    }
                    // Browser navigate: strip snapshot, keep URL + title + status
                    if (toolName === 'browser_navigate' && !isErr) {
                      try {
                        const parsed = JSON.parse(result);
                        const url = parsed.url || '';
                        const title = parsed.title || '';
                        const status = parsed.httpStatus || '';
                        return `browser_navigate: navigated to ${url}${title ? ` (${title})` : ''}${status ? ` HTTP ${status}` : ''}`;
                      } catch { return `browser_navigate: OK`; }
                    }
                    // Browser click: keep what was clicked and resulting URL
                    if (toolName === 'browser_click' && !isErr) {
                      try {
                        const parsed = JSON.parse(result);
                        const clicked = parsed.clicked || '';
                        const url = parsed.url || '';
                        return `browser_click: clicked "${clicked}"${url ? `, now at ${url}` : ' (no navigation)'}`;
                      } catch { return `browser_click: OK`; }
                    }
                    // Browser type: keep what was typed
                    if (toolName === 'browser_type' && !isErr) {
                      try {
                        const parsed = JSON.parse(result);
                        const url = parsed.url || '';
                        return `browser_type: typed${url ? `, now at ${url}` : ''}`;
                      } catch { return `browser_type: OK`; }
                    }
                    // read_file: preserve file path and content excerpt so model doesn't re-read same file
                    if (toolName === 'read_file' && !isErr) {
                      try {
                        const parsed = JSON.parse(result);
                        const filePath = parsed.path || '';
                        const content = (parsed.content || '').substring(0, 300);
                        return `read_file: ${filePath}${content ? ` — ${content}` : ''}`;
                      } catch { return `read_file: OK`; }
                    }
                    // list_directory: preserve directory path so model knows it already listed it
                    if (toolName === 'list_directory' && !isErr) {
                      try {
                        const parsed = JSON.parse(result);
                        const dirPath = parsed.path || '';
                        const entries = (parsed.entries || []).map(e => e.name || e).slice(0, 15).join(', ');
                        return `list_directory: ${dirPath} — ${entries}`;
                      } catch { return `list_directory: OK`; }
                    }
                    // ask_question: preserve the full answer — it contains user-provided data
                    // (credentials, choices, instructions) that must survive compaction
                    if (toolName === 'ask_question' && !isErr) {
                      try {
                        const parsed = JSON.parse(result);
                        const answer = parsed.answer || '';
                        return `ask_question: ${answer.substring(0, 1000)}${answer.length > 1000 ? '...' : ''}`;
                      } catch { return `ask_question: OK`; }
                    }
                    return `${toolName}: ${isErr ? 'FAILED' : 'OK'}`;
                  });
                  this._chatHistory[idx] = {
                    type: 'user',
                    text: `[Earlier Tool Results (summarized)]\n${summaryLines.join('\n')}`,
                  };
                }
              }
            }
          }

          // KV cache always preserved between tool rounds.
          // Previously cleared after write tools (attention-pattern contamination theory),
          // but this caused 40-90s full-prefill penalties. Root cause (sampling) was fixed
          // in the generation-speed parity fix. Preserving cache = fast prefill every round.
          console.log('[ChatEngine] KV cache preserved — fast prefill enabled');

          // Reset streaming filter state for the next generation round
          _sfBuf = '';
          _sfDepth = 0;
          _sfActive = false;
          _sfConfirmed = false;
          _sfInStr = false;
          _sfEscaped = false;
          _sfLastCharWasNewlineOrStart = true;
          _sfInFence = false;
          _sfFenceBuf = '';
          _sfFenceTickCount = 0;
          _sfFileWriteDetected = false;
          _sfContentStreamActive = false;
          _sfContentDone = false;
          _sfContentEsc = false;
          _sfContentBuf = '';
          _sfContentFilePath = '';
          _sfUnicodeCount = 0;
          _sfUnicodeChars = '';
          _sfVisibleChars = 0;
          _sfInThink = false;
          _sfThinkBuf = '';
          _sfThinkTagMatch = '';
          _sfFenceInThink = false;
          _sfPostFenceSuppress = false;
          _sfFenceStreamPlain = false;
          _sfFencePlainTick = 0;
          _sfNativeThinkActive = false;

          // Generate continuation — model sees tool results and can issue more tool calls
          // Recalculate maxTokens for this round — tool results consumed context space
          const ctxUsedNow = this._sequence?.nextTokenIndex || 0;
          const ctxAvailNow = contextSize - ctxUsedNow;
          genOptions.maxTokens = Math.max(MIN_GENERATION_TOKENS, ctxAvailNow);
          const _prefillStart = Date.now();
          console.log(`[ChatEngine] Continuation maxTokens: ${genOptions.maxTokens} (ctx used: ${ctxUsedNow}/${contextSize})`);

          roundStart = fullResponse.length;
          const _sfVisibleAtRoundStart = _sfVisibleChars; // snapshot before this round's generation
          console.log(`[ChatEngine] Calling generateResponse CONTINUATION: history=${this._chatHistory.length} msgs`);
          result = await this._chat.generateResponse(this._chatHistory, genOptions);
          console.log(`[ChatEngine] generateResponse CONTINUATION returned: stopReason=${result.metadata?.stopReason}, responseLen=${result.response?.length || 0}`);
          const _prefillAndGenMs = Date.now() - _prefillStart;
          console.log(`[ChatEngine] Continuation after tools: stopReason=${result.metadata?.stopReason}, responseLen=${result.response?.length || 0}, prefill+gen=${_prefillAndGenMs}ms, ctxUsed=${ctxUsedNow}`);
          // EOG DIAGNOSTIC (continuation): same shape as the primary diagnostic above.
          // Reads `roundTokens` (recomputed from this round's metadata) so the printed
          // token count is real, not the always-undefined eogMeta.totalTokens.
          if (result.metadata?.stopReason === 'eogToken') {
            const eogMeta = result.metadata || {};
            const respText = result.response || '';
            const lastChars = respText.length > 80 ? respText.slice(-80) : respText;
            const roundTokens = eogMeta.totalTokens ?? respText.length ?? 0;
            const truncatedMidWord = /\w$/.test(respText.trim());
            console.warn(`[ChatEngine] EOG DIAGNOSTIC (continuation) ── stopReason=eogToken`);
            console.warn(`  tokens generated: ${roundTokens}, maxTokens budget: ${genOptions.maxTokens}`);
            console.warn(`  context: ${ctxUsedNow}/${contextSize}, gpuLayers=${this._model?.gpuLayers ?? '?'}`);
            console.warn(`  last 80 chars: "${lastChars}"`);
            console.warn(`  truncated mid-word: ${truncatedMidWord}`);
            console.warn(`  metadata keys: ${Object.keys(eogMeta).join(', ')}`);
            console.warn(`  chatWrapper: ${this._chat?.chatWrapper?.wrapperName ?? 'unknown'}`);
          }
          const _contResp = result.response || '';
          const _contThink = _contResp.match(/<think>([\s\S]*?)<\/think>/) || _contResp.match(/<reasoning>([\s\S]*?)<\/reasoning>/) || _contResp.match(/<reflection>([\s\S]*?)<\/reflection>/);
          if (_contThink) {
            console.log(`[ChatEngine] ─── CONTINUATION THINKING ─── "${_contThink[1]}"`);
          }
          console.log(`[ChatEngine] ─── CONTINUATION RESPONSE ─── "${_contResp}"`);

          // Flush streaming filter buffer before parsing new text
          _sfFlush();
          _sfFlushFence();

          // Parse only the NEW text from this round (avoid re-executing previous tool calls)
          const newText = fullResponse.substring(roundStart);
          const newVisibleChars = _sfVisibleChars - _sfVisibleAtRoundStart; // visible chars from this round only
          parsedCalls = parseToolCalls(newText);
          if (parsedCalls.length > 0) {
            const { repaired } = repairToolCalls(parsedCalls, newText);
            parsedCalls = filterWebWorkspaceToolConflict(repaired);

            // Safety net cleanup for any missed tool JSON in new text
            // CRITICAL: use newVisibleChars (actual chars sent to frontend this round) not newText.length
            if (onStreamEvent) {
              const cleanNewText = stripToolCallText(newText);
              if (cleanNewText.length < newVisibleChars) {
                onStreamEvent('llm-replace-last', { originalLength: newVisibleChars, replacement: cleanNewText });
              }
            }
          }

        }

      } else if (executeToolFn && _userAbortedGeneration) {
        console.log(`[ChatEngine] Skipping tool parse/execute — generation stopReason=${_genStopReason} (user stopped)`);
      }

      this._lastEvaluation = result.lastEvaluation;
      if (result.lastEvaluation?.cleanHistory) {
        console.log(`[ChatEngine] Applying cleanHistory from lastEvaluation: ${result.lastEvaluation.cleanHistory.length} msgs`);
        this._chatHistory = result.lastEvaluation.cleanHistory;
      }
      const stopReason = result.metadata?.stopReason || 'natural';

      console.log(`[ChatEngine] Generation complete. Tool calls: ${totalToolCalls}, stopReason=${stopReason}, responseLen=${fullResponse.length}, thoughtLen=${_sfNativeThinkChars}, visibleLen=${_sfVisibleChars}`);

      // Inference speed diagnostic
      const ctxUsedTokens = this._sequence?.nextTokenIndex || 0;
      const totalCtx = this._context?.contextSize || 0;
      const gpuLayers = this.modelInfo?.gpuLayers || 0;
      const totalLayers = this.modelInfo?.totalLayers || gpuLayers;
      const ctxPct = totalCtx > 0 ? Math.round((ctxUsedTokens / totalCtx) * 100) : 0;
      const totalGenElapsed = (Date.now() - genStartTime) / 1000;
      const avgTokPerSec = totalGenElapsed > 0 && genTokenCount > 0 ? (genTokenCount / totalGenElapsed).toFixed(1) : '?';
      console.log(`[ChatEngine] Inference diagnostic: ctx=${ctxUsedTokens}/${totalCtx} (${ctxPct}%), gpuLayers=${gpuLayers}/${totalLayers}, responseLen=${fullResponse.length}, thoughtLen=${_sfNativeThinkChars}, visibleLen=${_sfVisibleChars}, genTokens=${genTokenCount}, totalTime=${totalGenElapsed.toFixed(1)}s, avgTok/s=${avgTokPerSec}, model=${this.modelInfo?.name}`);
      // Memory monitoring: check VRAM/RAM pressure after generation
      if (this.gpuPreference !== 'cpu') {
        try {
          const vramState = await this._llama.getVramState();
          const vramFreeNow = vramState?.free || 0;
          const vramTotalNow = vramState?.total || 0;
          const vramUsedPct = vramTotalNow > 0 ? Math.round(((vramTotalNow - vramFreeNow) / vramTotalNow) * 100) : 0;
          if (vramUsedPct > 90 && onStreamEvent) {
            // Rate-limit: only emit once per 5 minutes to avoid spamming the UI
            const now = Date.now();
            if (!this._lastVramWarn || (now - this._lastVramWarn) > 300000) {
              this._lastVramWarn = now;
              onStreamEvent('generation-warning', {
                message: `VRAM is ${vramUsedPct}% full — generation may slow down or fail`,
                suggestion: 'Try reducing context size or GPU layers in settings.',
              });
            }
          }
          console.log(`[ChatEngine] Memory post-gen: vramUsed=${vramUsedPct}%, vramFree=${(vramFreeNow/1e9).toFixed(2)}GB, ramFree=${(os.freemem()/1e9).toFixed(2)}GB`);
        } catch (e) { console.warn('[ChatEngine] Memory post-gen check failed:', e.message); }
      }

      // Emit error only when neither visible response nor native thinking was produced
      const hadVisibleOutput = !!fullResponse.trim() || _sfVisibleChars > 0;
      const hadThinkingOutput = _sfNativeThinkChars > 0;
      if (!hadVisibleOutput && !hadThinkingOutput && stopReason !== 'cancelled' && stopReason !== 'abort' && onStreamEvent) {
        console.warn(`[ChatEngine] Empty response warning: stopReason=${stopReason}, contextTokens=${contextTokens}, thoughtLen=0, visibleLen=${_sfVisibleChars}`);
        onStreamEvent('generation-error', {
          message: 'Model produced no output',
          suggestion: contextTokens < 4096
            ? `Context window is only ${contextTokens.toLocaleString()} tokens — too small for this model's tool prompt. Try a different model, increase context size in settings, or start a new session.`
            : 'The model may have encountered an internal error. Try again or start a new session.',
        });
      }

      console.log(`[ChatEngine] chat() returning: textLen=${fullResponse.length}, stopReason=${stopReason}, toolCalls=${totalToolCalls}`);
      if (onComplete) onComplete(fullResponse);
      return { text: fullResponse, stopReason, toolCallCount: totalToolCalls };
    } catch (err) {
      console.error(`[ChatEngine] chat() CATCH: ${err.name}: ${err.message}`);
      if (err.name === 'AbortError' || this._abortController?.signal?.aborted) {
        console.log('[ChatEngine] chat() returning cancelled');
        return { text: fullResponse, stopReason: 'cancelled', toolCallCount: totalToolCalls };
      }
      // Emit generation error to UI
      if (onStreamEvent) {
        onStreamEvent('generation-error', {
          message: `Generation failed: ${err.message}`,
          suggestion: 'Try again, start a new session, or check the backend log for details.',
        });
      }
      throw err;
    } finally {
      console.log('[ChatEngine] chat() FINALLY: abortController cleared');
      this._abortController = null;
    }
  }

  cancelGeneration(reason) {
    console.log(`[ChatEngine] cancelGeneration called: reason=${reason || 'cancelled'}`);
    if (this._abortController) {
      this._abortController.abort(reason || 'cancelled');
    }
  }

  /**
   * Revert the backend context to match a truncated frontend message array.
   * Called when the user clicks the pencil edit submit or a checkpoint restore button.
   * Rebuilds _chatHistory from the provided messages, preserving the system prompt entry.
   * @param {Array<{role:string, content:string}>} messages - truncated chatMessages from frontend
   */
  revertContext(messages) {
    if (!this._chatHistory?.length) return;
    // Cancel any in-flight generation before mutating history
    if (this._abortController) {
      this._abortController.abort('context_revert');
    }
    const systemEntry = this._chatHistory[0]; // preserve system prompt + tool definitions
    const newHistory = systemEntry ? [{ ...systemEntry }] : [{ type: 'system', text: SYSTEM_PROMPT }];
    for (const msg of (messages || [])) {
      if (!msg?.role || msg.content == null) continue;
      if (msg.role === 'user') {
        newHistory.push({ type: 'user', text: String(msg.content) });
      } else if (msg.role === 'assistant') {
        newHistory.push({ type: 'model', response: [String(msg.content)] });
      }
    }
    this._chatHistory = newHistory;
    this._lastEvaluation = null; // force full context rebuild on next generation
    // Clear the sequence's KV cache so stale tokens don't contaminate the rebuilt history.
    // resetSession() does the same thing — revertContext must match that behaviour.
    if (this._sequence) {
      try { this._sequence.clearHistory(); } catch (_) {}
    }
    console.log(`[ChatEngine] Context reverted: rebuilt from ${messages?.length || 0} messages → ${newHistory.length - 1} history entries (system entry preserved, KV cache cleared)`);
  }

  /**
   * Spawn a focused sub-agent using the same loaded model with a fresh context.
   * Sub-agents run SEQUENTIALLY (local hardware can't run two models in parallel).
   * The sub-context is disposed immediately after the task completes to free VRAM.
   * @param {string} task - the sub-task description
   * @param {object} [opts] - { contextSize, temperature, maxTokens, toolPrompt, executeToolFn }
   */
  async spawnSubAgent(task, opts = {}) {
    if (!this._model) throw new Error('No model loaded — cannot spawn sub-agent');
    console.log(`[ChatEngine] Sub-agent spawning: "${String(task)}"`);
    const llamaCppPath = this._getNodeLlamaCppPath();
    const { LlamaChat } = await import(pathToFileURL(llamaCppPath).href);
    // Sub-agent context is at most half the main context, with a runtime floor of
    // MIN_CONTEXT_FLOOR. No hardcoded fallback values — if the main context is not
    // available, the sub-agent allocation derives from MIN_CONTEXT_FLOOR alone so
    // the same code works on a 4 GB laptop and a 128 GB workstation (Rule 9).
    const mainCtx = this._context?.contextSize || MIN_CONTEXT_FLOOR;
    const halfMain = Math.floor(mainCtx / 2);
    const requested = (Number.isFinite(opts.contextSize) && opts.contextSize > 0) ? opts.contextSize : halfMain;
    const subCtxSize = Math.max(MIN_CONTEXT_FLOOR, Math.min(requested, halfMain));
    let subContext = null;
    try {
      subContext = await this._model.createContext({ contextSize: subCtxSize });
      const subSequence = subContext.getSequence();
      const subChat = new LlamaChat({
        contextSequence: subSequence,
        chatWrapper: this._chatWrapper || 'auto',
      });
      const subHistory = [
        { type: 'system', text: `You are a focused sub-agent. Complete the task below fully and return your results in clear text.\n\nTask: ${task}` },
        { type: 'user', text: task },
      ];
      let subResponse = '';
      const subGenOptions = {
        temperature: opts.temperature ?? 0.3,
        signal: this._abortController?.signal,   // cancel sub-agent when main cancel fires
        stopOnAbortSignal: true,
        onTextChunk: (chunk) => { subResponse += chunk; },
      };
      if (opts.toolPrompt && opts.executeToolFn) {
        subHistory[0].text += `\n\n${opts.toolPrompt}`;
      }
      const result = await subChat.generateResponse(subHistory, subGenOptions);
      subResponse = result?.response || subResponse;
      console.log(`[ChatEngine] Sub-agent completed: ${subResponse.length} chars`);
      return { success: true, result: subResponse };
    } catch (err) {
      console.error(`[ChatEngine] Sub-agent failed: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      try { subContext?.dispose(); } catch (_) {}
    }
  }

  /**
   * Inject a user message into the ongoing tool call loop.
   * The message will be prepended to the next continuation's tool results
   * so the model sees it immediately and can adjust its behavior.
   */
  injectUserMessage(text) {
    console.log(`[ChatEngine] injectUserMessage: text=${String(text)}`);
    this._pendingUserMessage = text;
  }

  async resetSession() {
    console.log('[ChatEngine] resetSession START');
    if (this._loadPromise) {
      console.log('[ChatEngine] resetSession: awaiting in-flight model load');
      try { await this._loadPromise; } catch (_) { /* load failed */ }
    }
    if (this._loadState === 'loading' || this._loadState === 'disposing') {
      console.warn('[ChatEngine] resetSession skipped — model load in progress');
      return;
    }
    this._sessionId++;
    this._chatHistory = [{ type: 'system', text: SYSTEM_PROMPT }];
    this._lastEvaluation = null;
    if (this._sequence) {
      try { this._sequence.clearHistory(); } catch (e) { console.warn('[ChatEngine] resetSession clearHistory failed:', e.message); }
    }
    console.log(`[ChatEngine] resetSession DONE: newSessionId=${this._sessionId}`);
  }

  getStatus() {
    const status = {
      isReady: this.isReady,
      isLoading: this.isLoading,
      loadState: this._loadState,
      modelInfo: this.modelInfo,
      currentModelPath: this.currentModelPath,
      gpuPreference: this.gpuPreference,
    };
    console.log(`[ChatEngine] getStatus: ready=${status.isReady}, loading=${status.isLoading}`);
    return status;
  }

  async getGPUInfo() {
    // Plan 8 instrumentation — log inter-call delta so the next session reveals
    // any caller that runs more often than the documented StatusBar 60s cadence.
    // No retry, no rate-limit, no behavior change. Diagnostic-only.
    try {
      const _now = Date.now();
      const _delta = this._lastGetGpuInfoTs ? (_now - this._lastGetGpuInfoTs) : 0;
      this._lastGetGpuInfoTs = _now;
      console.log(`[ChatEngine] getGPUInfo START (delta=${_delta}ms since last)`);
    } catch (_) { console.log('[ChatEngine] getGPUInfo START'); }
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'],
        { timeout: 5000 },
      );
      const [name, memTotal, memUsed, memFree, utilGpu, temp] = stdout.trim().split(',').map(s => s.trim());
      console.log(`[ChatEngine] getGPUInfo: name=${name}, memTotal=${memTotal}, memUsed=${memUsed}, memFree=${memFree}`);
      const info = {
        name,
        memoryTotal: parseFloat(memTotal),
        memoryUsed: parseFloat(memUsed),
        memoryFree: parseFloat(memFree),
        gpuUtilization: parseFloat(utilGpu),
        temperature: parseFloat(temp),
      };
      this._cachedGpuInfo = info;
      return info;
    } catch (e) {
      if (this._cachedGpuInfo) {
        console.log(`[ChatEngine] getGPUInfo failed (${e.message}) — returning cached reading`);
        return this._cachedGpuInfo;
      }
      console.warn(`[ChatEngine] getGPUInfo failed: ${e.message}`);
      return { name: 'Unknown', memoryTotal: 0, memoryUsed: 0, memoryFree: 0, gpuUtilization: 0, temperature: 0 };
    }
  }

  async dispose() {
    console.log('[ChatEngine] dispose START');
    this._loadState = 'disposing';
    await this._dispose();
    this.isReady = false;
    this.isLoading = false;
    this._loadState = 'idle';
    this.modelInfo = null;
    this.currentModelPath = null;
    this.emit('status', { state: 'idle', message: 'Model unloaded' });
    console.log('[ChatEngine] dispose DONE');
  }

  async _dispose() {
    console.log('[ChatEngine] _dispose START');
    try { await visionServer.stop(); } catch (e) { console.warn('[ChatEngine] _dispose visionServer.stop failed:', e.message); }
    try { if (this._sequence) this._sequence.dispose(); } catch (e) { console.warn('[ChatEngine] _dispose sequence.dispose failed:', e.message); }
    try { if (this._context) await this._context.dispose(); } catch (e) { console.warn('[ChatEngine] _dispose context.dispose failed:', e.message); }
    try { if (this._model) await this._model.dispose(); } catch (e) { console.warn('[ChatEngine] _dispose model.dispose failed:', e.message); }
    this._sequence = null;
    this._context = null;
    this._model = null;
    this._chat = null;
    this._chatHistory = [];
    this._lastEvaluation = null;
    console.log('[ChatEngine] _dispose DONE');
  }

  _contextShiftStrategy({ chatHistory, maxTokensCount, tokenizer }) {
    if (chatHistory.length <= 2) return { chatHistory, metadata: { droppedCount: 0 } };

    // Tokenizer cache — avoids re-tokenizing the same items across multiple shift calls
    const _tokenCache = new Map();
    const tokenize = (text) => {
      const key = text;
      if (_tokenCache.has(key)) return _tokenCache.get(key);
      let result;
      try { result = tokenizer.tokenize(String(text || ''), false).length; }
      catch { result = Math.ceil(String(text || '').length / 3); }
      _tokenCache.set(key, result);
      return result;
    };

    const getItemText = (item) => {
      if (item.text != null) return String(item.text);
      if (item.response) {
        return item.response.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('');
      }
      return '';
    };

    const estimateTokens = (item) => tokenize(getItemText(item)) + 10;

    const budget = Math.floor(maxTokensCount * 0.92);
    const systemItem = chatHistory[0];
    const lastItem = chatHistory[chatHistory.length - 1];

    const systemTokens = estimateTokens(systemItem);
    let lastItemTokens = chatHistory.length > 1 ? estimateTokens(lastItem) : 0;
    let effectiveLastItem = lastItem;

    // If system + lastItem exceeds budget, try progressively:
    // 1. Truncate lastItem (current behavior)
    // 2. Replace system prompt with minimal version
    // 3. Truncate both to absolute minimum
    // Only fail if even the absolute minimum doesn't fit.
    let effectiveSystemItem = systemItem;
    let systemTokensAdjusted = systemTokens;

    if (chatHistory.length > 1 && systemTokensAdjusted + lastItemTokens > budget) {
      const availableForLastItem = budget - systemTokensAdjusted - 20;
      if (availableForLastItem > 100) {
        const fullText = getItemText(lastItem);
        const isToolOrSystemInject = RE_TOOL_OR_SYSTEM_INJECT.test(fullText);
        let keepChars = Math.floor(availableForLastItem * 3);
        // Tool/system inject messages must keep the START (JSON + snippets), not the tail.
        let truncatedText = isToolOrSystemInject ? fullText.slice(0, keepChars) : fullText.slice(-keepChars);
        let truncTokens = tokenize(truncatedText);

        let iterations = 0;
        while (truncTokens > availableForLastItem && keepChars > 200 && iterations < 5) {
          keepChars = Math.floor(keepChars * 0.75);
          truncatedText = isToolOrSystemInject ? fullText.slice(0, keepChars) : fullText.slice(-keepChars);
          truncTokens = tokenize(truncatedText);
          iterations++;
        }

        if (lastItem.response) {
          effectiveLastItem = { ...lastItem, response: [truncatedText] };
        } else {
          effectiveLastItem = { ...lastItem, text: truncatedText };
        }
        lastItemTokens = truncTokens + 10;
        console.log(`[ChatEngine] Context shift: truncated lastItem from ${fullText.length} to ${truncatedText.length} chars (${isToolOrSystemInject ? 'head' : 'tail'})`);
      }

      // If still doesn't fit after truncation, fall back to minimal system prompt
      if (systemTokensAdjusted + lastItemTokens > budget) {
        const MINIMAL_SYSTEM = 'You are a helpful AI assistant. Respond concisely.';
        const minimalSystemItem = systemItem.response
          ? { ...systemItem, response: [MINIMAL_SYSTEM] }
          : { ...systemItem, text: MINIMAL_SYSTEM };
        const minimalSystemTokens = tokenize(MINIMAL_SYSTEM) + 10;
        const availableWithMinimal = budget - minimalSystemTokens - 20;

        if (availableWithMinimal > 100) {
          effectiveSystemItem = minimalSystemItem;
          systemTokensAdjusted = minimalSystemTokens;
          console.log(`[ChatEngine] Context shift: replaced system prompt with minimal version (${systemTokens} → ${minimalSystemTokens} tokens)`);

          // Re-truncate lastItem with the freed-up space
          const fullText = getItemText(lastItem);
          if (minimalSystemTokens + lastItemTokens > budget) {
            const isToolOrSystemInject = RE_TOOL_OR_SYSTEM_INJECT.test(fullText);
            let keepChars = Math.floor(availableWithMinimal * 3);
            let truncatedText = isToolOrSystemInject ? fullText.slice(0, keepChars) : fullText.slice(-keepChars);
            let truncTokens = tokenize(truncatedText);
            let iterations = 0;
            while (truncTokens > availableWithMinimal && keepChars > 100 && iterations < 5) {
              keepChars = Math.floor(keepChars * 0.75);
              truncatedText = isToolOrSystemInject ? fullText.slice(0, keepChars) : fullText.slice(-keepChars);
              truncTokens = tokenize(truncatedText);
              iterations++;
            }
            if (lastItem.response) {
              effectiveLastItem = { ...lastItem, response: [truncatedText] };
            } else {
              effectiveLastItem = { ...lastItem, text: truncatedText };
            }
            lastItemTokens = truncTokens + 10;
          }
        } else {
          // Absolute minimum: minimal system + heavily truncated last item
          effectiveSystemItem = minimalSystemItem;
          systemTokensAdjusted = minimalSystemTokens;
          const fullText = getItemText(lastItem);
          const floorChars = Math.min(200, fullText.length);
          const truncatedText = fullText.slice(-floorChars);
          if (lastItem.response) {
            effectiveLastItem = { ...lastItem, response: [truncatedText] };
          } else {
            effectiveLastItem = { ...lastItem, text: truncatedText };
          }
          lastItemTokens = tokenize(truncatedText) + 10;
          console.log(`[ChatEngine] Context shift: extreme compression — minimal system + ${floorChars} char lastItem floor`);
        }
      }
    }

    // Pure sliding window: keep most recent messages that fit, no pinning
    let used = systemTokensAdjusted + lastItemTokens;
    const keptIndices = new Set();

    for (let i = chatHistory.length - 2; i >= 1; i--) {
      const cost = estimateTokens(chatHistory[i]);
      if (used + cost > budget) break;
      used += cost;
      keptIndices.add(i);
    }

    const droppedCount = (chatHistory.length - 2) - keptIndices.size;
    const newHistory = [effectiveSystemItem];
    for (let i = 1; i <= chatHistory.length - 2; i++) {
      if (keptIndices.has(i)) newHistory.push(chatHistory[i]);
    }
    if (chatHistory.length > 1) newHistory.push(effectiveLastItem);

    // Auto-maintain context state file — when messages are dropped, write a compact
    // summary to .guide-scratch/context-state.md so the model can read_file to recover
    if (droppedCount > 0) {
      try {
        const scratchDir = this._projectPath
          ? path.join(this._projectPath, '.guide-scratch')
          : null;
        if (scratchDir) {
          fs.mkdirSync(scratchDir, { recursive: true });
          const stateFile = path.join(scratchDir, 'context-state.md');
          // Build compact summary of dropped items
          const droppedItems = [];
          for (let i = 1; i <= chatHistory.length - 2; i++) {
            if (!keptIndices.has(i)) {
              const item = chatHistory[i];
              const text = getItemText(item);
              const role = item.type || 'unknown';
              // Compact: role + first 200 chars of each dropped item
              droppedItems.push(`[${role}] ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
            }
          }
          // Also include what's currently in context for full picture
          const keptItems = [];
          for (let i = 1; i <= chatHistory.length - 2; i++) {
            if (keptIndices.has(i)) {
              const item = chatHistory[i];
              const text = getItemText(item);
              const role = item.type || 'unknown';
              keptItems.push(`[${role}] ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
            }
          }
          const stateContent = [
            '# Context State',
            `Updated: ${new Date().toISOString()}`,
            `Context: ${used}/${budget} tokens used`,
            '',
            '## Current Conversation (in context)',
            ...keptItems,
            '',
            '## Dropped Conversation (shifted out)',
            ...droppedItems,
          ].join('\n');
          fs.writeFileSync(stateFile, stateContent, 'utf8');
        }
      } catch (e) { /* non-critical — don't break generation if scratch write fails */ console.warn('[ChatEngine] Scratch write failed:', e.message); }
    }

    console.log(`[ChatEngine] Context shift: kept ${keptIndices.size} items, dropped ${droppedCount}. Budget: ${budget}, used: ${used}`);
    return { chatHistory: newHistory, metadata: { droppedCount } };
  }

  _buildToolPrompt(functions) {
    console.log(`[ChatEngine] _buildToolPrompt: ${Object.keys(functions || {}).length} functions`);
    const toolLines = Object.entries(functions).map(([name, def]) => {
      return `- ${name}: ${def.description || 'No description'}`;
    });
    const prompt = `\n\nYou have access to the following tools:\n${toolLines.join('\n')}\n\nTOOL USAGE RULES:\n- When the user asks you to create, write, edit, read, or delete files in their project, you MUST use the appropriate file tool (write_file, read_file, edit_file, append_to_file, delete_file). Do NOT output file contents inline.\n- When the user asks you to find, search, or look for something in their code, use grep_search or find_files.\n- When the user asks to list or explore project structure, use list_directory.\n- When the user asks to run a command, script, or install something, use run_command.\n- When the user asks to search the web or look something up online, use web_search then immediately fetch_webpage on the first and second ranked result URLs in the same continuation before answering (if only one hit, fetch that URL). Do not ask the user whether to fetch. Do not list the project directory in the same tool round as web_search/fetch_webpage unless the user asked about the project.\n- When the user asks a general question, wants an explanation, or asks you to review code you already have, respond with text directly.\n- You can chain tools: use read_file to see existing code, then edit_file to modify it, then run_command to test it.\n- Always prefer tools over inline code when the user wants changes to their actual project files.`;
    console.log(`[ChatEngine] _buildToolPrompt: built ${prompt.length} chars`);
    return prompt;
  }

  _getNodeLlamaCppPath() {
    console.log('[ChatEngine] _getNodeLlamaCppPath START');
    try {
      const resolved = require.resolve('node-llama-cpp');
      console.log(`[ChatEngine] _getNodeLlamaCppPath resolved: ${resolved}`);
      return resolved;
    } catch (e) {
      const fallback = path.join(__dirname, '..', 'node_modules', 'node-llama-cpp', 'dist', 'index.js');
      console.warn(`[ChatEngine] _getNodeLlamaCppPath fallback: ${fallback} (error: ${e.message})`);
      return fallback;
    }
  }

  /**
   * Convert mcpToolServer tool definitions to node-llama-cpp ChatModelFunctions format.
   * mcpToolServer format: [{ name, description, parameters: { paramName: { type, description, required } } }]
   * ChatModelFunctions format: { name: { description, params: GbnfJsonSchema } }
   *
   * Note: In GBNF JSON Schema, ALL properties in an object schema are required.
   * We only include required params to avoid forcing the model to output optional values.
   */
  static convertToolDefs(toolDefs) {
    console.log(`[ChatEngine] convertToolDefs: ${toolDefs?.length || 0} tool definitions`);
    const functions = {};
    for (const tool of (toolDefs || [])) {
      const properties = {};
      if (tool.parameters) {
        for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
          // Only include required parameters (GBNF makes all properties required)
          if (paramDef.required === false) continue;

          const prop = { type: paramDef.type || 'string' };
          if (paramDef.description) prop.description = paramDef.description;
          properties[paramName] = prop;
        }
      }

      // Strip the format hint from descriptions (e.g. 'Format: {"tool":"name",...}')
      let desc = tool.description || '';
      const formatIdx = desc.indexOf('Format:');
      if (formatIdx > 0) desc = desc.substring(0, formatIdx).trim();

      functions[tool.name] = {
        description: desc,
        params: Object.keys(properties).length > 0
          ? { type: 'object', properties }
          : undefined,
      };
    }
    console.log(`[ChatEngine] convertToolDefs: converted ${Object.keys(functions).length} functions`);
    return functions;
  }
}

// Default set of tools enabled out of the box
ChatEngine.DEFAULT_ENABLED_TOOLS = new Set([
  // Files
  'read_file', 'write_file', 'edit_file', 'append_to_file',
  'delete_file', 'rename_file', 'copy_file',
  'list_directory', 'create_directory', 'find_files', 'grep_search',
  'search_codebase', 'search_in_file', 'replace_in_files',
  'get_project_structure', 'get_file_info', 'diff_files',
  // Terminal
  'run_command',
  // Web
  'web_search', 'fetch_webpage',
  // Browser
  'browser_navigate', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_get_content', 'browser_screenshot',
  'browser_evaluate', 'browser_fill_form', 'browser_select_option',
  'browser_scroll', 'browser_wait', 'browser_wait_for',
  'browser_back', 'browser_press_key', 'browser_hover',
  'browser_drag', 'browser_tabs', 'browser_handle_dialog',
  'browser_console_messages', 'browser_file_upload',
  'browser_resize', 'browser_get_url', 'browser_get_links',
  'browser_close',
  // Memory
  'save_memory', 'get_memory', 'list_memories',
  // Planning
  'write_todos', 'update_todo',
  // Interaction
  'ask_question',
]);

module.exports = { ChatEngine, buildEngineLoadSettings };
