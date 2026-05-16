# guIDE Section 16 Audit & Remediation Plan
**Document:** 516-plan.md  
**Scope:** 25 identified band-aids / artificial injections / over-engineered mechanisms  
**Files affected:** chatEngine.js, toolParser.js, browserManager.js, settingsManager.js  
**Created:** v0.3.56 audit session  
**Rule basis:** RULES.md Sections 4, 9, 11, 15, 16  

---

## EXECUTIVE SUMMARY

This document inventories 25 code locations across 3 core files that violate RULES.md Section 4 (No Band-Aids) and/or Section 15 (No Over-Engineering). Each item is classified as **REMOVE**, **REPLACE**, or **KEEP**, with:
- Exact file path and line range
- Current code (verbatim)
- Why it was originally implemented (root bug it addressed)
- Why it is now classified as a band-aid or over-engineering
- Section 16 plan (WHAT / WHERE / WHEN / WHY / HOW / EDGE CASES / FALSE POSITIVES / BAND-AID CHECK / PRODUCTION CHECK / AI PERSPECTIVE)

---

## PHASE 1 — REMOVE ARTIFICIAL INJECTIONS & LIMITERS
**Priority:** Highest  
**Risk:** Low  
**User approval:** A1 ✅, A2 ✅, B1 ✅  
**Pending user decision:** B2 (tentative), B3 (keep for now), B4 (pending)

---

### A1 — Remove Generation Timeout

**Current code:**
```js
@/chatEngine.js:1509-1520
// S3: Generation timeout — abort if model gets stuck (0 = disabled)
const timeoutSec = options.generationTimeoutSec ?? 0;
let generationTimer = null;
if (timeoutSec > 0) {
  generationTimer = setTimeout(() => {
    console.warn(`[ChatEngine] Generation timeout (${timeoutSec}s) — aborting`);
    this._abortController.abort();
  }, timeoutSec * 1000);
}

let result = await this._chat.generateResponse(this._chatHistory, genOptions);
if (generationTimer) clearTimeout(generationTimer);
```

**Why it was implemented:**  
When Llama.cpp stalls (e.g., context full, KV cache corruption, model load failure), the generateResponse promise never resolves. Users had no way to cancel. The timeout was added as an emergency abort.

**Why it is a band-aid:**  
RULES.md Section 4 explicitly bans "Adding a timeout to mask a stall instead of fixing the stall." The stall is a bug in context management, model loading, or KV cache state. Killing the generation hides the bug from the user and from diagnostics. Default is already 0 (disabled), meaning this code is dead weight that complicates the inference path.

**Section 16 Plan:**
```
PLAN: Remove generation timeout mechanism
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/chatEngine.js
  - Function: _generateResponse
  - Line range: 1509-1517 (setup), 1520 (cleanup)
  - What changes: Delete setTimeout abort and clearTimeout cleanup

WHAT: Remove the generation timeout abort completely.
WHERE: chatEngine.js, _generateResponse, lines 1509-1520
WHEN: Per inference request
WHY: Timeout masks stalls instead of fixing why they occur. RULES.md §4 bans this.
HOW: Delete lines 1509-1517 (the setTimeout block) and line 1520 (clearTimeout). 
      Keep the generateResponse call at line 1519.

EDGE CASES:
  - Stall without timeout: User cancels manually. The stall must be fixed at source.
  - Long generation: Valid multi-minute generation should not be killed.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? N/A (removing code)
  - Could this block a legitimate action? N/A (removing code)

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? N/A
  - Or does this PREVENT the problem from occurring? Removing the band-aid.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes — removing dead band-aid code.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes — timeouts as stall masks are amateur.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions? 
    Yes — I would no longer have valid generation killed by an arbitrary timer.
  - Would I understand why my tool call was blocked/modified? Yes — timeout no longer exists.
```

---

### A2 — Remove Max Iteration Cap

**Current code:**
```js
@/chatEngine.js:1562-1563
// S2: maxIterations caps the loop when set (>0); 0 = unlimited (context bounds naturally)
const maxIterations = (options.maxIterations > 0) ? options.maxIterations : Infinity;

@/chatEngine.js:1604-1605
console.log(`[ChatEngine] Tool loop ENTER: ... maxIterations=${maxIterations === Infinity ? 'unlimited' : maxIterations}`);
while (parsedCalls.length > 0 && this._toolRoundCount < maxIterations) {

@/chatEngine.js:2126-2138
// S2: If we hit the iteration cap, notify the model so it can summarize
if (this._toolRoundCount >= maxIterations && parsedCalls.length > 0) {
  console.warn(`[ChatEngine] Max iterations (${maxIterations}) reached — ${parsedCalls.length} tool call(s) still pending`);
  this._chatHistory.push({ type: 'user', text: `[System: Max iterations (${maxIterations}) reached. Summarize what you've accomplished and what remains. Do NOT attempt more tool calls.]` });
  // Generate one final summary response
  const ctxUsedNow = this._sequence?.nextTokenIndex || 0;
  genOptions.maxTokens = Math.max(MIN_GENERATION_TOKENS, contextSize - ctxUsedNow);
  try {
    result = await this._chat.generateResponse(this._chatHistory, genOptions);
    fullResponse += result.response || '';
    if (onStreamEvent) onStreamEvent('llm-token', result.response || '');
  } catch (_) {}
}
```

**Why it was implemented:**  
When the model enters an infinite tool loop (e.g., browser_navigate → browser_click → browser_navigate → ...), the loop never exits. The cap was added to force termination and generate a summary.

**Why it is a band-aid:**  
RULES.md Section 4: "Adding a retry count to cap an infinite loop instead of fixing why it loops." If the model loops infinitely, the cause is either: (1) prompt ambiguity, (2) tool result confusion, (3) lack of clear task completion signal. Capping iterations prevents the model from completing legitimate multi-step tasks. The user confirmed they hit this cap in normal use (value = 25).

**Section 16 Plan:**
```
PLAN: Remove max iteration cap
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/chatEngine.js
  - Function: _handleTurn
  - Line range: 1562-1563 (declaration), 1604-1605 (while condition), 2126-2138 (cap handler)
  - What changes: Delete maxIterations variable, replace while condition, delete cap handler

