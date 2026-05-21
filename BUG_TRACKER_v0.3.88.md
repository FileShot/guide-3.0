# Bug Tracker — guIDE v0.3.88

**Source log:** `C:\Users\brend\AppData\Roaming\guide-ide\logs\guide-main.log` (1,221 lines)  
**Test session:** 2026-05-21, RTX 3050 Ti 4GB, guIDE v0.3.88 installed  
**Process:** One bug at a time. Full pipeline trace (Tripwire 8) before any code. No implementation until you approve each bug's plan.

**User constraint (log line 1065):** Fixing context pressure by shrinking the tool prompt is **not** the solution. Auto load must balance GPU layers vs usable context. All behavior must remain overrideable in settings (`gpuLayers`, `contextSize`, etc.).

---

## How we work through this list

| Column | Meaning |
|--------|---------|
| **Status** | `OPEN` = not investigated yet · `TRACING` = pipeline read in progress · `PLAN READY` = plan written, awaiting your approval · `FIXED` = you verified in app · `WONTFIX` / `DEFERRED` = your call |
| **Investigation** | What we have actually read in code — honest, not guessed |
| **Proposed direction** | Hypothesis for fix — **not** confirmed until trace complete |

**Current session rule:** Pick one bug ID → I trace full pipeline → write plan for that bug only → you approve → I implement that bug only → you test → mark status → next bug.

---

## Summary table

| ID | Severity | Bug | Status |
|----|----------|-----|--------|
| B01 | CRITICAL | Context collapses to 2048 on every model load | IMPLEMENTED — pending user verify |
| B02 | CRITICAL | GLM 4.6 — entire response (incl. tools) in thinking dropdown only | IMPLEMENTED — pending user verify |
| B03 | CRITICAL | GLM 4.6 — empty main chat / log shows responseLen=0 | IMPLEMENTED — pending user verify (same fix as B02) |
| B04 | CRITICAL | Orphan `</think>` retroactive move | PLAN READY |
| B05 | CRITICAL | Tool call JSON parsed/executed from thinking content (GLM) | OPEN |
| B06 | MAJOR | GLM post-tool continuation returns empty visible text | OPEN |
| B07 | MAJOR | GLM 4.7 missing forced-open thinking wrapper | OPEN |
| B08 | MAJOR | Thinking content not written to guide-main.log | OPEN |
| B09 | MAJOR | maxTokens budget exceeded (119%–233% in log) | OPEN |
| B10 | MAJOR | Context shift mid-generation drops messages | OPEN |
| B11 | MAJOR | Phi — wrong tool on story (`write_scratchpad` missing `key`) | IMPLEMENTED — pending user verify |
| B12 | MAJOR | Llama — spurious tool calls on casual chat | IMPLEMENTED — pending user verify |
| B13 | MAJOR | VRAM reports 100% used / 0.00GB free after every generation | OPEN |
| B14 | MINOR | Continuation emits instruction echo text to user | OPEN |
| B15 | MINOR | `cancelGeneration: no abortController exists` spam on idle cancel | OPEN |
| B16 | OPEN | Tools execute after user stop (v0.3.86 report — **not in this log**) | OPEN |
| — | INFO | Vision mmproj scan warnings | Not tracked as bugs |

**Suggested order:** B08 first (logging only, no behavior change) → B01 → B02/B03/B04/B05/B06/B07 as one GLM thinking group → B09 → B10 → rest.

---

## B01 — Context collapses to 2048 on every model load

**Severity:** CRITICAL  
**Status:** PLAN READY  
**Plan file:** [BUG_B01_GPU_CONTEXT_PLAN.md](./BUG_B01_GPU_CONTEXT_PLAN.md)  
**Investigation:** Full pipeline traced (loadModel → budget → createContext → UI). Awaiting approval before code.

### What you see
- Auto load always ends at **2048 context** regardless of model.
- Status/warnings suggest reducing GPU layers manually.
- You told the model (log 1065): the fix is **not** shrinking tool prompt — it's GPU/context balance at load.

### Log evidence
| Model | Lines | gpuLayers | desiredMax | Actual ctx |
|-------|-------|-----------|------------|------------|
| Phi-4-mini | 28–36 | 32/32 | 112,338 | 2048 |
| GLM-4.6V | 197–201 | 17/40 | 64,145 | 2048 |
| GPT-OSS 20B | 443–457 | 5/24 | 53,412 | 2048 |
| Llama 3.2 3B | 532–536 | 21/28 | 22,854 | 2048 |
| GLM-4.7 | 1141–1149 | 9/47 | 25,628 | 2048 |

Every load: `Context degradation: Context collapsed to 2048 ... GPU layers consumed too much VRAM`

