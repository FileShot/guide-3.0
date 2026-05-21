# GLM Thinking — Upgrade Path Investigation (2026-05-21)

## Summary

**npm `node-llama-cpp@3.18.1` is already the latest release** (2026-03-17, ships llama.cpp b8390). There is no newer npm version to bump. The upgrade path for GLM thinking is **correct API wiring inside guIDE**, not a package version bump.

---

## Root Causes (confirmed in source)

### 1. Dead `chatTemplateKwargs` on `LlamaChat` constructor

`LlamaChatOptions` only accepts `{ contextSequence, chatWrapper?, autoDisposeSequence? }`.  
guIDE passed `chatTemplateKwargs: { enable_thinking: true }` — **silently ignored**.

**Fix:** Build `JinjaTemplateChatWrapper` with `additionalRenderParameters: { enable_thinking }`.

### 2. GLM Jinja template omits open tag when thinking is ON

From [GLM-4.6 chat_template.jinja](https://huggingface.co/zai-org/GLM-4.6/blob/main/chat_template.jinja):

```jinja
{%- if add_generation_prompt -%}
<|assistant|>{{- '\n<think>\n\n' if (enable_thinking is defined and not enable_thinking) else '' -}}
{%- endif -%}
```

When `enable_thinking=true`, generation prompt is `<|assistant|>` with **no** `<think>`.  
GLM-4.6 often emits reasoning then only `</think>` — matching training, not a guIDE bug.

**Fix:** `noPrefixTrigger: { type: 'segment', segmentType: 'thought', inject: <think> }`  
Implemented in `chatWrappers/glmJinjaChatWrapper.js` (extends `JinjaTemplateChatWrapper.generateContextState`).  
Same pattern as `HarmonyChatWrapper` for gpt-oss.

### 3. GLM-4.7 tool JSON inside thinking dropdown

When the thought segment is open, **all bytes** (including `` ```json `` tool fences) route to `segmentType: 'thought'` via `SegmentHandler`. This is correct parser behavior.

**Not a regex problem.** Short-term fix: forced-open + close tag separates thinking from post-close visible content.

**XML tools (long-term, optional — NOT implemented, NOT in scope for v0.3.87):**  
GLM's GGUF Jinja template already defines an XML tool-call format (`<tool_call>`, etc.) when `tools` are passed to the template renderer. node-llama-cpp can drive that via its `functions` API instead of appending a 15K-char JSON catalog to the system prompt. That would be a **separate, opt-in path** per model template capability — raw JSON tool parsing remains the universal fallback for all models. guIDE does not switch GLM to XML-only; it would add native function calling where the template supports it, with text-prompt fallback unchanged for everything else.

### 4. Tools executing after user stop

**Fix:** Gate `parseToolCalls` / execute loop when `stopReason === 'abort' | 'cancelled'`.

---

## What node-llama-cpp 3.18.1 already provides

| Capability | Status |
|------------|--------|
| `<think>` in `extractSegmentSettingsFromTokenizerAndChatTemplate` | Yes |
| `onResponseChunk` with `segmentType: thought \| comment` | Yes |
| `JinjaTemplateChatWrapper.segments.thoughtTemplate` | Yes |
| `noPrefixTrigger` forced-open segments | Yes (Harmony uses it; Jinja does not by default) |
| `reopenThoughtAfterFunctionCalls` | Yes (disabled for GLM — raw JSON tools are not native function calls) |

---

## llama.cpp source rebuild (separate track)

Bundled binary may lag for **Gemma 4** and other new arches. For GLM thinking specifically, **3.18.1 APIs are sufficient** once wired correctly.

CI already runs `npx node-llama-cpp source download --release latest` per `scripts/build-installers.js` and `.github/workflows/build.yml`. No additional npm upgrade needed for GLM thinking.

---

## Verification checklist (v0.3.87 test)

After load, log should show:
```
JinjaTemplateChatWrapper: enable_thinking=true, thoughtSegment=true, forcedOpen=true
✓ B4: Native onResponseChunk thought segments active
```

During GLM-4.6 generation:
- Reasoning appears **only** in thinking dropdown
- No `orphan </think> consumed` lines (raw parser inactive when B4 active)

After user stop:
- `Skipping tool parse/execute — generation stopReason=abort`

After `_sfNativeThinkActive` confirmed on GLM + DeepSeek:
- **Remove** `_sfProcessChunk` think-tag state machine (~200 lines)
- **Remove** `retroactiveThinkingMove` frontend handler

---

## Explicitly not doing

- Regex/heuristic GLM output sniffing
- Improving orphan-close retroactive handler
- Post-stream thinking strip from visible text
- toolParser Method 1.1 regex recovery expansion
