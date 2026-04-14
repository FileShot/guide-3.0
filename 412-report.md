# Test Report — 2026-04-12

## Test 1 — Space Station Dashboard (test-session-2026-04-12a)

```
TEST: "I want you to create a single HTML file with everything embedded for a retro pixel-art space station command center dashboard..." (14+ feature requirements, single paragraph)
CATEGORY: Basic Sanity + Tool Calling
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~110 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - rawLen=12195 (first generation), rawLen=1232 (second generation after tool result)
  - stopReason=abort (brace-depth tracking detected complete JSON)
  - File written: index.html, 291 lines
  - Context peaked at ~80%, no rotation triggered
  - Tool call parsed from model output: write_file with filePath and content
  - Parser `"}}` fix verified — no JSON structure leaked into file content
  - LlamaChatSession context management: second generation produced rawLen=1232 (not rawLen=0 as before migration)

BUGS FOUND:
  - BUG: Raw tool call JSON visible in chat during generation (pre-streaming detection code)
    EVIDENCE: User observation: "the codeblock literally has the tool call in it"
    SEVERITY: major — addressed by streaming file content detection implemented after this test

LINE COUNT PROGRESSION: 0 → 291 (no regression, single generation)
STRUCTURAL INTEGRITY: yes — DOCTYPE through closing /html verified

---

## Test 2 — Fantasy RPG Character Sheet (test-session-2026-04-12b)

