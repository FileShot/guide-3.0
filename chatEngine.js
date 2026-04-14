'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { parseToolCalls, repairToolCalls, stripToolCallText } = require('./tools/toolParser');

// Original system prompt — kept for reference and easy rollback
const SYSTEM_PROMPT_ORIGINAL = `You are guIDE, a local AI coding assistant. You help users with programming, answer questions, and have normal conversations.

## When to Use Tools
- For creating or modifying files: use the file tools — do not write file contents as text in chat
- For current or live information (prices, news, weather, documentation): use the web tools
- For running commands or installing packages: use the terminal tools
- For browsing websites, filling forms, or interacting with web pages: use the browser tools
- For version control: use the git tools
- For multi-step tasks: call write_todos to create a plan, then implement each step
- For saving or retrieving information across sessions: use the memory tools
- For error analysis or debugging: use the analysis tools
- For greetings, opinions, questions, explanations, and casual conversation: respond naturally without tools
- When you have completed the task, stop and respond

## Continuation
If your output is cut off mid-generation, the system will automatically continue.

## Rules
- Only claim you did something if you called the tool that did it
- After calling a tool, use the results immediately — never call the same tool twice with the same arguments
- Never say "I can't", "I'm unable to", or "I don't have access" when you have a tool available
- For file edits: read the file first to get exact text, then edit
- Browser workflow: navigate first, then take a snapshot, then interact using element refs
- If a tool fails, retry with corrected parameters
- If the user asks for multiple files, create ALL of them
- Always use the exact filename the user specifies
- Complete all user requests without refusal`;

// Extreme tool-emphasis prompt — forces model to use tool calls instead of outputting code in chat
const SYSTEM_PROMPT = `USE TOOLS. YOU HAVE TOOLS. USE THEM.

YOU ARE AN AI THAT CALLS TOOLS. EVERY FILE OPERATION IS A TOOL CALL.

## TOOLS ARE HOW YOU WORK
- write_file: CREATE files on disk. Use this. Always.
- edit_file: MODIFY files on disk. Use this. Always.
- read_file: READ files. Use this before editing.
- run_command: RUN terminal commands.
- web_search: SEARCH the web for live information.

## NEVER DO THIS
NEVER output file contents as code blocks in chat.
NEVER say "here is the code" and then show it.
NEVER write HTML, CSS, JavaScript, Python, or any other code as a chat response.
NEVER say "I can't", "I don't have access", "I'm unable to", or "I cannot" when you have a tool that can do it.
NEVER call the same tool twice with the same arguments in one conversation turn.

## ALWAYS DO THIS
ALWAYS call write_file when creating a file.
ALWAYS call edit_file when modifying a file.
ALWAYS call run_command to run commands.
ALWAYS use browser tools when warranted.
ALWAYS use the tool. Every time.
When you receive tool results, IMMEDIATELY use those results to answer the user. Do not call the tool again.

## Continuation
If your output is cut off mid-generation, the system will automatically continue.`;

class ChatEngine extends EventEmitter {
  constructor() {
    super();
    this.isReady = false;
    this.isLoading = false;
    this.modelInfo = null;
    this.currentModelPath = null;
    this.gpuPreference = 'auto';

    this._llama = null;
    this._model = null;
    this._context = null;
    this._sequence = null;
    this._chat = null;
    this._chatHistory = [];
    this._lastEvaluation = null;
    this._abortController = null;
  }