### Known mechanism (code, partial read)
- `chatEngine.js` `computeUnifiedVramBudget()` scores `gpuLayers * 1_000_000 + contextSize` — **max layers always wins**, context floor 2048 is acceptable.
- `MIN_CONTEXT_FLOOR = 2048`, VRAM overhead 512MB + buffer 256MB.
- v0.3.87 change intended to prefer partial GPU over cpu-only; on 4GB it maxes layers and floors context.

### Proposed direction (needs full trace + web research)
- Replace layer-dominant scoring with **balanced auto** (user setting: speed / balanced / context).
- Reject auto configs that only fit 2048 unless no GPU config meets minimum usable context.
- Post-load: if context at floor with high layer count, **reduce layers and retry** until usable context or user override.
- Research: LM Studio, Ollama, llama.cpp heuristics for 4GB partial offload.
- **Not** the fix: shrinking tool prompt (B08 symptom only).

### Files to trace (Tripwire 8)
`chatEngine.js` (budget, load, createContext) → `settingsManager.js` → `firstRunSetup.js` → UI settings exposure

### Verify fix
Load Phi on 4GB: log shows `ctx > 4096` (or explicit tradeoff message), `gpuLayers < total`, generation works without immediate context shift on `"hi"`.

---

## B02 — GLM 4.6 entire response in thinking dropdown

**Severity:** CRITICAL  
**Status:** OPEN  
**Investigation:** Partial — `onResponseChunk`, orphan handler, frontend retroactive event referenced; frontend not fully read.

### What you see
- **Entire** GLM 4.6 reply — prose, tool JSON, everything — appears only inside the thinking dropdown, not main chat.

### Log evidence
- Line 203: `forcedOpen=true`, native thought segments active (233, 274).
- Line 275: `orphan </think> consumed — retroactively marking preceding text as thinking`
- Lines 283–296: MODEL RESPONSE blob contains prose + `web_search` + `fetch_webpage` JSON + `</think>`
- Line 282: `stopReason=maxTokens` after 72.7s

### Known mechanism (partial)
- Thought segments → UI via `llm-thinking-token`, **not** `fullResponse` (log shows empty; UI shows content).
- Orphan close tag → `llm-thinking-retroactive` moves **all** prior visible chars to thinking panel.

### Proposed direction
- Trace: Jinja wrapper → node-llama-cpp segments → `onResponseChunk` → `_sfProcessChunk` → `appStore.js` retroactive handler → UI segments.
- Fix at source: correct thought/comment segment boundaries for GLM; tool JSON must not live in thought channel.
- Remove dependence on retroactive move once native routing is correct (retroactive is post-hoc band-aid per RULES).

### Verify fix
GLM 4.6 `"hey whats up"`: main chat has visible reply; thinking dropdown optional/short; tools not inside thinking UI.

---

## B03 — GLM 4.6 empty main chat / log responseLen=0

**Status:** IMPLEMENTED — pending user verify (B02 routing + B03 empty-warning/logging)

### What you see
- Blank main chat area on GLM 4.6 for simple messages.

### Log evidence
- Lines 235–252: `"hey whats up"` → `tokens=0`, `responseLen=0`, `Empty response warning`
- Lines 409–426: sarcasm message → same

### Known mechanism
- All output in thought channel; `fullResponse` empty → log + empty main UI if retroactive/thinking-only routing.

### Fix (with B02)
- Native segment routing: visible reply → main chat (`fullResponse` / `segmentType null`).
- Track `thoughtLen` separately from `responseLen` in logs.
- Skip false `Empty response warning` when native thinking content was streamed.

### Verify fix
Same as B02: main chat has visible reply when model emits `</think>`. Log shows `thoughtLen>0` and/or `responseLen>0` — not both zero unless truly empty.

---

## B04 — Orphan `</think>` retroactive move

**Severity:** CRITICAL  
**Status:** PLAN READY  
**Plan file:** [BUG_B04_IMPLEMENTATION.md](./BUG_B04_IMPLEMENTATION.md)  
**Investigation:** B02 partial fix (strip when `_sfNativeThinkActive`). Gap: retroactive still fires when native segments never activate, or before first thought chunk.

### What you see
- Sudden reclassification of all streamed text into thinking when model emits close tag without open.

### Log evidence
- Line 275 (GLM 4.6 GPU complaint message)

### Known mechanism
- `_sfProcessChunk` orphan CLOSE_TAG handler → `llm-thinking-retroactive` with `length: _sfVisibleChars` → frontend moves last N chars to thinking.

### Proposed direction
Gate retroactive move off for Jinja+`enable_thinking` models (`_nativeThinkSegmentMode`). Strip redundant literal close tags only — never `llm-thinking-retroactive`. See plan file.

