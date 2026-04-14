# guIDE 3.0 — Changes Log

> Every code change must be logged here. Context windows expire. If it's not here, it's lost.

---

## 2026-04-14 — Fix streaming in fence path, title bar drag, web search multi-backend

### Problems
1. Code block streaming fix from previous commit only worked for raw JSON tool calls — models that output tool calls inside code fences (` ```json ... ``` `) still showed three dots during generation because the fence path had no content streaming
2. Title bar not draggable — all child elements had `WebkitAppRegion: 'no-drag'`, including the center `flex-1` div, leaving zero draggable pixels
3. Web search (DuckDuckGo) consistently rate-limited — "Search temporarily unavailable" on every query
4. Recommended models showed 3 entries instead of 2

### Changes

#### `chatEngine.js`
- **Fence path content streaming**: Added the same real-time JSON content extraction state machine to the `_sfInFence` branch of `_sfProcessChunk`. When a fenced code block is detected as containing a file write tool call, the `"content"` field value is streamed character-by-character to `file-content-token` events (with JSON escape decoding), identical to the raw JSON path.
- **`_sfFlushFence()` updated**: Now gracefully finalizes any in-progress content stream before flushing the fence buffer, and resets all content streaming state variables.
- **Fence close handling**: When closing ``` is detected and content was being streamed, pending content is flushed and `file-content-end` is emitted before the fence is suppressed.
- Both fence and raw JSON paths now share the same state variables (`_sfContentStreamActive`, `_sfFileWriteDetected`, etc.) for content streaming.

#### `webSearch.js`
- Complete rewrite with multi-backend architecture:
  1. **Primary: Brave Search** — scrapes `search.brave.com` HTML results (more reliable, no rate limiting)
  2. **Fallback: DuckDuckGo POST** — uses POST to `lite.duckduckgo.com` with proper headers (Referer, Origin) — less likely to trigger bot detection than GET
  3. **Last resort: DuckDuckGo GET** — original method with retry
- **User-Agent rotation**: 4 different browser UA strings, randomly selected
- **Better headers**: Sec-Fetch-*, Accept-Encoding, Referer headers match real browsers
- Dedicated `_httpPost` helper method for POST-based search

#### `frontend/src/components/TitleBar.jsx`
- Moved `WebkitAppRegion: 'no-drag'` from the outer `flex-1` center container to the inner `search-bar-container` (max-w-[480px]). The space on either side of the search bar is now draggable.

#### `frontend/src/components/WelcomeScreen.jsx`
- Reduced `RECOMMENDED_MODELS` from 3 entries to 2 (removed Qwen 3.5 27B "advanced" tier)

---

## 2026-04-14 — Real-time code block streaming, UI fixes, New Window support

### Problems
1. File content (e.g., 312-line HTML files) only appeared after the entire tool call completed — user saw bouncing dots during generation, then the full code block appeared at once
2. Welcome screen installed models list showed all models with no limit, causing overhang
3. Default theme was "Monolith" instead of "Carbon"
4. TitleBar "Open Folder" used `prompt()` instead of native dialog and referenced wrong API fields (`d.tree` vs `d.items`)
5. No "New Window" option; single instance lock prevented multiple windows

### Root Cause (Streaming)
The streaming filter in `chatEngine.js` correctly suppressed tool call JSON from the UI, but the `file-content-*` events were only emitted **after** `generateResponse()` completed (in the tool execution loop). The entire file content was sent as a single `file-content-token` burst. During generation, `streamingSegments.length === 0` triggered the three-dot loading indicator.

### Changes

#### `chatEngine.js`
- Added real-time file content streaming state machine inside the streaming filter (`_sfProcessChunk`)
- When a confirmed tool call is detected as a file write (`write_file`/`create_file`/`append_to_file`), the filter watches for the `"content": "` key-value pattern
- Once found, subsequent characters are decoded from JSON escape sequences (`\n`, `\t`, `\"`, `\\`, `\uXXXX`) and streamed to the UI via `file-content-token` events in 40-character batches
- `file-content-start` is emitted when the content field begins (with filePath extracted from the buffer)
- `file-content-end` is emitted when the closing `"` of the content value is reached
- `_sfStreamedFileWrites` Set tracks which files were already streamed in real-time — the post-generation emission is skipped for those
- `_sfFlush()` gracefully finalizes any in-progress content stream if generation is interrupted
- All new state variables reset between tool iteration rounds

#### `frontend/src/components/WelcomeScreen.jsx`
- Changed `llmModels.map()` to `llmModels.slice(0, 2).map()` — only 2 models shown
- Added "+N more installed" button when truncated, links to download panel

#### `frontend/src/components/ThemeProvider.jsx`
- Changed default theme from `'monolith'` to `'carbon'` in three places: context default, useState initializer, and fallback