WHAT: Remove the max iteration cap handler entirely.
WHERE: chatEngine.js, _handleTurn, lines 1562-1563, 1604-1605, 2126-2138
WHEN: Per tool round
WHY: Capping iterations prevents multi-step task completion. The loop design is wrong if it needs a cap.
HOW:
  1. Delete line 1562-1563: const maxIterations = ...
  2. Replace line 1605: while (parsedCalls.length > 0 && this._toolRoundCount < maxIterations)
     → while (parsedCalls.length > 0)
  3. Delete lines 2126-2138 entirely (the cap handler block).
  4. Optionally remove the maxIterations setting from settingsManager.js DEFAULTS 
     (settingsManager.js line 33: maxIterations: 0).

EDGE CASES:
  - Infinite loop: User cancels. Fix via better prompt/tool result clarity.
  - Very long tasks: Tasks needing many steps should continue freely.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? N/A (removing code)
  - Could this block a legitimate action? N/A (removing code)

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? N/A
  - Or does this PREVENT the problem from occurring? Removing the band-aid.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — I could complete multi-step tasks without an arbitrary cap forcing me to stop.
  - Would I understand why my tool call was blocked/modified? Yes — no more cap.
```

---

### B1 — Remove samePageWarning Injection

**Current code:**
```js
@/chatEngine.js:1695-1703
// Detect same-page navigation — when browser_navigate lands on the same URL
if (call.tool === 'browser_navigate' && toolResult?.samePage) {
  console.warn(`[ChatEngine] browser_navigate landed on same page: ${toolResult.url}`);
  // Inject anti-loop directive into the result so the model sees it
  const samePageWarning = `\n[SYSTEM: You are ALREADY on this page (${toolResult.url}). Do NOT navigate to this URL again — it will land on the same page. Use browser_snapshot, browser_click, or browser_type to interact with the current page instead.]`;
  if (typeof toolResult === 'object' && toolResult.snapshot) {
    toolResult.snapshot = (toolResult.snapshot || '') + samePageWarning;
  }
}
```

**Why it was implemented:**  
The model would repeatedly call browser_navigate to the same URL (e.g., after a failed click, it would re-navigate instead of interacting with the current page). The injection was meant to scold the model into using browser_snapshot or browser_click instead.

**Why it is a band-aid:**  
The detection variables (`samePageWarning`) were already removed in a previous session, but the string injection remains. Instead of teaching the model through prompt clarity, this scolds it after the fact. The user confirmed they just encountered this issue — the injection did NOT prevent the behavior. The correct fix is updating SYSTEM_PROMPT browser workflow instructions.

**Section 16 Plan:**
```
PLAN: Remove samePageWarning injection
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/chatEngine.js
  - Function: _handleTurn
  - Line range: 1695-1703
  - What changes: Delete the samePageWarning injection block

WHAT: Remove the "[SYSTEM: You are ALREADY on this page...]" injection.
WHERE: chatEngine.js, _handleTurn, lines 1695-1703
WHEN: When browser_navigate returns samePage=true
WHY: Scolding the model instead of teaching it via prompt clarity. User confirmed it doesn't work.
HOW: Delete lines 1695-1703 entirely.
      ALSO: Update SYSTEM_PROMPT browser workflow section to add:
      "If you navigate to a URL and land on the same page you were already on, 
       do NOT navigate to that URL again. Instead, use browser_snapshot to see 
       the current page, then use browser_click or browser_type to interact with it."

EDGE CASES:
  - Model repeats navigate: Fix via SYSTEM_PROMPT clarity, not injection.
  - SPA navigation: Same base URL with different hash — handled by browser tool.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? Yes — adds noise to every same-page result.
  - Could this block a legitimate action? No, but it distracts from actual task.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? Yes — injection AFTER repeated navigate.
  - Or does this PREVENT the problem from occurring? No. Redesign: improve SYSTEM_PROMPT.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? No — removing a band-aid.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — I would not be scolded for navigation choices.
  - Would I understand why my tool call was blocked/modified? Yes — no more mysterious injections.
