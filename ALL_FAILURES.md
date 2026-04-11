# ALL FAILURES — Complete Inventory Across All Three Codebases

> **Every system, approach, mechanism, and fix that was tried and failed.**
> If your proposal resembles ANYTHING in this file, it is WRONG. Do not implement it.
> This file is the product of 2+ months of daily 7AM-1AM+ development across 3 codebases.

---

## CODEBASE 1: Original IDE (C:\Users\brend\IDE)

### Architecture That Failed
- **agenticChat.js**: 2,781 lines. Monolithic orchestration with inline context management, tool execution, streaming, continuation — all in one file.
- **Pipeline size**: 10,000+ lines across multiple files.
- **THREE competing context management systems**: contextManager.js (4-phase progressive compaction), proactive rotation at 70%, and native context shift hook. All operated independently on different views of context state. When one compressed, the others didn't know.

### Specific Failed Approaches
1. **4-phase progressive compaction** at 35/50/65/80% thresholds — DESTROYED the KV cache every time it ran. node-llama-cpp's KV cache depends on conversation sequence being stable. Compaction rewrote the sequence, invalidating the entire cache, forcing full reprocessing.
2. **Gibberish detection** — regex/heuristic to detect when model output "degenerate" tokens. Band-aid that masked model confusion caused by KV cache corruption.
3. **ChatML wrapper forcing** — manual injection of `<|im_start|>` and `<|im_end|>` tokens into prompts. Conflicted with node-llama-cpp's own chat wrapping. Double-wrapped messages confused models.
4. **Aggressive tool JSON stripping** — stripped ALL JSON-looking content from model output before processing. Sometimes stripped legitimate model prose that contained JSON examples.
5. **Model-specific temperature overrides** — hardcoded temperature values per model family. Violated the hardware-agnostic principle. Different quantizations of the same model needed different temperatures.
6. **Proactive rotation at 70% context** — triggered context compression before the context was actually full. Preempted the native context shift strategy, which should run only when the context is genuinely full. Caused unnecessary compressions that degraded quality.

### Documentation Found
- PIPELINE_AUDIT.md — audit of the pipeline architecture
- CONTEXT_MANAGEMENT_OVERHAUL.md — plans for fixing context management (never completed)
- LLAMACHAT_MIGRATION_ISSUES.md — issues migrating to LlamaChat API
- FIXES_Applied.md — history of attempted fixes
- PIPELINE_AUDIT_RESULTS.md — audit findings
- 326_DEFECTS.md — defect tracker
- MUSTFIXBUGS315.md — critical bugs

---

## CODEBASE 2: guide-2.0 (C:\Users\brend\guide-2.0)

### The Complete Patch History (R19 through R58p + v2.2.0-v2.3.13)

58+ patch rounds. 4,579-line CHANGES_LOG. This section catalogs EVERY significant failed approach.

### BAND-AIDS — All Tried, All Failed

#### 13 Counters (all removed in the Great Rewrite, some re-added later)
1. `consecutiveStuckCount` — counted repeated identical tool calls. Never reached threshold because model varied parameters slightly.
2. `consecutiveTodoOnlyIters` — counted iterations with only write_todos calls. Throttled at 3. Model just used different tool names.
3. `d6ConsecutiveSmallAppends` — counted small append operations. Terminated after N. Killed legitimate small appends (CSS, closing tags).
4. `emptyResponseCount` — counted empty model responses. Model sometimes legitimately produced empty responses between tool calls.
5. `overallIterCount` — global iteration counter with hard limit. Killed legitimate long generations.
6. `structuralRetryCount` — counted structural retries. Arbitrary limit.
7. `itersSinceLastProgress` — counted iterations without "progress" (subjectively defined). Unreliable metric.
8. `sameToolCallCount` — similar to #1. Different variable, same failure.
9. `waveLengthCounter` — tracked "wave" lengths in generation. Over-engineered signal processing on text output.
10. `forcedCompleteCount` — counted how many times force-complete was invoked. Band-aid counting band-aids.
11. `retryBudget` — limited total retries. Arbitrary number. Sometimes too high (wasted time), sometimes too low (killed valid work).
12. `toolCallBudget` — limited total tool calls per session. Violated by legitimate multi-file operations.
13. `stutterCount` — counted "stuttering" (model outputting same tokens repeatedly). Confused with legitimate repetition in HTML/CSS.