#### `frontend/src/components/TitleBar.jsx`
- Rewrote `openFolder` handler: uses `electronAPI.openFolderDialog()` (native OS dialog) + `POST /api/project/open` + `setFileTree(t.items || [])` — matching the working Sidebar implementation
- Added "New Window" item to File menu (`action: 'newWindow'`)
- Added `newWindow` case in `executeMenuAction` → calls `electronAPI.newWindow()`

#### `appMenu.js`
- Added "New Window" item with `CmdOrCtrl+Shift+N` accelerator to native File menu

#### `electron-main.js`
- Removed single instance lock (`app.requestSingleInstanceLock()`) so multiple windows can run
- Added `new-window` IPC handler — spawns a detached child process via `process.execPath`

#### `preload.js`
- Exposed `newWindow` method via `ipcRenderer.invoke('new-window')`

#### `frontend/src/App.jsx`
- Added `newWindow` case in native menu action handler

---

## 2026-04-14 — Wire tool call events to frontend, strip raw JSON from chat

### Problem
Tool calls displayed as raw JSON text in chat. Model outputs like `{"tool":"web_search","query":"..."}` appeared verbatim to the user instead of rendering as ToolCallCard UI components. File operations (write_file, etc.) were completely invisible — the R42-Fix-4 skip excluded them from ToolCallCards expecting FileContentBlock, but file-content-* events were never emitted by the backend.

### Root Causes
Three disconnected wiring gaps between chatEngine → server → frontend:
1. `chatEngine.js` line 152 destructured `onToken`, `onToolCall`, etc. but **never destructured `onStreamEvent`** — the callback passed by server/main.js was silently dropped
2. `onToolCall` emitted `tool-call` events, but `App.jsx` had no handler for `tool-call` — it expected `tool-executing` and `mcp-tool-results` events
3. All tokens including tool call JSON were forwarded via `onToken` → `llm-token` → `appendStreamToken` — displayed as regular text

### Changes

#### `tools/toolParser.js`
- Added `stripToolCallText(text)` — removes tool call JSON blocks from model output text using the same structural patterns parseToolCalls detects (XML `<tool_call>` tags, fenced code blocks, raw JSON objects with "tool" key via brace-counting)
- Added `_isInsideExistingRange(ranges, index)` helper for range overlap detection
- Exported `stripToolCallText` in module.exports

#### `chatEngine.js`
- Line 152: Added `onStreamEvent` to options destructuring (was previously passed by server/main.js but never received)
- After initial `parseToolCalls()`: emit `llm-replace-last` with cleaned text to replace raw JSON in UI
- Before tool execution loop: emit `tool-executing` event with all parsed calls (triggers ToolCallCard rendering)
- After each individual tool execution: emit `mcp-tool-results` event (updates ToolCallCard with result/error status)
- After each continuation round: same `llm-replace-last` cleanup for new text

#### `frontend/src/App.jsx`
- Removed R42-Fix-4 FILE_OPS skip from `tool-executing` handler — all tools now show as ToolCallCards (file-content-* events were never wired, so the skip made file ops invisible)
- Removed matching FILE_OPS_R skip from `mcp-tool-results` handler

### What Should Change
- Raw tool call JSON never appears in chat — suppressed during streaming
- All tool calls render as proper ToolCallCard components with pending/success/error states
- File write operations (write_file, create_file, append_to_file) display as FileContentBlocks with syntax highlighting
- Tool execution results update the cards in real-time (spinner → check mark or error)
- Web search retries automatically on rate limiting (up to 3 attempts with exponential backoff)

### Follow-up (same day) — Real-time streaming filter + file content events + web search retry

