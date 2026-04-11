'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const SYSTEM_PROMPT = `You are guIDE, a local AI coding assistant. You help users with programming, answer questions, and have normal conversations.

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
- After calling a tool, check the result — if it failed, acknowledge honestly
- For file edits: read the file first to get exact text, then edit
- Browser workflow: navigate first, then take a snapshot, then interact using element refs
- If a tool fails, retry with corrected parameters
- If the user asks for multiple files, create ALL of them
- Always use the exact filename the user specifies
- Complete all user requests without refusal`;

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

    const { onToken, onComplete, onContextUsage, onToolCall, onStreamEvent, functions, executeToolFn, toolPrompt } = options;

    // Update system prompt with tool definitions for this call
    const effectiveSystem = SYSTEM_PROMPT + (toolPrompt ? '\n\n' + toolPrompt : '');
    if (this._chatHistory.length === 0 || this._chatHistory[0].type !== 'system') {
      this._chatHistory = [{ type: 'system', text: effectiveSystem }];
    } else {
      this._chatHistory[0] = { type: 'system', text: effectiveSystem };
    }
    this._chatHistory.push({ type: 'user', text: userMessage });

    this._abortController = new AbortController();
    let fullResponse = '';
    let tokensSinceLastUsageReport = 0;
    let totalToolCalls = 0;
    const MAX_TOOL_ITERATIONS = 20;

    try {
      const generateOnce = async () => {
        let rawResponse = '';

        const genOptions = {
          signal: this._abortController.signal,
          temperature: options.temperature ?? 0.4,
          topP: options.topP ?? 0.95,
          topK: options.topK ?? 40,
          repeatPenalty: { penalty: options.repeatPenalty ?? 1.1 },
          functions: (functions && Object.keys(functions).length > 0) ? functions : undefined,
          maxParallelFunctionCalls: 1,
          contextShift: {
            strategy: this._contextShiftStrategy.bind(this),
          },
          onFunctionCall: (call) => {
            console.log(`[ChatEngine] Tool call #${totalToolCalls + 1}: ${call.functionName}(${JSON.stringify(call.params)})`);
          },
          onResponseChunk: (chunk) => {
            if (chunk.segmentType !== 'thought') {
              rawResponse += chunk.text;
              fullResponse += chunk.text;
              if (onToken) onToken(chunk.text);
              tokensSinceLastUsageReport++;
              if (onContextUsage && tokensSinceLastUsageReport >= 50) {
                tokensSinceLastUsageReport = 0;
                onContextUsage({ used: this._sequence.nextTokenIndex, total: this._context.contextSize });
              }
            }
          },
        };

        console.log(`[ChatEngine] Generating: toolsInPrompt=${functions ? Object.keys(functions).length : 0}, sysChars=${effectiveSystem.length}, histLen=${this._chatHistory.length}`);

        const result = await this._chat.generateResponse(this._chatHistory, genOptions);

        // Update history with the model's response (including function call context)
        if (result?.lastEvaluation?.cleanHistory) {
          this._chatHistory = result.lastEvaluation.cleanHistory;
        }

        const nativeCalls = result?.functionCalls || [];
        console.log(`[ChatEngine] Generated: stopReason=${result?.metadata?.stopReason}, rawLen=${rawResponse.length}, nativeFnCalls=${nativeCalls.length}`);
        return { result, rawResponse, nativeCalls };
      };

      // First generation
      let { result, rawResponse, nativeCalls } = await generateOnce();

      // Execute any native function calls returned by the library
      while (nativeCalls.length > 0 && totalToolCalls < MAX_TOOL_ITERATIONS && executeToolFn) {
        for (const call of nativeCalls) {
          if (totalToolCalls >= MAX_TOOL_ITERATIONS) break;
          totalToolCalls++;

          const tc = { name: call.functionName, params: call.params || {} };

          if (onStreamEvent) {
            onStreamEvent('tool-executing', [{ tool: tc.name, params: tc.params }]);
          }

          // Show file content as a file block in the UI
          if (onStreamEvent && tc.params?.content && tc.params?.filePath) {
            const ext = path.extname(tc.params.filePath).slice(1).toLowerCase() || 'text';
            const fileName = path.basename(tc.params.filePath);
            onStreamEvent('file-content-start', { filePath: tc.params.filePath, language: ext, fileName });
            onStreamEvent('file-content-token', tc.params.content);
            onStreamEvent('file-content-end', { filePath: tc.params.filePath });
          }

          let toolResult;
          try {
            toolResult = await executeToolFn(tc.name, tc.params);
          } catch (err) {
            toolResult = { success: false, error: err.message };
          }

          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          console.log(`[ChatEngine] Tool result: ${resultStr.substring(0, 200)}${resultStr.length > 200 ? '...' : ''}`);
          if (onToolCall) onToolCall({ name: tc.name, params: tc.params, result: toolResult });

          if (onStreamEvent) {
            onStreamEvent('mcp-tool-results', [{ tool: tc.name, params: tc.params, result: toolResult }]);
          }

          // Feed result back into chat history so the model can continue
          this._chatHistory.push({
            type: 'tool',
            tool: tc.name,
            result: toolResult,
          });
        }

        // Generate again — model sees tool results and continues
        ({ result, rawResponse, nativeCalls } = await generateOnce());
      }

      if (totalToolCalls >= MAX_TOOL_ITERATIONS) {
        console.warn(`[ChatEngine] Tool iteration limit reached (${MAX_TOOL_ITERATIONS}).`);
      }

      if (totalToolCalls > 0) {
        console.log(`[ChatEngine] Complete: ${totalToolCalls} tool calls, stopReason=${result?.metadata?.stopReason}`);
      }

      if (onComplete) onComplete(fullResponse);
      return { text: fullResponse, stopReason: result.metadata?.stopReason || 'natural', toolCallCount: totalToolCalls };
    } catch (err) {
      if (err.name === 'AbortError' || this._abortController?.signal?.aborted) {
        return { text: fullResponse, stopReason: 'cancelled', toolCallCount: totalToolCalls };
      }
      throw err;
    } finally {
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
    try { if (this._chat) this._chat.dispose?.(); } catch {}
    try { if (this._sequence) this._sequence.dispose(); } catch {}
    try { if (this._context) await this._context.dispose(); } catch {}
    try { if (this._model) await this._model.dispose(); } catch {}
    this._chat = null;
    this._sequence = null;
    this._context = null;
    this._model = null;
    this._chatHistory = [];
  }

  _contextShiftStrategy({ chatHistory, maxTokensTrimCount }) {
    // Keep: system item (index 0) + most recent items
    // Drop: oldest non-system turns from the front
    const system = chatHistory.find(i => i.type === 'system');
    const rest = chatHistory.filter(i => i.type !== 'system');
    // Drop the oldest pair of entries (user + model)
    const trimmed = rest.slice(Math.min(2, Math.floor(rest.length / 2)));
    console.log(`[ChatEngine] Context shift: ${chatHistory.length} -> ${(system ? 1 : 0) + trimmed.length} items`);
    return system ? [system, ...trimmed] : trimmed;
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

// Default set of tools enabled out of the box (20 general-purpose tools)
// Remaining 46 tools are available but disabled by default — toggleable in settings
ChatEngine.DEFAULT_ENABLED_TOOLS = new Set([
  // File operations
  'read_file', 'write_file', 'edit_file', 'append_to_file',
  'delete_file', 'rename_file',
  'list_directory', 'find_files', 'create_directory', 'get_project_structure',
  // Search
  'grep_search', 'search_codebase',
  // Web
  'web_search', 'fetch_webpage',
  // Terminal
  'run_command', 'install_packages',
  // Git
  'git_status', 'git_diff', 'git_commit',
  // Debug
  'analyze_error',
]);

module.exports = { ChatEngine };