```

---

### B2 — Remove Recently-Written File Content Injection
**User status:** Tentatively approved pending clarification

**Current code:**
```js
@/chatEngine.js:1660-1693
// Track recently-written files so we can inject content on run_command failure.
// Root cause of write_file loop: _writeFile returns {success:true} with NO content.
// After run_command SyntaxError, model has zero visibility into actual file content
// and re-writes identical broken code. Injecting the content closes the information gap.
if (FILE_WRITE_OPS.has(call.tool) && toolResult?.success !== false && call.params?.content) {
  const writtenPath = call.params.filePath || call.params.path || toolResult?.path || '';
  if (writtenPath) {
    this._recentlyWrittenFiles.set(writtenPath, call.params.content);
  }
}
// On run_command failure, check if the command references a recently-written file.
// If so, inject the file's actual content so the model can see what's wrong.
if (call.tool === 'run_command' && toolResult?.success === false && this._recentlyWrittenFiles.size > 0) {
  const cmdStr = (call.params?.command || '').toLowerCase();
  for (const [fp, content] of this._recentlyWrittenFiles) {
    const fileName = fp.split(/[\\/]/).pop() || '';
    if (cmdStr.includes(fileName.toLowerCase()) || cmdStr.includes(fp.toLowerCase().replace(/\\/g, '/'))) {
      const MAX_CONTENT_INJECT = 3000;
      const snippet = content.length > MAX_CONTENT_INJECT
        ? content.slice(0, MAX_CONTENT_INJECT) + '\n... [truncated]'
        : content;
      const inject = `\n\n[SYSTEM: The file "${fileName}" was just written by you and the command failed. Here is the ACTUAL content currently in the file — compare it with what you intended to write]:\n${snippet}`;
      if (typeof toolResult.message === 'string') {
        toolResult.message += inject;
      } else if (typeof toolResult.error === 'string') {
        toolResult.error += inject;
      } else if (typeof toolResult.output === 'string') {
        toolResult.output += inject;
      }
      console.log(`[ChatEngine] Injected recently-written file content for ${fileName} into run_command failure result`);
      break;
    }
  }
}
```

**Why it was implemented:**  
When the model writes a file with `write_file`, the tool returns `{success: true}` but NO file content. If a subsequent `run_command` (e.g., `node index.js`) fails with a SyntaxError, the model cannot see the actual file content in context. It would then rewrite the SAME broken code in a loop. The injection was meant to close this information gap by showing the model what it actually wrote.

**Why it is a band-aid:**  
This creates an artificial content channel that bypasses normal context management. The root cause is that `write_file` tool results don't include the written content, so the model has no memory of what it wrote after context compaction/rotation. The proper fix: (1) include file content in write_file tool results, or (2) ensure context rotation preserves recent file write operations. The injection also has false positives — any run_command failure referencing ANY recently-written file triggers this, even if unrelated.

**Section 16 Plan:**
```
PLAN: Remove recently-written file content injection
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/chatEngine.js
  - Function: _handleTurn
  - Line range: 1660-1693
  - What changes: Delete the injection block and _recentlyWrittenFiles tracking

WHAT: Remove the artificial injection of recently-written file content into run_command failures.
WHERE: chatEngine.js, _handleTurn, lines 1660-1693
WHEN: When run_command returns non-zero exit
WHY: Artificial content channel. Root cause: write_file returns no content; model loses memory after rotation.
HOW:
  1. Delete lines 1660-1693 (the entire injection block).
  2. Delete line 256: this._recentlyWrittenFiles = new Map();
  3. Delete line 611: this._recentlyWrittenFiles.clear();
  4. PROPER FIX (separate task): Ensure write_file tool results include the written 
     content in the result object, so it survives context rotation naturally.

EDGE CASES:
  - Model forgot file content: Fix context rotation to preserve recent writes.
  - Large file injection: Could blow context window.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? Yes — any run_command failure triggers this.
  - Could this block a legitimate action? No, but it pollutes context with potentially unrelated content.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? Yes — injection AFTER run_command failure.
  - Or does this PREVENT the problem from occurring? No. Redesign: fix context retention.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? No — removing a band-aid.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — I would rely on proper context retention instead of mysterious injections.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

### B3 — Remove Lint Auto-Fix Injection
**User status:** KEEP (user explicitly stated they want lint auto-fix)

**Current code:**
```js
@/chatEngine.js:1728-1743
let injectResult = resultStr;
// Lint auto-fix — if any file-modification tool returned diagnostic errors,
// inject a human-readable correction instruction AND emit a frontend event for the UI pill.
if (FILE_MODIFY_OPS_SET.has(call.tool) && toolResult?.diagnostics?.errors > 0 && options.autoLintFix !== false) {
  const { errors, details } = toolResult.diagnostics;
  const detailStr = details?.length ? details.join('; ') : `${errors} error(s)`;
  const filePath = call.params?.filePath || call.params?.path || 'file';
  injectResult += `\n[LINT ERRORS IN ${filePath} — MUST FIX IMMEDIATELY: ${detailStr}. Fix ALL errors before proceeding.]`;
  if (onStreamEvent) {
    onStreamEvent('file-content-lint', {
      filePath,
      diagnostics: toolResult.diagnostics,
    });
  }
  console.log(`[ChatEngine] Lint auto-fix: ${errors} error(s) in ${filePath} — correction injected into tool result`);
}
```

**Why it was implemented:**  
After `write_file` or `edit_file`, if a linter (e.g., ESLint, TypeScript) reports errors, the model might not notice them or might prioritize continuing its task over fixing errors. The injection forces the model to address lint errors immediately.

**Why it is classified as a band-aid:**  
The tool result already contains the diagnostics object. The model can read it and decide whether to fix it. The injection overrides the model's judgment with an artificial directive. However, the user explicitly stated: "if there's lint errors in a file, then you want it to be auto fixed, and that's what that's supposed to do."  
**VERDICT:** KEEP. The user wants this behavior. It is an artificial injection, but the user considers it a feature, not a bug.

---

### B4 — Remove Empty Brace Suppression
**User status:** Pending approval