#### 13 Detection Mechanisms (all removed, some re-added)
1. **Stuck loop detector** — detected when model was "stuck" (subjective). Threshold-based. Never agreed with reality.
2. **Cycle detection** — detected repetitive patterns in tool call sequences. Too many false positives.
3. **Todo loop detector** — detected write_todos spam. The real fix was better continuation messages.
4. **Force-complete system** — declared files "complete" based on heuristics. Users got broken files.
5. **Stutter detection** — regex-based detection of repeated token sequences. Killed legitimate CSS/HTML.
6. **Wasted iteration detection** — subjective assessment of "useful" vs "wasted" work.
7. **Give-up regex** — detected when model said "I'll stop here" or similar. The real fix was preventing the model from wanting to stop.
8. **Restart detection** — detected when model restarted a file from scratch. The real fix was a proper symbol inventory.
9. **Duplication detection (RC4)** — scanned files for duplicate sections. Post-hoc checker on a problem that should be prevented upstream.
10. **Content-type classifier (looksLikeCode/looksLikeProse)** — keyword/regex classification of model output as "code" or "prose". Fundamentally unreliable. Replaced by state-based routing in R38.
11. **Raw JSON dump detector** — detected when JSON was leaking into file content. The real fix was clean streaming separation.
12. **Escaped-quote detector** — detected `\"` sequences in file content. Addressed by proper JSON parsing, not detection.
13. **Deduplication function (_deduplicateContentKey)** — removed duplicate `"content"` keys from JSON. Post-hoc sanitizer that should never have been needed.

### ARCHITECTURAL MISTAKES — guide-2.0

#### Mistake 1: The 2,593-Line Agentic Loop
- agenticLoop.js grew from ~500 lines to 2,593 lines over 58+ patches.
- 292 named patch annotations (R19-Fix-A through R58p-Fix-Whatever).
- Every fix was annotated inline: `// R38-Fix-C: 5 retries for structural completion`.
- The file had 32 different `nextUserMessage = ...` assignments, each building continuation messages differently.
- A complete rewrite (Great Rewrite) reduced it to 1,113 lines by removing all 13 counters and 13 detectors. Within 10 sessions it was growing back.

#### Mistake 2: Continuation Message Chaos
- 32 different code paths that built continuation messages.
- Some paths included head+tail+symbols+instructions. Some included nothing.
- Model behavior varied wildly depending on which path fired.
- Fix: unified continuation message builder (ONE function). But this was implemented late and the old paths kept leaking back.

#### Mistake 3: Template-Based Summarization (ConversationSummarizer)
- conversationSummarizer.js generated template-based summaries of dropped conversation turns.
- Quality was inconsistent — sometimes too verbose, sometimes missing critical context.
- Competed with the rolling summary (rollingSummary.js) for what the model remembered.
- Eventually removed as redundant.

#### Mistake 4: Content Inspection During Eviction
- When context items were evicted (shifted out), the strategy parsed their content looking for embedded JSON, file paths, tool results.
- This meant the eviction strategy was deeply coupled to the content format.
- Any change in how tools reported results required changing the eviction logic.
- Fix: eviction should be format-agnostic. Just evict oldest items. Let continuation messages provide what the model needs.

#### Mistake 5: Chat Wrapper Disasters (R52-R54)
- Auto-resolved QwenChatWrapper worked. Someone replaced it with JinjaTemplateChatWrapper.
- Result: model entered an infinite write_todos loop (60 calls in 75 iterations).
- Root cause: wrong chat wrapper changed the model's perception of conversation structure.
- Fix: reverted to auto-resolved wrapper. Lesson: NEVER manually specify chat wrappers.

#### Mistake 6: KV Cache Bugs (R55-R57)
- cancelGeneration() unconditionally cleared `lastEvaluation`, destroying KV cache reuse.
- KV reuse was always `false` because the flag was checked before it was set.
- Cooldown timer was set before handler ran, not after.
- These three bugs meant every generation started from scratch — negating the entire point of KV caching.