#### `chatEngine.js` — Streaming filter
- Added two-layer tool call suppression:
  - Layer 1 (real-time): Character-by-character state machine in onTextChunk detects `{` at line boundaries, buffers, checks for `"tool":` within first 80 chars. If confirmed, JSON is silently consumed. Also detects ``` code fences and suppresses fence content containing tool calls.
  - Layer 2 (post-generation): stripToolCallText() catches anything the streaming filter missed (XML tags, edge cases)
- Filter state is properly reset between generation rounds
- File write operations emit file-content-start/token/end events for FileContentBlock rendering

#### `frontend/src/App.jsx`
- File write ops (write_file, create_file, append_to_file) now skip ToolCallCard but display via FileContentBlock
- Non-file tools (read_file, edit_file, delete_file, web_search, run_command, etc.) show as ToolCallCards

#### `webSearch.js`
- Added retry with exponential backoff (up to 3 attempts) when DuckDuckGo returns 202/bot-detection
- Added random jitter to retry delays to avoid thundering herd

---

## 2026-04-13 — Replace GBNF tool calling with raw text parsing

### Problem
Tool calling is 0% functional. `functionCalls=0` across ALL tests (10+ tests, 7+ models). Small models either ignore GBNF grammar constraints (generate text instead of structured calls) or loop indefinitely (repeat same call 20 times). Meanwhile, `tools/toolParser.js` (728-line multi-format parser) and `mcpToolServer.getToolPrompt()` (comprehensive prompt with examples) exist in the codebase but were never wired into chatEngine.js.

### Root Cause
Three gaps in chatEngine.js:
1. `toolPrompt` passed by server/main.js but never destructured — comprehensive mcpToolServer prompt discarded
2. `genOptions.functions` set GBNF grammar — small models can't use it (PAST_FAILURES.md Category 6)
3. `toolParser.parseToolCalls()` never imported or called — 728 lines of battle-tested parsing unused

### Changes (chatEngine.js ONLY)
1. **Line 8**: Added `const { parseToolCalls, repairToolCalls } = require('./tools/toolParser');`
2. **Line 123**: Added `toolPrompt` to options destructuring
3. **Lines 127-135**: System prompt now prefers `toolPrompt` (from mcpToolServer, with format examples + "use write_file" rule) over `_buildToolPrompt(functions)` (flat list, no examples)
4. **Lines 164-166**: Removed `genOptions.functions` and `genOptions.documentFunctionParams` (GBNF disabled)
5. **Lines 180-250**: Replaced dead GBNF loop (`stopReason === 'functionCalls'`, never triggered) with raw text parsing loop: `parseToolCalls(fullResponse)` → `repairToolCalls()` → execute via `executeToolFn` → add results to history → regenerate → repeat until no tool calls or MAX_TOOL_ITERATIONS

### Design Details
- `roundStart` index tracks where each generation round starts in `fullResponse` — prevents re-executing tool calls from previous rounds
- Tool results fed back as `{type: 'user', text: '[Tool Results]\n...'}` — gives model natural continuation context
- `repairToolCalls()` handles edge cases: empty content recovery, filePath inference, dropped call recovery
- `_buildToolPrompt()` and `convertToolDefs()` kept as fallbacks but not used when `toolPrompt` is available
- No changes to `_contextShiftStrategy`, SYSTEM_PROMPT, server/main.js, or any other file

### What Should Change
Model should receive the comprehensive tool prompt with format examples. If it outputs tool call JSON in any of 7+ supported formats (XML `<tool_call>`, ```json fences, raw JSON, function-call syntax, etc.), `parseToolCalls` will detect and execute them. If model still outputs raw text without tool calls, behavior is identical to before (no regression).

---

## 2026-04-13 — Pin user message in context shift strategy

### Problem
After context rotation, the model lost the user's original request. The `_contextShiftStrategy` allocated ALL remaining budget (after system prompt) to the response tail, leaving 0 tokens for the user message. The user message was dropped as a "middle item" on every rotation. Result: model generated 25,793 lines of repetitive ASCII art across 93 rotations because it had no knowledge of the original task.

### Root Cause
Line `availableForLastItem = budget - systemTokens - 20` sized the response tail to fill the ENTIRE remaining budget. With budget=6266, systemTokens≈1500, the response consumed ~4746 tokens, leaving only ~10 tokens — far too few for the user message (~500 tokens).

### Fix
In `_contextShiftStrategy()` (chatEngine.js):
1. Find the most recent user-type message in the middle items
2. Reserve its token count in the budget before truncating the response
3. Skip it during the middle-item fill loop (already accounted for)
4. Include it in the output history in chronological order using index-based ordering
5. Changed budget line to: `availableForLastItem = budget - systemTokens - pinnedUserTokens - 20`

### Effect
After rotation, model sees [system + user message + response tail] instead of [system + response tail]. Response tail is ~500 tokens shorter (~12K chars instead of ~14K), but model retains knowledge of the task.

---

## 2026-04-13 — Restore backup chatEngine.js (context shift fix)

### Problem
The git HEAD (v2.3.15) had a BROKEN `_contextShiftStrategy` that returned a plain array instead of `{ chatHistory, metadata }`. This caused `TypeError: Cannot read properties of undefined (reading 'slice')` in node-llama-cpp's `addAvailableFunctionsSystemMessageToHistory`. The strategy silently fell back to the default (eraseFirstResponseAndKeepFirstSystem), which cannot trim the current in-progress response. Result: generation stops at 100% context, zero context rotation.

### Root Cause
The guide-3.0-backup copy at `C:\Users\brend\guide-3.0-backup\chatEngine.js` had the CORRECT version (437 lines) with proper `{ chatHistory, metadata }` return format AND response truncation logic. The git HEAD had a broken version (397 lines) that lost `_lastEvaluation` tracking, `_buildToolPrompt`, and correct context shift return format.