**Current code:**
```js
@/chatEngine.js:1336-1344
} else {
  // Unconfirmed buffer reached depth 0 — likely stray {} or non-tool JSON
  // Suppress if it looks like a tool call fragment (starts with {, short, no prose)
  const trimmed = _sfBuf.trim();
  if (trimmed.length <= 4 || /^[\{\}\[\]:,.\s\d]+$/.test(trimmed)) {
    // Just punctuation/braces — suppress (this is the empty } bug)
    _sfBuf = '';
  } else {
    _sfFlush();
  }
}
```

**Why it was implemented:**  
The model sometimes emits stray `}` or `{}` tokens that are not part of a valid tool call. These appear in the UI as garbage text. The suppression regex catches and hides them.

**Why it is a band-aid:**  
RULES.md Section 4: "Stripping bad content after generation instead of preventing bad generation." The model emits stray braces because the prompt formatting or context confusion leads it to think it's in a tool call block. The real fix is prompt clarity and SYSTEM_PROMPT formatting rules.

**Section 16 Plan:**
```
PLAN: Remove empty brace suppression
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/chatEngine.js
  - Function: _generateResponse (streaming handler)
  - Line range: 1339-1341
  - What changes: Delete the regex strip, always flush buffer

WHAT: Remove the post-processing strip of stray punctuation/braces.
WHERE: chatEngine.js, streaming token handler, lines 1339-1341
WHEN: Per token during streaming
WHY: Suppresses model output instead of fixing why it emits stray braces.
HOW: Replace lines 1339-1341 with a single `_sfFlush();` call.
      Root cause fix: Add to SYSTEM_PROMPT: "Never emit lone braces `{}` or `[]` 
      outside of a valid tool call JSON block."

EDGE CASES:
  - Model emits stray braces: Observe when/why. Fix root cause.
  - Legitimate JSON fragment: The regex could strip valid but minimal JSON.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? Yes — could suppress valid tool call start.
  - Could this block a legitimate action? Yes — could suppress the start of a valid tool call.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? Yes — strip AFTER generation.
  - Or does this PREVENT the problem from occurring? No. Redesign: fix prompt clarity.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? No — removing a band-aid.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — my output would not be silently edited.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

## PHASE 2 — ARCHITECTURE FIXES (REPLACE BAND-AIDS)
**Priority:** High  
**Risk:** Medium-High  
**User approval:** None yet — pending Phase 1 completion

---

### C1 — Replace Progressive Trimming with Deterministic Budget

**Current code:**
```js
@/chatEngine.js:1445-1494
const MIN_GENERATION_TOKENS = 512;
let promptCompacted = false;
let toolsTrimmed = false;

// ... progressive fallback chain ...
// 1. Compact prompt
// 2. Trim to 4 tools
// 3. Strip history
// 4. Emergency trim
```

**Why it was implemented:**  
When context fills up, there may be zero tokens left for generation, causing the model to hit EOS immediately. The progressive chain was meant to ensure at least MIN_GENERATION_TOKENS of generation space by progressively stripping content.

**Why it is a band-aid:**  
The fallback chain is reactive and crude. It strips different parts of the prompt unpredictably depending on how full context is. The correct approach is to compute the budget BEFORE assembling the prompt, so generation space is ALWAYS guaranteed.

**Section 16 Plan:**
```
PLAN: Replace progressive trimming with deterministic budget
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/chatEngine.js
  - Function: _generateResponse
  - Line range: 1445-1494
  - What changes: Replace progressive fallback chain with single pre-flight check

WHAT: Replace the progressive MIN_GENERATION_TOKENS fallback chain with a single 
      deterministic context budget reservation.
WHERE: chatEngine.js, _generateResponse, lines 1445-1494
WHEN: Per inference request
WHY: The fallback chain (compact prompt → 4 tools → strip history) is reactive and crude.
HOW:
  1. Keep MIN_GENERATION_TOKENS = 512 as a constant.
  2. Remove the progressive fallback chain (the if/else ladder at lines 1445-1494).
  3. In _assemblePrompt, compute estimatedPromptTokens BEFORE building the prompt.
  4. If estimatedPromptTokens + MIN_GENERATION_TOKENS > effectiveContextSize,
     compact/summarize history UNTIL there is space. Do this ONCE, not progressively.
  5. Ensure _contextShiftStrategy runs BEFORE prompt assembly when space is tight.

EDGE CASES:
  - Very long user message: Split or truncate with clear boundary marker.
  - Tool result explosion: Compact before entering context.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? No — deterministic budget check.
  - Could this block a legitimate action? No — ensures space exists before generation.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? No — the old code did. 
    The new code PREVENTS by computing upfront.
  - Or does this PREVENT the problem from occurring? Yes.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — I would always have guaranteed generation space.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

### D1 — Consolidate Tool Parser Recovery

**Current code:**
```js
@/toolParser.js:257-382 (Method 1.1-1.6 regex chain)
@/toolParser.js:507-640 (Fenced-block recovery)
@/toolParser.js:800-814 (_recoverWriteFileContent)
@/toolParser.js:816-838 (_inferFilePath)
@/toolParser.js:841-871 (_detectFallbackFileOperations)
```

**Why it was implemented:**  
Models output tool calls in many formats: fenced JSON, XML, raw JSON, function-call syntax, etc. Some models emit malformed JSON. The parser needed to be robust to handle all these variations.

