# Test Report — 2026-04-13 (Post-Optimization Validation)

Context: Tests 23-26 validate the prompt optimization changes (Changes 1-3) applied in the previous session. Test 22 (in 412-report.md) was the first post-optimization test and eliminated Category B+C bugs but showed 26 Category D bugs remain. These 4 tests use varied prompts to confirm whether the improvement is consistent.

Configuration (all tests):
- Model: Qwen3.5-2B-Q8_0.gguf
- Context: TEST_MAX_CONTEXT=8000 (8192 actual)
- Token budget: ~2,480 tokens (30%) consumed by system+tool prompt
- Changes applied: slimmed SYSTEM_PROMPT, removed TOOL_EXAMPLES, skipForCode tool filter

---

## Test 23 — Simple Prompt (Countdown Timer)

**Prompt**: "build me a countdown timer app in a single html file with start stop and reset buttons"

**Timeline**:
- 19:38 — Prompt submitted
- Generation completed at 41% context (no rotation)

**Server Logs**:
- stopReason=abort, rawLen=4427, parsedToolCalls=1
- Tool call #1: write_file → index.html
- Follow-up: stopReason=eogToken, rawLen=439

**Output**:
- File: test-post-opt-23/index.html
- Disk: 158 lines, 4,136 bytes
- Browser display: 83 lines (collapsed code block)
- Notification: "+179" (vs 158 actual — mismatch)

**Context Rotation**: NONE (41% at completion)

**Code Quality Assessment**:
- Better than Test 22 — proper CSS variables, proper function definitions, good structure
- Dark theme with CSS custom properties
- Countdown logic present (hours/minutes/seconds inputs)
- Audio notification attempt (AudioContext oscillator)

**Bugs Found**:

| # | Bug | Category | Description |
|---|-----|----------|-------------|
| 115 | Truncated HTML | D | File cut off mid-function at line 158 — `finishTimer()` incomplete. No closing `</script>`, `</body>`, `</html>` |
| 116 | Line count mismatch (browser) | D | Browser shows 83 lines, disk has 158 lines — 2x discrepancy |
| 117 | Line count mismatch (notification) | D | Notification shows "+179" but disk file is 158 lines |
| 118 | stopReason=abort | D | Model forced to stop by abort, not natural completion (eogToken) |
| 119 | No meta charset | D | Missing `<meta charset="UTF-8">` — only has `<title>` in head |
| 120 | oscillator never started | D | `finishTimer()` creates AudioContext/oscillator but function is truncated before `.start()` is called |
| 121 | No timer display update | D | Timer display element (`#timer-display`) referenced but update logic may be in truncated portion |
| 122 | Start/stop state management | D | `isRunning` flag used but reset logic and edge cases incomplete due to truncation |

