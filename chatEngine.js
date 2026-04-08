'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const SYSTEM_PROMPT = `You are guIDE, a helpful AI coding assistant running locally. You help users write code, answer questions, and assist with software development tasks. Be concise and direct.`;

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

    const { onToken, onComplete, onContextUsage, onToolCall, systemPrompt, functions, executeToolFn } = options;

    // Augment system prompt: base + tool instructions when functions are provided
    const basePrompt = systemPrompt || SYSTEM_PROMPT;
    if (functions && Object.keys(functions).length > 0) {
      this._chatHistory[0].text = basePrompt + this._buildToolPrompt(functions);
      console.log(`[ChatEngine] Functions provided: ${Object.keys(functions).length} tools: ${Object.keys(functions).join(', ')}`);
    } else if (systemPrompt) {
      this._chatHistory[0].text = systemPrompt;
    }

    this._chatHistory.push({ type: 'user', text: userMessage });

    this._abortController = new AbortController();
    let fullResponse = '';
    let tokensSinceLastUsageReport = 0;
    let totalToolCalls = 0;

    try {
      // Build common generation options
      const genOptions = {
        signal: this._abortController.signal,
        temperature: options.temperature ?? 0.7,
        topP: options.topP,
        topK: options.topK,
        repeatPenalty: options.repeatPenalty ? { penalty: options.repeatPenalty } : undefined,
        contextShift: { strategy: this._contextShiftStrategy.bind(this) },
        onTextChunk: (chunk) => {
          fullResponse += chunk;
          if (onToken) onToken(chunk);
          tokensSinceLastUsageReport++;
          if (onContextUsage && tokensSinceLastUsageReport >= 50) {
            tokensSinceLastUsageReport = 0;
            const used = this._sequence.nextTokenIndex;
            const total = this._context.contextSize;
            onContextUsage({ used, total });
          }
        },
      };

      // Add function calling if tools are provided
      if (functions && Object.keys(functions).length > 0) {
        genOptions.functions = functions;
        genOptions.documentFunctionParams = true;
      }

      // Add lastEvaluation context window if available
      if (this._lastEvaluation) {
        genOptions.lastEvaluationContextWindow = {
          contextWindow: this._lastEvaluation.contextWindow,
          contextShiftMetadata: this._lastEvaluation.contextShiftMetadata,
        };
      }

      // Tool call loop: generate, execute tools if needed, repeat
      let result = await this._chat.generateResponse(this._chatHistory, genOptions);
      console.log(`[ChatEngine] generateResponse returned: stopReason=${result.metadata?.stopReason}, functionCalls=${result.functionCalls?.length || 0}, responseLen=${result.response?.length || 0}`);

      const MAX_TOOL_ITERATIONS = 20;
      while (result.metadata?.stopReason === 'functionCalls' && result.functionCalls?.length > 0 && executeToolFn && totalToolCalls < MAX_TOOL_ITERATIONS) {
        // Process each function call
        const functionCallItems = [];
        for (const fc of result.functionCalls) {
          console.log(`[ChatEngine] Tool call: ${fc.functionName}(${JSON.stringify(fc.params)})`);
          totalToolCalls++;

          let toolResult;
          try {
            toolResult = await executeToolFn(fc.functionName, fc.params);
          } catch (toolErr) {
            toolResult = { success: false, error: toolErr.message };
          }

          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          console.log(`[ChatEngine] Tool result for ${fc.functionName}: ${resultStr.substring(0, 200)}${resultStr.length > 200 ? '...' : ''}`);

          if (onToolCall) onToolCall({ name: fc.functionName, params: fc.params, result: toolResult });

          functionCallItems.push({
            type: 'functionCall',
            name: fc.functionName,
            description: functions[fc.functionName]?.description,
            params: fc.params,
            result: resultStr,
            rawCall: fc.raw,
          });
        }

        // Update evaluation state and history
        this._lastEvaluation = result.lastEvaluation;
        if (result.lastEvaluation?.cleanHistory) {
          this._chatHistory = result.lastEvaluation.cleanHistory;
        }

        // The model response with function calls becomes part of history
        // node-llama-cpp's cleanHistory already includes the model response with function calls
        // We just need to update the lastEvaluation context window for the next call

        genOptions.lastEvaluationContextWindow = this._lastEvaluation ? {
          contextWindow: this._lastEvaluation.contextWindow,
          contextShiftMetadata: this._lastEvaluation.contextShiftMetadata,
        } : undefined;

        // Generate next response (model sees tool results and continues)
        result = await this._chat.generateResponse(this._chatHistory, genOptions);
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

    // Tokenize text accurately, with fallback to character estimation
    const tokenize = (text) => {
      try { return tokenizer.tokenize(String(text || ''), false).length; }
      catch { return Math.ceil(String(text || '').length / 3); }
    };

    // Extract all text from a chat history item (handles both text and response items)
    const getItemText = (item) => {
      if (item.text != null) return String(item.text);
      if (item.response) {
        return item.response.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('');
      }
      return '';
    };

    const estimateTokens = (item) => tokenize(getItemText(item)) + 10;

    // Use 85% of maxTokensCount as budget — leaves room for tokenization estimation error
    const budget = Math.floor(maxTokensCount * 0.85);
    const systemItem = chatHistory[0];
    const lastItem = chatHistory[chatHistory.length - 1];

    const systemTokens = estimateTokens(systemItem);
    let lastItemTokens = chatHistory.length > 1 ? estimateTokens(lastItem) : 0;
    let effectiveLastItem = lastItem;

    // CRITICAL: Handle case where system + lastItem alone exceeds budget.
    // This happens when the model generates a very large response (e.g., 800-line HTML file).
    // Truncate the lastItem from the BEGINNING, keeping the most recent content.
    if (chatHistory.length > 1 && systemTokens + lastItemTokens > budget) {
      const availableForLastItem = budget - systemTokens - 20; // 20 token safety margin
      if (availableForLastItem > 100) {
        const fullText = getItemText(lastItem);
        // Start with a character estimate (roughly 3 chars per token), then verify with tokenizer
        let keepChars = Math.floor(availableForLastItem * 3);
        let truncatedText = fullText.slice(-keepChars);
        let truncTokens = tokenize(truncatedText);

        // Iteratively reduce if still too large (max 5 iterations to avoid expensive loops)
        let iterations = 0;
        while (truncTokens > availableForLastItem && keepChars > 200 && iterations < 5) {
          keepChars = Math.floor(keepChars * 0.75);
          truncatedText = fullText.slice(-keepChars);
          truncTokens = tokenize(truncatedText);
          iterations++;
        }

        // Rebuild the item with truncated content
        if (lastItem.response) {
          effectiveLastItem = { ...lastItem, response: [truncatedText] };
        } else {
          effectiveLastItem = { ...lastItem, text: truncatedText };
        }
        lastItemTokens = truncTokens + 10;
        console.log(`[ChatEngine] Context shift: truncated lastItem from ${fullText.length} to ${truncatedText.length} chars (${estimateTokens(lastItem)} -> ${lastItemTokens} tokens)`);
      }
    }

    // Fill middle items from most recent backward
    let used = systemTokens + lastItemTokens;
    const kept = [];

    for (let i = chatHistory.length - 2; i >= 1; i--) {
      const cost = estimateTokens(chatHistory[i]);
      if (used + cost > budget) break;
      used += cost;
      kept.unshift(chatHistory[i]);
    }

    const droppedCount = (chatHistory.length - 2) - kept.length;
    const newHistory = [systemItem, ...kept];
    if (chatHistory.length > 1) newHistory.push(effectiveLastItem);

    console.log(`[ChatEngine] Context shift: kept ${kept.length} middle items, dropped ${droppedCount}. Budget: ${budget}, used: ${used}`);
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