**Why it is over-engineering:**  
1000 lines of regex fallbacks is excessive. The `_detectFallbackFileOperations` function literally fabricates tool calls from markdown code blocks when the model outputs code as plain text instead of calling tools. This is the #1 recurring failure per system memory ("Tool calling breaks → model outputs code as plain text"). Instead of fixing the root cause (prompt clarity, SYSTEM_PROMPT strength), the parser patches the model's mistakes.

**Section 16 Plan:**
```
PLAN: Consolidate tool parser recovery
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/tools/toolParser.js
  - Function: parse, _extractFencedToolCalls, _recoverWriteFileContent, 
             _inferFilePath, _detectFallbackFileOperations
  - Line range: 257-382, 507-640, 800-871
  - What changes: Replace 7-method regex chain with single unified parser.
                  Remove fallback detectors entirely.

WHAT: Replace the fragmented regex recovery chain with a single unified parser.
      Remove all fallback detectors that fabricate tool calls.
WHERE: toolParser.js, parse function and helpers, lines 257-382, 507-640, 800-871
WHEN: Per model response
WHY: 1000 lines of regex fallbacks hides parser bugs. Fallback detectors fabricate 
      tool calls instead of teaching the model proper format.
HOW:
  1. Keep initial strict parsing (fenced JSON blocks).
  2. Replace Method 1.1–1.6 with ONE recovery function that:
     a. Extracts all fenced JSON blocks
     b. Sanitizes quotes and braces
     c. Attempts JSON.parse
     d. If failing, logs the malformed block for debugging
  3. Delete _detectFallbackFileOperations (lines 841-871).
  4. Delete _recoverWriteFileContent (lines 800-814).
  5. Delete _inferFilePath (lines 816-838).
  6. PROPER FIX (separate): Strengthen SYSTEM_PROMPT tool call examples 
     and add format validation examples.

EDGE CASES:
  - Model outputs malformed JSON: Single recovery function handles it.
  - Model outputs plain text with no tool calls: Parser returns empty array. Correct.
  - Truncated tool call: Detected by unclosed braces in recovery function.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? No — deterministic parse.
  - Could this block a legitimate action? No — if JSON is valid, it parses.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? The old code did.
    The new code removes the fallback detectors.
  - Or does this PREVENT the problem from occurring? Removing detectors forces 
    the root cause (prompt/system) to be fixed.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes — single parser is standard.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing detectors.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — I would receive clear feedback when my tool call format is wrong.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

## PHASE 3 — BROWSER MANAGER CLEANUP
**Priority:** Medium  
**Risk:** Medium  
**User approval:** None yet — pending Phase 1 completion

---

### E1 — Remove Retry Loop in _ensurePage

**Current code:**
```js
@/browserManager.js:235-245
async _ensurePage() {
  if (this._page && !this._page.isClosed()) return true;
  // Page missing — try to recover (browser may have crashed or been closed)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (this._browser) {
      try {
        this._page = await this._browser.newPage();
        return true;
      } catch { /* continue to next attempt */ }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
```

**Why it was implemented:**  
If the browser crashes or the page is closed, the manager tries to recover by creating a new page. The retry loop was meant to handle transient failures.

**Why it is a band-aid:**  
Retry with sleep is a band-aid. If the browser is not ready, fix the startup timing. If the page crashed, report the crash and let the user/browser_tabs handle it.

**Section 16 Plan:**
```
PLAN: Remove retry loop in _ensurePage
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/browserManager.js
  - Function: _ensurePage
  - Line range: 235-245
  - What changes: Delete the 3-attempt retry loop; keep single ensure

WHAT: Remove the retry loop with waitForTimeout from _ensurePage.
WHERE: browserManager.js, _ensurePage, lines 235-245
WHEN: Per browser action
WHY: Retry with sleep is a band-aid. If page is not ready, fix why it's not ready.
HOW: Replace the for loop with a single check:
     if (!this._page || this._page.isClosed()) { return false; }
     return true;

EDGE CASES:
  - Browser still launching: Calling code should handle startup timing.
  - Page crash: Should be detected and reported.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? N/A (removing code)
  - Could this block a legitimate action? N/A

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? N/A
  - Or does this PREVENT the problem from occurring? Removing band-aid.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Indirectly — browser errors would be clearer.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

### E2 — Replace Hardcoded Timeouts with Constants

**Current code:**
```js
@/browserManager.js:133   timeout: 90000  (page.goto)
@/browserManager.js:136   timeout: 15000  (waitForLoadState)
@/browserManager.js:138   await this._page.waitForTimeout(500)
@/browserManager.js:771   timeout: 5000   (frame.click)
@/browserManager.js:821   timeout: 5000   (waitForEvent popup)
@/browserManager.js:822   timeout: 5000   (page.click)
@/browserManager.js:1028  timeout: 5000   (locator.fill)
@/browserManager.js:1055 timeout: 5000   (locator.fill)
@/browserManager.js:1114 timeout: 5000   (selectOption)
@/browserManager.js:1190 timeout: 10000  (waitForSelector)
@/browserManager.js:1216 timeout: 5000   (locator.fill in fillForm)
@/browserManager.js:1221 timeout: 5000   (locator.check)
@/browserManager.js:1223 timeout: 5000   (locator.check radio)
@/browserManager.js:1225 timeout: 5000   (selectOption in fillForm)
@/browserManager.js:1227 timeout: 5000   (locator.fill in fillForm)
@/browserManager.js:1253 timeout: 5000   (dragTo)
```

**Why it was implemented:**  
Playwright actions need timeouts to prevent hanging on slow sites or unresponsive elements. Each developer added timeouts as needed without centralizing them.

**Why it is poor engineering:**  
17 hardcoded timeout literals scattered across 1446 lines. No way to tune for slow networks or fast local environments. This is not a band-aid per se, but it violates production code standards.

**Section 16 Plan:**
```
PLAN: Centralize Playwright timeouts
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/browserManager.js
  - Function: All action methods
  - Line range: 133, 136, 138, 771, 821, 822, 1028, 1055, 1114, 1190, 
                1216, 1221, 1223, 1225, 1227, 1253
  - What changes: Replace all literal timeout numbers with a constants object

WHAT: Centralize all Playwright timeout values into a single constants object.
WHERE: browserManager.js, top of file or module-level
WHEN: All browser operations
WHY: 17 hardcoded timeout values is unmaintainable.
HOW:
  1. Add at top of file:
     const BROWSER_TIMEOUTS = {
       navigation: 90000,
       loadState: 15000,
       action: 5000,
       popup: 5000,
       waitForSelector: 10000,
       shortPause: 500,
       mediumPause: 800,
     };
  2. Replace every literal timeout: X with BROWSER_TIMEOUTS.Y.

EDGE CASES:
  - Slow sites: User can adjust constants in one place.
  - Fast local sites: Same.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? No — just refactoring.
  - Could this block a legitimate action? No.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? N/A — refactoring.
  - Or does this PREVENT the problem from occurring? N/A.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes — centralized config is standard.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    No direct impact.
  - Would I understand why my tool call was blocked/modified? No change to behavior.
```

---

### E3 — Replace Stale-Ref Detection with Snapshot-Gen Check

**Current code:**
```js
@/browserManager.js:704-716
_isStaleRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  const m = trimmed.match(/(?:ref\s*=\s*|\[|^)(\d+)(?:\]|$)/) || (/^(\d+)$/.test(trimmed) && [null, trimmed]);
  if (!m) return null;
  const numRef = parseInt(m[1]);
  if (!this._refGenMap.has(numRef)) return null;
  if (this._refGenMap.get(numRef) !== this._snapshotGen) {
    return `Stale ref [ref=${numRef}] — this element was from a previous page...`;
  }
  return null;
}

@/browserManager.js:792-794, 1046-1048, 1108-1110, 1172-1173, 1208-1209
// Repeated in click(), type(), selectOption(), hover(), fillForm()
```

**Why it was implemented:**  
When the model clicks a ref from a previous snapshot (before navigation), it clicks the wrong element or nothing. The stale-ref check prevents this.

**Why it is over-engineered:**  
A separate `_refGenMap` tracks every ref's generation. Simpler: check if the ref exists in the CURRENT snapshot's element list. If not, it's stale. One check at action time is sufficient.

**Section 16 Plan:**
```
PLAN: Simplify stale-ref detection
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/browserManager.js
  - Function: _isStaleRef, click, type, select, hover, fillForm
  - Line range: 704-716, 792-794, 1046-1048, 1108-1110, 1172-1173, 1208-1209
  - What changes: Replace _refGenMap with single snapshot-gen check at action time

WHAT: Simplify stale-ref detection to a snapshot-generation presence check.
WHERE: browserManager.js, _isStaleRef and all action methods
WHEN: Per snapshot and per action
WHY: _refGenMap tracking every ref's generation is over-engineered.
HOW:
  1. Remove _refGenMap (Map) and its maintenance in getSnapshot.
  2. Keep _snapshotGen (number).
  3. In getSnapshot, store current refs in this._currentRefs (Set).
  4. In each action method, instead of _isStaleRef, check:
     if (!this._currentRefs.has(refNum)) return { error: "Stale ref — call browser_snapshot first" };
  5. Delete _isStaleRef function.

EDGE CASES:
  - Ref from previous snapshot: Caught by "not in current set" check.
  - CSS selector (non-ref): Passes through as before.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? No — deterministic presence check.
  - Could this block a legitimate action? No — if ref exists, it's valid.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? No — prevents stale clicks.
  - Or does this PREVENT the problem from occurring? Yes — by checking at action time.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes — simpler than current.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — clear "call browser_snapshot first" error.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

### E4 — Remove Navigation History Injection

**Current code:**
```js
@/browserManager.js:581-585
// Add navigation history to help the model avoid repeating navigations
if (this._navHistory.length > 0) {
  const historyText = this._navHistory.map((h, i) => `${i + 1}. ${h.action}: ${h.url}`).join('\n');
  text += `\n\nNavigation history (DO NOT repeat these — move to NEXT step):\n${historyText}`;
}
```

**Why it was implemented:**  
The model would repeatedly navigate to the same URLs in loops. The history was meant to remind it what it already did.

**Why it is a band-aid:**  
"DO NOT repeat these" is a directive to the model. The model should learn from history, not be scolded. The history is already in the snapshot/context. The directive is redundant.

**Section 16 Plan:**
```
PLAN: Remove navigation history injection
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/browserManager.js
  - Function: getSnapshot
  - Line range: 581-585
  - What changes: Delete the anti-loop directive from snapshot text

WHAT: Remove the "DO NOT repeat these" navigation history directive.
WHERE: browserManager.js, getSnapshot, lines 581-585
WHEN: Per snapshot
WHY: Scolding the model instead of teaching it via SYSTEM_PROMPT.
HOW: Delete lines 581-585.
      ALSO: Update SYSTEM_PROMPT browser section: "Track your navigation history 
      mentally. Do not revisit URLs you have already loaded in the same task."

EDGE CASES:
  - Model repeats navigation: Fix via prompt clarity.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? Yes — adds noise to every snapshot.
  - Could this block a legitimate action? No, but it pollutes context.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? Yes — directive AFTER history.
  - Or does this PREVENT the problem from occurring? No. Redesign: improve SYSTEM_PROMPT.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? No — removing a band-aid.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — cleaner snapshots without scolding.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

### E5 — Remove DOM Fingerprinting

**Current code:**
```js
@/browserManager.js:801-806
// PL5: Lightweight DOM fingerprint before click — detects same-URL content changes
let fingerprintBefore = '';
try { fingerprintBefore = await this._page.evaluate(() => {
  const els = document.querySelectorAll('a, button, [role="tab"], [role="menuitem"]');
  return `${els.length}:${(document.body?.innerText || '').substring(0, 200)}`;
}); } catch {}

@/browserManager.js:887-894
// PL5: Compare DOM fingerprints to detect same-URL content changes
let contentChanged = false;
try {
  const fingerprintAfter = await this._page.evaluate(() => {
    const els = document.querySelectorAll('a, button, [role="tab"], [role="menuitem"]');
    return `${els.length}:${(document.body?.innerText || '').substring(0, 200)}`;
  });
  contentChanged = fingerprintBefore !== fingerprintAfter;
} catch {}
```

**Why it was implemented:**  
SPA navigation (same URL, different content) was not being detected. The fingerprinting was meant to catch content changes that URL comparison missed.

**Why it is over-engineered:**  
The snapshot after click already shows the model what changed. The model can infer content changes from the snapshot. Fingerprinting is a derived metric that may mismatch due to dynamic content (ads, timers).

**Section 16 Plan:**
```
PLAN: Remove DOM fingerprinting
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/browserManager.js
  - Function: click
  - Line range: 801-806, 887-894
  - What changes: Delete before/after DOM fingerprint comparison

WHAT: Remove the DOM fingerprinting before and after click.
WHERE: browserManager.js, click, lines 801-806 and 887-894
WHEN: Per click action
WHY: Over-engineered. Snapshot after click already shows what changed.
HOW: Delete fingerprintBefore/fingerprintAfter variables and contentChanged check.
      Keep the snapshot return.

EDGE CASES:
  - SPA content change without URL change: Snapshot after click shows this.
  - Dropdown menu: Snapshot includes role="menuitem" if present.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? Yes — fingerprint may differ due to dynamic content.
  - Could this block a legitimate action? No, but it adds false state messaging.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? Yes — fingerprint AFTER click.
  - Or does this PREVENT the problem from occurring? No. Redesign: rely on snapshot.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? No — removing over-engineering.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — I see the actual snapshot, not a derived fingerprint.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

### E6 — Remove Hardcoded Page State Messaging

**Current code:**
```js
@/browserManager.js:882-904
// PL4+PL5: Clear page state messaging — tell the model exactly what happened
let pageState;
if (navigated) {
  pageState = 'PAGE NAVIGATED — you are now on a new page. Call browser_snapshot to see the new page before taking any action.';
} else {
  const hasMenuItems = snapshot.success && snapshot.text?.includes('role="menuitem"');
  if (hasMenuItems) {
    pageState = 'SAME PAGE — a dropdown menu opened. Menu items are visible in the snapshot below. Click one directly using its ref number.';
  } else if (contentChanged) {
    pageState = 'SAME URL but page content changed (tab switch, content update). The snapshot below shows the updated page.';
  } else {
    pageState = 'SAME PAGE — the click succeeded but the URL and content did not change. The click may not have had the intended effect. Try a different element or action.';
  }
}
```

**Why it was implemented:**  
The model was confused about whether navigation happened. The state messages were meant to give it clear direction.

**Why it is a band-aid:**  
Hardcoded strings telling the model what to think. The snapshot + navigated boolean is sufficient. The model should infer state from raw data.

**Section 16 Plan:**
```
PLAN: Remove hardcoded page state messaging
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/browserManager.js
  - Function: click
  - Line range: 882-904
  - What changes: Replace hardcoded pageState strings with simple boolean return

WHAT: Remove the hardcoded "PAGE NAVIGATED / SAME PAGE / dropdown" strings.
WHERE: browserManager.js, click, lines 882-904
WHEN: Per click action
WHY: The model should infer page state from the snapshot, not be told what to think.
HOW:
  1. Delete the pageState variable and all its string assignments (lines 882-904).
  2. Return { success: true, url, navigated, snapshot: snapshot.text }.
  3. Let the model interpret the snapshot.

EDGE CASES:
  - Model confused about state: The snapshot contains all visible elements.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? Yes — adds noise.
  - Could this block a legitimate action? No.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? Yes — state messaging AFTER click.
  - Or does this PREVENT the problem from occurring? No. Redesign: return raw data.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes — raw data over derived conclusions.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? No — removing one.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — I interpret the page myself.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

### E7 — Simplify JS Fallbacks

**Current code:**
```js
@/browserManager.js:918-984 (click JS fallback)
// Main page JS click fallback (lines 918-948)
// Child frame iteration fallback (lines 950-984)

@/browserManager.js:1070-1096 (type JS fallback)
```

**Why it was implemented:**  
Some sites block Playwright's native click/fill (event interception, custom JS handlers). The JS fallback clicks the element via evaluate() as a workaround.

**Why it is over-engineered:**  
Nested fallbacks (main page JS → child frame 1 JS → child frame 2 JS ...) are excessive. If Playwright fails, try ONE JS fallback on the main page. If that fails, report the error. The model can reassess.

**Section 16 Plan:**
```
PLAN: Simplify JS fallbacks
=====
EXACT LINES OF CHANGE:
  - File: c:/Users/brend/guide-3.0/browserManager.js
  - Function: click, type
  - Line range: 918-984 (click), 1070-1096 (type)
  - What changes: Replace nested multi-frame fallbacks with single main-page fallback

WHAT: Simplify JS fallbacks to one attempt on the main page only.
WHERE: browserManager.js, click and type methods
WHEN: When Playwright action fails
WHY: Nested fallbacks (main page JS → child frame 1 → child frame 2 ...) are over-engineered.
HOW:
  1. In click: Keep the main-page evaluate fallback (lines 918-948). 
     Delete the child frame iteration (lines 950-984).
  2. In type: Keep the main-page evaluate fallback (lines 1070-1096).

EDGE CASES:
  - Element in iframe: Playwright handles iframes natively. If it fails, the model 
    should use browser_snapshot to reassess.

FALSE POSITIVES:
  - Could this trigger when nothing is wrong? No — only on Playwright failure.
  - Could this block a legitimate action? No — simplifies, not removes.

BAND-AID CHECK:
  - Does this fix what happens AFTER the problem occurs? Yes — fallback AFTER Playwright failure.
  - Or does this PREVENT the problem from occurring? No. But ONE fallback is acceptable 
    robustness; NESTED fallbacks are band-aids.

PRODUCTION QUALITY CHECK:
  - Is this ONLY a proper production solution? Yes — single fallback is standard.
  - Test-specific? No.
  - Use-case-specific? No.
  - Model-specific? No.
  - Hardware-specific? No.
  - On par with $1M software? Yes.
  - Uses any banned mechanisms? One fallback is acceptable; nested ones are not.

AI PERSPECTIVE:
  - If I were running inside guIDE, would this change help me make better decisions?
    Yes — clearer error when Playwright fails.
  - Would I understand why my tool call was blocked/modified? Yes.
```

---

## ITEMS CLASSIFIED AS KEEP

### Item 8 — VRAM Warning Rate-Limiter
**File:** chatEngine.js  
**Lines:** 2167-2175  
**Verdict:** KEEP  
**Rationale:** This is a pure diagnostic logger. It emits a console warning once per 5 minutes when VRAM is critically low. It does NOT affect model behavior, tool calls, or context. It is a monitoring mechanism, not a functional band-aid.

### Item 9 — Context Compaction
**File:** chatEngine.js  
**Lines:** 1926-2037  
**Verdict:** KEEP (refine later)  
**Rationale:** This is core architecture. Context MUST be compacted when the window fills. The "browser_snapshot: OK (old page)" summaries are crude, but the compaction itself is necessary until context rotation is perfect. Revisit after Phase 2.

### Item 10 — Context State File
**File:** chatEngine.js  
**Lines:** 2479-2524  
**Verdict:** KEEP  
**Rationale:** `.guide-scratch/context-state.md` is a recovery mechanism for when context rotation loses critical state. It is a necessary evil until rotation is flawless. The user has not flagged this as problematic.

### Item 25 — Settings Migration
**File:** settingsManager.js  
**Lines:** 144-147, 149-153, 155-158  
**Verdict:** KEEP  
**Rationale:** These migrations reset old default values (generationTimeoutSec 120→0, contextSize 8k→auto, kvCacheType q3_0→q4_0). They are harmless, run once per user, and prevent configuration drift. Not a band-aid.

---

## IMPLEMENTATION CHECKLIST

### Phase 1 (APPROVED)
- [x] A1 — Remove generation timeout (lines 1509-1520) — COMPLETED
- [x] A2 — Remove max iteration cap (lines 1562-1563, 1604-1605, 2126-2138) — COMPLETED
- [x] B1 — Remove samePageWarning injection (lines 1695-1703) — COMPLETED
- [ ] B2 — Remove recently-written file injection (lines 1660-1693, 256, 611) — PENDING USER CONFIRMATION
- [x] B4 — Remove empty brace suppression (lines 1336-1344) — COMPLETED

### Phase 2 (PENDING)
- [ ] C1 — Replace progressive trimming (lines 1445-1494)
- [ ] D1 — Consolidate tool parser (lines 257-382, 507-640, 800-871)

### Phase 3 (PENDING)
- [x] E1 — Remove retry loop (lines 228-256) — COMPLETED
- [ ] E2 — Centralize timeouts (17 locations)
- [ ] E3 — Simplify stale-ref (lines 704-716, 792-794, 1046-1048, 1108-1110, 1172-1173, 1208-1209)
- [x] E4 — Remove nav history injection (lines 581-585) — COMPLETED
- [x] E5 — Remove DOM fingerprinting (lines 762-767) — COMPLETED
- [x] E6 — Remove page state messaging (lines 870-900, 766-773) — COMPLETED
- [ ] E7 — Simplify JS fallbacks (lines 918-984, 1070-1096)

---

## NOTES

- Every change MUST update CHANGES_LOG.md (RULES.md Section 17).
- Every change MUST follow the PRE-CODE and POST-CODE checklists (RULES.md Sections 7-8).
- Test configuration: Qwen 3.5 2B, 8000 context, max GPU layers (RULES.md Section 9).
- If a change causes regressions, the ENTIRE pipeline for that subsystem must be rebuilt (RULES.md Section 3, Rule 12).
