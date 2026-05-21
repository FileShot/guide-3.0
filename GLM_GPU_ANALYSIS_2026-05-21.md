# GLM 4.6/4.7 + GPU Layer Analysis — 2026-05-21

Session: guIDE v0.3.86, RTX 3050 Ti 4GB, log `guide-main.log` (1085 lines read in full via grep + sectional read).

Research performed:
- [llama.cpp PR #16426](https://github.com/ggml-org/llama.cpp/pull/16426) — forced-open reasoning blocks for Jinja templates (GLM-Z1); closed as draft
- [llama.cpp issue #21465](https://github.com/ggml-org/llama.cpp/issues/21465) — `<think>` open tag not rendered in generation prompt
- [GLM-4.6 chat_template.jinja](https://huggingface.co/zai-org/GLM-4.6/blob/main/chat_template.jinja) — `enable_thinking` controls reasoning blocks
- Ollama VRAM budgeting PR #1850 (referenced in BUG_AUDIT)

---

## Issue A — GLM 4.6V: thinking leaks into chat (orphan `</think>` only)

### The Bug
User sees thinking prose in the main chat stream. GLM 4.6V emits thinking text **without** an opening `<think>` tag, then closes with `</think>`, then emits the visible reply.

### The Evidence
```
Line 108: orphan </think> consumed — retroactively marking preceding text as thinking
Line 114-115: last 80 chars: "...help you with today?</think>\nHello! How may I assist you today?"
Line 119: chatWrapper: JinjaTemplate
Line 120: MODEL RESPONSE includes BOTH thinking sentence AND visible reply in one string
```
No log line `✓ B4: Native onResponseChunk thought segments` — native segment API never activates for GLM.

`enable_thinking=true` is correctly set (line 79). Template declares thinking support (line 78).

### The Cause (full pipeline)
1. **Template layer:** GLM Jinja templates with `enable_thinking=true` are designed to open a reasoning block in the *generation prompt* (forced-open). llama.cpp issue #21465 documents cases where the opening tag is **not** emitted in `add_generation_prompt`, so the model only learns to close with `</think>`.
2. **node-llama-cpp layer:** `chatWrapper: JinjaTemplate` streams raw completion text via `onTextChunk`. Reasoning is NOT split into `onResponseChunk` segments for GLM (unlike DeepSeek-R1 native path).
3. **guIDE layer (`_sfProcessChunk`):** Raw-text state machine waits for `<think>` open tag. Without open tag, thinking bytes go to `onToken` → visible chat.
4. **On orphan close:** `llm-thinking-retroactive` fires (line 108) — a **post-hoc band-aid** that tries to move already-forwarded text into the thinking panel. It races with visible streaming and fails to prevent duplicate/leaked prose (user confirmed).
5. **Frontend (`retroactiveThinkingMove`):** Moves last N chars from `chatStreamingText` to thinking segment — fragile, length-based, not template-aware.

### How Other Tools Handle This
| Tool | Approach |
|------|----------|
| **llama.cpp server** | Template-level CoT parsing: `reasoning_content` vs `content` fields separated at parse time (PR #16394 direction). `reasoning_format: auto` splits before streaming to client. |
| **LM Studio** | Uses llama.cpp Jinja + backend reasoning split; UI gets pre-separated thinking/content channels, not streaming regex. |
| **Ollama** | Template + parser in Go layer; thinking blocks never hit the visible content channel. |

None of them use a streaming char-by-char `<think>` regex filter or retroactive text moves.

### The Fix (architectural — NOT regex)
1. **Delete** the `_sfProcessChunk` think-tag state machine (~200 lines) and `retroactiveThinkingMove` once replacement works.
2. **Use node-llama-cpp / llama.cpp native reasoning separation:**
   - Verify whether bundled node-llama-cpp exposes `reasoning_content` or segment types for JinjaTemplate + GLM.
   - If not: upgrade node-llama-cpp to version that includes llama.cpp CoT parser (track #16394 / template forced-open fix).
   - Pass `enable_thinking` via `chatTemplateKwargs` (already done) AND ensure generation prompt includes forced-open block (llama.cpp template fix, not guIDE regex).
3. **Route at source:** `onResponseChunk` with `segmentType: "thought" | "comment"` OR dedicated reasoning channel → `llm-thinking-token` only. Visible channel → `onToken` only. **One byte, one destination.**
4. **If template cannot be fixed upstream:** configure node-llama-cpp `SegmentHandler` segment definitions to match GLM's exact open/close tokens from the GGUF `chat_template` metadata — this is template metadata, not output sniffing.

### What Could Go Wrong
- Upgrading node-llama-cpp may re-break Gemma 4 (separate track).
- GLM 4.7 may behave differently from 4.6V (different template) — fix must be template-driven, not model-name driven.
- Until upstream fix lands, there is no correct local-only fix without template integration.

### What's Been Tried Before
- v0.3.63 B4 native segment routing (CHANGES_LOG) — works for DeepSeek, not GLM JinjaTemplate.
- v0.3.86 segmentType fix — same limitation; GLM never hits native segments.
- Fix 5 orphan retroactive handler — band-aid, still in code, causes the symptoms user reports.

---

## Issue B — GLM 4.7: prose + raw tool JSON in thinking dropdown; tools execute after pause

### The Bug
During long generation, thinking panel fills with analysis prose AND raw `` ```json `` tool call blocks. User hits pause. Tool calls then appear as code blocks in main chat and **execute** (write_file ×3).

### The Evidence
```
Line 557: <think> tag detected — routing to llm-thinking-token (raw text path)
Lines 561-593: code fence inside thinking — deferring close decision (×14)
Line 594-597: agent-pause → stopReason=abort, tokens=8221
Lines 819-975: parseToolCalls on 8221-char aborted response → 4 tool calls recovered via regex
Lines 977-1002: Tool loop EXECUTES write_file ×3 AFTER user paused
Line 986: write_file content includes garbage: "}}\n<file>consensus_analysis.md</pattern>..."
```

### The Cause
1. **Thinking vs action not separated:** While `_sfInThink`, ALL bytes including `` ```json `` tool fences route to `llm-thinking-token` (by design in `_sfProcessChunk` lines ~1172-1191). Tool calls are **actions**, not reasoning — they belong in the visible/tool pipeline.
2. **Abort does not gate tool execution:** `chat()` runs `_sfFlush` → `parseToolCalls(fullResponse)` regardless of `stopReason=abort`. Partial/garbage JSON inside thinking block gets regex-recovered and executed.
3. **Regex recovery in toolParser:** Method 1.1 "regex recovery" on malformed JSON creates false-positive tool calls from thinking-stream garbage.

### How Other Tools Handle This
- **LM Studio / Ollama:** Tool calls are either native function-calling API or clearly separated assistant content — never parsed from inside a reasoning block after user cancellation.
- **llama.cpp server:** `reasoning_format` keeps reasoning out of the content stream; tool calls use separate channel.

### The Fix (architectural)
1. **Same as Issue A** — reasoning separated at template/parser level so tool JSON never enters thinking channel.
2. **Abort gate at architectural level:** If `stopReason === 'abort' | 'cancelled'`, skip tool parse/execute entirely. User pause = hard stop, no side effects.
3. **Remove** "code fence inside thinking" deferral logic — it exists because thinking/action aren't separated upstream.
4. **Tighten toolParser:** Do not regex-recover tool calls from malformed JSON (Method 1.1) — reject and feed validation error back to model on next turn. Regex recovery IS a band-aid per RULES.

### What Could Go Wrong
- Legitimate tool calls mid-stream on abort are lost — correct behavior; user paused intentionally.
- Models that only emit tools inside thinking blocks need template fix, not parser recovery.

---

## Issue C — Zero GPU layers; all VRAM to KV context

### The Bug
GLM 4.6V (6.17GB) and GLM 4.7 (23B MoE) load with `gpuLayers=0` and massive context (131072 / 91136) on 4GB VRAM. User gets CPU-only inference (~2-8 tok/s effective).

### The Evidence
```
Line 69-71: modelSize=6.17GB, vramFree=3.45GB → gpuLayers=0/40, estCtx=131072
Line 77: Context created: ctx=131072, gpuLayers=0
Line 350-363: GLM 4.7 → gpuLayers=0/47, ctx=90993
Compare line 22: DeepSeek 1.5B (1.89GB) → gpuLayers=13/28, ctx=69120 ✓
```

### The Cause
**Regression in v0.3.86 `computeUnifiedVramBudget`** (`chatEngine.js` lines 72-133):

```javascript
const score = contextSize * 1000 + gpuLayers;
```

When the full model cannot fit in VRAM, `gpuLayers=0` leaves ALL VRAM for KV cache → `maxCtx = desiredMaxContext` (131K). Score for (0 layers, 131K ctx) = **131,072,000**.

Any partial offload (e.g. 10 layers, 50K ctx) scores lower → **algorithm always picks 0 GPU layers to maximize context**. This is the opposite of what Ollama/LM Studio do on constrained VRAM.

Additionally `hwCap` uses RAM when model exceeds VRAM (line 69: `source=ram, hwCap=314625`) → `desiredMaxContext=131072` is unrealistically large for a CPU-offload scenario.

### How Other Tools Handle This
| Tool | Behavior on 4GB + oversized model |
|------|-------------------------------------|
| **Ollama** | Partial GPU offload when possible; default context ~4K on <24GB; KV sized WITH layer budget in one pass (PR #1850) |
| **LM Studio** | Offloads max layers that fit; context scaled down; does not allocate 131K KV with zero layers |

### The Fix
1. **Rewrite scoring in `computeUnifiedVramBudget`:**
   - Phase 1: Find **maximum gpuLayers** that fit with `minContext` (profile-derived, e.g. 8192).
   - Phase 2: With those layers locked, compute **maximum context** from remaining VRAM.
   - Never prefer ctx=131K at gpuLayers=0 when gpuLayers≥1 is achievable.
2. **Cap `desiredMaxContext` when modelSize > vramFree:** Use RAM hwCap for context ceiling but still offload partial layers to GPU for compute speed.
3. **Respect `requireMinContextForGpu`:** If user wants GPU speed, sacrifice context before sacrificing all layers.
4. **Log clearly:** `chose gpuLayers=N ctx=M because partial offload beats CPU-only` — aids diagnosis.

### What Could Go Wrong
- Some architectures may not support partial GPU offload well — still better than 0 layers.
- Very large context requests from user settings must cap against achievable VRAM after layers allocated.

### What's Been Tried Before
- Pre-v0.3.86: iterative gpu layer loop with MIN_VIABLE_CONTEXT=4096 — got *some* layers for small models but still two-pass.
- v0.3.86 unified budget — introduced this regression by maximizing context score without requiring gpuLayers > 0.

---

## Issue D — Full 15K tool prompt on 131K context (related)

Line 102: `Tool prompt injected (15077 chars, mode=full, budget=45147 tok, ctx=131072)`.

Budget-proportional tool catalog allows full catalog when context is huge. With Issue C fixed (smaller ctx), this self-corrects. Additionally: cap tool budget absolute maximum regardless of context size.

---

## Priority Order

| # | Issue | Severity | Fix type |
|---|-------|----------|----------|
| 1 | C — GPU layers 0 regression | Critical (perf) | Rewrite `computeUnifiedVramBudget` scoring |
| 2 | B — tools execute after abort | Critical (data safety) | Abort gate before tool loop |
| 3 | A — GLM thinking leak | Major (UX) | Template/native reasoning channel; remove regex band-aids |
| 4 | B — tool JSON in thinking | Major (UX) | Same as A + abort gate |
| 5 | D — tool prompt bloat | Minor | Absolute tool budget cap |

---

## Explicitly Banned Approaches

- Improving orphan `</think>` retroactive handler
- Better regex in `_sfProcessChunk` for GLM-specific patterns
- Detecting "GLM" by name/family to special-case behavior
- Post-stream stripping of thinking from visible text
- More aggressive regex recovery in toolParser Method 1.1

---

## Next Step

**Implemented (pending v0.3.87 test):**
- [x] C — GPU scoring rewrite + desiredMax VRAM cap when model > VRAM
- [x] B — abort gate before tool parse/execute
- [x] D — absolute tool budget cap (4096 tokens)
- [x] A (partial) — `enable_thinking` wired via `JinjaTemplateChatWrapper.additionalRenderParameters` + explicit `redacted_thinking` segments (was dead on `LlamaChat` constructor)

**Still pending verify:**
- [ ] GLM 4.6/4.7: confirm `✓ B4: Native onResponseChunk thought segments active` in log
- [ ] GLM 4.6: confirm `forcedOpen=true` and no orphan-close retroactive lines
- [ ] Remove `_sfProcessChunk` think parser after native segments verified
- [ ] Long-term: GLM native XML tools via node-llama-cpp `functions` API (see `GLM_THINKING_UPGRADE.md`)

**npm upgrade:** Not required — already on `node-llama-cpp@3.18.1` (latest). Fix is API wiring + `glmJinjaChatWrapper.js` noPrefixTrigger.
