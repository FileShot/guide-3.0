'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { parseToolCalls, repairToolCalls, stripToolCallText } = require('./tools/toolParser');
const { visionServer } = require('./visionServer');

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
    kvCacheType: raw.kvCacheType || 'q4_0',
  };
}

// Agent identity prompt — balanced identity, conditional tool use, anti-loop, STOP-after-tool
const SYSTEM_PROMPT = `You are guIDE, an autonomous AI agent with direct system access and access to tools for file editing, browsing, terminal commands, and more. Tool use is not appropriate in response to greetings, casual conversations, image analysis requests, or social chat. When the user asks you to DO something actionable, you MUST use the appropriate tool. You CANNOT say "I cannot," "I don't have access," or "I'm unable to" when the user asks for action.

## How to call tools
Output a fenced JSON block with "tool" and "params" keys. NEVER output raw JSON, braces, or backticks outside of a fenced code block. If you are not calling a tool, write normal prose with NO JSON syntax. After outputting a tool call, wait for the tool result before continuing.

Examples:

User: "What files are in this project?"
Assistant:
\`\`\`json
{"tool":"list_directory","params":{"path":"."}}
\`\`\`

User: "Create a todo list for adding auth, then mark the first task done"
Assistant:
\`\`\`json
{"tool":"write_todos","params":{"items":["Add login route to Express","Create JWT middleware"]}}
\`\`\`
\`\`\`json
{"tool":"update_todo","params":{"id":"auth-1","status":"completed"}}
\`\`\`

User: "Create a new file called utils.js with a helper function"
Assistant:
\`\`\`json
{"tool":"write_file","params":{"filePath":"utils.js","content":"function helper() {\n  return 'done';\n}\n\nmodule.exports = { helper };\n"}}
\`\`\`

User: "Append a log line to the end of app.log"
Assistant:
\`\`\`json
{"tool":"append_to_file","params":{"filePath":"app.log","content":"[INFO] Application started\n"}}
\`\`\`

User: "Change 'Hello' to 'Goodbye' in main.py"
Assistant:
\`\`\`json
{"tool":"edit_file","params":{"filePath":"main.py","old_string":"print('Hello')","new_string":"print('Goodbye')"}}
\`\`\`

User: "What is the latest version of React?"
Assistant:
\`\`\`json
{"tool":"web_search","params":{"query":"React latest version release notes"}}
\`\`\`
\`\`\`json
{"tool":"fetch_webpage","params":{"url":"https://react.dev/blog"}}
\`\`\`

User: "Go to example.com and click the login button"
Assistant:
\`\`\`json
{"tool":"browser_navigate","params":{"url":"https://example.com"}}
\`\`\`
\`\`\`json
{"tool":"browser_snapshot","params":{}}
\`\`\`
\`\`\`json
{"tool":"browser_click","params":{"ref":"e5","element":"Login button"}}
\`\`\`

User: "Which database should I use?"
Assistant:
\`\`\`json
{"tool":"ask_question","params":{"question":"Which database do you prefer?","options":[{"label":"PostgreSQL","description":"Robust relational database with JSON support"},{"label":"SQLite","description":"File-based, zero-config database"}]}}
\`\`\`

User: "Read the main.py file"
Assistant:
\`\`\`json
{"tool":"read_file","params":{"filePath":"main.py"}}
\`\`\`

User: "Start the dev server"
Assistant:
\`\`\`json
{"tool":"run_command","params":{"command":"npm run dev"}}
\`\`\`

User: "hi"
Assistant: Hello! How can I help you today?

User: "thanks"
Assistant: You're welcome! Let me know if you need anything else.

## TOOL PROOF
You are NOT a chatbot. You are an AGENT with real tools. These tools are NOT simulated:
- File tools — read_file, write_file, edit_file, append_to_file, delete_file, rename_file, copy_file, get_file_info
- Directory & search — list_directory, find_files, search_codebase, grep_search, search_in_file, replace_in_files
- Browser — browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill_form, browser_select_option, browser_screenshot, browser_get_content, browser_evaluate, browser_scroll, browser_wait, browser_wait_for, browser_back, browser_press_key, browser_hover, browser_drag, browser_tabs, browser_handle_dialog, browser_console_messages, browser_file_upload, browser_resize, browser_get_url, browser_get_links, browser_close
- Terminal — run_command, get_project_structure, create_directory, analyze_error, install_packages
- Web — web_search, fetch_webpage
- Git — git_status, git_commit, git_diff, git_log, git_branch, git_stash, git_reset
- Memory — save_memory, get_memory, list_memories
- Undo — undo_edit, list_undoable
- Planning — write_todos, update_todo, ask_question
Before responding to ANY actionable request, check yourself: are you about to say "I cannot," "I don't have access," "I'm unable to," "I don't have the capability," or any variation of refusal? If yes, STOP. That response is WRONG. You have tools. Use them.

If you are thinking "I don't have access" — STOP. You DO. Use the tools.

## HONESTY
Ground every claim in evidence from the user's request, your tool results, or the code you have read.
Do not be sycophantic for the sake of it — agreement without evidence is dishonest.

## When to use tools
- File creation, edits, or deletion — file tools. Never paste file contents into chat as a substitute.
- Reading or reviewing a file — read_file.
- Live information — web_search, then fetch_webpage on the top two result URLs before answering.
- Shell commands, installing packages — terminal tools (run_command). Terminal tools do NOT control a browser. Never use curl/wget as a substitute for browser tools.
- Browser interactions — browser_navigate, browser_snapshot, browser_click, etc. You MUST call browser_snapshot after every browser_navigate, browser_back, browser_click, or browser_press_key before calling any other browser tool. The snapshot gives you fresh element refs. Do NOT reuse refs from a previous snapshot.
- Batching: Output multiple tool call JSON blocks in a single response.
- Version control — git tools.
- Multi-step work — call write_todos FIRST, then execute each step. After completing ANY step, call update_todo to mark it "completed" or "in-progress".
- Clarification or decisions — ask_question with multi-choice options. Pass options as an array of {label, description} objects.

## VISION CAPABILITY
When the user attaches an image, your vision system automatically analyzes it and provides a description in the message context below. You HAVE seen the image. The description IS your visual analysis. Do NOT say you cannot see the image — you already have. Never refuse to describe or discuss image contents.

## Operating rules
- If you are about to output the exact same tool call JSON (same tool name + same parameters) that you already output earlier in this conversation, you are looping. Do NOT output it again. Try a different approach or call ask_question.
- If you called a tool and the result gave you no new information useful for the task, do not repeat that same call. Try a different approach or call ask_question.
- Call each tool at most once per distinct argument set. If a call fails, adjust the arguments and try a different shape; do not repeat identical calls. If a tool still fails after one retry, call ask_question to ask the user for guidance.
- After a tool returns, use its result and continue with the next step of the task. Do not stop until the task is complete or you call ask_question.
- After a tool returns, use its result. Do not re-ask for information the tool already provided.
- Ground web answers in fetched page content, not in training memory. Search snippets alone are never sufficient.
- If output is truncated, continue from the point of interruption. Do not restart or re-summarize what was already produced.
- If you are STUCK, you MUST call ask_question to ask the user for guidance. NEVER just end your response saying "it didn't work".
- If you are uncertain about any information, parameter, value, or next step, call ask_question. NEVER guess. Guessing causes errors. Asking prevents them.
- Vision: Images are automatically captioned. When you receive an image description in brackets, that IS the image content — do not call read_file on image files.

## USER-PROVIDED INFORMATION
When the user provides credentials, answers, or instructions via the ask_question tool, those answers ARE part of your context. You DO have them. Use them immediately when needed. Do NOT say you do not have access to them. Do NOT ask the user to provide them again.`;