### Change
- Copied `guide-3.0-backup/chatEngine.js` to `guide-3.0/chatEngine.js`
- Replaced the backup's one-line SYSTEM_PROMPT with the current detailed version (tool usage instructions, continuation note, rules)
- Restored: `_contextShiftStrategy` with correct `{ chatHistory, metadata }` return format
- Restored: Response truncation from beginning when single response exceeds budget
- Restored: `_lastEvaluation` tracking and `lastEvaluationContextWindow` passing
- Restored: `_buildToolPrompt` for dynamic tool usage instructions

### Observable Effect
Context shift should no longer crash. When context fills, the strategy truncates the current response from the beginning (keeping most recent content) and returns proper format. Generation should continue after context shift instead of stopping at 100%.

---

## 2026-04-10 — Change AB: Pre-seeded conversation history with native chat tokens

### Problem
Change AA (behavioral examples in SYSTEM_PROMPT) failed. sysChars confirmed at 8497 — model received the examples. But they appeared as plain text inside the system message using `User:`/`Assistant:` labels, NOT the model's native `<|im_start|>user` / `<|im_end|>` / `<|im_start|>assistant` tokenizer format. The model cannot treat plain-text examples in the system prompt as "prior successful interactions" — they're just instructions. Training prior (output code blocks for coding requests) dominated.

### Root cause refinement
Behavioral examples MUST use the model's native chat format to be effective. When examples are real entries in `_chatHistory`, `LlamaChatSession` formats them with the correct Jinja template tokens. The model sees them as prior context in its exact training format, and in-context learning activates.

### Change AB — chatEngine.js: Pre-seeded initial conversation history

**File:** `chatEngine.js`
**Changes:**
- Reverted SYSTEM_PROMPT `## Examples` section (Change AA removed — no effect, ~400 tokens overhead recovered)
- Added `_buildInitialHistory()` private method returning 7-item array: system message + 3 example exchange pairs (write_file, append_to_file, plain text question)
- Replaced both `this._chatHistory = [{ type: 'system', text: SYSTEM_PROMPT }]` initializations (in `initialize()` and `resetSession()`) with `this._chatHistory = this._buildInitialHistory()`

**Examples seeded:**
1. User: "create an entry point for the project" → Model: `{"tool":"write_file",...}`  
2. User: "the file is getting long, keep adding the remaining code" → Model: `{"tool":"append_to_file",...}`
3. User: "what does a closure do in JavaScript" → Model: plain text (no tool)

**What stays unchanged:** Generation parameters (Change Z), toolPrompt from mcpToolServer, context shift strategy, all parsing logic.

**Test result:** FAILED — same failure as all previous changes. rawLen=22,616, stopReason=eogToken, 0 tool calls. Model wrote full HTML as chat text.

**Revert path:** Superseded by Change AC.

---

## 2026-04-10 — Change AC: LlamaCompletion (raw text) instead of LlamaChat (chat template)

### Root cause (confirmed)
`LlamaChatSession` → `QwenChatWrapper` applies `<|im_start|>user<|im_end|><|im_start|>assistant` tokens → activates RLHF-trained "helpful assistant" mode. In this mode the model outputs markdown code blocks for every file request. This overrides ALL prompt-level instructions — proven across 11 changes (S through AB).

Evidence: guide-2.0 R20-R21 used the same model (Qwen3.5-2B-Q8_0), same library (node-llama-cpp 3.18.1), with raw text completion → write_file calls worked.

### Solution
Switch from `LlamaChat`/`generateResponse` to `LlamaCompletion`/`generateCompletionWithMeta`. No chat template = no RLHF mode activation. Model receives raw text prompt and must produce raw text output. Tool call examples in the prompt are plain JSON, not fenced code blocks.

### Change AC — chatEngine.js: Full API switch

**File:** `chatEngine.js`
**Changes:**

1. **Constructor**: `_chat → _completion`, `_chatHistory → _conversationLog []`, removed `_lastEvaluation`
2. **initialize()**: Import `LlamaCompletion` instead of `LlamaChat`; instantiate `this._completion = new LlamaCompletion({ contextSequence })`; init `_conversationLog = []`
3. **chat()**: Removed system-prompt mutation logic; `effectiveToolPrompt` computed once; `_conversationLog.push({ role: 'user', text: userMessage })`
4. **generateOnce()**: Calls `this._completion.generateCompletionWithMeta(prompt, genOptions)` with `disableContextShift: true` and `customStopTriggers: ['\nUser:', '\n\nUser:', '<|im_end|>']`; removed `contextShift.strategy` and `lastEvaluationContextWindow`
5. **Tool loop**: History tracked via `_conversationLog` (push assistant + tool results); removed `_lastEvaluation` / `cleanHistory` updates
6. **Final state**: `_conversationLog.push({ role: 'assistant', text: rawResponse })` instead of lastEvaluation update
7. **resetSession()**: `_conversationLog = []` + `sequence.clearHistory()`
8. **_dispose()**: `_completion = null; _conversationLog = []`
9. **REMOVED**: `_buildInitialHistory()` (Change AB artifact), `_contextShiftStrategy()` (80 lines — no longer needed)
10. **ADDED**: `_buildPrompt(toolPrompt)` — builds raw text prompt: SYSTEM_PROMPT + toolPrompt + 3 examples + `_conversationLog` serialized as `User:`/`Assistant:` lines
11. **ADDED**: `_trimHistoryToFit(toolPrompt)` — pre-generation context trim: while tokenCount > 0.75*contextSize, drops oldest 2 entries from `_conversationLog` (keeps current user message)