### Verify fix
No log line `orphan </think> consumed` on GLM test prompts; no full-response jump to thinking.

---

## B05 — Tool calls parsed/executed from thinking content (GLM)

**Severity:** CRITICAL  
**Status:** OPEN  

### What you see
- Tools run from content that was only visible in thinking dropdown (web search, fetch webpage on GPU complaint).

### Log evidence
- Lines 346–364: `web_search`, `fetch_webpage` parsed from 2065-char MODEL RESPONSE blob that included thinking markup
- Tools executed successfully; continuation empty (373–381)

### Proposed direction
- Tool parser must run on **comment channel only**, not thought segments or retroactive-moved text.
- If model puts tool JSON in thought segment, do not execute until visible comment segment confirms (or use native function-call segments from node-llama-cpp if available).

### Verify fix
GLM sarcasm/GPU message: no tool execution unless user intent requires it; tools never launched from thinking-only stream.

---

## B06 — GLM post-tool continuation empty visible text

**Severity:** MAJOR  
**Status:** OPEN  

### What you see
- After tools run, no final answer in main chat.

### Log evidence
- Lines 372–381: `Continuation RESPONSE ─── ""`, `responseLen=0`, `tokens generated: 0`

### Proposed direction
- Trace continuation `generateResponse` segment routing separately from initial generation.
- Likely same thought-only output path as B02; may need to force comment segment after tool results injected.

### Verify fix
After GLM tool loop, main chat shows summary answer prose.

---

## B07 — GLM 4.7 missing forced-open thinking wrapper

**Severity:** MAJOR  
**Status:** OPEN  
**Investigation:** Partial — `needsGlmForcedOpen` at ~925 read.

### What you see
- (Potentially) different thinking behavior between GLM 4.6 and 4.7.

### Log evidence
- 4.6 line 203: `forcedOpen=true`
- 4.7 line 1151: `forcedOpen=false`, family detected as `deepseek` not `glm`

### Known mechanism
- `needsGlmForcedOpen = needsThinkingJinja && (_detectedFamily === 'glm' || ggufArchString === 'chatglm')`
- GLM 4.7 file: `GLM-4.7-Flash-REAP-23B` but arch `deepseek2` → forcedOpen skipped.

### Proposed direction
- Extend detection: filename contains `GLM`, or arch in `{glm4, chatglm, deepseek2}` with GLM template, etc.
- Full trace: model profile resolution in load path.

### Verify fix
4.7 log shows `forcedOpen=true` when thinking enabled; simple `"hi"` (line 1182+) behavior consistent with 4.6 fix.

---

## B08 — Thinking content not written to guide-main.log

**Severity:** MAJOR (observability — blocks debugging)  
**Status:** OPEN  
**Investigation:** Confirmed — `onResponseChunk` thought path does not log content.

### What you see
- Agent/log analysis says `responseLen=0` while you see full response in UI thinking panel.

### Log evidence
- Only `✓ B4: Native onResponseChunk thought segments active` — no thinking text logged.

### Proposed direction
- Log per generation: `{ thoughtChars, visibleChars, retroactiveMoves, thoughtPreview }`.
- Optional setting `logThinkingContent` for full text (default off).

### Verify fix
Log contains thinking length/preview; matches what you see in UI.

---

## B09 — maxTokens budget exceeded

**Severity:** MAJOR  
**Status:** OPEN  
**Investigation:** Not traced.

### What you see
- Model generates far more than allotted budget; may contribute to context pressure.

### Log evidence
| Lines | Budget | Reported generated | Over |
|-------|--------|-------------------|------|
| 626 | 512 | 611 | 119% |
| 827 | 2048 | 4767 | 233% |
| 1005 | 2048 | 3801 | 186% |
| 1078 | 1227 | 2709 | 221% |

### Proposed direction
- Trace `maxTokens` from `chatEngine.js` → node-llama-cpp `generateResponse` → metadata.
- Clarify whether logged "tokens generated" is chars vs tokens vs includes prompt.
- Enforce budget on continuation paths.

### Verify fix
Log never shows `used > 100%` of maxTokens budget unless stopReason=maxTokens with correct count.

---

## B10 — Context shift mid-generation drops messages

**Severity:** MAJOR  
**Status:** OPEN  
**Investigation:** Not traced.

### What you see
- History/system prompt stripped during active generation; coherence loss.

### Log evidence
- Lines 279–280, 370–371, 746–747, 819–820, 997–998, 1073–1074: `Context shift: replaced system prompt with minimal version (1914 → 27 tokens)`, `dropped N`

### Proposed direction
- Trace `lastEvaluationContextWindow` / context shift trigger in generation loop.
- Retest after B01 — larger context may reduce shift frequency.
- Ensure shift preserves tool results + current user message.