class ChatEngine extends EventEmitter {
  constructor() {
    super();
    console.log('[ChatEngine] constructor START');
    this.isReady = false;
    this.isLoading = false;
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
    this._recentlyWrittenFiles = new Map(); // filePath → content written in current chat() call
    this._sessionId = 0; // increments on resetSession to detect stale tool results
    console.log('[ChatEngine] constructor DONE');
  }

  /**
   * @param {string} modelPath
   * @param {object} [rawLoadSettings] â€” from settingsManager.get() (gpuPreference, gpuLayers, contextSize, requireMinContextForGpu)
   */
  async initialize(modelPath, rawLoadSettings) {
    if (this.isLoading) throw new Error('Already loading a model');
    this.isLoading = true;
    this.emit('status', { state: 'loading', message: 'Loading model...' });

    try {
      const llamaCppPath = this._getNodeLlamaCppPath();
      const { getLlama, LlamaChat, readGgufFileInfo } = await import(pathToFileURL(llamaCppPath).href);

      const s = buildEngineLoadSettings(rawLoadSettings || {});
      this.gpuPreference = s.gpuPreference;

      if (this._model) await this._dispose();

      let trainMaxContext = null;
      let totalLayersFromGguf = null;
      let ggufArchMeta = null;
      try {
        const gguf = await readGgufFileInfo(modelPath, { readTensorInfo: false, logWarnings: false });
        const am = gguf.architectureMetadata;
        ggufArchMeta = am || null;
        if (am && typeof am.context_length === 'number') trainMaxContext = am.context_length;
        if (am && typeof am.block_count === 'number') totalLayersFromGguf = am.block_count;
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
        // RAM path: free system RAM minus model weights, half reserved for KV
        const freeRam = Math.max(0, os.freemem() - modelStats.size);
        const ramKvBudget = freeRam / 2;
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
        // Auto: min(hardware cap, train cap, 32K default ceiling).
        // 32K is a safe, reasonable default that avoids allocating massive KV caches
        // (e.g. 8GB+ for 262K) that starve GPU offloading and slow generation.
        // Users can manually set higher in settings if needed.
        const AUTO_DEFAULT_MAX = 32768;
        if (hardwareCap != null && trainMaxContext != null) {
          desiredMax = Math.min(hardwareCap, trainMaxContext, AUTO_DEFAULT_MAX);
        } else if (hardwareCap != null) {
          desiredMax = Math.min(hardwareCap, AUTO_DEFAULT_MAX);
        } else if (trainMaxContext != null) {
          desiredMax = Math.min(trainMaxContext, AUTO_DEFAULT_MAX);
        } else {
          desiredMax = AUTO_DEFAULT_MAX;
        }
      } else {
        desiredMax = s.contextSize;
        if (trainMaxContext != null) desiredMax = Math.min(desiredMax, trainMaxContext);
        desiredMax = Math.max(MIN_CONTEXT_FLOOR, desiredMax);
      }

      const minBase = s.requireMinContextForGpu ? MIN_CONTEXT_WHEN_GPU_REQUIRED : MIN_CONTEXT_FLOOR;
      const contextMin = Math.min(minBase, desiredMax);

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

      // KV cache quantization: resolve BEFORE loadModel so we can adjust fitContext
      const ALLOWED_KV_TYPES = new Set(['q3_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_0', 'f16']);
      const rawKvType = rawLoadSettings.kvCacheType || 'q4_0';
      const kvCacheType = ALLOWED_KV_TYPES.has(rawKvType) ? rawKvType : undefined;

      if (s.gpuPreference === 'cpu') {
        loadModelOpts.gpuLayers = 0;
      } else if (s.gpuLayers >= 0) {
        loadModelOpts.gpuLayers = s.gpuLayers;
      } else {
        // Compute GPU layers iteratively.
        // llama.cpp allocates the KV cache on the same device as each model layer,
        // so the GPU-proportional portion of the KV cache must fit in VRAM alongside
        // the model weights. This creates a circular dependency: gpuLayers depends on
        // kvOnGpu which depends on gpuLayers. We solve it by iterating until stable.
        const totalLayers = totalLayersFromGguf || 32;
        const bytesPerLayer = modelStats.size / totalLayers;
        const kvBytesForFullCtx = (kvBytesPerToken || 0) * desiredMax;
        const vramOverhead = 512 * 1024 * 1024; // 512MB for activations/buffers
        let computedGpuLayers = totalLayers; // start optimistic
        for (let i = 0; i < 10; i++) {
          const kvOnGpu = kvBytesForFullCtx * (computedGpuLayers / totalLayers);
          const availableForModel = vramFree - kvOnGpu - vramOverhead;
          const newGpuLayers = availableForModel > 0
            ? Math.max(0, Math.min(Math.floor(availableForModel / bytesPerLayer), totalLayers))
            : 0;
          if (newGpuLayers === computedGpuLayers) break; // converged
          computedGpuLayers = newGpuLayers;
        }
        const kvOnGpuFinal = kvBytesForFullCtx * (computedGpuLayers / totalLayers);
        console.log(`[ChatEngine] GPU layer computation: vramFree=${(vramFree/1e9).toFixed(2)}GB, kvFullCtx=${(kvBytesForFullCtx/1e9).toFixed(2)}GB, kvOnGpu=${(kvOnGpuFinal/1e9).toFixed(2)}GB, overhead=0.50GB, bytesPerLayer=${(bytesPerLayer/1e6).toFixed(1)}MB, gpuLayers=${computedGpuLayers}/${totalLayers}`);
        loadModelOpts.gpuLayers = computedGpuLayers;
      }

      this._model = await this._llama.loadModel(loadModelOpts);

      // Batch size: larger batch = faster prompt processing.
      // GPU models benefit from 1024 (more parallel prompt processing).
      // CPU-only models use 512 (less memory pressure).
      const batchSize = s.gpuPreference === 'cpu' ? 512 : 1024;

      // Threads: llama.cpp runs best on physical cores, not logical (HT causes cache thrashing).
      // os.availableParallelism() may return logical cores on some platforms,
      // so we always cap at half the logical count as a safe physical-core estimate.
      const logicalCores = os.cpus().length;
      const physicalCores = logicalCores > 1 ? Math.max(1, Math.floor(logicalCores / 2)) : 1;

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

      if (kvBytesPerToken > 0 && gpuLayerRatio > 0 && s.gpuPreference !== 'cpu') {
        // Measure actual VRAM free after model weights are loaded
        let vramFreeAfterModel = vramFree;
        try {
          const vs = await this._llama.getVramState();
          vramFreeAfterModel = vs?.free || vramFree;
        } catch (e) { console.warn('[ChatEngine] VRAM check after model load failed:', e.message); }
        // KV on GPU = kvBytesPerToken * contextSize * gpuLayerRatio
        // Available for KV = vramFreeAfterModel - buffer
        // contextSize = available / (kvBytesPerToken * gpuLayerRatio)
        const vramBuffer = 256 * 1024 * 1024; // 256MB safety buffer
        const maxCtxFromVram = Math.floor((vramFreeAfterModel - vramBuffer) / (kvBytesPerToken * gpuLayerRatio));
        computedCtxSize = Math.max(MIN_CONTEXT_FLOOR, Math.min(maxCtxFromVram, desiredMax));
        console.log(`[ChatEngine] Context size computation: vramFreeAfterModel=${(vramFreeAfterModel/1e9).toFixed(2)}GB, kvBpt=${kvBytesPerToken}, gpuRatio=${gpuLayerRatio.toFixed(2)}, maxCtxFromVram=${maxCtxFromVram}, computedCtxSize=${computedCtxSize}`);
      }

      // Create context with computed single-number size (bypasses f16-based fitting)
      try {
        this._context = await this._model.createContext({
          contextSize: computedCtxSize,
          flashAttention: s.gpuPreference !== 'cpu',
          ignoreMemorySafetyChecks: true,
          batchSize,
          threads: { ideal: physicalCores, min: 1 },
          experimentalKvCacheKeyType: kvCacheType,
          experimentalKvCacheValueType: kvCacheType,
        });
      } catch (ctxErr) {
        // Fallback: if q4_0 KV type isn't actually applied by llama.cpp,
        // the real KV size is f16 (4x larger). Recompute with f16 estimate.
        if (kvBytesPerToken > 0 && gpuLayerRatio > 0 && s.gpuPreference !== 'cpu') {
          let vramFreeAfterModel = vramFree;
          try {
            const vs = await this._llama.getVramState();
            vramFreeAfterModel = vs?.free || vramFree;
          } catch (e) { console.warn('[ChatEngine] VRAM check (f16 fallback) failed:', e.message); }
          const kvBytesF16 = kvBytesPerToken * 4;
          const vramBuffer = 256 * 1024 * 1024;
          const maxCtxF16 = Math.floor((vramFreeAfterModel - vramBuffer) / (kvBytesF16 * gpuLayerRatio));
          const fallbackCtxSize = Math.max(MIN_CONTEXT_FLOOR, Math.min(maxCtxF16, desiredMax));
          console.warn(`[ChatEngine] Context creation at ${computedCtxSize} failed (${ctxErr.message}), retrying with f16 estimate: ${fallbackCtxSize}`);
          this._context = await this._model.createContext({
            contextSize: fallbackCtxSize,
            flashAttention: s.gpuPreference !== 'cpu',
            ignoreMemorySafetyChecks: true,
            batchSize,
            threads: { ideal: physicalCores, min: 1 },
            experimentalKvCacheKeyType: kvCacheType,
            experimentalKvCacheValueType: kvCacheType,
          });
        } else {
          throw ctxErr;
        }
      }

      // Diagnostic: verify context creation
      const actualCtxSize = this._context?.contextSize;
      console.log(`[ChatEngine] Context created: ctx=${actualCtxSize}, gpuLayers=${actualGpuLayers}, flashAttn=${s.gpuPreference !== 'cpu'}, batchSize=${batchSize}, threads=${physicalCores}, kvCacheType=${kvCacheType || 'default'}, requestedSize=${computedCtxSize}`);

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
      this._chat = new LlamaChat({ contextSequence: this._sequence });
      this._chatHistory = [{ type: 'system', text: SYSTEM_PROMPT }];
      this._lastEvaluation = null;

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

      this.currentModelPath = modelPath;
      this.isReady = true;
      this.isLoading = false;

      // Check vision availability — do NOT auto-start. Vision starts on-demand when an image needs captioning.
      try {
        const visionCheck = visionServer.checkAvailability(modelPath);
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
      this.emit('status', { state: 'error', message: err.message });
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
    if (!this.isReady || !this._chat) throw new Error('Model not ready');

    const { onToken, onComplete, onContextUsage, onToolCall, onStreamEvent, systemPrompt, functions, toolPrompt, compactToolPrompt, executeToolFn, guideInstructionsPath } = options;

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
    if (options.askOnly) {
      // Ask mode: no tools available — just set the base prompt with mode instruction
      this._chatHistory[0].text = basePrompt;
    } else if (toolPrompt) {
      // Estimate token cost of tool prompt (~3.5 chars/token for English)
      const toolPromptTokens = Math.ceil(toolPrompt.length / 3.5);
      const toolPct = Math.round((toolPromptTokens / contextTokens) * 100);

      // Emit warning to UI when tool prompt consumes too much context
      if (toolPct > 50 && onStreamEvent) {
        onStreamEvent('generation-warning', {
          message: `Tool prompt uses ${toolPct}% of context (${toolPromptTokens.toLocaleString()}/${contextTokens.toLocaleString()} tokens)`,
          suggestion: 'Responses may be limited. Try a smaller model, reduce context in settings, or start a new session.',
        });
      }

      // Use compact prompt when tool prompt would consume >40% of context
      // (not just when ctx<8192 — a 13K tool prompt in 14K ctx is equally disastrous)
      // Decision is based on CONTEXT SIZE, not model parameters — small models in 2026
      // have huge context windows (128K+), so model size doesn't determine prompt style.
      const useCompact = compactToolPrompt && (contextTokens < 8192 || toolPct > 40);
      let effectiveToolPrompt = useCompact ? compactToolPrompt : toolPrompt;

      // If even the compact prompt is too large, progressively trim it
      if (useCompact && typeof effectiveToolPrompt === 'string') {
        const compactPct = Math.round((Math.ceil(effectiveToolPrompt.length / 3.5) / contextTokens) * 100);
        if (compactPct > 50) {
          // Strip everything after the first 8 tool descriptions — keep format header + core tools
          const lines = effectiveToolPrompt.split('\n');
          const toolLineIdx = [];
          lines.forEach((l, i) => { if (l.startsWith('- **')) toolLineIdx.push(i); });
          if (toolLineIdx.length > 8) {
            effectiveToolPrompt = lines.slice(0, toolLineIdx[8]).join('\n') + '\n…and more tools available\n';
          }
        }
      }

      this._chatHistory[0].text = basePrompt + '\n\n' + effectiveToolPrompt;
      const finalPct = Math.round((Math.ceil(effectiveToolPrompt.length / 3.5) / contextTokens) * 100);
      console.log(`[ChatEngine] Tool prompt injected (${effectiveToolPrompt.length} chars${useCompact ? ', compact' : ''}, ctx=${contextTokens}, finalPct=${finalPct}%, compactAvailable=${!!compactToolPrompt})`);
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
      const _sfStreamedFileWrites = new Set();
      let _sfVisibleChars = 0; // tracks chars forwarded to frontend (after filter removes tool JSON)

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
              if (thinkContent && onStreamEvent && !_thinkingFilterEnabled) {
                onStreamEvent('llm-thinking-token', thinkContent);
                onStreamEvent('llm-thinking-end', {
                  position: _sfVisibleChars,
                  length: thinkContent.length,
                  content: thinkContent
                });
              }
              console.log('[ChatEngine] </think> closed — thinking block: ' + (thinkContent || '').length + ' chars');
              _sfInThink = false;
              _sfThinkBuf = '';
              continue;
            }
            // Plan I: detect tool fence ``` inside think mode — model emitted a tool call
            // without first closing think. Treat as implicit close; flush thinking content;
            // re-enter fence mode so the tool call is parsed normally instead of lost as text.
            if (_sfThinkBuf.endsWith('\n```') || _sfThinkBuf === '```') {
              const fenceStart = _sfThinkBuf.lastIndexOf('```');
              const thinkContent = _sfThinkBuf.slice(0, fenceStart).replace(/\n$/, '');
              if (thinkContent && onStreamEvent && !_thinkingFilterEnabled) {
                onStreamEvent('llm-thinking-token', thinkContent);
                onStreamEvent('llm-thinking-end', {
                  position: _sfVisibleChars,
                  length: thinkContent.length,
                  content: thinkContent
                });
              }
              console.log('[ChatEngine] tool fence inside <think> — implicit close, entering fence mode');
              _sfInThink = false;
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
              if (toEmit && onStreamEvent && !_thinkingFilterEnabled) {
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
              // Full open match — enter thinking mode, discard the tag
              _sfInThink = true;
              _sfThinkBuf = '';
              _sfThinkTagMatch = '';
              if (onStreamEvent && !_thinkingFilterEnabled) {
                onStreamEvent('llm-thinking-start', { position: _sfVisibleChars });
              }
              console.log('[ChatEngine] <think> tag detected — routing thinking to llm-thinking-token (raw text path)');
              continue;
            } else if (_sfThinkTagMatch === CLOSE_TAG) {
              // Orphan </think> in normal mode — silently consume; preceding visible content stays as prose.
              console.log('[ChatEngine] orphan </think> consumed — no preceding <think>');
              _sfThinkTagMatch = '';
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
              // Suppress only if this looks like a tool call schema:
              // - "tool":"<name>" (strongest signal), OR
              // - "name":"<snake_case>" + "params":{ (two signals together)
              if (RE_TOOL_KEY.test(_sfFenceBuf) || (RE_NAME_KEY.test(_sfFenceBuf) && RE_PARAMS_KEY.test(_sfFenceBuf))) {
                _sfFenceBuf = '';
              } else {
                _sfFlushFence();
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
      let thinkBudget = options.thinkingBudget;
      const reasoningEffort = options.reasoningEffort;
      if ((!thinkBudget || thinkBudget === 0) && reasoningEffort) {
        if (reasoningEffort === 'low') thinkBudget = 512;
        else if (reasoningEffort === 'medium') thinkBudget = 2048;
        else if (reasoningEffort === 'high') thinkBudget = 8192;
      }
      const genOptions = {
        signal: this._abortController.signal,
        stopOnAbortSignal: true,
        temperature: options.temperature ?? 0.4,
        topP: options.topP,
        topK: options.topK,
        repeatPenalty: { penalty: options.repeatPenalty ?? 1.1 },
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
          if (chunk.type === 'segment' && chunk.text && onStreamEvent && !_thinkingFilterEnabled) {
            onStreamEvent('llm-thinking-token', chunk.text);
            // Diagnostic: log first native thinking segment so we can confirm this path fires
            if (!this._nativeThinkLogged) {
              this._nativeThinkLogged = true;
              console.log('[ChatEngine] ✓ Thinking via native onResponseChunk segment API (QWOPUS/distilled path)');
            }
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

      // Raw-text tool call loop: parse tool calls from model output, execute, continue
      if (executeToolFn) {
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
          const { repaired } = repairToolCalls(parsedCalls, fullResponse);
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
            const FILE_WRITE_OPS = new Set(['write_file', 'create_file', 'append_to_file']);
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
            text: `${userInterruptPrefix}[Tool Results]\n${toolResultLines.join('\n')}${relatedSection}\n\nContinue with the remaining steps of the task. Call the next tool if more work is needed, or explain the result if the task is complete.`
          });
          console.log(`[ChatEngine] ─── TOOL RESULTS → MODEL ─── ${toolResultLines.length} result(s), ${relatedFileLines.length} related file(s), interrupt=${!!this._pendingUserMessage}`);
          console.log(`[ChatEngine] Tool result summary: ${toolResultLines.join(' | ')}`);

          // ─── Context compaction between tool rounds ───
          // Root cause of slow prefill: each round re-prefills the ENTIRE history.
          // Browser snapshots are the worst offender — 5-10KB of page DOM per result.
          // The model only needs the CURRENT page state, not full DOMs from 5 pages ago.
          // Solution: strip snapshot text from old results, keep only URL/title/status.
          // Only the most recent tool result message retains full content.
          if (this._chatHistory.length > 6) {
            const toolResultIndices = [];
            for (let i = 0; i < this._chatHistory.length; i++) {
              if (this._chatHistory[i].type === 'user' && this._chatHistory[i].text.startsWith('[Tool Results]')) {
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

          // Only clear KV cache after write tools (which cause attention-pattern contamination).
          // Browser tools, read_file, and other non-mutation tools do NOT contaminate the KV cache.
          // Preserving the cache eliminates the 40-90s full-prefill penalty between tool rounds.
          const writeToolsExecuted = parsedCalls.some(c =>
            ['write_file', 'edit_file', 'append_to_file'].includes(c.tool)
          );
          if (writeToolsExecuted) {
            genOptions.lastEvaluationContextWindow = undefined;
            try { this._sequence?.clearHistory(); } catch (_) {}
            console.log('[ChatEngine] KV cache cleared after write tools');
          } else {
            console.log('[ChatEngine] KV cache preserved — fast prefill enabled');
          }

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

      }

      this._lastEvaluation = result.lastEvaluation;
      if (result.lastEvaluation?.cleanHistory) {
        console.log(`[ChatEngine] Applying cleanHistory from lastEvaluation: ${result.lastEvaluation.cleanHistory.length} msgs`);
        this._chatHistory = result.lastEvaluation.cleanHistory;
      }
      const stopReason = result.metadata?.stopReason || 'natural';

      console.log(`[ChatEngine] Generation complete. Tool calls: ${totalToolCalls}, stopReason=${stopReason}, responseLen=${fullResponse.length}`);

      // Inference speed diagnostic
      const ctxUsedTokens = this._sequence?.nextTokenIndex || 0;
      const totalCtx = this._context?.contextSize || 0;
      const gpuLayers = this.modelInfo?.gpuLayers || 0;
      const totalLayers = this.modelInfo?.totalLayers || gpuLayers;
      const ctxPct = totalCtx > 0 ? Math.round((ctxUsedTokens / totalCtx) * 100) : 0;
      const totalGenElapsed = (Date.now() - genStartTime) / 1000;
      const avgTokPerSec = totalGenElapsed > 0 && genTokenCount > 0 ? (genTokenCount / totalGenElapsed).toFixed(1) : '?';
      console.log(`[ChatEngine] Inference diagnostic: ctx=${ctxUsedTokens}/${totalCtx} (${ctxPct}%), gpuLayers=${gpuLayers}/${totalLayers}, responseLen=${fullResponse.length}, genTokens=${genTokenCount}, totalTime=${totalGenElapsed.toFixed(1)}s, avgTok/s=${avgTokPerSec}, model=${this.modelInfo?.name}`);
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

      // Emit error to UI when generation produced nothing useful (but NOT if user manually stopped)
      if (!fullResponse.trim() && stopReason !== 'cancelled' && stopReason !== 'abort' && onStreamEvent) {
        console.warn(`[ChatEngine] Empty response warning: stopReason=${stopReason}, contextTokens=${contextTokens}`);
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
    } else {
      console.warn('[ChatEngine] cancelGeneration: no abortController exists');
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
      const subChat = new LlamaChat({ contextSequence: subSequence });
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
      return {
        name,
        memoryTotal: parseFloat(memTotal),
        memoryUsed: parseFloat(memUsed),
        memoryFree: parseFloat(memFree),
        gpuUtilization: parseFloat(utilGpu),
        temperature: parseFloat(temp),
      };
    } catch (e) {
      console.warn(`[ChatEngine] getGPUInfo failed: ${e.message}`);
      return { name: 'Unknown', memoryTotal: 0, memoryUsed: 0, memoryFree: 0, gpuUtilization: 0, temperature: 0 };
    }
  }

  async dispose() {
    console.log('[ChatEngine] dispose START');
    await this._dispose();
    this.isReady = false;
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

    // If system + lastItem exceeds budget, truncate lastItem (keeps end)
    if (chatHistory.length > 1 && systemTokens + lastItemTokens > budget) {
      const availableForLastItem = budget - systemTokens - 20;
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
    }

    // Pure sliding window: keep most recent messages that fit, no pinning
    let used = systemTokens + lastItemTokens;
    const keptIndices = new Set();

    for (let i = chatHistory.length - 2; i >= 1; i--) {
      const cost = estimateTokens(chatHistory[i]);
      if (used + cost > budget) break;
      used += cost;
      keptIndices.add(i);
    }

    const droppedCount = (chatHistory.length - 2) - keptIndices.size;
    const newHistory = [systemItem];
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