**Test project:** test-changeac-1
**Test result:** PENDING

**Revert path:** `git restore chatEngine.js`

---

## 2026-04-10 — Change AA: Behavioral few-shot examples in SYSTEM_PROMPT (REVERTED)

### Problem
Model never calls tools. Changes S-Z all failed. Root cause analysis determined:
1. `LlamaChatSession` puts the model in "assistant response" mode — fine-tuning strongly biases toward outputting code blocks in chat rather than tool call JSON.
2. The system prompt had rules ("for file operations use the file tools") but NO worked examples showing the model what a correct response looks like. Rules are weaker than training priors for a 2B model in chat mode.
3. Switching to raw completion was considered but rejected because the `_contextShiftStrategy` is tied to `LlamaChatSession`'s `chatHistory` structure — the working context rotation would break.

### Hypothesis
In-context learning (behavioral few-shot examples) can override training priors by showing the model the exact expected output pattern, not just instructions. The model learns from examples in the system prompt: "when user asks to create a file → call write_file, not code block in chat."

### Change AA — chatEngine.js: SYSTEM_PROMPT behavioral examples

**File:** `chatEngine.js`
**Constant:** `SYSTEM_PROMPT`
**Change:** Added `## Examples` section after the `## Rules` section with 12 behavioral examples covering: write_file (new file), append_to_file (continue writing), write_file×2 (multiple files), read_file, edit_file, run_command, list_directory, grep_search, web_search, browser_navigate, and 2 plain text responses (no tool needed).

**What stays unchanged:** Generation parameters (Change Z), all parsing logic, toolPrompt from mcpToolServer, context shift strategy.

**Test result:** PENDING

**Revert path:** `git restore chatEngine.js`

---

## 2026-04-10 — Change Z: Sampling parameters — match guide-2.0 working defaults

### Problem
Model never calls tools. Changes S-Y all modified system prompt text and parser routing. All failed. Root cause investigation compared the actual `generateResponse()` call parameters between guide-2.0 (known to call write_file for simple tasks) and guide-3.0.

Found: guide-2.0 uses temperature=0.4, topP=0.95, topK=40, repeatPenalty=1.1. Guide-3.0 defaulted to temperature=0.7, no topP/topK/repeatPenalty constraints. At temperature 0.7 without sampling constraints, the model's probability distribution is flatter — the training distribution attractor (write code in chat) competes more evenly with the instruction-following signal (call write_file). For complex tasks with strong training distribution pull, the training distribution wins.

### Change Z — chatEngine.js: Match sampling parameters to guide-2.0 defaults

**File:** `chatEngine.js`
**Function:** `chat()`, `generateOnce()`, `genOptions` block
**Changes:**
- `temperature: options.temperature ?? 0.7` → `options.temperature ?? 0.4`
- `topP: options.topP` → `options.topP ?? 0.95`
- `topK: options.topK` → `options.topK ?? 40`
- `repeatPenalty: options.repeatPenalty ? { penalty: options.repeatPenalty } : undefined` → `{ penalty: options.repeatPenalty ?? 1.1 }`

**What stays unchanged:** All prompt text (SYSTEM_PROMPT, toolPrompt), all parsing logic, all event wiring, all context shift logic.

**Revert path:** `git restore chatEngine.js`

---

## 2026-04-10 — Structured system prompt + concrete tool format example

### Problem: Model writes code as text instead of calling tools despite full tool prompt being active
Change X confirmed the full tool prompt (4566 chars, 20 tools) reaches the model. Parser works (found run_command call). But model still wrote 25,483 chars of HTML as text, 0 proper tool calls. Investigation found:
1. guide-3.0's SYSTEM_PROMPT was abstract paragraphs ("use the appropriate tool") — guide-2.0/original IDE had structured "## When to Use Tools" categories that worked
2. guide-3.0's format instruction had abstract placeholder `{"tool":"name","params":{...}}` — guide-2.0 had a concrete example with real tool name and params
3. guide-3.0's tool categories were bare labels — no usage context for when to use each category

### Change Y — chatEngine.js + mcpToolServer.js: Structured prompt + format example