#### Mistake 7: Timeout-Based Fixes
- 120-second generation timeout — killed legitimate generations before context shift could fire.
- 30-minute WebSocket timeout — connections dropped during long operations.
- 30-minute wall clock deadline — same as above but worse.
- All removed. Timeouts mask bugs. If generation stalls, the stall is the bug.

#### Mistake 8: Checkpoint Corruption Cascade (R31-R32)
- `rotationCheckpoint` held pre-rotation state but got corrupted by multiple writers.
- Three separate checkpoint corruption bugs were found and fixed.
- Pre-execution duplicate blocking was needed to prevent the same tool call from executing twice.
- Root cause: shared mutable state accessed by multiple async operations.

#### Mistake 9: Finalize/Suspense Ordering (R42-R44)
- `resolveSuspense()` and `finalize()` ran in wrong order.
- Result: naked code leaked into chat, streaming code blocks disappeared, React Error #185 crashed the UI.
- StreamingErrorBoundary (React error boundary) had to be added as a safety net.
- Root cause: async event ordering was not deterministic. Events fired in different order depending on timing.

#### Mistake 10: Quote Toggle Mistrack (R58o)
- String boundary tracking failed on HTML attributes containing escaped quotes.
- `\"<div class=\\"container\\">\"` — the toggle lost track of which quotes were string delimiters vs content.
- Result: parser thought it was inside a string when it wasn't (or vice versa), corrupting JSON extraction.

### SPECIFIC BUG RECURRENCES

#### Naked Code in Chat — "Fixed" 6+ Times
- R58i: context shift boundary handler reset caused it
- R58j: streaming state not restored after shift
- R58k: anti-closing instruction created infinite loop, tokens leaked
- R58l: 80% threshold wrong (contamination happened at 59.5%)
- R58m: tool-use instruction missing after shift
- R58n: still happening — model didn't know to use tool calls

Each fix closed ONE path but left others open. The symptom recurred because there were multiple independent root causes, and each patch addressed only one.

#### Content Duplication — "Fixed" 8+ Times
Every fix improved the continuation message slightly. The duplication reduced but never went away because the model's attention pattern after context shift inherently biased toward regenerating content it could no longer see.

#### Infinite Loops — "Fixed" 10+ Times
Counters, throttles, force-complete — all band-aids. The root causes were:
- Anti-closing instruction + completeness check = logical contradiction (told not to close, then checked if closed)
- Multiple retry paths cascading (one failure triggered 3 different retry mechanisms)
- No upper bound on completeness checks (fired after every tool call, forever)

#### JSON Parse Failures — "Fixed" 5+ Times
Parser grew from simple JSON.parse to 400-line recovery system with 6 fallback strategies. Each fallback introduced edge cases that required the next fallback.

### THE TIMELINE OF REGRESSION

| Range | What Happened |
|-------|---------------|
| R19 | StreamHandler rewrite. Separate file content events. |
| R20-R21 | **HIGH POINT**. 674-line file. 6 context rotations. File completed. |
| R22-R24 | 18 changes. Net regression. MASS REVERT to R21 baseline. |
| R25-R28 | Stress tests. Structural fixes. Escaped-quote regex. |
| R29 | New regexHelpers.js for systematic escaped-quote handling. |
| R30 | Inter-iteration context shift fix. |
| R31-R32 | Rotation checkpoint corruption cascade (3 checkpoint fixes). |
| R33-R34 | 8 UI/tool defects. Code block stabilization. Show More fix. |
| R35-R37 | Post-context-shift decision fix. Streaming defects. |
| R38 | State-based routing replaces keyword heuristics. |
| R39-R41 | 9 defect fixes. Pipeline bugs. Stress test (10 tests). |
| R42-R44 | Naked code leak. React Error #185. Scroll reset. |
| R45-R48 | ThinkingBlock. Carbon theme. Band-aid purge then re-accumulation. |
| R49-R51 | 8-issue bug fix sessions. Model loading. Mode switching. |
| R52-R54 | Chat wrapper disaster (write_todos loop). Stuck loops. Web search. |
| R55-R58 | File explorer. KV cache bugs. Streaming bleed. Web mode. |
| R58a-R58p | The final descent. Each fix created new bugs. |

### FEATURE SYSTEMS THAT WORKED (but are not pipeline)