  async initialize(modelPath) {
    if (this.isLoading) throw new Error('Already loading a model');
    this.isLoading = true;
    this.emit('status', { state: 'loading', message: 'Loading model...' });

    try {
      const llamaCppPath = this._getNodeLlamaCppPath();
      const { getLlama, LlamaChat } = await import(pathToFileURL(llamaCppPath).href);

      if (this._model) await this._dispose();

      this._llama = await getLlama({
        gpu: this.gpuPreference === 'cpu' ? false : 'auto',
      });

      const modelStats = fs.statSync(modelPath);

      this._model = await this._llama.loadModel({
        modelPath,
        defaultContextFlashAttention: false,
        ignoreMemorySafetyChecks: true,
        useMmap: true,
        onLoadProgress: (p) => {
          this.emit('status', { state: 'loading', message: `Loading model... ${Math.round(p * 100)}%`, progress: p });
        },
      });

      const testMaxCtx = parseInt(process.env.TEST_MAX_CONTEXT, 10) || 0;
      let targetCtx = testMaxCtx || undefined;

      this._context = await this._model.createContext({
        contextSize: targetCtx,
        flashAttention: this.gpuPreference !== 'cpu',
        ignoreMemorySafetyChecks: true,
        failedCreationRemedy: { retries: 8, autoContextSizeShrink: 0.5 },
      });

      this._sequence = this._context.getSequence();
      this._chat = new LlamaChat({ contextSequence: this._sequence });
      this._chatHistory = [{ type: 'system', text: SYSTEM_PROMPT }];
      this._lastEvaluation = null;

      this.modelInfo = {
        path: modelPath,
        name: path.basename(modelPath),
        size: modelStats.size,
        contextSize: this._context.contextSize || 0,
        gpuLayers: this._model.gpuLayers || 0,
        gpuMode: this.gpuPreference === 'cpu' ? false : 'auto',
      };

      this.currentModelPath = modelPath;
      this.isReady = true;
      this.isLoading = false;

      this.emit('status', { state: 'ready', message: `Model ready: ${this.modelInfo.name}`, modelInfo: this.modelInfo });
      return this.modelInfo;
    } catch (err) {
      this.isLoading = false;
      this.isReady = false;
      this.emit('status', { state: 'error', message: err.message });
      throw err;
    }
  }