```
TEST: "I want you to create a single HTML file with everything embedded for a fantasy RPG character sheet manager..." (14+ feature requirements including dark/light theme, stat bars, inventory, skill tree, spell grid, dice roller, XP bar, notes, modals, save/load — single paragraph)
CATEGORY: Tool Calling + Streaming File Content Detection
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~123 seconds (first gen) + ~11 seconds (follow-up)
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - rawLen=16176 (first generation), rawLen=1281 (second generation)
  - stopReason=abort (brace-depth tracking), then eogToken
  - File written: index.html, 460 lines on disk
  - Context peaked at 96%, no rotation triggered
  - Streaming file content detection active:
    - file-content-start, file-content-token, file-content-end events emitted from backend
    - 186+ file-content-token events captured in browser console (earlier events overflowed buffer)
    - file-content-end event received with {filePath: index.html}
  - FileContentBlock rendered in finalized message showing "HTML (340 lines)"
  - Finalization log: segmentsLen=2, messageContentLen=12871, hasContent=true
  - Model generated a bulleted feature summary in follow-up response (1281 chars)
  - Tool JSON was suppressed from chat — no raw JSON visible during generation

BUGS FOUND:
  - BUG: Auto-scroll does not engage during streaming file content accumulation
    EVIDENCE: StreamingFooter renders file content block with accumulating content, but the auto-scroll useEffect in ChatPanel.jsx (line ~450) depends on [chatStreaming, chatStreamingText, streamingSegments, streamingToolCalls] — does NOT include streamingFileBlocks. When file content accumulates via appendFileContentToken (which updates streamingFileBlocks), no scroll fires. The footer is below the visible viewport and never scrolls into view during generation.
    SEVERITY: major — user sees nothing during the entire 2+ minute generation

  - BUG: File content line count mismatch — streaming detection captured 340 lines but actual file has 460 lines
    EVIDENCE: FileContentBlock in chat shows "HTML (340 lines)". Backend log shows write_file created index.html with 460 lines (+460 in the files-changed banner). 120 lines of content were lost during streaming detection, likely from the 100ms buffer flush timing in appendFileContentToken or from the last chunk not being fully processed before file-content-end fires.
    SEVERITY: major — streamed content is incomplete compared to actual file

LINE COUNT PROGRESSION: 0 → 460 on disk, 0 → 340 in streaming display
STRUCTURAL INTEGRITY: yes on disk — DOCTYPE through closing /body verified in backend log

---

---

## Test 3 — Recipe Manager App (test-session-2026-04-12c)

```
TEST: "i'm building a recipe manager app for the browser, needs an index.html with the structure, a styles.css file with a cozy warm kitchen theme using earthy tones and card layouts, an app.js with all the logic..." (14+ feature requirements across 4 files, single paragraph)
CATEGORY: Multi-File Tool Calling + Implicit Tool Use
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~165 seconds total
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 6 total tool calls (tool call #1–6)
  - Tool call sequence:
    - #1: write_file({"filePath":"index.html"}) — NO content param → error returned
    - #2: write_file({"filePath":"index.html","content":"..."}) rawLen=2891 → success (66 lines on disk)
    - #3: write_file({"filePath":"styles.css"}) — NO content param → error returned
    - #4: write_file({"filePath":"styles.css","content":"..."}) rawLen=9447 → success (378 lines on disk)
    - #5: write_file({"filePath":"app.js"}) — NO content param → error returned
    - #6: write_file({"filePath":"app.js","content":"..."}) rawLen=10706 → success (280 lines on disk)
  - stopReason=eogToken for tool calls #1, #3, #5, #6; stopReason=abort for #2, #4 (brace-depth)
  - Final generation: rawLen=667, parsedToolCalls=0 (text summary)
  - readme.md was NOT created despite being explicitly requested in the prompt
  - Context peaked at 94%
  - 3 FileContentBlocks rendered in chat: index.html (72 lines), styles.css (439 lines), app.js (257 lines)
  - "3 files changed, +815 lines" banner in toolbar

BUGS FOUND:
  - BUG: Model calls write_file without the content parameter, then retries after error
    EVIDENCE: Tool calls #1, #3, #5 all contain only {"filePath":"..."} — no "content" key. The tool returns an error message explaining the missing param. On the very next generation, the model then calls write_file again with full content. This happened for all 3 large files. The model is "planning ahead" rather than writing in one call.
    SEVERITY: major — doubles the number of tool call roundtrips (3 unnecessary failed calls + 3 retry calls = 6 instead of 3). Each failed call consumes context. Every failed roundtrip adds latency (~2 seconds + the next generation).

  - BUG: readme.md not written despite explicit user request
    EVIDENCE: Prompt explicitly says "oh and add a readme.md that explains how to use it". After app.js was written (tool call #6, rawLen=10706), the model produced a text summary (rawLen=667) instead of calling write_file again for readme.md. Context was at 94% — approaching limit.
    SEVERITY: major — prompt compliance failure. Context pressure caused the model to skip the final deliverable.

  - BUG (REPRO): File content line count mismatch — chat shows different line counts than disk
    EVIDENCE:
    - index.html: chat shows "72 lines", disk has 66 lines (chat over-reports by 6)
    - styles.css: chat shows "439 lines", disk has 378 lines (chat over-reports by 61)
    - app.js: chat shows "257 lines", disk has 280 lines (chat UNDER-reports by 23)
    Line count reported in the FileContentBlock differs from actual file content. Direction varies (over and under). Not a simple off-by-one.
    SEVERITY: major — matches Bug 2 from Test 2 (streaming detection line count mismatch). Confirmed as a consistent pipeline bug.

LINE COUNT PROGRESSION: 0 → 66 (index.html) + 378 (styles.css) + 280 (app.js) = 724 lines total on disk
STRUCTURAL INTEGRITY: yes for all 3 files — well-formed HTML, CSS, and JS in backend log

---

## Summary of Open Bugs (after Tests 1-4)

| # | Bug | Severity | Location | Tests |
|---|-----|----------|----------|-------|
| 1 | Auto-scroll does not engage during file streaming | major | ChatPanel.jsx ~L450 | Test 2 |
| 2 | Content line count mismatch (streaming vs disk) | major | chatEngine.js / appStore.js | Test 2, Test 3 |
| 3 | Model calls write_file without content, retries after error | major | System prompt / tool call loop | Test 3 |
| 4 | readme.md skipped — context pressure truncates deliverables | major | chatEngine.js context management | Test 3 |
| 5 | Overwrite protection blocks legitimate fix; model infinite-loops to 20 call limit | critical | mcpToolServer.js overwrite guard | Test 4 |

---

## Test 4 — Task Tracker Bug Fix (test-session-2026-04-12d)

```
TEST: "the task tracker app in public/ has a bug where tasks don't persist when you reload the page, take a look at the code and fix whatever is causing it"
CATEGORY: Non-write_file tools (list_directory, read_file) + Bug Fix
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~48 seconds (truncated at 20 tool call limit)
CONTEXT SHIFTS: 0
FILES: server.js, package.json, public/index.html, public/app.js (27 lines, has BUG comments)
```

OBSERVATIONS:
  - Tool call sequence:
    - #1: list_directory({"dirPath":"public"}) — correctly found the directory content
    - #2: read_file({"filePath":"public/app.js"}) — correctly read the 27-line file with bugs
    - #3: write_file({"filePath":"public/app.js","content":"..."}) rawLen=1097 — BLOCKED (22 lines vs 27 on disk → overwrite protection triggered)
    - #4–#9: (unknown intermediate calls — model trying different approaches)
    - #10–#20: write_file({"filePath":"public/app.js","content":"render();\n\nfunction toggle..."}) — 5-line partial content, BLOCKED each time
    - At call #20: Tool iteration limit reached — generation ended
  - The fix in call #3 was CORRECT: added `localStorage.setItem('tasks', JSON.stringify(tasks))` in both `addTask()` and `toggle()`. The content was reduced from 27 to 22 lines because the model removed the `// BUG:` comments, which is correct behavior.
  - The overwrite protection incorrectly blocked a legitimate refactor/fix that reduced line count
  - After being blocked, the model entered an infinite retry loop submitting a 5-line partial fragment — same content, same error, every ~2 seconds
  - Hit the 20-call tool iteration limit. File NOT fixed.
  - Non-write_file tools were used successfully: list_directory and read_file both worked correctly on the first try — no "missing parameter" behavior

BUGS FOUND:
  - BUG: Overwrite protection blocks legitimate line-reducing file writes (bug fixes, refactors)
    EVIDENCE: write_file call #3 contained the complete correct fix (22 clean lines) but was blocked because the original file had 27 lines (5 extra comment lines with `// BUG: ...` notes). The guard triggers on line count reduction regardless of intent.
    SEVERITY: critical — prevents fixing bugs in existing files unless the fixed version is longer than the original

  - BUG: Model enters infinite retry loop on repeated tool failures with same inputs
    EVIDENCE: Tool calls #10–#20 are identical: same filePath, same 5-line content fragment. Each gets the same BLOCKED error. The model does not escalate to a different tool (edit_file, append_to_file) — it just retries the same failed call indefinitely until the 20-call limit fires.
    SEVERITY: critical — 20 tool calls consumed, user sees failure, no file written

  - BUG: 20 tool call limit is not surfaced to the user
    EVIDENCE: WARN log says "Tool iteration limit reached (20)" but no indication was visible in chat that the operation was cut off. The user would see a message with whatever partial output was generated after 20 failed calls, with no explanation.
    SEVERITY: major — silent failure

LINE COUNT PROGRESSION: 0 changes (file NOT modified due to overwrite protection)
STRUCTURAL INTEGRITY: N/A — no file was written

---

## Test 5 — Note Keeper Bug Fix (test-session-2026-04-12e)

```
TEST: "hey the note keeper app in public/ is broken. notes dont save when you reload, and the delete buttons dont work at all. can u look at the code and fix whatever is wrong with it"
CATEGORY: Bug Fix via read_file + write_file (non-write_file tools first)
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~unknown (short — 3 total steps)
CONTEXT SHIFTS: 0
FILES: public/app.js (45 lines, 3 deliberate bugs: wrong localStorage key, localStorage.setItem never called, '#del-btn' selector instead of '.del-btn')
```

OBSERVATIONS:
  - Tool call sequence:
    - #1: read_file({"filePath":"index.html"}) — WRONG PATH: file is at public/index.html, not index.html. ENOENT error returned.
    - #2: browser_navigate({"url":"file:///..."}) — CRASHED: "this.browserManager.navigate is not a function" — runtime error on server
    - Final generation: rawLen=761, parsedToolCalls=0 — prose guessing bugs, no code written
  - app.js unchanged on disk: still 45 lines, all 3 bugs remain
  - Model did NOT attempt write_file after the two failed non-write_file calls
  - Model guessed the bugs in the prose response without reading the file (speculation without evidence)

BUGS FOUND:
  - BUG: read_file called with wrong path — omits subdirectory prefix
    EVIDENCE: File is at test-session-2026-04-12e/public/index.html. Model called read_file("index.html") — did not include the "public/" subdirectory. The tool returns ENOENT rather than searching for the file.
    SEVERITY: major — model cannot fix bugs in files inside subdirectories without correct path

  - BUG: browser_navigate tool crashes with "this.browserManager.navigate is not a function"
    EVIDENCE: Tool call #2 was browser_navigate({"url":"file:///..."}). Server-side execution threw: TypeError: this.browserManager.navigate is not a function. The method does not exist on browserManager. This is a runtime crash in the tool handler.
    SEVERITY: critical — browser_navigate is completely non-functional; any model attempt to use it will crash the server handler

LINE COUNT PROGRESSION: 0 (file NOT modified)
STRUCTURAL INTEGRITY: N/A — no file written

---

## Test 6 — Portfolio Site 4-File Creation (test-session-2026-04-12f)

```
TEST: "build me a portfolio website with 4 files: index.html with semantic html structure and a nav hero about projects skills and contact section, styles.css with a dark theme responsive design with animations and hover effects, app.js with interactive features including scroll spy smooth scrolling skill bar animations dark mode toggle and contact form validation, and a readme.md explaining the project structure and setup"
CATEGORY: Multi-File Tool Calling (4 files including markdown)
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~3 minutes 30 seconds
CONTEXT SHIFTS: 4 (99%→93%→100%→97%)
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 4 tool calls, all write_file, all successful
  - Tool call sequence:
    - #1: write_file("index.html") rawLen=12947 → success (122 lines on disk). stopReason=abort (brace-depth)
    - #2: write_file("styles.css") rawLen=8451 → success (273 lines on disk). stopReason=abort (brace-depth)
    - #3: write_file("app.js") rawLen=5596 → success (144 lines on disk). stopReason=abort (brace-depth)
    - #4: write_file("readme.md") rawLen=3304 → success (58 lines on disk). stopReason=eogToken
  - Context shifts observed in sequence: 99%→93%→100%→97% — LlamaChatSession auto-managed
  - readme.md was written (context was lower than Test 3 — 97% not 94%, but different threshold behavior)
  - Model did NOT call write_file with missing content parameters (unlike Test 3's 3 empty calls)
  - Complete: 4 tool calls, stopReason=eogToken (final summary generation)
  - Context peaked at 100% and continued — context rotation/shift handled by LlamaChatSession
  - OBSERVATION: Raw JSON tool call visible inside a code block in chat when model output starts with prose explanation before the JSON. Streaming detection only activates when token stream begins with `{` or backtick-fence — missed when model writes text first.

BUGS FOUND:
  - BUG: Streaming detection misses tool calls preceded by prose preamble (NEW)
    EVIDENCE: In at least 1 of the 4 tool calls, the model began its response with explanatory text ("I'll create...") before the raw JSON tool call. The streaming suppression only fires when the response starts with `{` or ` ``` ` — any preceding text causes the raw JSON to leak into a rendered code block in chat.
    SEVERITY: major — user sees raw tool call JSON mid-conversation; same root bug as Test 1's initial version

  - BUG (REPRO): File content line count mismatch — streaming vs disk (same as Tests 2 and 3)
    EVIDENCE: Streaming counts differ from disk counts (not independently verified per-file in this test).
    SEVERITY: major — consistent pipeline bug across Tests 2, 3, 6

LINE COUNT PROGRESSION: 0 → 122 (index.html) + 273 (styles.css) + 144 (app.js) + 58 (readme.md) = 597 lines total
STRUCTURAL INTEGRITY: yes for all 4 files — backend log confirms all write_file results success=true

---

## Test 7 — JavaScript Concept Q&A (test-session-2026-04-12g)

```
TEST: "hey quick question - whats the difference between == and === in javascript and when should i actually use each one"
CATEGORY: Non-tool-calling path (Q&A / conversational response)
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~10 seconds
CONTEXT SHIFTS: 0
```

OBSERVATIONS:
  - rawLen=1383, parsedToolCalls=0, stopReason=eogToken
  - No tool calls made — correct behavior for a Q&A prompt
  - Response was well-formatted markdown with code examples illustrating == vs ===
  - Context at 29% — well within limits
  - "Session prompt: histItems=5, contextSize=8192" logged

BUGS FOUND:
  - None — Q&A path functioned correctly

LINE COUNT PROGRESSION: No files affected
STRUCTURAL INTEGRITY: N/A — no tool calls

---

## Test 8 — Utility Library Single-File (test-session-2026-04-12h)

```
TEST: "create a javascript utility library file called utils.js with the following functions in it: a deepClone function that handles nested objects arrays and primitives, a debounce function with immediate option, a throttle function, a flattenObject function that flattens nested object keys with dot notation, a groupBy function that groups an array of objects by a key, a memoize function with optional max cache size, a pipe function for function composition, a curry function, a chunk function to split arrays into chunks, an isEqual function for deep equality checking between two values, and add jsdoc comments to each function explaining params and return value"
CATEGORY: Single-File Tool Calling (10 named functions with JSDoc, dense content)
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~55 seconds
CONTEXT SHIFTS: 0
```

OBSERVATIONS:
  - 1 tool call: write_file("utils.js") rawLen=7595 → success (192 lines on disk, 7296 bytes)
  - stopReason=abort (brace-depth tracking detected JSON boundary)
  - Context at 52% when complete
  - All 10 requested functions present in the file: deepClone, debounce, throttle, flattenObject, groupBy, memoize, pipe, curry, chunk, isEqual
  - JSDoc comments present for each function (verified in chat preview and on disk)
  - "Early tool call detected at complete JSON boundary (1)" log — brace-depth parser fired before eogToken
  - Follow-up generation: rawLen=710, parsedToolCalls=0 (text summary listing all functions) — correct

BUGS FOUND:
  - BUG: Model generates invalid JavaScript syntax — `export function ...pipe(...)`, `export function ...curry(...)`, `export function ...chunk(...)`, `export function ...isEqual(...)`
    EVIDENCE: Backend log shows function declarations with `...` spread prefix on the function name, e.g. `export function ...pipe(...funcs)`. This is syntactically invalid JS. The model likely confused rest parameters with function name syntax. The functions ARE present and have otherwise valid bodies, but the declarations are broken.
    SEVERITY: major — utils.js is written but not syntactically valid JS (would fail to parse/import). The file exists and all content is there, but requires a manual fix to be usable.

  - BUG (REPRO): deepClone implementation references undefined variables (`isDeepCloneInput`, `cloneArrayOrObject`)
    EVIDENCE: Body of deepClone contains `(val instanceof Date && !isDeepCloneInput)` and `cloneArrayOrObject(val)` — neither `isDeepCloneInput` nor `cloneArrayOrObject` is defined anywhere in the file. Model hallucinated helper function names.
    SEVERITY: major — runtime crash if deepClone is called at certain input shapes. File is written and executes through requires, but deepClone throws ReferenceError.

LINE COUNT PROGRESSION: 0 → 192 (utils.js)
STRUCTURAL INTEGRITY: partial — file was written, all 10 functions present, JSDoc present, but 4 function declarations have invalid `...` syntax prefix and deepClone has undefined variable references

---

## Updated Summary of Open Bugs

| # | Bug | Severity | Location | Tests |
|---|-----|----------|----------|-------|
| 1 | Auto-scroll does not engage during file streaming | major | ChatPanel.jsx ~L450 | Test 2 |
| 2 | Content line count mismatch (streaming vs disk) | major | chatEngine.js / appStore.js | Test 2, 3, 6 |
| 3 | Model calls write_file without content, retries after error | major | System prompt / tool call loop | Test 3 |
| 4 | readme.md skipped at high context (94%) | major | chatEngine.js context management | Test 3 |
| 5 | Overwrite protection blocked legit line-reducing writes — REMOVED | critical→fixed | mcpToolServer.js | Test 4 |
| 6 | 20 tool call limit not surfaced to user | major | chatEngine.js | Test 4 |
| 7 | read_file called with wrong path (omits subdirectory prefix) | major | System prompt / tool behavior | Test 5 |
| 8 | browser_navigate crashes: "this.browserManager.navigate is not a function" | critical | server-side tool handler | Test 5 |
| 9 | Streaming detection misses tool calls preceded by prose preamble | major | chatEngine.js streaming detection | Test 1, 6 |
| 10 | Model generates syntactically invalid JS function declarations (extra `...`) | major | Model generation quality | Test 8 |
| 11 | Model hallucinates undefined variable/function references in generated code | major | Model generation quality | Test 8 |
| 12 | Model misdiagnoses bugs — fixes wrong root cause, presents incorrect fix as solved | major | Model reasoning / system prompt | Test 9 |
| 13 | Model drops module.exports in file rewrite (silent regression) | major | Model generation quality | Test 9 |
| 14 | Model corrupts JS with unclosed `/**` comment prefix | critical | Model generation quality | Test 9 |
| 15 | edit_file tool never invoked across 9 tests — model defaults to write_file for all edits | major | System prompt / tool selection | Tests 1-9 |

## Tests Still Needed

- Tests that trigger context rotation (Test 6 had context shifts at 99%→93%→100%→97% but no independent rotation verification)
- Tests with edit_file tool (none of the 9 tests used it — write_file used for all edits)
- Tests with create_directory tool (none used it)
- Tests with append_to_file tool (none used it)
- Retest of bug fix scenario after overwrite protection removal (note: Test 9 succeeded at reading+writing but introduced new bugs via incorrect fix + JS corruption)

---

## Test 9 — Shopping Cart Bug Fix (test-session-2026-04-12i)

```
TEST: "i have a cart.js file in the project and it has two bugs. first the removeItem function is broken - when you call removeItem with an id it does nothing, the item stays in the cart. second getTotal is calculating the wrong total - it adds price and quantity instead of multiplying them. can you read the file, find both bugs and fix them"
CATEGORY: Bug Fix via read_file + write_file (targeted 2-line fix)
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~14 seconds total
CONTEXT SHIFTS: 0
FILES: cart.js (33 lines, 2 deliberate bugs: filter direction wrong in removeItem, + vs * in getTotal)
```

OBSERVATIONS:
  - 2 tool calls: read_file → write_file
  - Tool call sequence:
    - #1: read_file({"filePath":"cart.js"}) rawLen=119 — correct path (file at project root, stopReason=abort)
    - #2: write_file({"filePath":"cart.js","content":"..."}) rawLen=1649 → success (isNew=false, overwrote existing file, stopReason=eogToken)
  - Complete: 2 tool calls, stopReason=eogToken
  - Context at 37%
  - Model used write_file (full rewrite), NOT edit_file — edit_file was NOT called in any of Tests 1-9
  - read_file was called with correct path: "cart.js" (file is at root of test project, not subdirectory)

BUGS FOUND:
  - BUG: removeItem bug misdiagnosed — model fixed type coercion but kept wrong filter direction
    EVIDENCE: Original bug: `this.items.filter(item => item.id === productId)` — filter KEEPS matching items instead of removing them. Correct fix: change `===` to `!==`. Model "fixed" by adding String() coercion: `this.items.filter(item => String(item.id) === productId)` — still keeps matching items. The bug is NOT fixed. Model identified the wrong root cause (type mismatch) instead of the actual one (operator direction).
    SEVERITY: major — model confident in its wrong diagnosis, wrote "FIX:" comment above incorrect code, presented it as solved

  - BUG: Model drops module.exports line from rewrite
    EVIDENCE: Original file ends with `module.exports = cart;`. Written file ends with `};` (object closing only). The export line was silently omitted. File would fail to import in any consumer.
    SEVERITY: major — silent regression; file is written but not importable as a module

  - BUG: Model prepends `/**` to a line-comment, creating invalid JS
    EVIDENCE: Original file starts with `// Shopping cart module`. Written file starts with `/** Shopping cart module` — no closing `*/`, making the JS parser treat everything that follows as part of a multi-line comment until the next `*/` appears. This corrupts the entire module.
    SEVERITY: critical — file written to disk is not valid JavaScript at all

  - OBSERVATION: edit_file tool was never used
    EVIDENCE: Model chose write_file (full rewrite) for a 2-line targeted fix. No test in the 9 tests run has triggered edit_file. This may indicate: (a) the model never learned to prefer edit_file for targeted edits, (b) edit_file is not well-represented in the tool prompt, or (c) the model defaults to write_file for any modification.

LINE COUNT PROGRESSION: 33 lines → 32 lines (module.exports dropped)
STRUCTURAL INTEGRITY: NO — file starts with unclosed `/**` comment; entire content is inside a comment block; JS is not parseable

---

## Test 10 — Data Structures Reference Implementation (test-session-2026-04-12j)

```
TEST: "create a data-structures.js file that implements 10 classic data structures as ES6 classes: Stack (push, pop, peek, isEmpty, size, toArray), Queue (enqueue, dequeue, peek, isEmpty, size, toArray), LinkedList (append, prepend, insertAt, delete, find, contains, head, tail, toArray), DoublyLinkedList (same interface + previous traversal), BinarySearchTree (insert, delete, search, inOrder, preOrder, postOrder, contains, toArray), MinHeap (insert, extractMin, peek, buildFromArray, heapify, size), HashMap (set, get, delete, has, keys, values, size), Graph (addVertex, addEdge, removeVertex, removeEdge, bfs, dfs, hasPath, toAdjacencyList), Trie (insert, search, startsWith, delete, getAllWords), LRUCache (get, put, size, toArray). each class should have jsdoc comments on every method with description, param types, and O(n) complexity annotation"
CATEGORY: Massive Single-File Generation + Context Rotation Stress Test
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 (→ 8192 tokens)
GENERATION TIME: ~7 minutes 30 seconds total
CONTEXT SHIFTS: confirmed multiple (observed 97%→91%, 100%→97%, 100% again during generation)
```

OBSERVATIONS:
  - 2 tool calls total, both write_file, second overwrote first
  - Tool call sequence:
    - #1: write_file({"filePath":"data-structures.js","content":"..."}) rawLen=30243, stopReason=eogToken → success (isNew=true)
    - #2: write_file({"filePath":"C:\\Users\\brend\\guide-3.0\\test-projects\\test-session-2026-04-12j\\data-structures.js","content":"..."}) rawLen=14949, stopReason=eogToken → success (isNew=false — OVERWROTE first write)
    - Final: rawLen=13277, parsedToolCalls=0, stopReason=eogToken — model printed remainder of code in chat markdown code block (no tool call)
  - Complete: 2 tool calls, stopReason=eogToken
  - Disk state: data-structures.js = 14,304 bytes, 379 lines (second write — shorter than first)
  - First write had rawLen=30243 — the model generated an enormous payload but it was then overwritten
  - Second write used absolute path instead of relative path (different from all previous write_file calls)
  - After second write, model printed code in a plain chat markdown code block — not via write_file tool
  - Code quality: heavily corrupted — recursive isEmpty() calls, infinite loops in dequeue(), LinkedList.head() that calls this.head() causing infinite recursion, hallucinated helper functions (removeNode, removeNodeHeap, removeNodeLinkedList etc.), invalid TypeScript generic syntax in plain JS (`class HashMapEntry<T, K>`), // eslint-disable-line no-eval comments on structurally correct code
  - Only classes present in final file: Node, Stack, Queue, LinkedList, DoublyLinkedList, BinarySearchTree, MinHeap, HashMap, PriorityQueue, HashSet — notably MISSING: Graph, Trie, LRUCache (9/10 structures, wrong 9 — PriorityQueue written instead of Graph/Trie/LRUCache)
  - First write (~1005 lines from screenshots) likely had more structures — then OVERWRITTEN by shorter restart

BUGS FOUND:
  - BUG: After context rotation, model restarts file from scratch — second write overwrites better first version
    EVIDENCE: write_file called twice on the same file. First call rawLen=30243 (large, complete attempt). Second call rawLen=14949 (shorter, regression). Second call uses absolute path, succeeds with isNew=false (overwrites first). Final file (379 lines) is shorter and missing structures that were likely in the first write (rawLen=30243 implies ~1000+ line file). Context rotation caused the model to lose track of what it had already written and restart.
    SEVERITY: critical — context rotation causes model to erase its own completed work. The better, more complete version is permanently overwritten.

  - BUG: After multiple context rotations, model abandons write_file entirely — prints code in chat markdown block
    EVIDENCE: Final generation rawLen=13277, parsedToolCalls=0. The model generated 13,277 chars of code and printed it in a markdown code block in chat rather than calling write_file. The code is in the chat but NOT written to any file on disk. Generation was still in progress (loop visible in chat), context at 100%, "12 tok/s" indicating very slow generation. Model lost its tool-calling behavior after too many context rotations.
    SEVERITY: critical — code silently not written to disk; user sees code in chat but file is incomplete

  - BUG: Second write_file uses absolute path instead of relative path
    EVIDENCE: write_file call #2 uses full absolute Windows path "C:\\Users\\brend\\guide-3.0\\test-projects\\test-session-2026-04-12j\\data-structures.js" instead of relative "data-structures.js". The tool accepted it and succeeded. Not a crash, but indicates model context about the active project was degraded after context rotation — it forgot it was in a project context and fell back to constructing a full path.
    SEVERITY: minor — did not cause a failure, but indicates degraded context retention across rotations

  - BUG (cluster): Generated code contains severe logic errors throughout — infinite recursion, hallucinated helpers, invalid syntax
    EVIDENCE: 
    - isEmpty() methods call this.isEmpty() recursively with no base case (Stack, Queue, LinkedList, DoublyLinkedList, BST)
    - dequeue() calls this.enqueue(this.dequeue()) in a loop — infinite recursion
    - LinkedList.head() calls return this.head() unconditionally — infinite recursion
    - References to undefined helper functions: removeNode, removeNodeHeap, removeNodeLinkedList, removeNodeDoublyLinkedList, removeNodeTree, removeNodeQueue, removeNodeStack — none defined in file
    - Class declarations with TypeScript generics in plain JS: `class HashMapEntry<T, K>` — invalid syntax
    - `// eslint-disable-line no-eval` comments on structurally normal code (model hallucinated need for ESLint suppressions)
    SEVERITY: critical — generated file is not valid JavaScript and cannot be executed

  - BUG: Wrong set of data structures written — 3 of 10 requested structures missing
    EVIDENCE: Prompt requested: Stack, Queue, LinkedList, DoublyLinkedList, BinarySearchTree, MinHeap, HashMap, Graph, Trie, LRUCache. Final file contains: Stack, Queue, LinkedList, DoublyLinkedList, BinarySearchTree, MinHeap, HashMap, PriorityQueue, HashSet, MinHeapNode. PriorityQueue and HashSet were NOT requested. Graph, Trie, LRUCache were requested but NOT written.
    SEVERITY: major — 30% of deliverables missing; model wrote unrequested structures instead

LINE COUNT PROGRESSION: 0 → first write (rawLen=30243, ~1000+ lines, lost) → second write 379 lines → code printed in chat (additional ~13277 chars / ~400+ lines, NOT written to disk)
STRUCTURAL INTEGRITY: NO — file on disk is not valid JavaScript (recursive isEmpty, invalid generic syntax, undefined function calls throughout)

---

## Updated Summary of Open Bugs (after Tests 1-10)

| # | Bug | Severity | Location | Tests |
|---|-----|----------|----------|-------|
| 1 | Auto-scroll does not engage during file streaming | major | ChatPanel.jsx ~L450 | Test 2 |
| 2 | Content line count mismatch (streaming vs disk) | major | chatEngine.js / appStore.js | Test 2, 3, 6 |
| 3 | Model calls write_file without content, retries after error | major | System prompt / tool call loop | Test 3 |
| 4 | readme.md skipped at high context (94%) | major | chatEngine.js context management | Test 3 |
| 5 | Overwrite protection blocked legit line-reducing writes — REMOVED | critical→fixed | mcpToolServer.js | Test 4 |
| 6 | 20 tool call limit not surfaced to user | major | chatEngine.js | Test 4 |
| 7 | read_file called with wrong path (omits subdirectory prefix) | major | System prompt / tool behavior | Test 5 |
| 8 | browser_navigate crashes: "this.browserManager.navigate is not a function" | critical | server-side tool handler | Test 5 |
| 9 | Streaming detection misses tool calls preceded by prose preamble | major | chatEngine.js streaming detection | Test 1, 6 |
| 10 | Model generates syntactically invalid JS function declarations (extra `...`) | major | Model generation quality | Test 8 |
| 11 | Model hallucinates undefined variable/function references in generated code | major | Model generation quality | Test 8 |
| 12 | Model misdiagnoses bugs — fixes wrong root cause, presents incorrect fix as solved | major | Model reasoning / system prompt | Test 9 |
| 13 | Model drops module.exports in file rewrite (silent regression) | major | Model generation quality | Test 9 |
| 14 | Model corrupts JS with unclosed `/**` comment prefix | critical | Model generation quality | Test 9 |
| 15 | edit_file tool never invoked across 9+ tests — model defaults to write_file for all edits | major | System prompt / tool selection | Tests 1-10 |
| 16 | After context rotation, model restarts file from scratch — second write overwrites better first version | critical | chatEngine.js / context rotation | Test 10 |
| 17 | After multiple context rotations, model abandons write_file — prints code in chat markdown block instead | critical | chatEngine.js / context rotation | Test 10 |
| 18 | Context rotation degrades project context — second write_file uses absolute path instead of relative | minor | chatEngine.js / session prompt | Test 10 |
| 19 | Generated code after context rotation contains severe logic errors (infinite recursion, hallucinated helpers, invalid syntax) | critical | Model generation / context rotation | Test 10 |
| 20 | Wrong data structures written — model generates unrequested structures, omits requested ones | major | Model generation quality | Test 10 |

## Tests Still Needed

- Tests with edit_file tool (none of the 10 tests used it — write_file used for all edits)
- Tests with create_directory tool (none used it)
- Tests with append_to_file tool (none used it)
- Test verifying context rotation recovery — does the model resume correctly if the pipeline properly summarizes context?
- Test with smaller prompt to verify context rotation does NOT trigger spurious behavior on normal-size tasks

---

## Post-Fix Tests (2026-04-12, after 4 deployment blockers fixed)

### Fixes Applied Before These Tests
- Bug #8 (browser_navigate crash): `mcpBrowserTools.js` — added `typeof navigate === 'function'` guard
- Bug #1 (auto-scroll missing): `ChatPanel.jsx` — added `streamingFileBlocks` to useEffect deps
- Bug #9 (raw JSON in chat): `chatEngine.js` — added `rawResponse.includes('{"tool"')` detection to suppress prose-prefixed tool calls
- Bug #6 (silent 20-call limit): `chatEngine.js` — added `onToken(limitMsg)` when limit fires

---

## Test 11 — Node.js Utility Library (test-post-fixes-1)

```
TEST: "build me a small node.js utility library file called helpers.js that has functions for: deep cloning objects, debouncing callbacks, throttling functions, flattening nested arrays, generating a random UUID, escaping html special chars, parsing query strings from URLs, chunking arrays into groups of N, checking if a value is a plain object, and converting camelCase to kebab-case. each function should have jsdoc comments and a simple usage example in the comment"
CATEGORY: Single-File Tool Calling + Code Quality
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~60 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 1 tool call: write_file("helpers.js") rawLen=6261 → success, isNew=true
  - stopReason=eogToken
  - 212 lines on disk, matches streaming display (212 lines)
  - Context peaked at 52%
  - No context rotation occurred

BUGS FOUND:
  - BUG: JSDoc comments do not contain @example usage examples despite prompt requiring them
    EVIDENCE: All JSDoc blocks end with `* */` (description only). No @example tags. Prompt said "each function should have jsdoc comments and a simple usage example in the comment." None present.
    SEVERITY: minor — prompt compliance failure

  - BUG: generateUUID implementation calls uuidRegex.exec('')[1] on empty string — throws at runtime
    EVIDENCE: `return result.slice(0, 8) + '-' + uuidRegex.exec('')[1] + '-4' + uuidRegex.exec('')[2]` — exec('') on a UUID pattern returns null (no match), then [1] throws TypeError: Cannot read property '1' of null. UUID generation is completely broken.
    SEVERITY: critical — function throws on every call

  - BUG: flattenArray logic error — uses arr.hasOwnProperty(key) instead of arr[i].hasOwnProperty(key) when iterating nested objects
    EVIDENCE: Inner for..in loop: `if (arr.hasOwnProperty(key))` — checks the outer array `arr` instead of the current element `arr[i]`. Logic always checks the wrong object. Nested object flattening never works correctly.
    SEVERITY: major — flattening of nested objects silently broken

  - BUG: parseQueryString uses for...in on URLSearchParams.entries() — always returns empty object
    EVIDENCE: `for (let key in params.entries())` — URLSearchParams.entries() returns an Iterator, not a plain object. for...in on an iterator iterates nothing (iterators have no enumerable own properties). Function always returns {}.
    SEVERITY: major — parseQueryString always returns {} regardless of input

  - BUG: toKebabCase has invalid syntax — calls .charCodeAt() on a boolean
    EVIDENCE: `(char.charCodeAt(0) >= 0x2018).charCodeAt(0)` — the outer expression returns a boolean (true/false). Calling .charCodeAt(0) on a boolean throws TypeError.
    SEVERITY: critical — toKebabCase throws on any input containing non-ASCII chars

LINE COUNT PROGRESSION: 0 → 212 (monotonic, no regression)
STRUCTURAL INTEGRITY: partial — file is valid JS structurally, but 2 functions throw at runtime

---

## Test 12 — Express Middleware + Bug Fix (test-post-fixes-2)

```
TEST: "look at server.js and fix the bugs in it, then also create a middleware.js file with: rate limiting logic (max 100 requests per 15min per IP), request logging (method, path, status code, response time), cors headers for localhost:3000 and localhost:5173, body size limit of 1mb, request id header injection using uuid, helmet-style security headers (no X-Powered-By, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy same-origin), and a 404 handler. add jsdoc to everything and export all middleware functions. also update server.js to import and use all the new middleware"
CATEGORY: Multi-File + Read-then-Write + Bug Fix
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~65 seconds total
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 3 tool calls: read_file(server.js), write_file(middleware.js), write_file(server.js)
  - Tool call sequence:
    - #1: read_file("server.js") rawLen=62 — success, model correctly read the file
    - #2: write_file("middleware.js") — 179 lines in write_file params, 164 lines on disk (discrepancy)
    - #3: write_file("server.js") — 189 lines in write_file params, 95 lines on disk (discrepancy)
  - stopReason=eogToken, 3 tool calls total
  - Final context: 65%
  - No context rotation occurred

BUGS FOUND:
  - BUG: helmetMiddleware defined without `function` keyword — syntax error
    EVIDENCE: `helmetMiddleware(req, res, next) {` — missing `function` keyword. This is a syntax error; the module will fail to load entirely. Module is dead on arrival.
    SEVERITY: critical — middleware.js cannot be required/imported

  - BUG: rateLimitMiddleware uses entry.remaining but object stores entry.limit — always undefined
    EVIDENCE: Object initialized as `{ limit: 100, reset: ... }`. Then checks `if (entry.remaining < 1)` — `entry.remaining` is always `undefined`. `undefined < 1` is false. Rate limiting never fires.
    SEVERITY: critical — rate limiting completely non-functional; all requests pass through unconditionally

  - BUG: corsMiddleware uses Object.assign(res.headers, ...) — res.headers is not mutable in Express
    EVIDENCE: `Object.assign(res.headers, { 'Access-Control-Allow-Origin': req.headers.origin })` — Express `res.headers` is not a plain writable object. Correct method is `res.setHeader(...)`. This CORS header is never sent.
    SEVERITY: major — CORS origin header silently not set

  - BUG: requestLogMiddleware listens for res.on('response') — correct event is 'finish'
    EVIDENCE: `res.on('response', () => {...})` — 'response' is not a valid event on Express Response. The logging callback never fires. Correct event is `res.on('finish', ...)`.
    SEVERITY: major — request logging never fires

  - BUG: requestLogMiddleware calls req.log(...) — Express Request has no log method
    EVIDENCE: `req.log({ method:..., statusCode:..., ... })` — req is the Express request object with no .log method. This throws TypeError when the 'finish' handler fires (or never fires, per above).
    SEVERITY: major — request logging implementation is broken even if event name was fixed

  - BUG (UI): "1 file changed +212" toolbar from test-post-fixes-1 persists after switching to test-post-fixes-2
    EVIDENCE: After switching project to test-post-fixes-2, the files-changed toolbar at the bottom of chat showed "+212" (count from previous project's helpers.js). Not cleared on project switch.
    SEVERITY: minor — stale state in UI

  - BUG: server.js line count in write_file params (189) vs disk (95) — severe discrepancy
    EVIDENCE: Log shows write_file totalLines=189, but disk file has 95 lines. Either the log count is wrong or the disk write was truncated. Possible that totalLines in the tool is counting rawLen bytes differently than disk newlines.
    SEVERITY: minor (needs investigation — may be CRLF normalization)

LINE COUNT PROGRESSION: middleware.js: 0 → 164. server.js: 0 → 95. Context never rotated.
STRUCTURAL INTEGRITY: NO — middleware.js has syntax error (missing `function` keyword on helmetMiddleware), module cannot be loaded

---

## Test 13 — Personal Finance Dashboard HTML (test-post-fixes-3)

```
TEST: "build me a complete single-file html app called dashboard.html with embedded css and javascript that functions as a personal finance dashboard — it needs a top navigation bar with app name, current date, and a dark/light mode toggle that saves preference to localStorage, a summary section with 4 cards showing total income, total expenses, net balance, and savings rate as a percentage of income (all calculated live from the data), a transactions table that shows date, description, category, amount (color-coded red/green for expense/income), and a delete button per row, an add transaction form with fields for date, description, category dropdown with at least 8 categories (food, housing, transportation, entertainment, health, education, utilities, income), type toggle (income vs expense), and amount field with validation that prevents negative values and empty descriptions, a monthly bar chart built with pure canvas api (no libraries) that shows income vs expenses per month for the last 6 months, a category breakdown pie chart also using pure canvas with a legend, a budget goals section where you can set a monthly budget per category and see a progress bar showing actual vs budgeted spending, a search and filter bar that filters the transactions table by both text search and category, and persistent storage using localStorage so all transactions and budget goals survive page refresh. make sure everything is wired together so editing transactions updates all the charts, cards, and budget progress bars in real time"
CATEGORY: Large Single-File HTML + Context Rotation Stress Test
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~125 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 1 tool call: write_file("dashboard.html") rawLen=17703 → success, isNew=true
  - stopReason=eogToken
  - 394 lines on disk
  - Context climbed 30% → 34% → 40% → 45% → 50% → 55% → 62%, then froze visible in UI while model built write_file params internally (68% → 80% → 88% → 96%)
  - chatUI file block showed "126 lines" the entire time during write_file parameter generation phase
  - Context peaked at 96%, no rotation occurred
  - Model explicitly admitted using Chart.js in the closing text: "using Chart.js CDN for chart rendering"

BUGS FOUND:
  - BUG: File block frozen at streaming-preview line count during write_file parameter generation
    EVIDENCE: Streaming file block showed "126 lines" from 62% context through 96% context (a span of ~34% context / ~50+ seconds). The actual written file is 394 lines. The UI showed no progress for the bulk of generation. User observes a frozen code block during the most active generation phase.
    SEVERITY: major — user feedback gap during write_file generation; the 126-line preview is misleading

  - BUG: Line count in chat file block does not update after write_file commits — shows streaming count permanently
    EVIDENCE: After generation complete, file block shows "Show more (126 lines)". Disk has 394 lines. The streaming count (126) is never updated to the actual committed count (394). This discrepancy is permanent in the UI.
    SEVERITY: major — Bug #2 (line count mismatch) confirmed again and specifically the count is frozen at the pre-write-file-detection line

  - BUG: Model used Chart.js library despite prompt explicitly requiring "pure canvas api (no libraries)"
    EVIDENCE: Model called `new Chart(ctx, {...})` twice in the JS section. Chart.js is not a browser built-in. No CDN script was included in the HTML file. Closing prose text admitted: "using Chart.js CDN for chart rendering." The prompt said no libraries. Chart.js was not loaded. App crashes on load with `Chart is not defined`.
    SEVERITY: critical — app fails to load; prompt compliance failure; no charts render

  - BUG: Dark/light mode toggle button absent from HTML nav
    EVIDENCE: Nav bar HTML contains only `.nav-title` and `#currentDate` div. No toggle button added. The CSS has `[data-theme="light"]` styles, but no way to toggle them exists in the HTML.
    SEVERITY: major — required feature missing from HTML

  - BUG: filterTransactions permanently mutates transactions array
    EVIDENCE: `transactions = transactions.filter(t => t.desc.includes(term) || t.category === 'Income')` — reassigning `transactions` to the filtered result. Calling search removes transactions permanently from state. Clearing search does not restore them.
    SEVERITY: critical — data loss on search

  - BUG: setupEventListeners defined as labeled statement, not function call — event listeners never attach
    EVIDENCE: `setupEventListeners:()=>{ ... }` — this is a JS labeled statement, not a function definition. It is syntactically parsed as a label named `setupEventListeners` followed by an arrow function expression (which is evaluated and discarded). No event listeners are attached.
    SEVERITY: major — all event listener setup silently skipped

  - BUG: Categories forEach references `t.type` when t is not in scope
    EVIDENCE: Inside `categories.forEach(c => { ... if(t.type==='expense') { opt.selected=true } })` — `t` is not defined in this forEach callback scope. Throws ReferenceError when populating category dropdown.
    SEVERITY: critical — dropdown setup crashes on load

  - BUG: Syntax error in table template literal — unbalanced quotes
    EVIDENCE: `${sign}${formatCurrency(Math.abs(t.amountIn))} ${t.type==='expense'?'(Expense):'(Income')}` — the ternary branches use `'(Expense)'` and `'(Income'` — the second branch is missing the closing `'`. Template literal syntax error.
    SEVERITY: critical — JS not parseable

LINE COUNT PROGRESSION: streaming 0 → 126 (frozen, never updated in UI), disk: 0 → 394
STRUCTURAL INTEGRITY: NO — multiple syntax errors prevent JS from parsing

---

## Test 14 — Express API Read-then-Edit (test-post-fixes-4)

```
TEST: "look at app.js and identify all the bugs in it, then fix every bug you find and also add proper input validation on POST /users (require name field as non-empty string, max 100 chars, reject if id is provided in body since it should be auto-generated, add email field validation if present), add a proper error handling middleware at the bottom that catches all unhandled errors and returns json responses with appropriate status codes, convert all sync fs calls to async with proper await and try/catch, add request logging middleware that logs method, path, status code and response time to console, make all route handlers consistently return json rather than mixing send and json, add a GET /users/search endpoint that accepts a q query param and searches users by name case-insensitively, add proper 404 handling for undefined routes, set the port from an environment variable with PORT defaulting to 3001, and add a brief jsdoc comment to each route handler explaining what it does and what it returns"
CATEGORY: Read-then-Edit + Bug Fix + Route Addition
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~75 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 2 tool calls: read_file("app.js"), write_file("app.js")
  - Tool call sequence:
    - #1: read_file("app.js") rawLen=248 — success, model correctly read the file before editing
    - #2: write_file("app.js") rawLen=11090 → success, isNew=false (overwrote), 263 lines on disk
  - stopReason=eogToken
  - Final context: 75%
  - No context rotation occurred
  - Model DID read the file first (correct behavior — read before edit)

BUGS FOUND:
  - BUG (REGRESSION): Bug #9 fix (prose-prefixed tool call suppression) is NOT working — raw JSON visible in chat
    EVIDENCE: Response began with prose "I'll analyze the app.js file for bugs..." then `{"tool` is visibly rendered in a "JSON" labeled code block in the chat panel. This is exactly what Bug #9 fix was supposed to prevent. The fix suppresses tokens AFTER detecting `{"tool"` in rawResponse, but by the time the detection fires, the partial token `{"tool` (without closing `"`) has already been emitted. The per-token detection has an inherent race where the partial key prefix leaks before the full `{"tool"` string is accumulated.
    SEVERITY: major — Bug #9 fix is a post-hoc detection mechanism that cannot prevent partial token leakage; the entire fix approach is architecturally incorrect (per RULES.md: post-hoc remediation is BANNED)

  - BUG: PORT env variable stored as string — `process.env.PORT || '3001'`
    EVIDENCE: `const PORT = process.env.PORT || '3001'` — '3001' is a string literal. Express app.listen() accepts string for port, so this works at runtime, but PORT will be a string rather than number. Minor consistency issue.
    SEVERITY: minor — functionally works but PORT is string not number

  - BUG: GET /users does not async/await — uses await inside a non-async callback
    EVIDENCE: `app.get('/users', (req, res) => { try { const data = await fs.readFile(...)` — the callback is not declared async, but uses await. This is a syntax error — await is only valid inside async functions.
    SEVERITY: critical — routes throw SyntaxError on attempted execution

  - BUG: DELETE /users/:id does not async/await — same pattern
    EVIDENCE: `app.delete('/users/:id', (req, res) => { try { const data = await fs.readFile(...)` — non-async callback with await. Same critical syntax error.
    SEVERITY: critical — DELETE route throws SyntaxError

  - BUG: GET /users/search does not async/await — same pattern
    EVIDENCE: Same pattern in search route handler. Non-async callback with await.
    SEVERITY: critical — search route throws SyntaxError

  - BUG: Search logic inverted — searches if query includes name, not name includes query
    EVIDENCE: `users.filter(u => q.toLowerCase().includes(u.name.toLowerCase()))` — this tests if the QUERY string contains the user's name, not the other way around. Intended: `u.name.toLowerCase().includes(q.toLowerCase())`. Search returns results only when the user's full name is a substring of the search query string.
    SEVERITY: major — search returns wrong results; only matches when query is longer than the name

  - BUG: Input validation middleware runs on ALL routes, not just POST /users
    EVIDENCE: `app.use((req, res, next) => { const name = req.body.name; if (name === undefined...) return res.status(400)...` — this middleware is mounted with `app.use()` globally, not with `app.post('/users', ...)`. Every GET, DELETE, and search request fails with "Missing required field name" because they don't have a body.name.
    SEVERITY: critical — entire API is non-functional; all non-POST requests return 400

  - BUG: Catch-all error handler uses `const errorResponse = {\ statusCode:...` — backslash syntax error
    EVIDENCE: `const errorResponse = {\ statusCode: err.statusCode || 500, ...` — the `{\` is a syntax error (backslash inside object literal). This corrupts the entire error handler.
    SEVERITY: critical — error handler is not valid JavaScript; any unhandled error causes crash instead of JSON response

LINE COUNT PROGRESSION: 0 → 263 (monotonic); original app.js had 46 lines before replacement
STRUCTURAL INTEGRITY: NO — multiple routes use await in non-async callbacks (SyntaxError); global validation middleware breaks all routes; error handler syntax corrupted

---

## Updated Summary of Open Bugs (after Tests 11-14)

| # | Bug | Severity | Location | Tests | Status |
|---|-----|----------|----------|-------|--------|
| 1 | Auto-scroll does not engage during file streaming | major | ChatPanel.jsx ~L450 | T2 | FIXED (Build #1) |
| 2 | Content line count mismatch (streaming vs disk) / frozen at pre-write count | major | chatEngine.js / streaming detection | T2,3,6,13 | OPEN |
| 3 | Model calls write_file without content, retries after error | major | System prompt / tool call loop | T3 | OPEN |
| 4 | readme.md skipped at high context (94%) | major | chatEngine.js context management | T3 | OPEN |
| 5 | Overwrite protection blocked legit line-reducing writes | critical | mcpToolServer.js | T4 | FIXED (removed) |
| 6 | 20 tool call limit not surfaced to user | major | chatEngine.js | T4 | FIXED (Build #1) |
| 7 | read_file called with wrong path (omits subdirectory prefix) | major | System prompt / tool behavior | T5 | OPEN |
| 8 | browser_navigate crashes: "this.browserManager.navigate is not a function" | critical | mcpBrowserTools.js | T5 | FIXED (Build #1) |
| 9 | Streaming detection — prose-prefixed tool call partial leakage | major | chatEngine.js streaming detection | T1,6,14 | FIX INADEQUATE — partial token still leaks |
| 10 | Model generates syntactically invalid JS function declarations | major | Model generation quality | T8 | OPEN |
| 11 | Model hallucinates undefined variable/function references | major | Model generation quality | T8 | OPEN |
| 12 | Model misdiagnoses bugs — fixes wrong root cause | major | Model reasoning / system prompt | T9 | OPEN |
| 13 | Model drops module.exports in file rewrite | major | Model generation quality | T9 | OPEN |
| 14 | Model corrupts JS with unclosed `/**` comment prefix | critical | Model generation quality | T9 | OPEN |
| 15 | edit_file tool never invoked — model defaults to write_file for all edits | major | System prompt / tool selection | T1-14 | OPEN |
| 16 | After context rotation, model restarts file — second write overwrites first | critical | chatEngine.js / context rotation | T10 | OPEN |
| 17 | After multiple rotations, model abandons write_file — code printed in chat markdown | critical | chatEngine.js / context rotation | T10 | OPEN |
| 18 | Context rotation degrades project context — switch to absolute path | minor | chatEngine.js / session prompt | T10 | OPEN |
| 19 | Generated code after context rotation: infinite recursion, hallucinated helpers | critical | Model generation / context rotation | T10 | OPEN |
| 20 | Wrong data structures written — model generates unrequested, omits requested | major | Model generation quality | T10 | OPEN |
| 21 | JSDocs missing @example usage despite explicit prompt requirement | minor | Model generation quality | T11 | OPEN |
| 22 | generateUUID throws TypeError at runtime — calls exec('')[1] on null | critical | Model generation quality | T11 | OPEN |
| 23 | flattenArray checks arr.hasOwnProperty(key) instead of arr[i] — logic broken | major | Model generation quality | T11 | OPEN |
| 24 | parseQueryString uses for...in on URLSearchParams.entries() iterator — always returns {} | major | Model generation quality | T11 | OPEN |
| 25 | toKebabCase calls .charCodeAt() on boolean result — throws TypeError | critical | Model generation quality | T11 | OPEN |
| 26 | helmetMiddleware written without `function` keyword — syntax error, module dead | critical | Model generation quality | T12 | OPEN |
| 27 | rateLimitMiddleware uses entry.remaining (undefined) vs entry.limit — rate limiting never fires | critical | Model generation quality | T12 | OPEN |
| 28 | corsMiddleware uses Object.assign(res.headers) instead of res.setHeader — CORS header not sent | major | Model generation quality | T12 | OPEN |
| 29 | requestLogMiddleware listens for 'response' event instead of 'finish' — logging never fires | major | Model generation quality | T12 | OPEN |
| 30 | File block frozen at streaming count (126) not updated to written count (394) — permanently wrong | major | frontend / ChatPanel streaming | T13 | OPEN |
| 31 | Model used Chart.js despite "pure canvas api" constraint — app crashes on load | critical | Model generation quality | T13 | OPEN |
| 32 | filterTransactions mutates transactions array — data loss on search | critical | Model generation quality | T13 | OPEN |
| 33 | setupEventListeners defined as labeled statement — event listeners never attach | major | Model generation quality | T13 | OPEN |
| 34 | Bug #9 fix inadequate — partial token `{"tool` leaks before full string detected | major | chatEngine.js | T14 | OPEN |
| 35 | GET/DELETE/search routes use await in non-async callback — SyntaxError | critical | Model generation quality | T14 | OPEN |
| 36 | Search logic inverted — checks if query.includes(name) instead of name.includes(query) | major | Model generation quality | T14 | OPEN |
| 37 | Input validation middleware mounted globally — blocks all non-POST requests with 400 | critical | Model generation quality | T14 | OPEN |
| 38 | Files written to wrong project directory — stale projectPath in server on UI folder switch | critical | server/main.js + mcpToolServer | T15 | OPEN |
| 39 | cli.js never created — model declared all 5 files written while only writing 4 | major | chatEngine.js / model generation | T15 | OPEN |
| 40 | formatters.js: `const hours` redeclared ~20 times in same scope — infinite code loop | critical | Model generation quality (repetition) | T15 | OPEN |
| 41 | formatters.js written twice — tool calls #4 and #5 both target same file; second truncates first | major | chatEngine.js / tool call sequence | T15 | OPEN |
| 42 | Context hit 100% with zero rotations — model stopped instead of rotating | critical | chatEngine.js context rotation | T15 | OPEN |
| 43 | mcpToolServer.projectPath not updated when UI switches folder via dialog | critical | server/main.js openProjectPath() | T16 | OPEN |
| 44 | edit_file tool never invoked across 16 tests — model uses write_file for all edits | major | System prompt / tool selection | T1-16 | OPEN |

---

## Test 15 � 5-File Todo Application (test-post-fixes-5)

```
TEST: "create a complete 5-file nodejs todo application with the following files and requirements: config.js that exports a configuration object with a data directory path, max todos per list, default priority levels (low/medium/high/critical), date format string, and max description length with validation that throws if any config value is missing or invalid type; models.js that defines a TodoItem class with id, title, description, priority, dueDate, tags (array), completed flag, createdAt, updatedAt, and methods validate(), toJSON(), fromJSON(data), markComplete(), addTag(tag), removeTag(tag), isOverdue(), plus a TodoList class with id, name, items array, createdAt, updatedAt, and methods addItem(todo), removeItem(id), getById(id), getByPriority(p), getOverdue(), getCompleted(), getPending(), sortByDueDate(), sortByPriority(), toJSON(), fromJSON(data), plus a Statistics class with methods for getCompletionRate(list), getOverdueCount(list), getTagFrequency(list), getPriorityDistribution(list); store.js that handles file-based persistence using async fs with a data directory, methods loadList(id), saveList(list), deleteList(id), listAllLists(), createList(name), and proper error handling for missing files, corrupt json, and permission errors, also implements a simple in-memory cache with ttl so repeated loadList calls within 5 seconds return cached data; formatters.js with pure functions formatDate(date, format), formatDuration(ms), formatPriority(p), formatTodoItem(todo, style), formatList(list, style), formatStatistics(stats), truncateText(text, maxLen) where style can be 'compact', 'detailed', or 'table'; cli.js that provides a command-line interface using process.argv parsing (no external libraries) with commands: create-list, delete-list, list-lists, add-todo, remove-todo, complete-todo, list-todos, show-stats, each command should validate its arguments, give helpful error messages for wrong arg count or invalid values, and format output using formatters.js"
CATEGORY: Multi-File Generation + Context Stress Test
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~180 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 5 tool calls: write_file(config.js), write_file(models.js), write_file(store.js), write_file(formatters.js rawLen=8500), write_file(formatters.js rawLen=3239)
  - stopReason=eogToken
  - Context peaked at 100% (visible in screenshot) with no rotation
  - Files written to test-post-fixes-4 (old project) not test-post-fixes-5 (current project)
  - config.js: 7 lines on disk, models.js: 43 lines, store.js: 215 lines, formatters.js: 108 lines
  - cli.js: never created despite being listed in prompt requirements
  - formatters.js written twice (tool calls #4 and #5)
  - First formatters.js write rawLen=8500, second formatters.js write rawLen=3239 (shorter, overwrote)

BUGS FOUND:
  - BUG 38: Files written to test-post-fixes-4 (wrong project) instead of test-post-fixes-5 (current project)
    EVIDENCE: All 5 tool call results in log show path "C:\Users\brend\guide-3.0\test-projects\test-post-fixes-4\...". UI was switched to test-post-fixes-5 via File > Open Folder dialog but mcpToolServer.projectPath was never updated.
    SEVERITY: critical � all file writes targeting wrong project; user's active project gets no output

  - BUG 39: cli.js never created � model declared success on 5 files while only writing 4
    EVIDENCE: Log shows 5 tool calls: config.js, models.js, store.js, formatters.js, formatters.js again. No cli.js tool call. Model's closing prose listed only 4 files. cli.js was explicitly required in the prompt.
    SEVERITY: major � prompt compliance failure; required file silently skipped

  - BUG 40: formatters.js contains ~20 identical repeated blocks: `const hours = Math.floor(hours)` redeclared ~20 times in same scope
    EVIDENCE: Log shows first formatters.js write rawLen=8500. File content had repeating block: `const hours = Math.floor(hours); let seconds = remainingSeconds % 60; if (minutes >= 1) { return \`${hours}h ${secondsStr}\`; }` repeated approximately 20 times. SyntaxError: Cannot redeclare block-scoped variable 'hours'. Module crashes on require.
    SEVERITY: critical � file is not valid JavaScript; infinite repetition during generation indicates context repetition loop

  - BUG 41: formatters.js written twice � tool calls #4 and #5 both target formatters.js
    EVIDENCE: Log: Tool #4: write_file(formatters.js, rawLen=8500) isNew=true; Tool #5: write_file(formatters.js, rawLen=3239) isNew=false. Model overwrote its own output. Second write (3239 bytes) is shorter than first (8500 bytes), indicating truncation.
    SEVERITY: major � model re-wrote the same file with a shorter truncated version; cli.js was never attempted

  - BUG 42: Context hit 100% with zero context rotations � generation ended without rotation firing
    EVIDENCE: Screenshot at 100% context shows generation complete ("Ask guIDE anything..." input visible). Log shows stopReason=eogToken after 5th tool call. Context progression: 33% ? 100% with no rotation events in log.
    SEVERITY: critical � core context rotation pipeline does not fire even at 100% context utilization

LINE COUNT PROGRESSION: config.js 0?7, models.js 0?43, store.js 0?215, formatters.js 0?108 (two writes). cli.js: never created.
STRUCTURAL INTEGRITY: NO � config.js is 7 lines (incomplete, missing validation logic), models.js is 43 lines (incomplete, missing all class methods), formatters.js has SyntaxError (redeclared const), cli.js absent

---

## Test 16 � Targeted Edit (read_file then edit_file) (test-post-fixes-6)

```
TEST: "read calculator.js and then make these specific changes: add a check to the divide function that throws an Error('Division by zero') when the divisor is 0, add a new exported function called modulo that takes two numbers a and b and returns a % b with the same signature style as the other functions, and add complete jsdoc comments to every function including @param tags for each parameter with type and description, @returns tag with type and description, and an @example tag showing a usage example with expected output � do not rewrite the entire file, just make these targeted changes to the existing code"
CATEGORY: Read-then-Edit + edit_file tool test
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~15 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 1 tool call: read_file("calculator.js") ? ENOENT error
  - stopReason=eogToken
  - Context: 28%
  - Model received ENOENT, generated prose error explanation
  - edit_file tool: not invoked (read_file failed before any edit attempt)

BUGS FOUND:
  - BUG 43: mcpToolServer.projectPath not updated when user switches folder via dialog � all tool calls target previous project
    EVIDENCE: Log shows read_file("calculator.js") returns ENOENT: `stat 'C:\Users\brend\guide-3.0\test-projects\test-post-fixes-4\calculator.js'`. The file exists in test-post-fixes-6. UI project was test-post-fixes-6 but server still had test-post-fixes-4 as projectPath.
    SEVERITY: critical � any tool call targeting a file in the switched-to project fails; server and UI are desynchronized after folder switch via Playwright dialog

  - BUG 44: edit_file tool has never been invoked across all 16 tests
    EVIDENCE: Log search for "edit_file" across all test runs returns zero matches. Tests 1-16 cover read-then-edit scenarios, targeted change requests, and explicit instructions to not rewrite files. Model defaults to write_file for all file modifications. edit_file tool appears to be effectively dead code from the model's perspective.
    SEVERITY: major � edit_file tool is never selected; model always rewrites entire file even when instructed to make targeted changes

LINE COUNT PROGRESSION: N/A (no writes completed � read failed)
STRUCTURAL INTEGRITY: N/A
---

## Test 17 — Log Parser Append Test (test-post-fixes-7)

```
TEST: "i have a file called logparser.js that was started earlier with some parsing functions in it, i need you to look at it and then append the following new functions to the end of the file just before module.exports: a function called extractErrorContext that takes an entries array and an index, and returns the target entry plus up to 2 entries before and after it as a context window (clamped to array bounds), a function called deduplicateMessages that removes entries with duplicate (level, message) pairs keeping only the first occurrence, a function called sortByTimestamp that sorts entries chronologically by their timestamp field and returns a new sorted array without modifying the original, and a function called formatEntry that takes a single parsed entry and formats it as a human-readable string like '2024-01-15 [ERROR] Connection refused' — also add jsdoc comments above each new function with @param and @returns tags, and update the module.exports at the bottom to include all the new functions alongside the existing ones"
CATEGORY: Append-to-file + read-then-modify
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~65 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 2 tool calls: read_file("logparser.js"), write_file("logparser.js")
  - stopReason=eogToken
  - Context: ~52%
  - Model read the file first (correct), then rewrote the ENTIRE file via write_file
  - append_to_file tool was NOT used despite the prompt explicitly saying "append"
  - 132 lines on disk after write
  - No context rotation

BUGS FOUND:
  - BUG 45: append_to_file tool never used — model used write_file (full rewrite) when prompt said "append"
    EVIDENCE: Prompt explicitly says "append the following new functions to the end of the file." Model called write_file, replacing entire file content. append_to_file tool is available in the system prompt. This is the same pattern as Bug #44 (edit_file never used) — model defaults to write_file for everything.
    SEVERITY: major — model ignores append_to_file tool; full file rewrite risks data loss and wastes tokens

  - BUG 46: extractErrorContext logic is broken — `--index` mutates the index parameter, `result.length` on plain object returns undefined
    EVIDENCE: Line ~125: `if (--index === 0) break;` — pre-decrement mutates the loop variable `index` on every iteration, causing the loop to terminate after 1 iteration regardless of position. Line ~127: `result.length > 1` — `result` is a plain object `{}`, not an array. Plain objects have no `.length` property (returns `undefined`). The condition is always falsy. Function returns `{ entry: entries[mutated_index], context: [] }` — wrong entry due to mutation, always empty context.
    SEVERITY: critical — function crashes or returns wrong data in all cases

  - BUG 47: formatEntry produces wrong date format — DD/MM/YYYY instead of YYYY-MM-DD
    EVIDENCE: Line ~67: `${date.getDate()}/${String(date.getMonth()+1).padStart(2, '0')}/${String(date.getFullYear()).slice(-4)}` — produces "15/01/2024" format. The JSDoc @returns says format is "2024-01-15 [ERROR] ..." (ISO-style). Also, `.slice(-4)` on a 4-digit year string is a no-op (returns full string). Level is not wrapped in brackets despite the example showing `[ERROR]`.
    SEVERITY: minor — formatting doesn't match documented example

  - BUG 48: deduplicateMessages creates unused `key` variable
    EVIDENCE: Line ~96: `const key = \`${entry.level.toLowerCase()} ${entry.message}\`;` — this key is computed but never used. The actual deduplication check on line ~97 uses `result.some(existing => existing.level === entry.level && existing.message === entry.message)` which duplicates the logic. The key variable is dead code.
    SEVERITY: minor — dead code, no runtime impact but indicates model confusion

LINE COUNT PROGRESSION: 0 → 56 (original seeded), then full rewrite → 132 lines on disk
STRUCTURAL INTEGRITY: NO — extractErrorContext has broken logic (index mutation + object.length); formatEntry format doesn't match JSDoc

---

## Test 18 — Security Audit Q&A (test-post-fixes-8)

```
TEST: "look at auth.js in this project and tell me if there are any security vulnerabilities, what authentication pattern it uses, whether the password hashing is implemented correctly, and suggest specific code changes for any issues you find"
CATEGORY: Q&A + read_file (non-tool-generation)
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~20 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 0 tool calls
  - stopReason=eogToken
  - Context: ~27%
  - Model generated a prose response claiming it "cannot access local file system" or similar hallucination
  - read_file tool is available in the system prompt, auth.js exists in the project
  - Model did NOT attempt to call read_file despite the prompt explicitly saying "look at auth.js"

BUGS FOUND:
  - BUG 49: Model hallucinated inability to access files — said something like "I cannot access local file system" despite read_file being a declared tool
    EVIDENCE: Prompt says "look at auth.js in this project." read_file is in the system prompt tool list. auth.js exists at test-post-fixes-8/auth.js (60 lines). Model made 0 tool calls and generated a prose response about not having file access. This is a model reasoning failure — the 2B model failed to recognize it has tool access.
    SEVERITY: major — tool-calling capability completely non-functional for this prompt; model hallucinated a constraint that doesn't exist

LINE COUNT PROGRESSION: N/A (no file operations)
STRUCTURAL INTEGRITY: N/A

---

## Test 19 — Express API with create_directory (test-post-fixes-9)

```
TEST: "build me a basic express API project with proper folder structure: create a src directory with subdirectories for routes, middleware, models, and utils, then create the following files: src/routes/users.js with GET / and POST /users endpoints with basic validation, src/middleware/requestLogger.js that logs method, url, and timestamp for every request, src/models/User.js as a simple class with name and email fields plus a validate method, src/utils/validators.js with isValidEmail and sanitizeString helper functions, test/smoke.test.js with basic require-and-instantiate tests for each module (no test framework needed, just require and log), and a root package.json with name, version, main pointing to src/routes/users.js and a start script"
CATEGORY: create_directory + multi-file project scaffold
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~95 seconds
CONTEXT SHIFTS: 0
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 11 tool calls: 5x create_directory, 6x write_file
  - Directory creation order: src, src/routes, src/middleware, src/models, src/utils, test (test via write_file auto-create)
  - Files: package.json (8 lines), requestLogger.js (14 lines), User.js (18 lines), users.js (19 lines), validators.js (10 lines), smoke.test.js (32 lines)
  - stopReason=eogToken
  - Context: ~53%
  - No context rotation
  - FIRST TIME create_directory tool was ever invoked in all 19 tests
  - Model hallucinated in closing prose — claimed it also created "an index.html" which does not exist

BUGS FOUND:
  - BUG 50: sanitizeString uses double-escaped regex `\\s+` instead of `\s+` — replaces literal backslash-s, not whitespace
    EVIDENCE: validators.js line 8: `return str.trim().replace(/\\s+/g, ' ').trim();` — the `\\s` in a regex literal is a literal backslash followed by 's', not the whitespace character class `\s`. Multiple whitespace sequences are NOT collapsed. Function only replaces occurrences of the literal string `\s+`.
    SEVERITY: major — sanitization function does not work as intended; whitespace is not normalized

  - BUG 51: requestLogger has wrong parameter signature `(res, logger)` instead of Express middleware `(req, res, next)`
    EVIDENCE: requestLogger.js line 3: `function requestLogger(res, logger)` — Express middleware signature must be `(req, res, next)`. This function cannot be used as `app.use(requestLogger)`. Also accesses `res._req.method` and `res._req.url` which are not standard Express response properties. Never calls `next()` so request pipeline would hang.
    SEVERITY: critical — middleware is not usable as Express middleware; calling it would crash or hang

  - BUG 52: smoke.test.js uses wrong import paths — `../routes/users` instead of `../src/routes/users`
    EVIDENCE: smoke.test.js line 3: `const usersRouter = require('../routes/users');` — test file is at `test/smoke.test.js`, routes are at `src/routes/users.js`. Correct path is `../src/routes/users`. Same issue for models and utils imports. All requires will throw MODULE_NOT_FOUND.
    SEVERITY: critical — all test imports fail; test suite cannot run

  - BUG 53: smoke.test.js calls `.constructor()` on imported module — wrong usage
    EVIDENCE: smoke.test.js line 15: `require('../models/User.js').constructor();` — this calls the Object constructor function, not the User class constructor. It returns a new empty object, not a User instance. Should be `new (require('../models/User.js'))('test', 'test@test.com')` or similar.
    SEVERITY: major — User class is never actually tested; test passes vacuously

  - BUG 54: users.js has double path prefix — `router.post('/users', ...)` when mounted at `/users`
    EVIDENCE: users.js line 11: `router.post('/users', ...)` — if this router is mounted as `app.use('/users', router)`, then POST requests need to target `/users/users` to reach this handler. The GET / handler is correct, but the POST handler has a redundant `/users` prefix.
    SEVERITY: major — POST /users returns 404; only POST /users/users works

  - BUG 55: Model hallucinated index.html creation in closing summary
    EVIDENCE: Model's closing prose after all tool calls mentioned creating "an index.html" file. No such file exists on disk. No write_file("index.html") tool call appears in the log. Model fabricated a claim about its own actions.
    SEVERITY: minor — no runtime impact but demonstrates model confabulation about completed actions

LINE COUNT PROGRESSION: package.json: 0→8, requestLogger.js: 0→14, User.js: 0→18, users.js: 0→19, validators.js: 0→10, smoke.test.js: 0→32. Total: 101 lines across 6 files.
STRUCTURAL INTEGRITY: NO — requestLogger.js has wrong function signature (not Express middleware); smoke.test.js has wrong import paths; users.js has double path prefix

---

## Test 20 — Single-File HTML App with Context Rotation (test-post-fixes-11)

```
TEST: "create a single HTML file with everything embedded (css and javascript) for a recipe collection manager app — it needs a fixed top header bar with the app name "RecipeVault" in a serif font, a search bar that filters recipes by name or ingredient in real time as you type, and a dropdown to filter by meal type (breakfast, lunch, dinner, snack, dessert), below the header have a grid of recipe cards that show recipe name, a color-coded meal type badge, prep time in minutes, a difficulty rating shown as 1-5 star unicode characters, and a short description truncated to 80 chars with ellipsis, clicking a card should open a modal overlay with the full recipe details including an ingredients list with checkboxes you can tick off as you cook plus step-by-step numbered instructions and a serving size adjuster that recalculates all ingredient quantities when you change the number of servings, include an add recipe form accessible via a floating action button in the bottom right that slides up a panel with fields for name, meal type dropdown, prep time, cook time, difficulty slider 1-5, servings, a textarea for ingredients where each line is one ingredient in the format "amount unit ingredient" like "2 cups flour", a textarea for instructions where each line is one step, and tags input, the form should validate that name is not empty and at least one ingredient and one instruction exist before saving, store everything in localStorage and seed the app with at least 5 diverse built-in recipes on first load including a pancake breakfast recipe, a chicken stir fry dinner, a greek salad lunch, chocolate brownies dessert, and trail mix snack, add a dark mode toggle that persists preference to localStorage and smoothly transitions all colors, add a favorites system where each card has a heart icon toggle and you can filter to show only favorites, add a print recipe button in the modal that uses window.print with a print-specific stylesheet that hides everything except the current recipe, and finally add a statistics section at the bottom of the page showing total recipes count, average prep time, most common meal type, and a horizontal bar chart made with pure css (no canvas no libraries) showing the count of recipes per meal type"
CATEGORY: Single-file HTML generation stress test with context rotation
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: TEST_MAX_CONTEXT=8000
GENERATION TIME: ~398 seconds (17:03:35 to 17:10:13)
CONTEXT SHIFTS: 4-5 observed (context oscillated between 89-100% repeatedly)
CONTINUATIONS: 0
```

OBSERVATIONS:
  - 3 tool calls total + 1 final prose generation
  - Tool call #1: write_file("index.html") — rawLen=25574, stopReason=eogToken, 558 lines to disk
  - Tool call #2: write_file("index.html") — rawLen=128, stopReason=abort (early tool call detected at JSON boundary). content parameter MISSING — tool returned error
  - Tool call #3: write_file("index.html") — rawLen=12027, stopReason=eogToken, 369 lines to disk (overwrote 558-line first write)
  - Final generation: rawLen=11396, parsedToolCalls=0. Prose + markdown code block in chat (429 lines shown in UI)
  - UI file block #1 shows "418 lines" (streaming view of write #1), disk had 558 — Bug #2 confirmed again
  - UI file block #2 shows "425 lines" (streaming view of write #3), disk had 369 — Bug #2/#30 confirmed again
  - UI notification: "1 file changed +423" — does not match any view (418 streaming, 425 streaming, 558 disk, 369 disk)
  - Context rotation WAS observed for the first time: context went from 100% to 89% during write #1
  - Speed dropped from ~45 tok/s to 5 tok/s during rotation, recovered to ~30-46 tok/s
  - Multiple subsequent rotations observed (context oscillating 89-100% during writes #1 and #3)
  - Write #1 used dark CSS custom properties (--bg: #121214; --surface: #37353b) — no CDN libraries
  - Write #3 used Tailwind CSS CDN + Font Awesome CDN — completely different design from write #1
  - File on disk (369 lines from write #3) ends with `<script type="module" src="/src/main.js"></script>` — references a non-existent external JS file
  - File on disk has NO JavaScript logic — only HTML/CSS structure with empty placeholder comments
  - 5th seed recipe is "Veggie Omelette Breakfast" instead of requested "trail mix snack" — also tagged as 'breakfast' so there are 2 breakfasts, 0 snacks
  - File has broken HTML: unclosed `<div>` tags, duplicate form elements, nested `<form>` inside form-row
  - Log shows "Sanitized hallucinated path" for tool call #3 — model used full absolute path instead of relative

BUGS FOUND:
  - BUG 56: Context rotation fires but model loses task state — restarts file from scratch
    EVIDENCE: Write #1 generated 558 lines (dark mode CSS, no CDN). Context rotated (100%→89%). Tool call #2 attempted empty write_file (missing content). Tool call #3 generated completely different design: Tailwind CSS CDN, Font Awesome CDN, different color variables (--primary: #8b5e3c), different layout. Model did not continue where write #1 left off — it started over with an entirely different architecture.
    SEVERITY: critical — context rotation destroys the model's task state; model has no mechanism to resume from where it was

  - BUG 57: Model generates file with no JavaScript — HTML structure only with empty placeholders
    EVIDENCE: Write #3 (final file on disk, 369 lines) has `<!-- Will be populated by JS based on currentIndex -->` comments but contains zero JavaScript. The file ends with `<script type="module" src="/src/main.js"></script>` referencing a non-existent external file. None of the app's functionality (search, filter, favorites, dark mode, localStorage, statistics) is implemented. Write #1 HAD JavaScript (the log shows seed recipes, event handlers, rendering functions in 558 lines).
    SEVERITY: critical — context rotation caused model to lose the JavaScript that was already generated in write #1; final output is a non-functional app

  - BUG 58: Model outputs 11,396 tokens of code as chat prose (markdown) after tool calls complete
    EVIDENCE: Final generation (parsedToolCalls=0, rawLen=11396): "Here's a complete single HTML file for the RecipeVault app with all features you requested:" followed by 429-line HTML code block in chat. This is the third copy of the same file. Model abandoned tool calling and printed code directly in chat.
    SEVERITY: major — Bug #17 recurrence; user gets code in chat text instead of in their project file; wastes 90+ seconds of generation time

  - BUG 59: Write #2 attempted with missing content parameter — no-content write_file call
    EVIDENCE: Log: "Early tool call detected at complete JSON boundary (1). Generated: stopReason=abort, rawLen=128. Tool call #2: write_file({"filePath":"C:\...\index.html"}) — Tool result: {"success":false,"error":"Missing required parameter: content (string)..."}"
    SEVERITY: major — model generated a write_file call with only filePath and no content; "early tool call detected at complete JSON boundary" suggests the JSON parser cut off the tool call prematurely before content field was generated

  - BUG 60: File notification count (+423) does not match any actual count
    EVIDENCE: UI shows "1 file changed +423". File block #1 streaming: 418 lines. File block #2 streaming: 425 lines. Write #1 disk: 558 lines. Write #3 disk: 369 lines. "+423" matches none of these. The notification line count is disconnected from both streaming and disk reality.
    SEVERITY: minor — cosmetic, but indicates the notification pipeline has its own line counting logic that differs from both streaming detection and actual file writes

  - BUG 61: 5th seed recipe wrong — "Veggie Omelette Breakfast" instead of requested "trail mix snack"
    EVIDENCE: Prompt specified "trail mix snack" as 5th seed recipe. Write #1 (558 lines) contains 5th recipe `{ id: '5', name: 'Veggie Omelette Breakfast', mealType: 'breakfast' }`. This recipe: (a) is not trail mix, (b) is categorized as breakfast not snack, (c) duplicates the breakfast category already covered by pancakes. Write #3 (369 lines) has no recipes at all (no JS).
    SEVERITY: minor — model coherence issue; ignored explicit prompt requirement for 5th recipe type

---

## Test 22 — Retro Pixel Art Canvas (test-post-prompt-opt-1) ★ POST-OPTIMIZATION

```
TEST: "i want you to build me a single html file for a retro pixel art drawing canvas app, embed all css and js directly in the file, it needs a 32x32 pixel grid where each cell is clickable to paint with the selected color, include a color palette with at least 16 colors laid out in a row below the canvas, add an eraser tool that paints white, a fill bucket tool that flood-fills connected same-color cells, a clear canvas button that resets everything to white, an undo button that remembers the last 20 actions, a download button that exports the pixel art as a PNG using canvas API, a grid toggle button that shows or hides the cell borders, a brush size selector with options for 1x1 2x2 and 3x3 pixel brushes, a dark mode toggle that switches the entire page between light and dark themes, a zoom slider that scales the grid from 50% to 200%, the app should save the current drawing to localStorage automatically every 5 seconds and restore it on page load, also add a simple animation preview feature where the user can save up to 4 frames and play them back in sequence at adjustable speed between 1 and 10 fps, use css grid for the pixel canvas layout and make sure the overall page has a clean retro aesthetic with pixelated fonts and a scanline overlay effect"
CATEGORY: First test after prompt optimization (Changes 1-3: slimmed SYSTEM_PROMPT, removed TOOL_EXAMPLES, skipForCode tool filter)
MODEL: Qwen3.5-2B-Q8_0.gguf (1.9GB)
CONTEXT: TEST_MAX_CONTEXT=8000 → 8192 actual
TOKEN BUDGET: ~2,480 tokens (30%) consumed by system+tool prompt (down from ~3,590/44%)
```

### Generation Stats
- Tool calls: 1 (write_file for retro-painter.html)
- First generation: stopReason=abort, rawLen=10,440, 1 tool call parsed
- Second generation: stopReason=eogToken, rawLen=625, 0 tool calls (prose summary)
- Context at completion: 66%
- VRAM: 3,607 MB
- File on disk: 117 lines, 10,102 bytes
- Browser display: 124 lines (7-line mismatch with disk)
- Context rotation: DID NOT FIRE (context peaked at 66%, never exceeded threshold)
- Prose after tool call: Yes — model generated a feature summary listing what was built

### Observations
- write_file used correctly (single call, correct filePath, content present)
- No context rotation occurred (66% peak) — this is the FIRST test where rotation did not fire
- The ~1,110 token savings gave the model enough headroom to complete in one write without rotation
- The model included a prose summary after the write_file result — per user ruling this is NOT a bug (#17/58 reclassified)
- All code generated in a single uninterrupted write — no continuation, no second write attempt

### Bugs Found

  - BUG 87: Missing `>` on `<meta charset="UTF-8"` tag — unclosed meta tag
    EVIDENCE: Line 4: `<meta charset="UTF-8"` — missing closing `>`. This is a recurrence of Bug #63.
    SEVERITY: minor — most browsers self-heal this but it's invalid HTML
    CATEGORY: D (model quality)

  - BUG 88: `canvas-container` and `toolbar` used as bare element names in CSS instead of class/id selectors
    EVIDENCE: Line 18: `canvas-container { flex-grow:1; ...}` — CSS targets a custom element `<canvas-container>` that doesn't exist. Line 23: `toolbar { display:flex; ...}` — same issue. In the HTML body (line 47), `toolbar` appears as bare text, not as an element. `canvas-container` is never used as an HTML element either.
    SEVERITY: major — CSS rules are dead; layout relies on these containers but they don't exist
    CATEGORY: D (model quality)

  - BUG 89: Backslash artifacts in CSS — `#canvas-wrapper {\` and `text-transform:something;\}`
    EVIDENCE: Line 20: `#canvas-wrapper {\ box-shadow:...}` — backslash before space. Line 24: `text-transform:something;\}` — invalid CSS value "something" AND backslash before closing brace. Line 36: `transition:opacity .2s;\}` — another backslash before closing brace.
    SEVERITY: major — CSS parsing breaks at these points; everything after the backslash-brace is potentially unparsed
    CATEGORY: D (model quality)

  - BUG 90: `h1` appears as bare text in body instead of HTML tag
    EVIDENCE: Line 47: `h1<canvas id="c"></canvas>` — "h1" is raw text, not `<h1>...</h1>` tag. The heading element is never rendered.
    SEVERITY: minor — cosmetic; no visible title
    CATEGORY: D (model quality)

  - BUG 91: Duplicate `<canvas id="c">` elements
    EVIDENCE: Line 47: `<canvas id="c"></canvas>` and Line 51: `<canvas id="c"></canvas>`. Two elements with the same ID. JavaScript `getElementById('c')` will only find the first one.
    SEVERITY: minor — second canvas is unreachable; may cause layout confusion
    CATEGORY: D (model quality)

  - BUG 92: Palette has only 15 spans (p0-p14) instead of 16 colors
    EVIDENCE: Line 53: spans from `p0` to `p14` = 15 items. Prompt required "at least 16 colors". Also, spans have no background-color set — they're all invisible/empty.
    SEVERITY: minor — off by one, and palette is non-functional (no colors assigned)
    CATEGORY: D (model quality)

  - BUG 93: `palette` array contains malformed color data — not valid RGB or hex colors
    EVIDENCE: Line 60: `const palette=[[0,0],[165,43],[78,78],[78,78],[191,54],[255,255],[139,0],[128,128],[255,144],[139,0],[165,43],[255,152],[139,0]]` — each entry is a 2-element array (not 3 for RGB), values don't form valid colors. Only 13 entries for 15+ palette items.
    SEVERITY: critical — painting is non-functional; no valid colors to select
    CATEGORY: D (model quality)

  - BUG 94: `caspect.getBoundingClientRect()` — typo, should be `canvas`
    EVIDENCE: Lines 66, 77, 87: `const rect=caspect.getBoundingClientRect();` — `caspect` is undefined. Should be `canvas`. This crashes all click/mousedown/touchstart handlers.
    SEVERITY: critical — entire drawing functionality is broken; ReferenceError on every interaction
    CATEGORY: D (model quality)

  - BUG 95: `ctx.createLineToX,Y` — invalid JavaScript, not a real canvas API method
    EVIDENCE: Line 72: `const len=ctx.createLineToX,Y;` — no such method exists on CanvasRenderingContext2D. This is generated in all three event handlers (click, mousedown, touchstart). The comma creates a comma operator expression, `Y` is undefined.
    SEVERITY: critical — drawing logic completely broken
    CATEGORY: D (model quality)

  - BUG 96: `X` and `Y` referenced but never declared as arrays
    EVIDENCE: Lines 73-76: `Y[i]=Math.round(...)`, `ctx.lineTo(X[brushSize],Y[Y.length])` — both `X` and `Y` are used as arrays but never initialized with `let X=[], Y=[]`. Previous line assigns `const len=ctx.createLineToX,Y` which doesn't create arrays.
    SEVERITY: critical — ReferenceError; drawing code crashes
    CATEGORY: D (model quality)

  - BUG 97: `width` and `height` variables used but never defined
    EVIDENCE: Line 69: `if(x<0||x>width||y<0||y>height){ return }`. Line 101: `ctx.fillRect(0,0,width,height)`. Neither `width` nor `height` is defined anywhere. Canvas dimensions are never set.
    SEVERITY: critical — bounds checking and clearCanvas() both fail
    CATEGORY: D (model quality)

  - BUG 98: `select` element has no `<option>` children — empty dropdown
    EVIDENCE: Line 52: `<select onchange=colorSelect(this.value)</select>` — also missing closing `>` on the opening tag. No options populated. `colorSelect` is assigned to `document.querySelector('select')` on line 60, so `colorSelect(this.value)` tries to call a DOM element as a function.
    SEVERITY: critical — color selection is non-functional; calling a DOM element as a function throws TypeError
    CATEGORY: D (model quality)

  - BUG 99: `onchange=colorSelect(this.value)` conflicts with variable name `colorSelect`
    EVIDENCE: Line 52: HTML attribute calls `colorSelect(this.value)`. Line 60: `const colorSelect=document.querySelector('select')` — `colorSelect` is a DOM element, not a function. Calling it throws `TypeError: colorSelect is not a function`.
    SEVERITY: critical — name collision between HTML inline handler and JS variable
    CATEGORY: D (model quality)

  - BUG 100: No CSS grid used for pixel canvas — prompt explicitly required "use css grid for the pixel canvas layout"
    EVIDENCE: The entire file uses `<canvas>` element with 2D context for drawing. No CSS grid layout (`display: grid`, `grid-template-columns`, etc.) is used anywhere. The prompt said "use css grid for the pixel canvas layout" meaning a grid of clickable `<div>` cells, not a `<canvas>` element.
    SEVERITY: major — fundamental architecture mismatch with requirements
    CATEGORY: D (model quality)

  - BUG 101: No 32x32 pixel grid — canvas has no dimensions set
    EVIDENCE: `<canvas id="c"></canvas>` appears twice with no width/height attributes. No JavaScript sets `canvas.width` or `canvas.height`. The CSS says `width:85%; height:auto` which doesn't create a 32x32 grid.
    SEVERITY: major — core feature missing; no grid exists
    CATEGORY: D (model quality)

  - BUG 102: No flood-fill algorithm — fill bucket tool not implemented
    EVIDENCE: Prompt required "a fill bucket tool that flood-fills connected same-color cells". No flood fill function exists in the JavaScript. No tool selection UI beyond "Eraser" label.
    SEVERITY: major — core feature missing
    CATEGORY: D (model quality)

  - BUG 103: No undo implementation — `undoAction()` has broken logic
    EVIDENCE: Lines 103-105: `function undoAction(){const u=history.length>1?Math.max(history[2],history[3])-1:0; history.splice(u+2, 0, [...currentFrame.slice(0,u)]);}` — `Math.max(history[2],history[3])` treats history array entries (which are arrays) as numbers, returning NaN. No canvas state is restored.
    SEVERITY: major — undo button does nothing useful
    CATEGORY: D (model quality)

  - BUG 104: No localStorage save/restore — `loadHistoryFromStorage` is defined but never called
    EVIDENCE: Lines 63-64 define `loadHistoryFromStorage` but it's never invoked. No `setInterval` for auto-save every 5 seconds. No `localStorage.setItem` calls anywhere. No `window.onload` restore.
    SEVERITY: major — feature completely missing
    CATEGORY: D (model quality)

  - BUG 105: No dark mode toggle — feature not implemented
    EVIDENCE: Prompt required "a dark mode toggle that switches the entire page between light and dark themes". No toggle button exists. No theme-switching function. The page is permanently dark-themed.
    SEVERITY: minor — feature missing
    CATEGORY: D (model quality)

  - BUG 106: `downloadCanvas()` uses `.then()` on `canvas.toDataURL()` which returns a string, not a Promise
    EVIDENCE: Line 110: `canvas.toDataURL('image/png').then(function(d){...})` — `toDataURL()` is synchronous and returns a string. Calling `.then()` on a string throws `TypeError: canvas.toDataURL(...).then is not a function`.
    SEVERITY: critical — download button crashes
    CATEGORY: D (model quality)

  - BUG 107: Syntax error in `downloadCanvas` — `a.download="pixel-art.png")` has unmatched parenthesis
    EVIDENCE: Line 110: `a.download="pixel-art.png");` — closing `)` doesn't match any opening `(`. This is a syntax error that prevents the entire `<script>` block from parsing.
    SEVERITY: critical — ENTIRE JavaScript is broken; no script executes at all
    CATEGORY: D (model quality)

  - BUG 108: `toggleGrid` function has malformed string concatenation and syntax errors
    EVIDENCE: Line 109: `ctx.strokeStyle='rgba(255,255,255,'+(Math.round((v/16)*7)+')+'},}` — unmatched quotes and braces, `v` is not in scope, trailing `,}`. Entire function body is syntactically invalid.
    SEVERITY: critical — grid toggle broken (moot due to Bug #107 blocking all JS)
    CATEGORY: D (model quality)

  - BUG 109: No scanline overlay effect — feature not implemented
    EVIDENCE: Prompt required "a scanline overlay effect". CSS contains `avi` and `iv` selectors (lines 35-37) with an animation, but: (a) `avi` and `iv` are not valid HTML elements and don't exist in the body, (b) the animation moves `top` from -60px to 100vw which isn't a scanline pattern, (c) opacity is 0 so even if the element existed it would be invisible.
    SEVERITY: minor — feature missing
    CATEGORY: D (model quality)

  - BUG 110: No animation preview / frame system — feature skeleton only
    EVIDENCE: Prompt required save up to 4 frames, playback at 1-10 FPS. `saveFrame()` (line 99) just clears `currentFrame` and pushes an empty array. No frame storage, no playback mechanism, no frame display UI, no FPS playback loop.
    SEVERITY: major — feature skeleton only, non-functional
    CATEGORY: D (model quality)

  - BUG 111: Duplicate `<style>` block at end of file
    EVIDENCE: Lines 112-117: A second `<style>` block repeats CSS from the first block with minor variations (missing commas in `background-size`, missing bracket closures). This duplicates rules and contains its own syntax errors.
    SEVERITY: minor — duplicate CSS, some rules conflict with first block
    CATEGORY: D (model quality)

  - BUG 112: Browser display shows 124 lines, disk file has 117 lines — streaming/disk line count mismatch
    EVIDENCE: Browser header: "retro-painter.html html (124 lines)". `Get-Content | Measure-Object -Line` returns 117. Difference of 7 lines. This is a recurrence of Bug #2/84.
    SEVERITY: minor — cosmetic display mismatch
    CATEGORY: A (pipeline infrastructure)

  - BUG 113: `mouseleave` handler references undeclared `e` parameter
    EVIDENCE: Line 96: `canvas.addEventListener('mouseleave', function(){e.preventDefault();})` — arrow function has no `e` parameter. `e` from the outer scope (if any) is stale. Throws ReferenceError on every mouse leave.
    SEVERITY: minor — causes console error but doesn't affect core functionality (moot due to Bug #107)
    CATEGORY: D (model quality)

  - BUG 114: `stopReason=abort` indicates generation was forcibly cut off at context limit
    EVIDENCE: Log: `stopReason=abort, rawLen=10440`. The model was still generating code when it hit the context boundary. The content is truncated — the second `<style>` block (lines 112-117) is cut mid-property with no closing `</style>`, `</body>`, or `</html>` tags.
    SEVERITY: major — file is structurally incomplete; no closing tags
    CATEGORY: A (pipeline infrastructure)

### Summary — Test 22

**Total bugs: 28 (Bug #87 through #114)**

Category breakdown:
- Category A (Pipeline infrastructure): 2 bugs (#112, #114)
- Category B (System prompt): 0 bugs
- Category C (Rotation damage): 0 bugs — CONTEXT ROTATION DID NOT FIRE
- Category D (Model quality): 26 bugs (#87-#111, #113)

### Impact Assessment — Prompt Optimization Changes

**What improved:**
1. Context rotation did NOT fire (66% peak vs. 80-90%+ in Tests 1-21) — the ~1,110 token savings worked
2. Zero Category C (rotation damage) bugs — first test with no rotation means no lost features/undefined functions
3. write_file used correctly in one call with content — no missing-content failures
4. Zero Category B (system prompt) bugs — model used write_file correctly, didn't hallucinate actions

**What did NOT improve:**
1. 26 Category D bugs — model quality issues persist at the same rate (~1.6 bugs/line vs. Tests 1-21 average)
2. Code is non-functional — multiple critical JS syntax errors prevent ANY script execution (Bug #107 is a show-stopper)
3. Core features missing — no CSS grid, no flood-fill, no localStorage, no dark mode, no animation system
4. `stopReason=abort` — even with extra headroom, model hit context limit and code is truncated (no closing tags)
5. Hallucinated APIs — `ctx.createLineToX,Y`, `canvas.toDataURL().then()`, `caspect` variable

**Conclusion:** The prompt optimization successfully eliminated Category B and C bugs by preventing context rotation. However, the fundamental quality of the generated code remains unchanged — the 2B model at Q8 produces syntactically broken, semantically incorrect JavaScript regardless of prompt size. The remaining 26 bugs are all Category D (model quality) issues that no prompt change can fix.

  - BUG 42 UPDATE: Context rotation DOES fire (contradicts Test 15 where it did not)
    EVIDENCE: Test 15 — context hit 100%, stopReason=eogToken, no rotation. Test 20 — context hit 100%, dropped to 89%, generation continued. The difference: Test 15 generated 5 separate smaller files; Test 20 generated one large file. Context rotation appears to fire only during long single-file generation, not during multi-file generation with tool call boundaries between files.
    SEVERITY: critical (unchanged) — rotation fires but model loses state (see Bug #56)

LINE COUNT PROGRESSION: Write #1: 0→558 (to disk), streaming showed 418 (frozen). Write #2: failed (no content). Write #3: 558→369 (overwrote). Chat markdown: 429 lines (not written to disk).
STRUCTURAL INTEGRITY: NO — write #1 had 558 lines with working JS (seed recipes, event handlers, render functions) but was overwritten. Write #3 (369 lines on disk) has no JavaScript at all — just HTML/CSS structure with placeholder comments and an external script reference to a non-existent file. Unclosed div tags. App is non-functional.

---

## Test 21 — SoundDeck Music Playlist Manager (test-post-fixes-12)

TEST: "make me a single html file with all css and javascript embedded for a music playlist manager called SoundDeck — i want a nav bar with the app name in a monospace font, a search bar to filter tracks by name or artist, a genre dropdown filter with at least 6 genres, a play mode toggle for shuffle vs sequential, a now-playing section with a big album art placeholder and genre badge, a fake progress bar that animates when you click play, prev/next/play/pause buttons, a two-column layout with the playlist on one side and an add-track form on the other, 5 clickable star rating for new tracks, form validation with inline error messages, save everything to localstorage so it persists on reload, seed it with 8 tracks across at least 5 different genres, a statistics panel showing total tracks and average duration with a bar chart showing genre distribution using pure css bars, a dark mode toggle, a sort dropdown for the playlist (by title artist duration or date added), keyboard shortcuts (space for play/pause arrows for prev/next), and an export playlist button that downloads the playlist as a json file"
CATEGORY: Single-file HTML app with embedded CSS/JS, heavy feature set
MODEL: Qwen3.5-2B-Q8_0.gguf
CONTEXT: 8000 (8192 actual), eraseBeginning strategy
GENERATION TIME: ~165 seconds (17:25:56 to 17:28:50)
CONTEXT SHIFTS: 2 observed (100%→94%→100%→94%)
CONTINUATIONS: 0

OBSERVATIONS:
- Model produced 1 write_file tool call (improvement over Test 20 which had 3 attempts)
- rawLen=23854 for the tool call generation, stopReason=eogToken
- Follow-up prose generation: rawLen=1035, stopReason=eogToken (feature summary and usage instructions)
- File block in UI showed 125 lines (streaming counter), notification showed +475, disk has 475 lines
- No visible streaming output during the entire tool call generation (~165 seconds of "..." dots)
- Context rotated twice during generation — model did NOT restart the file (improvement over Test 20)
- Entire generation completed inside a single tool call — no fragmentation
- Speed dropped from 32 tok/s to 11 tok/s during tool call content generation (expected — onTextChunk doesn't fire for tool call parameters)
- 8 seed tracks present across 4 genres (electronic x2, rock, jazz, pop, classical x2, hip-hop) — 6 genres total, meets the 5+ requirement
- Model named it "SoundDeck v1.0" — matches requested name

BUGS FOUND:

- BUG #62: Missing closing `</body>` and `</html>` tags — file ends at `</script>` on line 475. Structurally incomplete HTML.
  EVIDENCE: `Select-String -Pattern "</body>|</html>"` returns zero matches. File verified ending with `</script>`.
  SEVERITY: critical

- BUG #63: Fatal JavaScript syntax error on line 341 — `function progressBar.style.width='100%'; document.getElementById('progressContainer').innerHTML += ...` — this is not valid JS. It is a broken statement fragment, not a function definition. The entire `<script>` block will fail to parse and no JavaScript will execute.
  EVIDENCE: Line 341 of index.html.
  SEVERITY: critical

- BUG #64: `filterTracks()` called on lines 266 and 270 but never defined anywhere in the file. Immediate ReferenceError if search input is used.
  EVIDENCE: grep for "function filterTracks" returns zero results.
  SEVERITY: critical

- BUG #65: `escapeHtml()` called in renderPlaylist template literals (lines 379, 380, 390, 391) but never defined. Immediate ReferenceError when playlist renders.
  EVIDENCE: grep for "function escapeHtml" returns zero results.
  SEVERITY: critical

- BUG #66: `toggleDarkMode()` referenced in HTML onclick (line 140) but never defined in JavaScript. Dark mode toggle does nothing.
  EVIDENCE: grep for "function toggleDarkMode" returns zero results.
  SEVERITY: major

- BUG #67: `validateForm()` referenced in HTML onblur (line 206) but never defined in JavaScript.
  EVIDENCE: grep for "function validateForm" returns zero results.
  SEVERITY: major

- BUG #68: `isActive` variable scoped to if-block (line 377) but referenced in else-block (line 389). ReferenceError in template literal for all tracks after index 0.
  EVIDENCE: Lines 377 and 389 of index.html.
  SEVERITY: critical

- BUG #69: `isShuffleActive` defined as const expression (line 369) but called as function `isShuffleActive()` on line 402 in `isSortedByDefault()`. TypeError: isShuffleActive is not a function.
  EVIDENCE: Line 369: `const isShuffleActive = currentSortKey === undefined && !isSortedByDefault();` vs line 402: `!isShuffleActive()`
  SEVERITY: critical

- BUG #70: Circular reference — `isSortedByDefault()` calls `isShuffleActive()` (line 402) and `isShuffleActive` assignment calls `isSortedByDefault()` (line 369). Even if both were functions, this would be infinite recursion on first call.
  EVIDENCE: Lines 369 and 402.
  SEVERITY: critical

- BUG #71: `updateChart()` references `document.getElementById('bar-chart-container')` (line 438) but HTML uses id `genreChartContainer` (line 241). Chart rendering silently fails — null reference.
  EVIDENCE: Line 438 vs line 241 of index.html.
  SEVERITY: major

- BUG #72: `counts` object increment broken — line 434: `(counts[t.genre] || 0)++` — postfix increment on an expression does not mutate the object property. Genre counts remain 0.
  EVIDENCE: Line 434 of index.html.
  SEVERITY: major

- BUG #73: `hip-hop` used as unquoted object key — line 433: `{ rock:0, pop:0, jazz:0, electronic:0, classical:0, hip-hop:0}`. JavaScript parses `hip-hop` as `hip` minus `hop` (subtraction), resulting in `NaN` property and missing hip-hop genre entirely.
  EVIDENCE: Line 433 of index.html.
  SEVERITY: critical

- BUG #74: CSS `:root` block missing closing brace — lines 7-16 define CSS custom properties in `:root {` but the block is never closed before `body {` begins on line 18. All subsequent CSS rules are nested inside `:root` unintentionally.
  EVIDENCE: Lines 7-18 of index.html.
  SEVERITY: critical

- BUG #75: `<meta charset="UTF-8"` missing closing `>` on line 4. Malformed HTML head.
  EVIDENCE: Line 4 of index.html.
  SEVERITY: major

- BUG #76: CSS selector `av.navbar` (line 26) instead of `nav.navbar`. Navigation bar styles never apply.
  EVIDENCE: Line 26 of index.html.
  SEVERITY: major

- BUG #77: Pervasive invalid CSS syntax — backslash artifacts throughout CSS (e.g., `main {\` on line 46, `.now-playing {\` on line 49, `.artwork {\` on line 52, dozens more). These are literal backslash characters in property declarations, causing CSS parse errors. At least 30 instances.
  EVIDENCE: Lines 46, 49, 52, 60, 63, 65, 69, 71, 74, 78, 84, 88, 90, 93, 96, 97, 99, 101, 105, 107, 109, 111, 113 of index.html.
  SEVERITY: critical

- BUG #78: Invalid CSS shorthand — `display:flex flex-col` used repeatedly (lines 22, 28, 46, 49, etc.) instead of `display:flex; flex-direction:column`. CSS `display` property does not accept multi-word values like this. Layouts broken throughout.
  EVIDENCE: At least 15 occurrences across CSS.
  SEVERITY: critical

- BUG #79: Duplicate `<main>` elements — `<main>` opens at line 142, then another `<main>` opens at line 181. Invalid HTML structure with nested/duplicate landmark elements.
  EVIDENCE: Lines 142 and 181 of index.html.
  SEVERITY: major

- BUG #80: Keyboard shortcuts not implemented — prompt requested "keyboard shortcuts (space for play/pause arrows for prev/next)" but no `keydown`/`keyup` event listener exists anywhere in the JavaScript.
  EVIDENCE: grep for "keydown\|keyup\|keyboard" returns zero results.
  SEVERITY: major

- BUG #81: Export playlist button has no click handler — the "Export Playlist (JSON)" button (line 176, id="exportBtn") has no JavaScript addEventListener or onclick binding. Feature not implemented.
  EVIDENCE: grep for "exportBtn\|export" in JS section returns no handler.
  SEVERITY: major

- BUG #82: Star rating is a single star with a range slider (lines 213-215) rather than 5 clickable stars as requested. The "rating" UI is a `<input type="range" min="0" max="4.99">` with a single star emoji — not a 5-star clickable component.
  EVIDENCE: Lines 211-215 of index.html.
  SEVERITY: major

- BUG #83: `j` variable not declared with let/const — line 254: `j = Math.floor(Math.random() * (i + 1))`. Creates an implicit global variable. Strict mode would throw ReferenceError.
  EVIDENCE: Line 254 of index.html.
  SEVERITY: minor

- BUG #84: Bug #2 recurrence — file block streaming count shows 125 lines, notification shows +475, disk has 475 lines. Streaming line counter continues to mismatch disk content.
  EVIDENCE: Screenshot of file block header vs terminal `$lines.Count` output.
  SEVERITY: major

- BUG #85: `< <span` broken HTML template literal — line 386: `< <span class="genre-badge"` has a stray `<` followed by a space before the actual `<span>`, creating invalid HTML in the playlist rendering for the first track (index 0).
  EVIDENCE: Line 386 of index.html.
  SEVERITY: minor

- BUG #86: Duration input has `name="duration"` but validation code references `document.getElementById('durationInput')` (line 452) — ID mismatch. Duration validation never runs.
  EVIDENCE: Line 206 (name="duration") vs line 452 (getElementById('durationInput')).
  SEVERITY: major

- BUG #42 UPDATE: Context rotation DID fire twice (100%→94%→100%→94%). Model continued generating without restarting the file — an improvement over Test 20. Bug #42 status remains: rotation fires but behavior varies per test.

LINE COUNT PROGRESSION: 0→475 (single write_file call). No rewrites. No restarts.
STRUCTURAL INTEGRITY: NO — missing `</body>` and `</html>`. CSS has unclosed `:root` block and pervasive backslash artifacts. JavaScript has a fatal syntax error (line 341) that prevents all JS from executing. Multiple undefined functions would crash even if the syntax error were fixed. Application is non-functional.

---

## Updated Summary of All Bugs (Tests 1-21)

| # | Bug | Severity | Location | Tests | Status |
|---|-----|----------|----------|-------|--------|
| 1 | Auto-scroll does not engage during file streaming | major | ChatPanel.jsx ~L450 | T2 | FIXED (Build #1) |
| 2 | Content line count mismatch (streaming vs disk) / frozen at pre-write count | major | chatEngine.js / streaming detection | T2,3,6,13 | OPEN |
| 3 | Model calls write_file without content, retries after error | major | System prompt / tool call loop | T3 | OPEN |
| 4 | readme.md skipped at high context (94%) | major | chatEngine.js context management | T3 | OPEN |
| 5 | Overwrite protection blocked legit line-reducing writes | critical | mcpToolServer.js | T4 | FIXED (removed) |
| 6 | 20 tool call limit not surfaced to user | major | chatEngine.js | T4 | FIXED (Build #1) |
| 7 | read_file called with wrong path (omits subdirectory prefix) | major | System prompt / tool behavior | T5 | OPEN |
| 8 | browser_navigate crashes: "this.browserManager.navigate is not a function" | critical | mcpBrowserTools.js | T5 | FIXED (Build #1) |
| 9 | Streaming detection — prose-prefixed tool call partial leakage | major | chatEngine.js streaming detection | T1,6,14 | FIX INADEQUATE |
| 10 | Model generates syntactically invalid JS function declarations | major | Model generation quality | T8 | OPEN |
| 11 | Model hallucinates undefined variable/function references | major | Model generation quality | T8 | OPEN |
| 12 | Model misdiagnoses bugs — fixes wrong root cause | major | Model reasoning / system prompt | T9 | OPEN |
| 13 | Model drops module.exports in file rewrite | major | Model generation quality | T9 | OPEN |
| 14 | Model corrupts JS with unclosed `/**` comment prefix | critical | Model generation quality | T9 | OPEN |
| 15 | edit_file tool never invoked — model defaults to write_file for all edits | major | System prompt / tool selection | T1-14 | OPEN |
| 16 | After context rotation, model restarts file — second write overwrites first | critical | chatEngine.js / context rotation | T10 | OPEN |
| 17 | After multiple rotations, model abandons write_file — code printed in chat markdown | critical | chatEngine.js / context rotation | T10 | OPEN |
| 18 | Context rotation degrades project context — switch to absolute path | minor | chatEngine.js / session prompt | T10 | OPEN |
| 19 | Generated code after context rotation: infinite recursion, hallucinated helpers | critical | Model generation / context rotation | T10 | OPEN |
| 20 | Wrong data structures written — model generates unrequested, omits requested | major | Model generation quality | T10 | OPEN |
| 21 | JSDocs missing @example usage despite explicit prompt requirement | minor | Model generation quality | T11 | OPEN |
| 22 | generateUUID throws TypeError at runtime — calls exec('')[1] on null | critical | Model generation quality | T11 | OPEN |
| 23 | flattenArray checks arr.hasOwnProperty(key) instead of arr[i] — logic broken | major | Model generation quality | T11 | OPEN |
| 24 | parseQueryString uses for...in on URLSearchParams.entries() iterator — always returns {} | major | Model generation quality | T11 | OPEN |
| 25 | toKebabCase calls .charCodeAt() on boolean result — throws TypeError | critical | Model generation quality | T11 | OPEN |
| 26 | helmetMiddleware written without `function` keyword — syntax error, module dead | critical | Model generation quality | T12 | OPEN |
| 27 | rateLimitMiddleware uses entry.remaining (undefined) vs entry.limit — rate limiting never fires | critical | Model generation quality | T12 | OPEN |
| 28 | corsMiddleware uses Object.assign(res.headers) instead of res.setHeader — CORS header not sent | major | Model generation quality | T12 | OPEN |
| 29 | requestLogMiddleware listens for 'response' event instead of 'finish' — logging never fires | major | Model generation quality | T12 | OPEN |
| 30 | File block frozen at streaming count (126) not updated to written count (394) — permanently wrong | major | frontend / ChatPanel streaming | T13 | OPEN |
| 31 | Model used Chart.js despite "pure canvas api" constraint — app crashes on load | critical | Model generation quality | T13 | OPEN |
| 32 | filterTransactions mutates transactions array — data loss on search | critical | Model generation quality | T13 | OPEN |
| 33 | setupEventListeners defined as labeled statement — event listeners never attach | major | Model generation quality | T13 | OPEN |
| 34 | Bug #9 fix inadequate — partial token `{"tool` leaks before full string detected | major | chatEngine.js | T14 | OPEN |
| 35 | GET/DELETE/search routes use await in non-async callback — SyntaxError | critical | Model generation quality | T14 | OPEN |
| 36 | Search logic inverted — checks if query.includes(name) instead of name.includes(query) | major | Model generation quality | T14 | OPEN |
| 37 | Input validation middleware mounted globally — blocks all non-POST requests with 400 | critical | Model generation quality | T14 | OPEN |
| 38 | Files written to wrong project directory — stale projectPath in server on UI folder switch | critical | server/main.js + mcpToolServer | T15 | OPEN |
| 39 | cli.js never created — model declared all 5 files written while only writing 4 | major | chatEngine.js / model generation | T15 | OPEN |
| 40 | formatters.js: `const hours` redeclared ~20 times in same scope — infinite code loop | critical | Model generation quality (repetition) | T15 | OPEN |
| 41 | formatters.js written twice — tool calls #4 and #5 both target same file; second truncates first | major | chatEngine.js / tool call sequence | T15 | OPEN |
| 42 | Context hit 100% with zero rotations — model stopped instead of rotating | critical | chatEngine.js context rotation | T15 | OPEN |
| 43 | mcpToolServer.projectPath not updated when UI switches folder via dialog | critical | server/main.js openProjectPath() | T16 | OPEN |
| 44 | edit_file tool never invoked across 19 tests — model uses write_file for all edits | major | System prompt / tool selection | T1-19 | OPEN |
| 45 | append_to_file tool never used — model uses write_file for appends | major | System prompt / tool selection | T17 | OPEN |
| 46 | extractErrorContext: --index mutation + result.length on plain object | critical | Model generation quality | T17 | OPEN |
| 47 | formatEntry date format doesn't match JSDoc example | minor | Model generation quality | T17 | OPEN |
| 48 | deduplicateMessages creates unused key variable | minor | Model generation quality | T17 | OPEN |
| 49 | Model hallucinated "cannot access file system" — 0 tool calls despite read_file available | major | Model reasoning / tool selection | T18 | OPEN |
| 50 | sanitizeString double-escaped regex `\\s+` — replaces literal chars, not whitespace | major | Model generation quality | T19 | OPEN |
| 51 | requestLogger wrong signature `(res, logger)` not Express middleware `(req, res, next)` | critical | Model generation quality | T19 | OPEN |
| 52 | smoke.test.js wrong import paths — `../routes/users` vs `../src/routes/users` | critical | Model generation quality | T19 | OPEN |
| 53 | smoke.test.js `.constructor()` — tests Object.constructor, not User class | major | Model generation quality | T19 | OPEN |
| 54 | users.js double path `/users/users` — POST handler has redundant prefix | major | Model generation quality | T19 | OPEN |
| 55 | Model hallucinated index.html creation in closing summary | minor | Model confabulation | T19 | OPEN |
| 56 | Context rotation fires but model loses task state — restarts file from scratch | critical | chatEngine.js / context rotation | T20 | OPEN |
| 57 | Model generates file with no JavaScript — HTML-only with external script ref | critical | Model generation / context rotation | T20 | OPEN |
| 58 | Model outputs 11K+ tokens of code as chat prose after tool calls complete | major | chatEngine.js / tool call detection | T10,20 | OPEN |
| 59 | write_file called with missing content — early JSON boundary abort | major | chatEngine.js early tool detection | T20 | OPEN |
| 60 | File notification line count (+423) matches no actual count (418/425/558/369) | minor | frontend notification pipeline | T20 | OPEN |
| 61 | 5th seed recipe wrong — "Veggie Omelette Breakfast" instead of "trail mix snack" | minor | Model generation quality | T20 | OPEN |
| 62 | Missing closing `</body>` and `</html>` tags — file structurally incomplete | critical | Model generation quality | T21 | OPEN |
| 63 | Fatal JS syntax error — `function progressBar.style.width=...` not valid JS, script block fails to parse | critical | Model generation quality | T21 | OPEN |
| 64 | `filterTracks()` called but never defined — ReferenceError | critical | Model generation quality | T21 | OPEN |
| 65 | `escapeHtml()` called but never defined — ReferenceError on playlist render | critical | Model generation quality | T21 | OPEN |
| 66 | `toggleDarkMode()` onclick handler calls undefined function — dark mode broken | major | Model generation quality | T21 | OPEN |
| 67 | `validateForm()` onblur handler calls undefined function | major | Model generation quality | T21 | OPEN |
| 68 | `isActive` scoped to if-block but referenced in else-block — ReferenceError | critical | Model generation quality | T21 | OPEN |
| 69 | `isShuffleActive` defined as const but called as function `isShuffleActive()` — TypeError | critical | Model generation quality | T21 | OPEN |
| 70 | Circular reference — `isSortedByDefault()` ↔ `isShuffleActive` — infinite recursion | critical | Model generation quality | T21 | OPEN |
| 71 | `updateChart()` references wrong element ID (`bar-chart-container` vs `genreChartContainer`) | major | Model generation quality | T21 | OPEN |
| 72 | Genre counts increment broken — `(counts[t.genre] \|\| 0)++` doesn't mutate object | major | Model generation quality | T21 | OPEN |
| 73 | `hip-hop` unquoted object key parsed as subtraction — genre missing | critical | Model generation quality | T21 | OPEN |
| 74 | CSS `:root` block missing closing brace — all CSS nested inside `:root` | critical | Model generation quality | T21 | OPEN |
| 75 | `<meta charset="UTF-8"` missing closing `>` — malformed HTML | major | Model generation quality | T21 | OPEN |
| 76 | CSS selector `av.navbar` instead of `nav.navbar` — nav styles never apply | major | Model generation quality | T21 | OPEN |
| 77 | Pervasive backslash artifacts in CSS (`{\` instead of `{`) — 30+ instances | critical | Model generation quality | T21 | OPEN |
| 78 | Invalid CSS shorthand `display:flex flex-col` — CSS property doesn't accept this | critical | Model generation quality | T21 | OPEN |
| 79 | Duplicate `<main>` elements — invalid HTML structure | major | Model generation quality | T21 | OPEN |
| 80 | Keyboard shortcuts not implemented — no keydown/keyup listener anywhere | major | Model generation quality | T21 | OPEN |
| 81 | Export playlist button has no click handler — feature not implemented | major | Model generation quality | T21 | OPEN |
| 82 | Star rating is range slider + 1 star, not 5 clickable stars as requested | major | Model generation quality | T21 | OPEN |
| 83 | `j` variable not declared with let/const — implicit global | minor | Model generation quality | T21 | OPEN |
| 84 | Bug #2 recurrence — streaming shows 125 lines, disk has 475 | major | chatEngine.js / streaming | T21 | OPEN |
| 85 | Stray `< <span` in template literal — invalid HTML in playlist item | minor | Model generation quality | T21 | OPEN |
| 86 | Duration input `name` vs `getElementById('durationInput')` — ID mismatch | major | Model generation quality | T21 | OPEN |