**chatEngine.js — SYSTEM_PROMPT (lines 10-30):**
- Replaced abstract paragraph-form prompt with structured sections
- Added "## When to Use Tools" with one entry per tool category (file, web, terminal, browser, git, memory, analysis, planning) — all categories treated equally
- Added "## Continuation" section for seamless continuation
- Added "## Rules" section with behavioral expectations (verify tool results, retry failures, create all requested files, use exact filenames)
- Category entries describe WHEN to use each category, not which specific tool to pick
- Conversation/text response listed LAST, not first

**mcpToolServer.js — _buildToolPrompt() (line 2853):**
- Format instruction changed from abstract `{"tool":"name","params":{...}}` to more concrete `{"tool":"tool_name","params":{"param":"value"}}`
- Added concrete `Example:` block with real tool call: `{"tool":"list_directory","params":{"dirPath":"."}}`
- Category headers changed from bare labels to descriptive labels with usage context (e.g. "File Operations — for creating, reading, modifying, or deleting files and directories")
- All 6 categories have equal usage descriptions — no tool prioritized over another

**Revert path:** `git restore chatEngine.js mcpToolServer.js`

---

## 2026-04-10 — Wire chatEngine to existing tool infrastructure

### Problem: Model writes code as text instead of calling tools (882 lines of HTML as text, 0 tool calls)
chatEngine.js had its own SIMPLIFIED _buildToolPrompt() (flat list, no categories, no rules) and SIMPLIFIED _parseToolCalls() (only 2 detection methods). The same codebase already had battle-tested versions in mcpToolServer.js (full prompt with categories, patterns, "NEVER output full file content as code blocks") and tools/toolParser.js (7+ detection methods, 50+ tool name aliases, truncated recovery, XML/JSON/function-call syntax). chatEngine wasn't using them.

Guide-2.0 live test confirmed: same model (Qwen3.5-2B) with the full tool prompt + full parser successfully called write_file to create hello.txt.

### Change X — chatEngine.js + server/main.js: Use existing tool infrastructure

**chatEngine.js:**
- Added `const { parseToolCalls } = require('./tools/toolParser');` import
- `chat()` now destructures `toolPrompt` from options
- When `toolPrompt` is provided (full prompt from mcpToolServer), uses it instead of calling `this._buildToolPrompt(functions)` — log message: "Using full tool prompt (N chars)"
- `_parseToolCalls()` body replaced: delegates to `parseToolCalls()` from toolParser, maps `{tool, params}` → `{name, params}` format, computes cleanText by stripping fenced/XML/raw tool blocks

**server/main.js:**
- Added `const toolPrompt = mcpToolServer.getToolPrompt();` after building tool definitions
- Passes `toolPrompt` in llmEngine.chat() options

**What stays unchanged:**
- `_buildToolPrompt()` method remains as fallback (used when no toolPrompt passed)
- `convertToolDefs()` unchanged
- Tool loop, event wiring (Change V), streaming logic unchanged
- No new files, no new abstractions

**Revert path:** `git restore chatEngine.js server/main.js`

---

## 2026-04-10 — Tool call format change + output suppression removed

### Problem: <tool_call> XML format recognized by 3/7 models (all Qwen). Output suppression hides tool call content from UI.
7-model test results: Qwen3 0.6B, Qwen2.5 0.5B, Qwen3 4B followed `<tool_call>` XML tags. Llama 3.2, EXAONE 4.0, Qwen2.5 1.5B, Qwen3.5 2B did not. EXAONE produced correct JSON without wrapper tags. The streaming buffer `flushSafeText()` mechanism suppressed tool call content from the UI, violating guide-master.md line 101.

### Change S — chatEngine.js: Remove output suppression from streaming buffer

**Removed:**
- `TOOL_START`/`TOOL_END` constants from `generateOnce()`
- `streamBuffer`, `inToolCall`, `toolCallBuffer` state variables
- `flushSafeText()` function — the entire streaming buffer state machine
- Post-generation buffer flush logic (orphan tag handling, remaining buffer flush)

**Replaced with:** Direct passthrough — every chunk from `onTextChunk` goes to `fullResponse` and `onToken` immediately. All model output is visible in the UI.

### Change T — chatEngine.js: Switch tool call format from `<tool_call>` XML to ` ```json ` markdown fences

**_buildToolPrompt():**
- OLD format instruction: `<tool_call>\n{"name":"tool_name","params":{...}}\n</tool_call>`
- NEW format instruction: ` ```json\n{"tool":"write_file","params":{"filePath":"index.html","content":"hello"}}\n``` `
- JSON key changed: `"name"` → `"tool"` (less ambiguous — "name" conflicts with parameter names)
- Concrete example with real tool values instead of placeholder `tool_name`
- Explicit rules: one tool per block, always use fences, wait for result