### Verify fix
Long prompt on Llama: shift if needed happens without dropping active tool results; model continues coherently.

---

## B11 — Phi wrong tool on story request

**Severity:** MAJOR  
**Status:** IMPLEMENTED — pending user verify

### What you see
- Asked for cat story; model called `write_scratchpad` incorrectly; story broken.

### Log evidence
- Lines 107–153: story request → `write_scratchpad` with `content` only → `"key must be a non-empty string"`

### Proposed direction
Consolidate tool format/examples/catalog into `getToolPrompt()` only; slim `SYSTEM_PROMPT` to identity + when-to-use + pointer. Fix scratchpad param mismatch. See plan file.

### Verify fix
Same story prompt: model responds with prose OR valid scratchpad call with required `key`.

---

## B12 — Llama spurious tool calls on casual chat

**Severity:** MAJOR  
**Status:** IMPLEMENTED — pending user verify

### What you see
- Casual chat triggers `ask_question`, `list_directory` on nonsense paths.

### Log evidence
- Lines 648–673: `ask_question` on `"what do u mean?"`
- Lines 714–740: `list_directory` path `"/jungle"` → ENOENT

### Proposed direction
Same plan as B11 — slim system, single tool section every turn, stronger when-to-use prose for casual chat. Not removing examples from what model sees; removing duplication.

### Verify fix
Casual Llama chat: no tool execution unless user asks for an action.

---

## B13 — VRAM 100% / 0.00GB free after generation

**Severity:** MAJOR  
**Status:** OPEN  

### What you see
- GPU appears fully saturated after every message.

### Log evidence
- Lines 96, 251, 386, 515, 602, 788, 935, 1054, 1121, 1215: `Memory post-gen: vramUsed=100%, vramFree=0.00GB`

### Proposed direction
- Symptom of B01 (2048 ctx + max layers fills VRAM).
- Verify diagnostic math in post-gen log vs nvidia-smi.
- Trace after B01 fix; may resolve without separate change.

### Verify fix
After load + one `"hi"`, log shows headroom OR honest explanation; matches nvidia-smi.

---

## B14 — Continuation instruction echo in user-visible output

**Severity:** MINOR  
**Status:** OPEN  

### Log evidence
- Lines 170–174: `[Continue writing based upon user's next input]` in CONTINUATION RESPONSE after failed scratchpad

### Proposed direction
- Secondary to B11 (failed tool). No output strip filter (band-aid). Fix tool path + model continuation prompt assembly.

### Verify fix
No bracketed meta-instructions in chat UI after story prompt.

---

## B15 — cancelGeneration no abortController spam

**Severity:** MINOR  
**Status:** OPEN  

### Log evidence
- Lines 32, 188, 431, 438, 520, 527, 794, 800, 947, 952, 1127, 1132: WARN on session clear / model swap when idle

### Proposed direction
- `cancelGeneration`: if no active generation, log DEBUG or skip WARN.
- Not related to B16 unless abortController lifecycle is broken during active gen.

### Verify fix
Session clear with no active chat: no WARN in log.

---

## B16 — Tools execute after user stop (prior v0.3.86 report)

**Severity:** CRITICAL (if still present)  
**Status:** OPEN — **not reproduced in this log session**

### Notes
- v0.3.87 added abort gate before tool parse/execute.
- This log has no user-stop-during-generation test.
- Must be explicit test case when we reach this bug.

### Verify fix
Start GLM tool generation → click stop → log shows abort before `Executing toolFn`; no tool runs.

---

## Informational (not tracked as bugs)

- VisionServer mmproj `unknown n_embd` skips — expected for non-vision models.
- Phi SWA disabled warning (node-llama-cpp).
- GLM 4.7 flash attention incompatible warning (line 1145).
- GPT-OSS special token attribute warnings on load.

---

## Regression watchlist (v0.3.87 / v0.3.88)

| Change | Risk |
|--------|------|
| `gpuLayers * 1e6 + contextSize` scoring | B01 — max layers, min context |
| GLM inlined Jinja forced-open wrapper | B02–B07 — thinking routing |
| Abort gate before tool loop | B16 — needs retest |
| Dynamic import removed (v0.3.88) | Model load — **working** in this log |
| Tool budget cap 4096 | Not root cause of B01 per user constraint |

---

## Next step

Pick a bug ID (recommended: **B08** then **B01**). I will:

1. Tripwire 8 full pipeline trace for that bug only  
2. Web research where required (RULES Section 6)  
3. Write a single-bug plan (or update this file's bug section with PLAN READY)  
4. Wait for your explicit approval before any code  

No half-baked multi-bug implementation.