These were implemented successfully and are not part of the pipeline failure:
- IPC architecture conversion (Phase 4) — electron-main.js 1144 lines, new preload.js
- Extension system (extensionManager.js)
- Debug system (debugService.js)
- RAG engine (ragEngine.js)
- Account/license system (accountManager.js, licenseManager.js)
- Settings manager with AES-256-GCM encrypted API keys
- Git manager (gitManager.js)
- Browser manager (browserManager.js)
- Auto-updater (autoUpdater.js)
- First-run setup (firstRunSetup.js)
- App menu (appMenu.js)
- Web search (webSearch.js)
- Model detection and profiles
- Tool server (mcpToolServer.js)

---

## CODEBASE 3: guide-3.0 with KoboldCpp (C:\Users\brend\guide-3.0 — first iteration)

### The KoboldCpp Experiment
- Replaced node-llama-cpp with KoboldCpp HTTP API.
- chatEngine.js (~500 lines) as the entire backend — much simpler.
- Context shifting worked between API calls (multi-turn shifting via KoboldCpp's internal mechanism).

### Why KoboldCpp Was Discarded
- **Cannot shift mid-generation.** Each `/api/v1/generate` call has a hard cap of `contextSize - promptTokens` for max_length.
- `max_tokens=-1` (or equivalent) is silently ignored — there is no "generate until context is full" mode.
- Context shifting only fires between calls, not within a single generation.
- This means a model with 8000 context and 3000 prompt tokens can generate at most ~5000 tokens per call. If the file is longer than that, the model must stop, and a new call must be made with a continuation prompt. But the continuation prompt itself eats into the budget, creating diminishing returns.
- **This is fundamentally incompatible with the goal of unlimited generation.** The core requirement is that the model generates until context fills, then shifts, then CONTINUES from where it was — all without stopping. KoboldCpp cannot do this.

### What Was Learned
- The HTTP API approach IS simpler to reason about — request/response instead of streaming callbacks.
- The frontend (React + Vite + Zustand) is solid and can be kept.
- The tool server works and can be kept.
- The chatEngine.js approach of a single slim backend file is the right direction — just with the wrong inference backend.

---

## THE META-FAILURE: THE FIX-TEST-FIX DEATH SPIRAL

### The Pattern (occurred 57+ times)
1. Bug found in testing
2. Root cause "identified" (often wrong — only one indicator traced)
3. Fix implemented
4. Fix creates 1-2 new bugs
5. New bugs found in testing
6. Go to step 2
7. After 3-4 cycles, codebase has layers of patches addressing patches

### Why It Happened
- Fixes applied without understanding the full call chain.
- "Root cause" declared from a single log line instead of tracing the entire pipeline.
- Fixes tested against the specific test that revealed the bug, not general usage.
- Band-aids accepted because they made the immediate test pass.
- No architectural review before coding.

### How to Prevent It
- **Research first.** Understand the problem domain thoroughly.
- **Design first.** Create the architecture on paper. Find edge cases before they become bugs.
- **If a fix creates new bugs, the architecture is wrong.** Don't patch. Redesign.
- **Zero tolerance for fix loops.** If you're on your second fix for the same system, stop and redesign from scratch.

---

## THE RULES DERIVED FROM ALL FAILURES

1. ONE context management system. Not two. Not three. ONE.
2. ONE continuation message builder function. Not 32 paths.
3. NO band-aids. If it detects a problem after it happens, it's wrong.
4. NO counters, throttles, or force-complete. If you need them, the architecture is wrong.
5. NO keyword/regex classification of model output (code vs prose). State-based routing only.
6. NO content inspection during eviction. Eviction is format-agnostic.
7. NO template-based summarization competing with rolling summary.
8. NO timeout-based fixes. Timeouts mask bugs.
9. NO manual chat wrapper specification. Use auto-resolved.
10. NO shared mutable state between async operations without explicit synchronization.
11. CLEAR KV cache after write tools. Always.
12. INSTRUCTIONS first, code last in continuation messages. Always.
13. SYMBOL INVENTORY in every continuation message after context rotation.
14. HEAD + TAIL of file content (not just tail).
15. SEPARATE streaming accumulator from JSON generation record.
16. If a fix doesn't work in ONE try, the DESIGN is wrong. Stop patching.
