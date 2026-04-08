# DON'T DO THIS — Past Failures from guide-2.0

> **Read this ENTIRE file before suggesting ANY pipeline approach.**
> If your suggestion resembles ANYTHING in this file, you must explicitly justify why your approach is different.

---

## WHY THIS FILE EXISTS

guIDE 2.0 spent **2 months** in a fix-test-fix loop on the context management pipeline. Over **57 patch cycles** were attempted. Every cycle followed the same pattern: "implement fix -> claim it works -> test -> same bugs -> repeat." This file documents what was tried and why it failed, so the same mistakes are never repeated.

The old pipeline was **10 files, 5,000+ lines** of code for what should be a straightforward problem. It was over-engineered, under-tested, and every fix introduced new bugs.

---

## THE FUNDAMENTAL PROBLEM

The pipeline had **three competing systems** that operated on different views of context state:
1. `contextManager.js` — 4-phase progressive compaction (DESTROYED the KV cache)
2. Proactive rotation at 70% context (PREEMPTED the native context shift strategy)
3. `nativeContextStrategy.js` — node-llama-cpp's built-in context shift hook

These three systems fought each other. When one compressed context, the others didn't know. When one cleared the KV cache, the others expected it to still be valid. The architecture was fundamentally broken because **three independent systems tried to manage the same resource without coordination.**

---

## CATEGORY 1: BAND-AID FIXES (The Most Common Failure Mode)

### What Is a Band-Aid?
A band-aid addresses what happens AFTER a problem occurs instead of preventing the problem. Every single one of these was tried. Every single one failed to solve the root cause.

### Band-Aids That Were Tried and Failed:

1. **Stuck detection counter** — Counted how many times the model repeated the same tool call. After N repetitions, force-terminated. **WHY IT FAILED:** The model varied parameters slightly between calls, resetting the counter. The counter never reached the threshold. Even when it did, it just killed the generation — it didn't fix WHY the model was stuck.

