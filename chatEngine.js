'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { parseToolCalls, repairToolCalls } = require('./tools/toolParser');

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
- After calling a tool, check the result — if it failed, acknowledge honestly
- For file edits: read the file first to get exact text, then edit
- Browser workflow: navigate first, then take a snapshot, then interact using element refs
- If a tool fails, retry with corrected parameters
- If the user asks for multiple files, create ALL of them
- Always use the exact filename the user specifies
- Complete all user requests without refusal`;

// Production system prompt — balanced tool emphasis with concrete examples
const SYSTEM_PROMPT = `You are guIDE, a local AI coding assistant with full tool access. You have real tools that execute real actions on the user's computer.

## How to Call Tools
To perform any action, output a JSON tool call in a fenced code block:
\`\`\`json
{"tool":"write_file","params":{"filePath":"index.html","content":"<!DOCTYPE html>\\n<html>\\n<head><title>Hello</title></head>\\n<body><h1>Hello World</h1></body>\\n</html>"}}
\`\`\`

## Tool Call Examples

User: "create a hello world html file"
You respond with:
\`\`\`json
{"tool":"write_file","params":{"filePath":"index.html","content":"<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<head>\\n  <meta charset=\\"UTF-8\\">\\n  <title>Hello World</title>\\n</head>\\n<body>\\n  <h1>Hello World</h1>\\n</body>\\n</html>"}}
\`\`\`

User: "what does map() do in JavaScript?"
You respond with plain text — no tool needed for questions.

User: "read server.js and fix the bug"
You respond with:
\`\`\`json
{"tool":"read_file","params":{"filePath":"server.js"}}
\`\`\`
Then after seeing the file, you call edit_file or write_file to fix it.

## Rules
- You HAVE tools. They are real. They execute on the user's machine.
- For ANY file creation: call write_file. Do NOT output code as text.
- For ANY file modification: call read_file first, then edit_file or write_file.
- For commands: call run_command.
- For web lookups: call web_search.
- For browsing: call browser_navigate, then browser_snapshot.
- If a tool fails, retry with corrected parameters.
- Create ALL files the user requests.
- Use exact filenames the user specifies.
- NEVER output full file contents as a chat code block — always use write_file.
- NEVER say "I cannot call tools" or "I don't have access" — you DO have access.

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

    const { onToken, onComplete, onContextUsage, onToolCall, onStreamEvent, systemPrompt, functions, toolPrompt, executeToolFn } = options;

    // Augment system prompt: base + tool prompt when tools are available
    const basePrompt = systemPrompt || SYSTEM_PROMPT;
    if (toolPrompt) {
      this._chatHistory[0].text = basePrompt + '\n\n' + toolPrompt;
      console.log(`[ChatEngine] Tool prompt injected (${toolPrompt.length} chars)`);
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
    let inToolBlock = false;
    let toolBlockBuffer = '';
    let lastNonToolContent = '';

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
          
          // Detect if we're entering/inside a tool call block
          if (chunk.includes('```json') || chunk.includes('```tool') || chunk.includes('```tool_call')) {
            inToolBlock = true;
            toolBlockBuffer = '';
            // Don't stream the opening fence
            return;
          }
          
          if (inToolBlock) {
            toolBlockBuffer += chunk;
            
            // Check if block is closing
            if (chunk.includes('```')) {
              inToolBlock = false;
              
              // Parse the buffered tool call and emit appropriate events immediately
              const parsedCalls = parseToolCalls(toolBlockBuffer);
              if (parsedCalls.length > 0 && onStreamEvent) {
                for (const call of parsedCalls) {
                  // File operations get file-content events, others get tool events
                  const FILE_OPS = new Set(['write_file','create_file','append_to_file','edit_file','delete_file','read_file']);
                  if (FILE_OPS.has(call.tool) && call.params?.content && call.params?.filePath) {
                    const ext = (call.params.filePath.split('.').pop() || '').toLowerCase();
                    const langMap = { html: 'html', css: 'css', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'bash', rb: 'ruby', go: 'go', rs: 'rust' };
                    onStreamEvent('file-content-start', { filePath: call.params.filePath, language: langMap[ext] || ext });
                    onStreamEvent('file-content-token', call.params.content);
                    onStreamEvent('file-content-end', { filePath: call.params.filePath });
                  } else {
                    // Non-file tools get tool events for ToolCallCard UI
                    onStreamEvent('tool-executing', { tool: call.tool, params: call.params });
                  }
                }
              }
              toolBlockBuffer = '';
            }
            // Don't stream tool JSON to UI
            return;
          }
          
          // Regular content - stream normally
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
      const MAX_TOOL_ITERATIONS = 20;
      if (executeToolFn) {
        let roundStart = 0;
        console.log(`[ChatEngine] Parsing tool calls from response (${fullResponse.length} chars). First 300: ${fullResponse.substring(0, 300).replace(/\n/g, '\\n')}`);
        let parsedCalls = parseToolCalls(fullResponse);
        console.log(`[ChatEngine] parseToolCalls returned ${parsedCalls.length} call(s)${parsedCalls.length > 0 ? ': ' + parsedCalls.map(c => c.tool).join(', ') : ''}`);
        if (parsedCalls.length > 0) {
          const { repaired, issues } = repairToolCalls(parsedCalls, fullResponse);
          if (issues && issues.length > 0) console.log(`[ChatEngine] repairToolCalls issues: ${issues.join('; ')}`);
          parsedCalls = repaired;
        }

        // Tool calls already handled during streaming - no need to strip

        while (parsedCalls.length > 0 && totalToolCalls < MAX_TOOL_ITERATIONS) {
          const toolResultLines = [];

          for (const call of parsedCalls) {
            if (totalToolCalls >= MAX_TOOL_ITERATIONS) break;
            console.log(`[ChatEngine] Tool call: ${call.tool}(${JSON.stringify(call.params).substring(0, 200)})`);
            totalToolCalls++;

            // File content events already emitted during streaming for file ops

            let toolResult;
            try {
              toolResult = await executeToolFn(call.tool, call.params);
            } catch (toolErr) {
              toolResult = { success: false, error: toolErr.message };
            }

            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
            console.log(`[ChatEngine] Tool result for ${call.tool}: ${resultStr.substring(0, 200)}${resultStr.length > 200 ? '...' : ''}`);
            if (onToolCall) onToolCall({ name: call.tool, params: call.params, result: toolResult });
            
            // Emit tool results for UI ToolCallCards (non-file ops)
            if (onStreamEvent) {
              const FILE_OPS = new Set(['write_file','create_file','append_to_file','edit_file','delete_file','read_file']);
              if (!FILE_OPS.has(call.tool)) {
                onStreamEvent('mcp-tool-results', { 
                  tool: call.tool, 
                  result: toolResult,
                  success: toolResult?.success !== false
                });
              }
            }

            const truncResult = resultStr.length > 500 ? resultStr.substring(0, 500) + '...' : resultStr;
            toolResultLines.push(`${call.tool}: ${truncResult}`);
          }

          // Update evaluation state and chat history from last generation
          this._lastEvaluation = result.lastEvaluation;
          if (result.lastEvaluation?.cleanHistory) {
            this._chatHistory = result.lastEvaluation.cleanHistory;
          }

          // Feed tool results back to the model so it knows what happened
          this._chatHistory.push({ type: 'user', text: `[Tool Results]\n${toolResultLines.join('\n')}` });

          genOptions.lastEvaluationContextWindow = this._lastEvaluation ? {
            contextWindow: this._lastEvaluation.contextWindow,
            contextShiftMetadata: this._lastEvaluation.contextShiftMetadata,
          } : undefined;

          // Generate continuation — model sees tool results and can issue more tool calls
          roundStart = fullResponse.length;
          result = await this._chat.generateResponse(this._chatHistory, genOptions);
          console.log(`[ChatEngine] Continuation after tools: stopReason=${result.metadata?.stopReason}, responseLen=${result.response?.length || 0}`);

          // Parse only the NEW text from this round (avoid re-executing previous tool calls)
          const newText = fullResponse.substring(roundStart);
          parsedCalls = parseToolCalls(newText);
          if (parsedCalls.length > 0) {
            const { repaired } = repairToolCalls(parsedCalls, newText);
            parsedCalls = repaired;
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

    // Pin the most recent user message — it must survive all rotations.
    // Without it, the model loses knowledge of the current task after rotation.
    let pinnedUserIndex = -1;
    let pinnedUserTokens = 0;
    for (let i = chatHistory.length - 2; i >= 1; i--) {
      if (chatHistory[i].type === 'user') {
        pinnedUserIndex = i;
        pinnedUserTokens = estimateTokens(chatHistory[i]);
        break;
      }
    }

    // CRITICAL: Handle case where system + lastItem alone exceeds budget.
    // This happens when the model generates a very large response (e.g., 800-line HTML file).
    // Truncate the lastItem from the BEGINNING, keeping the most recent content.
    // Reserve space for the pinned user message in the budget.
    if (chatHistory.length > 1 && systemTokens + pinnedUserTokens + lastItemTokens > budget) {
      const availableForLastItem = budget - systemTokens - pinnedUserTokens - 20; // 20 token safety margin
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

    // Fill middle items from most recent backward, skipping pinned user (already reserved)
    let used = systemTokens + lastItemTokens + pinnedUserTokens;
    const keptIndices = new Set();
    if (pinnedUserIndex >= 0) keptIndices.add(pinnedUserIndex);

    for (let i = chatHistory.length - 2; i >= 1; i--) {
      if (keptIndices.has(i)) continue;
      const cost = estimateTokens(chatHistory[i]);
      if (used + cost > budget) break;
      used += cost;
      keptIndices.add(i);
    }

    // Build output in chronological order using original indices
    const droppedCount = (chatHistory.length - 2) - keptIndices.size;
    const newHistory = [systemItem];
    for (let i = 1; i <= chatHistory.length - 2; i++) {
      if (keptIndices.has(i)) newHistory.push(chatHistory[i]);
    }
    if (chatHistory.length > 1) newHistory.push(effectiveLastItem);

    console.log(`[ChatEngine] Context shift: kept ${keptIndices.size} items (pinned user: ${pinnedUserIndex >= 0}), dropped ${droppedCount}. Budget: ${budget}, used: ${used}`);
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