**_parseToolCalls():**
- OLD: Single method scanning for `<tool_call>JSON</tool_call>` blocks
- NEW: Two-method parser:
  1. ` ```json ` fenced code blocks — regex extracts JSON from markdown fences, checks for `"tool"` key
  2. Raw JSON fallback — regex matches `{"tool":"...","params":{...}}` without fences (handles EXAONE-like models)
- Return interface unchanged: `{ toolCalls: [{name, params}], cleanText }`
- Non-tool ` ```json ` blocks (e.g. code examples) pass through — only blocks with a `"tool"` key are treated as tool calls

**Rationale:** Markdown code fences (` ```json `) appear in every LLM training corpus (GitHub code, Stack Overflow, documentation). `<tool_call>` XML tags appear in none. Choosing a format models already know reduces the need for complex multi-fallback parsers.

**Revert path:** `git restore chatEngine.js`

---

## 2026-04-10 — Truncated JSON brace recovery in _parseToolCalls

### Problem: Model hits eogToken before writing final closing brace(s) in tool call JSON
Qwen3-0.6B emitted a ```json fenced write_file call with 5495 chars of properly escaped HTML content. JSON was structurally complete except for missing final `}` to close the outer object. JSON.parse failed at position 5494. Tool call was detected but never executed — no file created.

### Change U — chatEngine.js: Add brace recovery to _parseToolCalls

**Where:** `_parseToolCalls()`, Method 1 catch block (fence detection)

**What:** When JSON.parse fails on a fenced code block, try appending up to 3 closing `}` characters. After each append, retry JSON.parse. If it succeeds and has a `"tool"` key, accept the recovered tool call.

**Why not a band-aid:** The model generated structurally valid JSON with properly escaped content (162 `\n` sequences). The only defect was a missing trailing brace — the model's eogToken fired before completing the structure. This recovers clearly-intended structure, not patching bad output.

**Revert path (all changes S+T+U):** `git restore chatEngine.js`

---

## 2026-04-10 — Wire backend tool events to frontend display system

### Problem: Raw tool call JSON visible in chat UI as code block
After Changes S+T+U, the model correctly generates ```json fenced tool calls, the parser extracts them, and tools execute. But the raw JSON `{"tool":"write_file","params":{...}}` was streamed as `llm-token` events during generation and rendered in the chat UI as a visible code block. The backend computed `cleanText` (response minus JSON) but never sent it to the frontend. The backend never emitted `file-content-start/token/end` events that the frontend's `FileContentBlock` component expects.

### Change V — chatEngine.js + server/main.js + App.jsx + appStore.js: Event wiring

**chatEngine.js:**
- Added `onStreamEvent` to destructured options
- After `_parseToolCalls()` finds tool calls:
  - Emits `llm-replace-last` with `{ originalLength: rawResponse.length, replacement: parsed.cleanText }` — tells frontend to strip the raw JSON from display and replace with clean text
  - Cleans `fullResponse` to match
- Before each tool execution:
  - Emits `tool-executing` — triggers tool card display (file ops skipped per R42-Fix-4)
  - For tools with `params.content` + `params.filePath`: emits `file-content-start` (with language from file extension), `file-content-token` (full content), `file-content-end` — triggers FileContentBlock display
- After each tool execution:
  - Emits `mcp-tool-results` — triggers tool completion card (file ops skipped per R42-Fix-4)

**server/main.js:**
- Added `onStreamEvent: (eventName, data) => mainWindow.webContents.send(eventName, data)` to ai-chat handler options

**App.jsx:**
- `llm-replace-last` handler now calls `s.replaceLastStreamingChunk(data.originalLength, data.replacement)`

**appStore.js:**
- Added `replaceLastStreamingChunk(originalLength, replacement)` method:
  - Flushes pending 80ms token buffer
  - Trims last `originalLength` characters from `chatStreamingText`
  - Appends `replacement` text
  - Updates last text segment in `streamingSegments` to match
  - Preserves previous segments (file blocks, tool cards from earlier iterations)

**Expected result:** User sees actual file content in a FileContentBlock (filename header + syntax-highlighted code), not raw JSON wrapper. Clean text (if any) before/after the tool call remains visible.

**Revert path (Change V only):** `git restore chatEngine.js server/main.js frontend/src/App.jsx frontend/src/stores/appStore.js`

---

## 2026-04-10 — Raw text parsing replaces GBNF function calling

### Problem: GBNF structured function calling fails across all model families
Tested 7 models / 6 families with node-llama-cpp's `genOptions.functions` + `documentFunctionParams: true`. 0 of 7 worked correctly. Category A (4 models) always pick text mode. Category B (3 models) loop the same function call 20 times. See PAST_FAILURES.md Category 6 for full test results.

### Change R — chatEngine.js: Raw text parsing (replaces GBNF function calling)

**Removed:**
- `genOptions.functions = functions` — no longer passing GBNF function definitions to generateResponse
- `genOptions.documentFunctionParams = true` — no longer using GBNF parameter documentation
- Entire GBNF-based tool call loop (`while (stopReason === 'functionCalls')` block)
- GBNF diagnostic log (replaced with new logging)

**Added:**
- `_parseToolCalls(text)` method — extracts `<tool_call>{"name":"...","params":{...}}</tool_call>` blocks from model text output. Returns `{ toolCalls: [{name, params}], cleanText }`.
- Streaming buffer in `generateOnce()` — holds back last 11 chars (length of `<tool_call>`) to prevent tool call content from reaching the UI. Text before `<tool_call>` is streamed normally. Text inside `<tool_call>...</tool_call>` is suppressed.
- Text-based tool call loop — after generation: parse raw response → execute tool calls → add `[Tool Result: toolName]\nresult` to chatHistory as user message → generate again → repeat.
- Fallback: if `fullResponse` is empty and no tools ran, shows `rawResponse` so user always sees something.

**Modified:**
- `_buildToolPrompt()` — added TOOL CALL FORMAT section telling the model the exact `<tool_call>` JSON format. Removed "chain tools in sequence" instruction (now: "call one tool at a time and wait for its result").

**Not changed:** server/main.js, mcpToolServer.js, convertToolDefs(), context shift strategy, frontend. The `functions` object is still created and passed to `chat()` but used only for building the system prompt — not for GBNF.

**Revert path:** `git restore chatEngine.js` reverts to the GBNF baseline state. Or for full revert of all uncommitted changes: `git restore chatEngine.js mcpToolServer.js frontend/src/components/ChatPanel.jsx CHANGES_LOG.md model-config.json PAST_FAILURES.md`

---

## 2026-04-09 (session 3, continued) — Tool calling improvements + UI fixes

### Problem: 0 tool calls at baseline. Model generates code as text instead of calling tools.
FileShot test: 781 lines HTML as text, stopReason=eogToken, functionCalls=0. System prompt had weak tool guidance, tool prompt was file-biased, only 12 tools enabled, tool descriptions contained legacy Format: hints and behavioral instructions.

### Change L — chatEngine.js: Production system prompt (SYSTEM_PROMPT constant)
- **OLD**: "You are guIDE, a helpful AI coding assistant running locally. You help users write code, answer questions, and assist with software development tasks. Be concise and direct."
- **NEW**: 4-paragraph prompt covering: (1) identity as local AI with tool access, (2) when to use tools — any action including files, commands, search, browse, analyze, (3) when to use text — questions, explanations, discussions, (4) code quality + follow existing conventions
- **Rationale**: Model needs explicit instruction that it has tools and should use them for actions.

### Change M — chatEngine.js: General _buildToolPrompt (replaces file-biased version)
- **OLD**: TOOL USAGE RULES listing specific file/grep/web tool categories with "you MUST use" imperatives
- **NEW**: AVAILABLE TOOLS section with parameter signatures (e.g. `- write_file (filePath: string, content: string): description`) followed by 4 general TOOL USAGE rules: use tools for actions, chain tools for multistep, prefer tools over text output, use text for questions/explanations
- **Rationale**: Previous version only instructed model about file tools. Browser, git, search, and system tools were not mentioned.

### Change N — chatEngine.js: DEFAULT_ENABLED_TOOLS expanded from 12 to 20
- **Added 8 tools**: search_codebase, delete_file, rename_file, git_status, git_diff, git_commit, install_packages, analyze_error
- **Categories covered**: File ops (10), Search (2), Web (2), Terminal (2), Git (3), Debug (1)
- **Remaining 46 tools**: Available but disabled by default, toggleable in settings

### Change O — mcpToolServer.js: Cleaned all 66 tool descriptions
- Removed `Format: {"tool":"name",...}` hints from all descriptions (legacy text-parsing hints, already stripped by convertToolDefs)
- Removed behavioral imperatives from descriptions (e.g. "ALWAYS use this tool", "NEVER output file contents", "Call this before naming or assuming any files exist")
- Kept descriptions factual: what the tool does, not how the model should behave
- Behavioral instructions belong in the system prompt, not individual tool descriptions

### Change P — chatEngine.js: GBNF diagnostic log
- Added generation config log before first generateResponse call
- Logs: function count, documentFunctionParams state, system prompt character length, lastEvaluation presence
- Purpose: Diagnostic — confirms GBNF function calling grammar is active during generation

### Change Q — ChatPanel.jsx: Directory-specific recent chats
- Session save now includes `projectPath` in the saved session object
- Session display filters by current `projectPath` — only shows sessions from the same project
- If no project is open, shows all sessions (fallback)

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