2. **Wasted iteration counter** — Counted iterations where the model produced no useful output. Force-terminated after 8. **WHY IT FAILED:** Same problem — addressed the symptom (too many iterations) not the cause (model doesn't know what to do next).

3. **Todo spam throttle** — Model called `write_todos` 60 times in 75 iterations. Added a hard limit of 3 calls. **WHY IT FAILED:** The model called write_todos because the continuation message said "Continue with the task" with no specific direction. Throttling the symptom didn't fix the vague continuation message.

4. **Duplicate section detection (RC4)** — Before any `append_to_file`, checked if the first 2-3 lines already existed in the file. Blocked duplicates. **WHY IT FAILED:** The model duplicated content because it couldn't see what was already in the file after context rotation. The detection was a post-hoc guard. The fix was giving the model a symbol inventory.

5. **Content deduplication in JSON parser** — When the model produced duplicate `"content"` keys in JSON, kept the first non-empty one. **WHY IT FAILED:** The model produced duplicate keys because of confused generation state after context shift. Fixing the JSON parser didn't fix the confused model.

6. **Write_file to append_to_file silent conversion** — When model called `write_file` on an existing file, silently converted to `append_to_file`. **WHY IT FAILED:** The model called `write_file` because it didn't know the file already existed. Silent conversion masked the information gap.

7. **JSON artifact cleanup regexes** — 15+ regex patterns to strip JSON fragments from file content. **WHY IT FAILED:** The artifacts appeared because of KV cache contamination. Stripping artifacts after they appeared didn't prevent the contamination.

8. **Anti-closing instruction** — Told the model "do NOT write final closing tags." **WHY IT FAILED:** Created an infinite loop — the pipeline told the model not to close tags, then checked if tags were closed, found they weren't, told the model to keep writing, repeat forever.

9. **Context shift boundary handler** — Reset streaming state on context shift. **WHY IT FAILED:** Resetting `_holdingToolCall = false` caused post-shift tokens to leak as naked code in the chat UI. The cure was worse than the disease.

10. **Generation timeout (30 minutes)** — Kill generation after 30 minutes. **WHY IT FAILED:** Legitimate long generations need more than 30 minutes. The timeout killed valid work. And it fired 15 seconds before context rotation would have naturally triggered.

11. **Retry guards (structuralRetryDone, toolLessRetryDone)** — Boolean flags that allowed ONE retry, then gave up. **WHY IT FAILED:** One retry is arbitrary. Sometimes the model needs 2-3 retries. Sometimes it needs 0. The real fix was the false-positive tool call recovery (R51-Fix) which eliminated most retry scenarios entirely.

12. **Force-complete system** — After N iterations, force the file to be "complete" regardless of state. **WHY IT FAILED:** An incomplete file is still incomplete regardless of what the pipeline declares. Users got broken files.

13. **Keyword/regex classifiers** — Detected specific user phrasings to trigger special behavior. **WHY IT FAILED:** Only worked for the specific test prompts. Real users type differently. Violated the "changes must be general" rule.

---

## CATEGORY 2: ARCHITECTURAL MISTAKES

### Mistake 1: Multiple Competing Context Management Systems
Three systems (contextManager.js, proactive rotation, nativeContextStrategy.js) all tried to manage context independently. They had different triggers, different compression strategies, and different views of what was in context. Fix in one broke the others.

**LESSON:** There must be ONE system that manages context. Not two. Not three. ONE.

### Mistake 2: 2,593-Line Agentic Loop
The main orchestration file grew to 2,593 lines with 292 named patches, 13 detection mechanisms, and 13 counters. It was unreadable, unmaintainable, and every change had unpredictable cascading effects.

**LESSON:** If the orchestration logic can't fit in your head, the design is wrong. Simplify.

### Mistake 3: KV Cache Contamination
After write_file tool execution, the model's KV cache still carried "writing HTML content" attention patterns. Reusing this cache for the next iteration caused the model to output raw HTML instead of tool calls. The fix (clearing KV after write tools) worked but was discovered only after weeks of debugging.

**LESSON:** Understand KV cache semantics. After tool execution, the model's internal state may be contaminated. Design for this from the start.

### Mistake 4: No Symbol Inventory After Context Rotation
After context rotation, the model lost knowledge of what functions/classes/components were already defined in the file. It re-implemented everything from scratch. Multiple fixes (extractDefinedSymbols, structured continuation messages) were needed over 5+ patch cycles.

**LESSON:** After any context compression, explicitly tell the model what already exists. Don't assume it will figure it out from a 30-line tail snippet.

### Mistake 5: Continuation Messages Were Inconsistent
32 different `nextUserMessage` assignments across the codebase, each building messages with different amounts of context. Some had head+tail+symbols, most had nothing. The model received wildly different guidance depending on which continuation path fired.

**LESSON:** ONE function builds ALL continuation messages. Every continuation provides the same baseline context.

### Mistake 6: Streaming Content Accumulated in Wrong Place
The stream handler accumulated content in `_toolCallJson`, which got corrupted by post-context-shift tokens. Content extraction re-parsed from corrupted JSON. A separate `_streamedContentAccumulator` had to be added to capture clean content.

**LESSON:** Separate the "what was streamed to the UI" record from the "what the model generated as JSON" record. They are different data streams.

### Mistake 7: Testing After Every Fix Instead of Getting It Right First
Every fix was tested immediately, found wanting, and another fix was attempted. This created a chain of patches-on-patches where each fix addressed the previous fix's regression. The codebase became a geological record of failed attempts.

**LESSON:** Get the architecture right through research and design BEFORE writing code. Test the architecture, not individual patches.

---

## CATEGORY 3: SPECIFIC BUG PATTERNS THAT KEPT RECURRING

### Bug: Naked Code in Chat
Model output appeared as raw code in the chat UI instead of inside a file block. Occurred because:
- KV cache contamination after write tools (model continued writing HTML from stale KV state)
- Context shift reset streaming state (tokens leaked as `llm-token` events)
- Missing tool-use instruction after context shift (model didn't know to use tool calls)

**How many times this was "fixed":** 6+ times across R58i, R58j, R58k, R58l, R58m, R58n. Each fix addressed one cause but not the others.

### Bug: Content Duplication
Model re-implemented already-existing functions/sections after context rotation. Occurred because:
- No symbol inventory was provided after rotation
- Continuation messages only showed the tail of the file
- Session state (what was already built) was lost during rotation

**How many times this was "fixed":** 8+ times. Each fix improved the continuation message slightly. The real fix was a unified continuation message builder with mandatory symbol inventory.

### Bug: Infinite Loops
Model entered infinite retry/append loops. Occurred because:
- Anti-closing instruction + structural completeness check = logical contradiction
- Retry mechanisms had no upper bound
- Multiple retry paths cascaded (one failure triggered 3 different retry mechanisms)
- Completeness checks had no counter (fired after every tool call)

**How many times this was "fixed":** 10+ times. Counters, throttles, and force-complete systems were all band-aids. The root cause was the retry cascade and contradictory instructions.

### Bug: JSON Parse Failures
Model-generated JSON couldn't be parsed. Occurred because:
- HTML attributes with unescaped quotes inside JSON content values
- Template literals with literal newlines inside JSON strings  
- Duplicate `"content"` keys (V8 takes the last one, which was empty)
- Nested JSON objects too complex for regex-based extraction

**How many times this was "fixed":** 5+ times. Each fix added another fallback to the parser. The parser grew from a simple JSON.parse to a 400-line recovery system with 6 fallback strategies.

### Bug: Early Termination
Model stopped generating before the file was complete. Occurred because:
- Continuation message was too short (200 chars instead of 1200)
- No explicit tool-use directive when todo list was empty
- Model defaulted to planning text + EOS instead of tool calls
- Timeout killed generation before context rotation could fire

### Bug: Instruction Echo
Pipeline instructions ("Do NOT use write_file", "Your response must be ONLY the append_to_file tool call") appeared verbatim in the generated file content. Occurred because instructions were placed at the END of the continuation message, and the model's next output started by echoing them.

**Fix that worked:** Put instructions FIRST, code LAST. LLM attention is most influenced by the end of the prompt. Ending with code = code output. Ending with instructions = instruction echo.

---

## CATEGORY 4: THE FIX-TEST-FIX DEATH SPIRAL

### The Pattern
1. Bug found in testing
2. Root cause identified (often incorrectly — only one indicator)
3. Fix implemented
4. Fix creates 1-2 new bugs
5. New bugs found in testing
6. Go to step 2
7. After 3-4 cycles, the codebase has layers of patches addressing patches

### Why It Happened
- Fixes were applied without understanding the full call chain
- "Root cause" was declared from a single log line instead of tracing the entire pipeline
- Fixes were tested against the specific test that revealed the bug, not against general usage
- Band-aids were accepted as fixes because they made the immediate test pass
- No architectural review before coding — just "see problem, write fix"

### How to Prevent It
- **Research first.** Understand the problem domain thoroughly before writing any code.
- **Design first.** Create the architecture on paper. Review it. Find edge cases before they become bugs.
- **Test comprehensively.** Don't just test the scenario that revealed the bug. Test ALL scenarios.
- **If a fix creates new bugs, the architecture is wrong.** Don't patch. Redesign.
- **Zero tolerance for fix loops.** If you're on your second fix for the same system, stop and redesign from scratch.

---

## CATEGORY 5: WHAT ACTUALLY WORKED

Despite all the failures, some approaches DID work and should be carried forward:

1. **Native context shift hook (node-llama-cpp's contextShift.strategy)** — Using the built-in hook instead of manual context management was the correct architectural decision. The implementation had bugs, but the approach is sound.

2. **Unified continuation message builder** — ONE function that builds ALL continuation messages with consistent context (symbols, head/tail, nesting state). This eliminated the inconsistency problem.

3. **Symbol inventory (extractDefinedSymbols)** — Explicitly telling the model what functions/classes/sections already exist. This dramatically reduced duplication.

4. **Stream content accumulator** — Separating "what was shown to the user" from "what the model generated as JSON." Clean separation prevented corruption from leaking into files.

5. **Clear KV cache after write tools** — Preventing stale attention patterns from contaminating the next generation. Simple, effective, correct.

6. **Instructions first, code last** — In continuation messages, placing behavioral instructions at the beginning and file content at the end. The model continues from the last thing it sees.

7. **False-positive tool call recovery** — When JSON.parse fails but the stream handler successfully identified the tool during streaming, use the stream handler's data instead of retrying.

---

## THE TAKEAWAY

The pipeline failed because it was **over-engineered from the start** and then **patched repeatedly instead of redesigned.** The problem (context fills up -> compress history -> model continues) is fundamentally simple. The solution should be simple too.

**If you're about to build the pipeline:**
1. Can you explain the entire design in 5 sentences? If not, it's too complex.
2. Does each component have exactly ONE job? If not, split or merge.
3. Can you trace any token from generation to file output through fewer than 3 functions? If not, simplify.
4. Does fixing one edge case require changing more than one file? If so, the abstraction boundaries are wrong.
5. After your first test, did ANY bug require a band-aid? If so, stop and redesign. DO NOT add the band-aid.