**Summary**: 8 bugs (#115-#122), all Category D. 0 Category B, 0 Category C (no context rotation). Code quality notably better than Tests 1-21 — the prompt optimization is working for structure/formatting. The persistent truncation issue (stopReason=abort) remains the dominant failure mode.

---

## Test 24 — Complex Prompt (Personal Finance Dashboard)

**Prompt**: "build me a single html file for a personal finance dashboard app with everything embedded, i want a monthly budget tracker section at the top with a table where each row has a category name an allocated amount and a spent amount and it calculates remaining automatically, below that add a transaction log where i can type a description select a category from a dropdown pick a date and enter an amount then click add and it appears in a scrollable list sorted by date newest first, include a pie chart using canvas that shows spending by category with different colors and labels, add a savings goal widget where i can set a target amount and current saved amount and it shows a progress bar with percentage, include a net worth calculator with fields for total assets and total liabilities that displays the difference, add month navigation buttons so i can switch between months and the data persists in localStorage for each month, include an export to csv button that downloads all transactions for the current month, add a search filter box above the transaction list that filters by description or category as you type, include a recurring transaction feature where i can mark a transaction as recurring monthly and it auto-populates when switching to a new month, add a dark mode toggle, use a clean modern design with css grid layout and subtle animations on hover, the pie chart should update in real time as transactions are added, and include a summary stats bar showing total income total expenses and net savings for the month"

**Timeline**:
- 19:46:31 — Session prompt logged (histItems=5, contextSize=8192)
- Context progression: 26% → 32% → 46% → 82% → 87% → 91% → 96% → 99% → 100%
- At least 5 context rotations observed: 100%→92%, 99%→90%, 99%→89%, 98%→88%, 100%→93%
- 19:48:37 — Generation completed

**Server Logs**:
- stopReason=abort, rawLen=20796, parsedToolCalls=1
- Tool call #1: write_file → index.html
- Tool result: success (file written)
- NO follow-up prose generation logged (model likely ran out of context after 20K raw tokens)

**Output**:
- File: test-post-opt-24/index.html
- Disk: 445 lines, 19,492 bytes
- Browser display: Two collapsed code blocks (62 lines + 63 lines = 125 total shown)
- Notification: "+445"

**Context Rotation**: YES — at least 5 rotations observed during generation

**Code Quality Assessment**:
- HTML structure is reasonable — proper sections for budget, transactions, chart, savings, net worth, recurring, export
- CSS uses custom properties (dark theme by default)
- JavaScript has DOMContentLoaded event listener — good practice
- Multiple functions defined: saveData, changeMonth, renderBudgetTable, renderTransactionList, updateTransaction, filterTransactions, toggleRecurrence, updatePieChart, updateSavingWidget, exportToCSV

**Critical JS Bugs (would prevent any functionality)**:
- `const currentMonthStr` declared with const, then reassigned later → TypeError
- `reduce((a,b)=>a+b,0).toFixed(2)` on transaction objects — adds objects not amounts → NaN
- Missing parenthesis in ternary: `savingTargetVal > 0 ? ((...) : 0` — SyntaxError
- `currentSavedVal` referenced but never defined → ReferenceError
- `formatDate()` called but never defined → ReferenceError
- `renderRecurringList()` called in init but never defined → ReferenceError
- `tbody` variable used across function scopes incorrectly
- `t` referenced outside its scope in `filterTransactions()` (`isRecurringMonthly` line)
- `Chart` constructor called but Chart.js never imported → ReferenceError
- `keys[key]` uses string key as array index → undefined
- CSV export truncated mid-template-literal — no closing backtick, no function close, no `</script>` or `</html>`

**Bugs Found**:

| # | Bug | Category | Description |
|---|-----|----------|-------------|
| 123 | Truncated HTML | D | File ends mid-CSV-export function. No `})`, no `</script>`, no `</body>`, no `</html>` |
| 124 | stopReason=abort | D | 20,796 raw tokens generated but forcibly aborted, not natural eogToken |
| 125 | const reassignment | D | `currentMonthStr` declared `const` then reassigned in if/else block → TypeError |
| 126 | reduce on objects | D | `.reduce((a,b)=>a+b,0)` adds transaction objects, not `.amount` values → NaN |
| 127 | Missing parenthesis | D | Ternary expression missing closing paren → SyntaxError blocks all JS |
| 128 | Undefined currentSavedVal | D | `currentSavedVal.textContent` but variable never declared → ReferenceError |
| 129 | Undefined formatDate | D | `formatDate(dateObj)` called but function never defined → ReferenceError |
| 130 | Undefined renderRecurringList | D | Called in DOMContentLoaded init but never defined → ReferenceError |
| 131 | Cross-scope tbody | D | `tbody` from `renderBudgetTable` used in `renderTransactionList` → ReferenceError or wrong element |
| 132 | Scope leak in filter | D | `t` variable referenced outside its callback scope in `filterTransactions()` → ReferenceError |
| 133 | Chart.js not imported | D | `new Chart(ctx, {...})` but Chart.js library never loaded via `<script>` → ReferenceError |
| 134 | String as array index | D | `keys[key]` where `key` is a string (category name) used to index an array → undefined |
| 135 | Duplicate element IDs | D | Two `recurrenceToggle` checkboxes with same ID in the HTML |
| 136 | Duplicate searchInput | D | Both `searchInput` and `searchInputTx` — filterTransactions reads both, returns early if either is empty |
| 137 | CSS backslash syntax | D | `div {\\ display:flex...}` — backslash in CSS property is invalid syntax |
| 138 | CSS ID selector error | D | `}#` appears in CSS — stray `#` character creates invalid selector |
| 139 | textarea backslash | D | `textarea {\\ width:90%...}` — same backslash CSS syntax error |
| 140 | No dark mode toggle | D | Prompt requested dark mode toggle but none exists (hardcoded dark theme only) |
| 141 | No add transaction form | D | Prompt requested "type a description, select category, pick date, enter amount, click add" — no form or Add button exists |
| 142 | No progress bar | D | Prompt requested "progress bar with percentage" for savings — not implemented |
| 143 | No CSS grid layout | D | Prompt requested "css grid layout" — uses flexbox throughout, no grid |
| 144 | No hover animations | D | Prompt requested "subtle animations on hover" — only `button:hover { opacity:0.9 }` |
| 145 | No real-time chart update | D | Pie chart draws once in init but `updatePieChart()` has no data to display (budgetData always empty) |
| 146 | Empty budgetData | D | `budgetData = {}` initialized empty, never populated — budget table always empty |
| 147 | No month display update | D | `currentMonthDisplay` span never populated — user can't see which month is active |
| 148 | CSV escape vulnerability | D | Transaction descriptions injected into CSV without escaping quotes — potential injection |
| 149 | No follow-up prose | C | After file write, model produced no response text (context exhausted after 5+ rotations and 20K tokens) |
| 150 | 5+ context rotations | C | Context rotated at least 5 times during single generation — each rotation loses coherence |
| 151 | Browser line mismatch | D | Browser shows 62+63=125 lines in two code blocks, but disk has 445 lines |
| 152 | Two write_file calls displayed | D | Browser shows two collapsed code blocks suggesting tool parser detected two write_file calls, but log says parsedToolCalls=1 |

**Summary**: 30 bugs (#123-#152), 28 Category D, 2 Category C. The complex prompt triggered 5+ context rotations (Category C returning), and the model generated 20,796 raw tokens — far exceeding the 8,192 context window. The code has at least 4 fatal JS errors that would prevent any functionality. Most of the 14 requested features are either missing or non-functional. This confirms that prompt optimization alone cannot fix complex-prompt scenarios — the context rotation pipeline is the critical bottleneck.

---

## Test 25 — Multi-Tool Mix (Web Search + Write File)

**Prompt**: "find out what the current Bitcoin price is today using web search, then create an HTML file that displays the price you found with a nice styled card layout"

**Timeline**:
- 20:01:15 — Session prompt logged (histItems=5, contextSize=8192)
- 20:01:17 — web_search called: `{"query":"Bitcoin BTC price today USD"}`
- 20:01:18 — Search result returned (CoinMarketCap)
- 20:01:50 — write_file #1: bitcoin-price.html (rawLen=4099)
- 20:02:16 — write_file #2: bitcoin-price.html OVERWRITE (rawLen=3003)
- 20:02:18 — append_to_file #1: "13T 09:47" (rawLen=95)
- 20:02:20 — append_to_file #2: "2025-1" (rawLen=92)
- 20:02:23 — Final prose (rawLen=430, eogToken)

**Server Logs**:
- Generation 1: stopReason=abort, rawLen=174, parsedToolCalls=1 → web_search
- Generation 2: stopReason=abort, rawLen=4099, parsedToolCalls=1 → write_file
- Generation 3: stopReason=eogToken, rawLen=3003, parsedToolCalls=1 → write_file (OVERWRITE)
- Generation 4: stopReason=eogToken, rawLen=95, parsedToolCalls=1 → append_to_file ("13T 09:47")
- Generation 5: stopReason=eogToken, rawLen=92, parsedToolCalls=1 → append_to_file ("2025-1")
- Generation 6: stopReason=eogToken, rawLen=430, parsedToolCalls=0 → prose
- Complete: 5 tool calls, stopReason=eogToken

**Output**:
- File: test-post-opt-25/bitcoin-price.html
- Disk: 124 lines, 2,739 bytes
- Browser display: Two code blocks (157 lines + 125 lines)
- Notification: "1 file changed"

**Context Rotation**: NONE (85% at completion)

**Multi-Tool Assessment**:
- web_search was successfully called and returned results ✓
- Model extracted Bitcoin price from search results ✓
- write_file called to create HTML ✓
- Follow-up prose generated with correct price reference ✓
- However: Model wrote file TWICE (overwrite) then tried 2 small appends — fragmented behavior

**Code Quality Assessment**:
- HTML structure is good — proper card layout with gradient background
- CSS is clean with proper flexbox centering, responsive design, media queries
- BTC symbol (₿) used correctly
- Color scheme: dark theme (#1a1a2e background, orange accents)
- No JavaScript for fetching live price (despite claiming "real-time updates from CoinMarketCap API")
- Shows "Loading..." permanently — no fetch logic
- File truncated: ends with `13T 09:472025-1` (append fragments)

**Bugs Found**:

| # | Bug | Category | Description |
|---|-----|----------|-------------|
| 153 | No JS fetch logic | D | Claims "real-time updates from CoinMarketCap API" in prose but no JavaScript fetch code exists |
| 154 | Permanent "Loading..." | D | `<div id="currentPrice">Loading...</div>` never gets updated — no JS to set it |
| 155 | Truncated HTML | D | File ends mid-tag with `13T 09:472025-1` — missing `</footer>`, `</div>`, `</body>`, `</html>` |
| 156 | Double write_file | D | File written twice (overwrite), then two append_to_file calls with junk fragments |
| 157 | Append fragments | D | `append_to_file("13T 09:47")` and `append_to_file("2025-1")` — model hallucinated these as meaningful content but they're timestamp fragments |
| 158 | Price hardcoded in prose only | D | Prose says "$69,379.31" but this price appears nowhere in the HTML file |
| 159 | No dark mode toggle | D | Card is dark by default but no toggle mechanism |
| 160 | Browser line count mismatch | D | Browser shows 157+125=282 lines across two code blocks but disk has 124 lines |
| 161 | Positive/Negative classes unused | D | CSS defines `.positive` and `.negative` classes but `#changePercent` span is never populated |
| 162 | Market cap section missing | D | `.market-cap` CSS class defined but no HTML element uses it |

**Summary**: 10 bugs (#153-#162), all Category D. 0 Category B, 0 Category C (no rotation at 85%). The multi-tool pipeline WORKS — web_search was called successfully, search results were returned, and the model used those results to write HTML. However, the model then fragmented its output across 5 tool calls (1 search + 2 writes + 2 appends), and the final file is truncated. The core multi-tool chaining capability is functional but the output quality remains poor due to truncation.

---

## Test 26 — Simple Single-Tool (Hello World)

**Prompt**: "create a simple hello world html file called hello.html with a centered heading that says Hello World and a paragraph below it that says This page was generated by AI, use a light blue background and dark text"

**Timeline**:
- 20:04:27 — Session prompt logged (histItems=5, contextSize=8192)
- 20:04:33 — write_file called: hello.html
- 20:04:35 — Follow-up prose generated
- Total generation time: ~8 seconds

**Server Logs**:
- Generation 1: stopReason=abort, rawLen=590, parsedToolCalls=1 → write_file(hello.html)
- Generation 2: stopReason=eogToken, rawLen=184, parsedToolCalls=0 → prose
- Complete: 1 tool call, stopReason=eogToken

**Output**:
- File: test-post-opt-26/hello.html
- Disk: 26 lines, 487 bytes
- Browser display: "hello.html HTML (26 lines)" — single code block
- Notification: "1 file changed +26"

**Context Rotation**: NONE (23% at completion)

**Code Quality Assessment**:
- File is COMPLETE with proper closing tags (`</body>`, `</html>`) ✓
- Centered heading "Hello World" ✓
- Paragraph "This page was generated by AI." ✓
- Light blue background (`lightblue`) ✓
- Dark text (`#00008b` dark blue) ✓
- Proper CSS flexbox centering ✓
- Clean, minimal code ✓
- Follow-up prose is accurate and clear ✓

**Bugs Found**:

| # | Bug | Category | Description |
|---|-----|----------|-------------|
| 163 | Missing meta charset | D | No `<meta charset="UTF-8">` in head |
| 164 | Unnecessary script | D | `<script>document.title = new Date().toLocaleTimeString();</script>` — not requested, changes window title to current time |
| 165 | Flexbox layout bug | D | `display: flex` on body with h1+p as direct children makes them side-by-side, not stacked vertically (needs `flex-direction: column`) |
| 166 | Style tag not closed properly | D | `</style>` appears on same line as last CSS rule — functional but poor formatting |

**Summary**: 4 bugs (#163-#166), all Category D. 0 Category B, 0 Category C. **This is the best result of all 26 tests.** The file is complete, all requested features are present, the code is clean and minimal. The only issues are minor (missing charset, unnecessary script, flex direction). At 23% context usage with a simple prompt, the model performs well.

---

## Cross-Test Analysis (Tests 23-26)

### Bug Count by Category

| Test | Prompt Complexity | Context Used | Rotations | Cat B | Cat C | Cat D | Total |
|------|-------------------|-------------|-----------|-------|-------|-------|-------|
| 23 | Simple (countdown timer) | 41% | 0 | 0 | 0 | 8 | 8 |
| 24 | Complex (14-feature dashboard) | 100% (5+ rotations) | 5+ | 0 | 2 | 28 | 30 |
| 25 | Multi-tool (web search + write) | 85% | 0 | 0 | 0 | 10 | 10 |
| 26 | Simple (hello world) | 23% | 0 | 0 | 0 | 4 | 4 |
| **TOTAL** | | | | **0** | **2** | **50** | **52** |

### Key Findings

1. **Category B bugs (tool prompt leaking): ELIMINATED** — Zero across all 4 tests. The prompt optimization (Changes 1-3) successfully eliminated tool prompt/example text appearing in generated code.

2. **Category C bugs (context rotation artifacts): Nearly eliminated** — Only 2 bugs in Test 24 (complex prompt that intentionally exceeded context). Simple-to-moderate prompts (Tests 23, 25, 26) showed zero Category C bugs.

3. **Category D bugs (general code quality): Persistent** — 50 bugs across 4 tests. These are inherent to the 2B model's code generation capability and cannot be fixed by prompt optimization alone.

4. **Prompt complexity is the key variable**:
   - Simple prompts (23% context) → near-perfect output (4 bugs, all minor)
   - Moderate prompts (41-85% context) → functional structure but truncated (8-10 bugs)
   - Complex prompts (100%+ context with rotations) → catastrophic quality (30 bugs, multiple fatal errors)

5. **Truncation (stopReason=abort) is the #1 remaining issue** — Tests 23, 24, and 25 all produced truncated files. Only Test 26 (simplest prompt) produced a complete file. The model generates until it hits the context limit, then gets aborted.

6. **Multi-tool pipeline works** — Test 25 demonstrated successful web_search → write_file chaining. The model correctly called web_search, processed results, and created HTML. However, it fragmented the output across 5 tool calls and the final file was still truncated.

7. **The optimization's impact**: Before optimization, ~44% of context was consumed by system+tool prompt. After optimization, ~30%. This 14% savings translates to ~1,100 additional tokens for generation — enough to make simple prompts work cleanly but insufficient for complex ones.

---

## Context Shift Investigation Tests

### Context Shift Test #1 — Moderate Prompt (~15 clauses)

**Project**: test-context-shift-1
**Prompt**: ~15 clauses specifying a single HTML file with multiple features (navigation, table, charts, dark mode, responsive layout)
**Objective**: Observe behavior when a single write_file tool call exceeds the context window

**Results**:
- 14 total tool calls emitted
- Tool call #1: `write_file` with rawLen=8,070 tokens — wrote a real (but truncated) file
- Tool calls #2-#14: Tiny fragmented write_file calls (110-615 tokens each) that **overwrote the file repeatedly**
- Final file: 3 lines, 88 bytes of garbage
- Browser showed 12 code blocks
- Model lost coherence after first contextShift, emitted garbage fragments

**Diagnosis**: After the first large write_file, the context contained: system prompt + tool definitions + user prompt + 8,070-token response + tool result. This exceeded 8,192 tokens. ContextShift (`eraseFirstResponseAndKeepFirstSystem`) evicted the first response, causing the model to lose memory of what it had written. It then emitted tiny, incoherent write_file calls that overwrote the file.

---

### Context Shift Test #2 — Large Prompt (50 sentences, 4,448 chars)

**Project**: test-context-shift-2
**Prompt**: 50 numbered requirements for a single Employee Dashboard HTML file (dashboard.html). Requirements included: dark theme, navigation, stat cards, employee table with 8 rows, modal forms, validation, search/filter, sorting, bar chart on canvas, pie chart, payroll calculator, dark/light mode toggle, localStorage, responsive grid, media queries, print stylesheet, back-to-top button, keyboard shortcuts, loading spinner, CSV export, tooltips, toast notifications, all JS in one script tag.
**Objective**: Force the model to attempt a file large enough to trigger contextShift and observe infinite-loop behavior

**Results**:
- Generation ran for **6 minutes 56 seconds** (22:07:41 — 22:14:37) before manual abort via page reload
- Line count progression: 30 → 62 → 86 → 105 → 120 → 140 → 156 → 171 → 189 → 204 → 221 → 237 → 258 → 287 → 309 → 327 → 357 → 378 → 399 → 444 → 467 → 513 → 560+
- Context % progression: 35% → 39% → 43% → 48% → 53% → 58% → 63% → 68% → 73% → 78% → 82% → 88% → 94% → 100% → 98% → 94% → 93% → 90% → 88% (oscillating as contextShift fires repeatedly)
- Speed degradation: 26 → 33 → 38 → 42 → 28 → 40 → 38 → 29 → 42 → 28 → 33 → 34 → 29 → 34 → 35 → 16 → 29 → 36 → 34 → 28 → 21 tok/s
- Only **1 code block** in browser (never multiple — the model never closed the tool call JSON)
- **File was NEVER written to disk** — dashboard.html does not exist
- The model entered a CSS repetition loop at ~86 lines (around 43% context), repeating `div[contenteditable="true"]{ outline:none } / card button:hover, .btn-primary:hover{ background-` endlessly
- By 560+ lines, ~480+ lines were pure repeated CSS blocks

**Critical Findings from Server Logs**:
1. `agent-pause` handler **does not exist**: `[Transport] Handler error for 'agent-pause': No handler registered for IPC channel: agent-pause` — the Stop Generation button does nothing
2. After page reload, `file-content-token` events were still being generated and dropped — the server continued generating tokens even after the client disconnected
3. No `stopReason` was ever logged — generation never completed
4. No `maxTokens` limit exists anywhere in chatEngine.js — there is no generation cap
5. The brace depth tracker correctly recognizes CSS braces inside JSON strings (they don't affect depth), so it will never trigger abort on repeated CSS — the model could repeat forever

**Root Cause Analysis**:

Three independent bugs combine to create this infinite-loop scenario:

1. **No maxTokens limit**: chatEngine.js line 179-189 sets temperature, topP, topK, repeatPenalty but never sets maxTokens. There is no upper bound on generation length.

2. **repeatPenalty (1.1) is insufficient**: The model enters a repetition loop at ~43% context (~86 lines). A penalty of 1.1 is too weak to break out of a strongly-reinforced pattern. The same 4-line CSS block repeats 100+ times.

3. **contextShift enables infinite generation**: When context fills to 100%, node-llama-cpp's default contextShift (`eraseFirstResponseAndKeepFirstSystem`, 10% deletion) evicts old tokens and continues generating. The model never hits a hard stop — it just keeps going with a degraded view of its own output. Context % oscillates between 88-100% indefinitely.

4. **Stop button is non-functional**: The frontend sends `agent-pause` via WebSocket, but no handler is registered for that channel. The user has no way to stop generation except closing/reloading the page.

5. **Server continues after disconnect**: Even after the client disconnects, the LLM inference continues generating tokens (evidenced by `file-content-token` events being dropped with "no sender"). There is no cleanup on disconnect.

**Behavior Difference from Test #1**:
- Test #1 (shorter prompt): Model completed the first write_file (brace depth returned to 0 → abort → file saved), then lost coherence on subsequent tool calls and overwrote the file with garbage
- Test #2 (longer prompt): Model entered repetition loop BEFORE completing the tool call JSON. The braces inside CSS strings don't affect JSON depth, so the tracker never triggered. The model repeated forever inside a single tool call, and the file was never saved.

---

### Combined Findings: The Context Problem Has Multiple Failure Modes

| Scenario | Prompt Size | Failure Mode | File Written? | Code Blocks |
|----------|-------------|--------------|---------------|-------------|
| Small prompt (Test 26) | 23% context | None | Yes, complete | 1 |
| Medium prompt (Test 23) | 41% context | Truncation at abort | Yes, truncated | 1 |
| Large prompt (Test 24) | 100%+ with rotations | Multiple overwrites + truncation | Yes, corrupted | 2+ |
| Multi-tool (Test 25) | 85% context | Fragmented across 5 calls | Yes, truncated | Multiple |
| Context shift test #1 | ~100% | Complete first write → garbage overwrites | Yes, destroyed | 12 |
| Context shift test #2 | 100%+ oscillating | Infinite repetition loop, never completes | No, never saved | 1 (infinite) |

**There are three distinct failure modes, not one**:

1. **Repetition loop** (Test CS-2): Model gets stuck repeating CSS/HTML patterns. repeatPenalty too weak. No maxTokens to stop it. ContextShift enables infinite generation. File never saves.

2. **Post-contextShift amnesia** (Test CS-1, Test 24): Model completes a tool call, context fills up, contextShift evicts the response, model loses memory and emits garbage tool calls that overwrite the file.

3. **Simple truncation** (Tests 23, 25): Model generates until it nears context limit, brace tracker fires at the right time (or model emits EOS), file is saved but incomplete. This is the "best-case" failure — the file exists and has useful content, just not all of it.

