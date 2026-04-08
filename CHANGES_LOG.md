# guIDE 3.0 — Changes Log

> Every code change must be logged here. Context windows expire. If it's not here, it's lost.

---

## 2026-04-08 — Context Management System (3 changes to chatEngine.js)

### Problem: No context management existed in guide-3.0
chatEngine.js had no context shift strategy (used default), maxTokens: -1 (unlimited — triggers infinite context shift loop per llama.cpp #3969), and no continuation mechanism (model stops mid-file and that's the end).

### Change A — chatEngine.js: Custom context shift strategy (_contextShiftStrategy method)
- ADDED: `_contextShiftStrategy()` method (lines 259-293)
- Logic: Always keeps system prompt (first item) + current response (last item). Fills remaining budget from most recent turns backward. Uses actual `tokenizer.tokenize()` for token counting — NOT character estimation. 10% safety margin on budget.
- No content inspection. No JSON parsing. No segment splitting. Items are opaque.
- Passed to `generateResponse()` via `contextShift: { strategy: this._contextShiftStrategy.bind(this) }`

### Change B — chatEngine.js: maxTokens default (lines 110-113)
- CHANGED: `maxTokens: options.maxTokens || -1` → computed default
- Formula: `Math.min(options.maxTokens > 0 ? options.maxTokens : Infinity, Math.floor(ctxSize * 0.8))`
- Caps any single generation at 80% of context size
- Prevents the infinite context shift loop (llama.cpp issue #3969)
- Every production tool (KoboldCpp, text-generation-webui, SillyTavern) sets a generation length cap

### Change C — chatEngine.js: Continuation loop (lines 148-189)
- ADDED: After first `generateResponse()`, if `stopReason === 'maxTokens'`, automatically:
  1. Adds continuation user message: "Continue exactly where you stopped. Do not repeat any content."
  2. Calls `generateResponse()` again with updated history + lastEvaluation
  3. Tokens stream via same `onToken` callback — UI sees continuous text
  4. Repeats until stopReason !== 'maxTokens' or 50 continuations reached
- ONE continuation path. ONE prompt. No nesting analysis. No symbol extraction.
- Returns `{ text, stopReason, continuations }` — caller knows how many continuations occurred.

### What was NOT added:
- No summarization (old turns are dropped, not summarized)
- No second or third system
- No proactive rotation
- No content inspection in the shift strategy
- No template-based task ledger
- Total: ~70 lines of new code

---

## 2026-04-08 (session 2) — Removed continuation loop, added context ring + tool calling

### Root Cause of Boundary Artifacts
Testing at 2048 context revealed boundary artifacts at continuation points:
- HTML entity encoding (`&lt;` instead of `<`) after continuation
- Markdown code fence (` ```html `) appearing at continuation boundary
- Model starts a NEW response after "Continue" message, creating a seam

The continuation loop (Change C above) was the source. The native context shift (Change A) works seamlessly — the model never knows a shift happened. The fix: remove the continuation loop entirely.

### Change D — chatEngine.js: REMOVED continuation loop (Change B + C undone)
- **File**: chatEngine.js, chat() method
- **Removed**: maxTokens computation (Change B), MAX_CONTINUATIONS, continuationCount, lastStopReason, the entire while loop, completion logging
- **Result**: chat() now makes a single generateResponse() call. The model generates until it naturally stops (eogToken). Context shifts happen transparently via Change A.
- **Rationale**: Native context shift handles context compression during generation without interrupting the model. No restart, no new code block, no boundary artifacts.

### Change E — chatEngine.js + server/main.js: Context progress ring events
- **File**: chatEngine.js, chat() method
- **Added**: `onContextUsage` callback option, throttled to fire every ~50 text chunks
- **Data**: `{ used: this._sequence.nextTokenIndex, total: this._context.contextSize }`
- **File**: server/main.js, ai-chat handler
- **Added**: `onContextUsage: (data) => mainWindow.webContents.send('context-usage', data)`
- **Frontend**: StatusBar.jsx already has ContextRing component reading chatContextUsage from store. App.jsx already handles 'context-usage' events. This change connects the backend to the existing frontend.

### Change F — chatEngine.js + server/main.js: Native tool calling via node-llama-cpp (UPDATED in session 3)
- **File**: chatEngine.js, chat() method
- **Added**: `functions`, `executeToolFn`, `onToolCall` options
- **Added**: Tool call loop: when `stopReason === 'functionCalls'`, executes each tool via `executeToolFn`, adds results to chat history, calls `generateResponse()` again. Loops until model stops calling tools.
- **Added**: Static `convertToolDefs()` method — converts mcpToolServer format (array of {name, description, parameters}) to node-llama-cpp's `ChatModelFunctions` format ({name: {description, params: GbnfJsonSchema}})
- **Added**: `ChatEngine.DEFAULT_ENABLED_TOOLS` — set of 12 core tools enabled by default
- **File**: server/main.js, ai-chat handler
- **Added**: Builds ChatModelFunctions from mcpToolServer.getToolDefinitions(), passes to llmEngine.chat() with executeToolFn callback that calls mcpToolServer.executeTool()
- **Added**: Default disabled tools set at startup — all tools except the 12 defaults are disabled
- **Added**: `onToolCall` sends 'tool-call' events to frontend
- **Key**: Uses node-llama-cpp's NATIVE function calling (GBNF grammar constrains output). NOT text-based parsing from guide-2.0. The model outputs structured function calls, not JSON blocks in text.

---

## 2026-04-08 (session 3) — 4 fixes to chatEngine.js after first tool call test

### Test Results That Prompted These Changes
- 796 lines generated, 1 context shift, 100% context reached
- BUG-1: Context shift strategy returned 9343 tokens for 6635 budget — node-llama-cpp fell back to default
- BUG-2: File incomplete (JS cut mid-function) — consequence of BUG-1
- BUG-3: Model never called tools — system prompt had no tool guidance

### Change G — chatEngine.js: Context shift strategy handles oversized lastItem
- **File**: chatEngine.js, `_contextShiftStrategy()` method (lines ~294-377)
- **Root cause**: When the model's current response (lastItem) is very large (800+ line HTML file), `systemItem + lastItem` alone exceeds the budget. The strategy returned the full oversized history, causing node-llama-cpp to reject it and fall back to its default strategy.
- **What changed**:
  - Budget reduced from 90% to 85% of maxTokensCount (more conservative margin for tokenization estimation error)
  - Added `getItemText()` helper that handles both `.text` and `.response` items (including non-string elements via JSON.stringify)
  - When `systemTokens + lastItemTokens > budget`: truncates lastItem from the BEGINNING, keeping the most recent content (the end of the response). Uses actual tokenizer with iterative reduction (max 5 iterations) to find the right truncation point.
  - Rebuilt item preserves original type: `.response` items get `[truncatedText]`, `.text` items get `truncatedText`
- **Observable effect**: Context shift should now return a valid history that node-llama-cpp accepts. The "strategy did not return a history that fits" warning should not appear.

### Change H — chatEngine.js: Tool-use instructions in system prompt
- **File**: chatEngine.js, `chat()` method + new `_buildToolPrompt()` method
- **Root cause**: SYSTEM_PROMPT was "You are guIDE, a helpful AI coding assistant..." with zero mention of available tools. The model had no reason to produce function calls even with GBNF grammar enabled.
- **What changed**:
  - `chat()` now augments the system prompt with tool descriptions when `functions` are provided
  - New `_buildToolPrompt(functions)` method: generates a tool list with names and descriptions, plus instructions on when to use tools vs inline code
  - Base prompt preserved — tool instructions are appended, not replaced
- **Observable effect**: Model should now be aware of available tools and prefer using them for file operations instead of generating inline code.

### Change I — chatEngine.js: Tool call iteration limit (MAX_TOOL_ITERATIONS = 20)
- **File**: chatEngine.js, `chat()` method, tool call while loop
- **Root cause**: The `while (stopReason === 'functionCalls' && ...)` loop had no upper bound. If the model kept producing function calls indefinitely, the loop would run forever.
- **What changed**: Added `totalToolCalls < MAX_TOOL_ITERATIONS` to while condition. Warning logged when limit reached.
- **Observable effect**: Tool call loop guaranteed to terminate after 20 iterations.

### Change K — chatEngine.js: Production-ready tool prompt (_buildToolPrompt)
- **File**: chatEngine.js, `_buildToolPrompt()` method
- **What changed**: Replaced basic one-line tool guidance with detailed TOOL USAGE RULES section. Explicitly instructs the model when to use each tool category (file tools for file operations, grep_search/find_files for search, list_directory for exploration, run_command for execution, web_search/fetch_webpage for web lookups). Explains tool chaining (read_file then edit_file then run_command). Clearly distinguishes when to respond with text vs. when to use tools. Uses imperative language ("you MUST use") for file operations.
- **Observable effect**: Model should more reliably use tools for file operations instead of generating inline code. System prompt now gives explicit decision rules for tool selection.

### Change J — chatEngine.js: Improved token estimation for response items
- **File**: chatEngine.js, `_contextShiftStrategy()`, `getItemText()` helper
- **Root cause**: Old `estimateTokens()` only handled string elements in `.response` arrays via `filter(r => typeof r === 'string')`. Non-string elements (function call objects etc.) were silently dropped, causing underestimation.
- **What changed**: `getItemText()` now maps ALL response array elements — strings pass through directly, non-strings are JSON.stringified. Gives accurate token estimation for all item types.
- **Observable effect**: More accurate context budget calculations, especially when chat history contains function call/result items.