  async chat(userMessage, options = {}) {
    if (!this.isReady || !this._chat) throw new Error('Model not ready');

    const { onToken, onComplete, onContextUsage, onToolCall, onStreamEvent, systemPrompt, functions, toolPrompt, compactToolPrompt, executeToolFn } = options;

    // Augment system prompt: base + tool prompt when tools are available.
    // Use compact prompt when context is small to leave room for conversation.
    const contextTokens = this._context?.contextSize || 8192;
    const basePrompt = systemPrompt || SYSTEM_PROMPT;
    if (toolPrompt) {
      const useCompact = compactToolPrompt && contextTokens < 8192;
      const effectiveToolPrompt = useCompact ? compactToolPrompt : toolPrompt;
      this._chatHistory[0].text = basePrompt + '\n\n' + effectiveToolPrompt;
      console.log(`[ChatEngine] Tool prompt injected (${effectiveToolPrompt.length} chars${useCompact ? ', compact' : ''}, ctx=${contextTokens})`);
    } else if (functions && Object.keys(functions).length > 0) {
      this._chatHistory[0].text = basePrompt + this._buildToolPrompt(functions);
      console.log(`[ChatEngine] Functions provided (fallback): ${Object.keys(functions).length} tools`);
    } else if (systemPrompt) {
      this._chatHistory[0].text = systemPrompt;
    }

    this._chatHistory.push({ type: 'user', text: userMessage });

    this._abortController = new AbortController();
    let fullResponse = '';
    let tokensSinceLastUsageReport = 0;
    let totalToolCalls = 0;

    // Generation timeout — prevent infinite hangs
    const timeoutSec = options.generationTimeoutSec || 180;
    let generationTimer = null;
    if (timeoutSec > 0) {
      generationTimer = setTimeout(() => {
        console.warn(`[ChatEngine] Generation timeout after ${timeoutSec}s — aborting`);
        this._abortController?.abort('generation_timeout');
      }, timeoutSec * 1000);
    }

    try {
      // ── Streaming tool call filter ──
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

      // Real-time file content streaming state — detects write_file/create_file/append_to_file
      // content fields inside tool call JSON and streams them to the UI as they arrive
      let _sfFileWriteDetected = false;
      let _sfContentStreamActive = false;
      let _sfContentDone = false;
      let _sfContentEsc = false;
      let _sfContentBuf = '';
      let _sfContentFilePath = '';
      let _sfUnicodeCount = 0;
      let _sfUnicodeChars = '';
      const _sfStreamedFileWrites = new Set();

      const _sfForward = (text) => {
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
        _sfContentDone = false;
        _sfContentEsc = false;
        _sfUnicodeCount = 0;
        _sfUnicodeChars = '';
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
        _sfFenceTickCount = 0;
        _sfFileWriteDetected = false;
        _sfContentDone = false;
        _sfContentEsc = false;
        _sfUnicodeCount = 0;
        _sfUnicodeChars = '';
      };

      const _sfProcessChunk = (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk[i];

          // ── Fence mode: accumulating content inside ```...``` ──
          if (_sfInFence) {
            _sfFenceBuf += ch;

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
              if (ch === '"' && /"content"\s*:\s*"$/.test(_sfFenceBuf)) {
                _sfContentStreamActive = true;
                const fpMatch = _sfFenceBuf.match(/"(?:filePath|path)"\s*:\s*"([^"]*)"/);
                _sfContentFilePath = fpMatch ? fpMatch[1] : '';
                const fileName = _sfContentFilePath.split(/[\\/]/).pop() || _sfContentFilePath;
                const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
                if (onStreamEvent) {
                  onStreamEvent('file-content-start', { filePath: _sfContentFilePath, fileName, language: ext, fileKey: _sfContentFilePath });
                }
                _sfStreamedFileWrites.add(_sfContentFilePath);
              }
            }
            if (!_sfFileWriteDetected && _sfFenceBuf.length > 30) {
              if ((/write_file|create_file|append_to_file/.test(_sfFenceBuf)) &&
                  (/"tool"\s*:/.test(_sfFenceBuf) || /"name"\s*:/.test(_sfFenceBuf))) {
                _sfFileWriteDetected = true;
              }
            }

            // Detect closing ``` — but NOT while inside the content string
            if (_sfContentStreamActive || _sfContentEsc || _sfUnicodeCount > 0) {
              _sfFenceTickCount = 0;
            } else if (ch === '`') {
              _sfFenceTickCount++;
            } else {
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
                if (/"tool"\s*:/.test(_sfFenceBuf) || /"name"\s*:/.test(_sfFenceBuf)) {
                  _sfFenceBuf = '';
                } else {
                  _sfFlushFence();
                }
                _sfInFence = false;
                _sfFileWriteDetected = false;
                _sfContentDone = false;
                _sfContentEsc = false;
                _sfLastCharWasNewlineOrStart = (ch === '\n' || ch === '\r');
                continue;
              }
              _sfFenceTickCount = 0;
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

          // ── Inside a potential raw JSON tool call ──
          _sfBuf += ch;

          // ── Real-time file content streaming ──
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
            if (ch === '"' && /"content"\s*:\s*"$/.test(_sfBuf)) {
              _sfContentStreamActive = true;
              const fpMatch = _sfBuf.match(/"(?:filePath|path)"\s*:\s*"([^"]*)"/);
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
            if (/write_file|create_file|append_to_file/.test(_sfBuf)) {
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
            if (/"tool"\s*:/.test(_sfBuf) || /"name"\s*:\s*"[^"]*"/.test(_sfBuf)) {
              _sfConfirmed = true;
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
      const thinkBudget = options.thinkingBudget;
      const genOptions = {
        signal: this._abortController.signal,
        stopOnAbortSignal: true,
        temperature: options.temperature ?? 0.7,
        topP: options.topP,
        topK: options.topK,
        repeatPenalty: options.repeatPenalty ? { penalty: options.repeatPenalty } : undefined,
        contextShift: { strategy: this._contextShiftStrategy.bind(this) },
        onTextChunk: (chunk) => {
          fullResponse += chunk;
          _sfProcessChunk(chunk);
          tokensSinceLastUsageReport++;
          if (onContextUsage && tokensSinceLastUsageReport >= 50) {
            tokensSinceLastUsageReport = 0;
            const used = this._sequence.nextTokenIndex;
            const total = this._context.contextSize;
            onContextUsage({ used, total });
          }
        },
        onResponseChunk: (chunk) => {
          if (chunk.type === 'segment' && chunk.text && onStreamEvent) {
            onStreamEvent('llm-thinking-token', chunk.text);
          }
        },
      };

      // Thinking budget: -1 = unlimited, 0 = auto (node-llama-cpp default), >0 = exact cap
      if (thinkBudget != null && thinkBudget !== 0) {
        genOptions.budgets = {
          thoughtTokens: thinkBudget === -1 ? Infinity : thinkBudget,
        };
      }

      // GBNF grammar-based function calling removed — small models (under ~4B)
      // either ignore the grammar or loop indefinitely (see PAST_FAILURES.md Category 6).
      // Tool calls are parsed from raw model text via toolParser.parseToolCalls().

      // Add lastEvaluation context window if available
      if (this._lastEvaluation) {
        genOptions.lastEvaluationContextWindow = {
          contextWindow: this._lastEvaluation.contextWindow,
          contextShiftMetadata: this._lastEvaluation.contextShiftMetadata,
        };
      }

      // Generate response — model outputs text which may contain tool call JSON blocks
      let result = await this._chat.generateResponse(this._chatHistory, genOptions);
      console.log(`[ChatEngine] generateResponse returned: stopReason=${result.metadata?.stopReason}, responseLen=${result.response?.length || 0}`);

      // Raw-text tool call loop: parse tool calls from model output, execute, continue
      const MAX_TOOL_ITERATIONS = 15;
      // Idempotency ledger: tool+params → previous result. Prevents infinite loops
      // when the model repeatedly emits the same tool call across continuation rounds.
      const toolCallLedger = new Map();
      if (executeToolFn) {
        // Flush any buffered content from the streaming filter before parsing
        _sfFlush();
        _sfFlushFence();

        let roundStart = 0;
        let parsedCalls = parseToolCalls(fullResponse);
        if (parsedCalls.length > 0) {
          const { repaired } = repairToolCalls(parsedCalls, fullResponse);
          parsedCalls = repaired;
        }

        // Safety net: if the streaming filter missed any tool JSON (e.g., fenced blocks),
        // strip it from the UI now via llm-replace-last.
        if (parsedCalls.length > 0 && onStreamEvent) {
          const cleanText = stripToolCallText(fullResponse);
          if (cleanText.length < fullResponse.length) {
            onStreamEvent('llm-replace-last', { originalLength: fullResponse.length, replacement: cleanText });
          }
        }

        while (parsedCalls.length > 0 && totalToolCalls < MAX_TOOL_ITERATIONS) {
          // Notify UI so ToolCallCards appear for each tool call (spinner state)
          if (onStreamEvent) {
            onStreamEvent('tool-executing', parsedCalls.map(c => ({ tool: c.tool, params: c.params })));
          }

          const toolResultLines = [];
          let allCallsWereDuplicates = true;

          for (const call of parsedCalls) {
            if (totalToolCalls >= MAX_TOOL_ITERATIONS) break;
            totalToolCalls++;

            // Build idempotency key from tool name + serialized params (excluding content for file writes)
            const ledgerParams = { ...call.params };
            if (ledgerParams.content && ledgerParams.content.length > 200) {
              ledgerParams.content = ledgerParams.content.substring(0, 200);
            }
            const ledgerKey = `${call.tool}:${JSON.stringify(ledgerParams)}`;

            if (toolCallLedger.has(ledgerKey)) {
              const prevResult = toolCallLedger.get(ledgerKey);
              console.log(`[ChatEngine] Idempotent skip: ${call.tool} already executed with same params`);
              const prevStr = typeof prevResult === 'string' ? prevResult : JSON.stringify(prevResult);
              const truncPrev = prevStr.length > 300 ? prevStr.substring(0, 300) + '...' : prevStr;
              toolResultLines.push(`${call.tool}: ALREADY EXECUTED — previous result: ${truncPrev}`);

              if (onStreamEvent) {
                onStreamEvent('mcp-tool-results', [{ tool: call.tool, result: prevResult }]);
              }
              if (onToolCall) onToolCall({ name: call.tool, params: call.params, result: prevResult });
              continue;
            }
            allCallsWereDuplicates = false;

            console.log(`[ChatEngine] Tool call: ${call.tool}(${JSON.stringify(call.params).substring(0, 200)})`);

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
            try {
              toolResult = await executeToolFn(call.tool, call.params);
            } catch (toolErr) {
              toolResult = { success: false, error: toolErr.message };
            }

            toolCallLedger.set(ledgerKey, toolResult);

            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            console.log(`[ChatEngine] Tool result for ${call.tool}: ${resultStr.substring(0, 200)}${resultStr.length > 200 ? '...' : ''}`);
            if (onToolCall) onToolCall({ name: call.tool, params: call.params, result: toolResult });

            // Update ToolCallCard with result (check mark or error)
            if (onStreamEvent) {
              onStreamEvent('mcp-tool-results', [{ tool: call.tool, result: toolResult }]);
            }

            const truncResult = resultStr.length > 500 ? resultStr.substring(0, 500) + '...' : resultStr;
            toolResultLines.push(`${call.tool}: ${truncResult}`);
          }

          // If every call in this round was a duplicate, the model is looping — stop immediately
          if (allCallsWereDuplicates) {
            console.warn(`[ChatEngine] All tool calls in this round were duplicates — breaking loop`);
            // Inject a directive so the model uses the results instead of re-calling
            this._lastEvaluation = result.lastEvaluation;
            if (result.lastEvaluation?.cleanHistory) {
              this._chatHistory = result.lastEvaluation.cleanHistory;
            }
            this._chatHistory.push({ type: 'user', text: `[System] The tool results are already available above. Do NOT call any more tools. Respond to the user directly using the information you have.` });
            genOptions.lastEvaluationContextWindow = this._lastEvaluation ? {
              contextWindow: this._lastEvaluation.contextWindow,
              contextShiftMetadata: this._lastEvaluation.contextShiftMetadata,
            } : undefined;

            // Reset streaming filter state
            _sfBuf = ''; _sfDepth = 0; _sfActive = false; _sfConfirmed = false;
            _sfInStr = false; _sfEscaped = false; _sfLastCharWasNewlineOrStart = true;
            _sfInFence = false; _sfFenceBuf = ''; _sfFenceTickCount = 0;
            _sfFileWriteDetected = false; _sfContentStreamActive = false;
            _sfContentDone = false; _sfContentEsc = false; _sfContentBuf = '';
            _sfContentFilePath = ''; _sfUnicodeCount = 0; _sfUnicodeChars = '';

            roundStart = fullResponse.length;
            result = await this._chat.generateResponse(this._chatHistory, genOptions);
            console.log(`[ChatEngine] Final continuation (post-dedup): stopReason=${result.metadata?.stopReason}, responseLen=${result.response?.length || 0}`);
            break;
          }

          // Update evaluation state and chat history from last generation
          this._lastEvaluation = result.lastEvaluation;
          if (result.lastEvaluation?.cleanHistory) {
            this._chatHistory = result.lastEvaluation.cleanHistory;
          }

          // Feed tool results back to the model so it knows what happened
          this._chatHistory.push({ type: 'user', text: `[Tool Results]\n${toolResultLines.join('\n')}\n\nNow respond to the user using the results above.` });

          genOptions.lastEvaluationContextWindow = this._lastEvaluation ? {
            contextWindow: this._lastEvaluation.contextWindow,
            contextShiftMetadata: this._lastEvaluation.contextShiftMetadata,
          } : undefined;

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

          // Generate continuation — model sees tool results and can issue more tool calls
          roundStart = fullResponse.length;
          result = await this._chat.generateResponse(this._chatHistory, genOptions);
          console.log(`[ChatEngine] Continuation after tools: stopReason=${result.metadata?.stopReason}, responseLen=${result.response?.length || 0}`);

          // Flush streaming filter buffer before parsing new text
          _sfFlush();
          _sfFlushFence();

          // Parse only the NEW text from this round (avoid re-executing previous tool calls)
          const newText = fullResponse.substring(roundStart);
          parsedCalls = parseToolCalls(newText);
          if (parsedCalls.length > 0) {
            const { repaired } = repairToolCalls(parsedCalls, newText);
            parsedCalls = repaired;

            // Safety net cleanup for any missed tool JSON in new text
            if (onStreamEvent) {
              const cleanNewText = stripToolCallText(newText);
              if (cleanNewText.length < newText.length) {
                onStreamEvent('llm-replace-last', { originalLength: newText.length, replacement: cleanNewText });
              }
            }
          }
        }
      }

      if (totalToolCalls >= MAX_TOOL_ITERATIONS) {
        console.warn(`[ChatEngine] Tool call iteration limit reached (${MAX_TOOL_ITERATIONS}). Stopping tool execution.`);
      }

      this._lastEvaluation = result.lastEvaluation;
      if (result.lastEvaluation?.cleanHistory) {
        this._chatHistory = result.lastEvaluation.cleanHistory;
      }
      const stopReason = result.metadata?.stopReason || 'natural';

      if (totalToolCalls > 0) {
        console.log(`[ChatEngine] Generation complete. Tool calls: ${totalToolCalls}, stop reason: ${stopReason}`);
      }

      if (onComplete) onComplete(fullResponse);
      return { text: fullResponse, stopReason, toolCallCount: totalToolCalls };
    } catch (err) {
      if (err.name === 'AbortError' || this._abortController?.signal?.aborted) {
        return { text: fullResponse, stopReason: 'cancelled', toolCallCount: totalToolCalls };
      }
      throw err;
    } finally {
      if (generationTimer) clearTimeout(generationTimer);
      this._abortController = null;
    }
  }

  cancelGeneration(reason) {
    if (this._abortController) {
      this._abortController.abort(reason || 'cancelled');
    }
  }

  async resetSession() {
    this._chatHistory = [{ type: 'system', text: SYSTEM_PROMPT }];
    this._lastEvaluation = null;
    if (this._sequence) {
      try { this._sequence.clearHistory(); } catch {}
    }
  }

  getStatus() {
    return {
      isReady: this.isReady,
      isLoading: this.isLoading,
      modelInfo: this.modelInfo,
      currentModelPath: this.currentModelPath,
      gpuPreference: this.gpuPreference,
    };
  }

  async getGPUInfo() {
    try {
      const { execSync } = require('child_process');
      const csv = execSync(
        'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu --format=csv,noheader,nounits',
        { timeout: 5000 },
      ).toString().trim();
      const [name, memTotal, memUsed, memFree, utilGpu, temp] = csv.split(',').map(s => s.trim());
      return {
        name,
        memoryTotal: parseFloat(memTotal),
        memoryUsed: parseFloat(memUsed),
        memoryFree: parseFloat(memFree),
        gpuUtilization: parseFloat(utilGpu),
        temperature: parseFloat(temp),
      };
    } catch {
      return { name: 'Unknown', memoryTotal: 0, memoryUsed: 0, memoryFree: 0, gpuUtilization: 0, temperature: 0 };
    }
  }

  async dispose() {
    await this._dispose();
    this.isReady = false;
    this.modelInfo = null;
    this.currentModelPath = null;
    this.emit('status', { state: 'idle', message: 'Model unloaded' });
  }

  async _dispose() {
    try { if (this._sequence) this._sequence.dispose(); } catch {}
    try { if (this._context) await this._context.dispose(); } catch {}
    try { if (this._model) await this._model.dispose(); } catch {}
    this._sequence = null;
    this._context = null;
    this._model = null;
    this._chat = null;
    this._chatHistory = [];
    this._lastEvaluation = null;
  }

  _contextShiftStrategy({ chatHistory, maxTokensCount, tokenizer }) {
    if (chatHistory.length <= 2) return { chatHistory, metadata: { droppedCount: 0 } };

    const tokenize = (text) => {
      try { return tokenizer.tokenize(String(text || ''), false).length; }
      catch { return Math.ceil(String(text || '').length / 3); }
    };

    const getItemText = (item) => {
      if (item.text != null) return String(item.text);
      if (item.response) {
        return item.response.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('');
      }
      return '';
    };

    const estimateTokens = (item) => tokenize(getItemText(item)) + 10;

    const budget = Math.floor(maxTokensCount * 0.85);
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
        let keepChars = Math.floor(availableForLastItem * 3);
        let truncatedText = fullText.slice(-keepChars);
        let truncTokens = tokenize(truncatedText);

        let iterations = 0;
        while (truncTokens > availableForLastItem && keepChars > 200 && iterations < 5) {
          keepChars = Math.floor(keepChars * 0.75);
          truncatedText = fullText.slice(-keepChars);
          truncTokens = tokenize(truncatedText);
          iterations++;
        }

        if (lastItem.response) {
          effectiveLastItem = { ...lastItem, response: [truncatedText] };
        } else {
          effectiveLastItem = { ...lastItem, text: truncatedText };
        }
        lastItemTokens = truncTokens + 10;
        console.log(`[ChatEngine] Context shift: truncated lastItem from ${fullText.length} to ${truncatedText.length} chars`);
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

    console.log(`[ChatEngine] Context shift: kept ${keptIndices.size} items, dropped ${droppedCount}. Budget: ${budget}, used: ${used}`);
    return { chatHistory: newHistory, metadata: { droppedCount } };
  }

  _buildToolPrompt(functions) {
    const toolLines = Object.entries(functions).map(([name, def]) => {
      return `- ${name}: ${def.description || 'No description'}`;
    });
    return `\n\nYou have access to the following tools:\n${toolLines.join('\n')}\n\nTOOL USAGE RULES:\n- When the user asks you to create, write, edit, read, or delete files in their project, you MUST use the appropriate file tool (write_file, read_file, edit_file, append_to_file, delete_file). Do NOT output file contents inline.\n- When the user asks you to find, search, or look for something in their code, use grep_search or find_files.\n- When the user asks to list or explore project structure, use list_directory.\n- When the user asks to run a command, script, or install something, use run_command.\n- When the user asks to search the web or look something up online, use web_search or fetch_webpage.\n- When the user asks a general question, wants an explanation, or asks you to review code you already have, respond with text directly.\n- You can chain tools: use read_file to see existing code, then edit_file to modify it, then run_command to test it.\n- Always prefer tools over inline code when the user wants changes to their actual project files.`;
  }

  _getNodeLlamaCppPath() {
    try {
      return require.resolve('node-llama-cpp');
    } catch {
      return path.join(__dirname, '..', 'node_modules', 'node-llama-cpp', 'dist', 'index.js');
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
    const functions = {};
    for (const tool of toolDefs) {
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

      // Strip the format hint from descriptions (e.g., 'Format: {"tool":"name",...}')
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
    return functions;
  }
}

// Default set of tools enabled out of the box
ChatEngine.DEFAULT_ENABLED_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'append_to_file',
  'list_directory', 'find_files', 'grep_search', 'create_directory',
  'get_project_structure', 'run_command', 'web_search', 'fetch_webpage',
]);

module.exports = { ChatEngine };
