# Bug Fix Plan — guIDE v0.3.82

Based on: guide-main.log (1681 lines), git history (30 commits), build.yml, chatEngine.js, appStore.js, ChatPanel.jsx, modelProfiles.js, and web research on how Ollama/LM Studio handle the same models.

---

## Bugs Found in Logs (cataloged from guide-main.log)

| # | Bug | Log Evidence | User-Visible Symptom |
|---|-----|-------------|---------------------|
| 1 | Gemma 4 won't load | Lines 74, 118: `unknown model architecture: 'gemma4'` | Can't use Gemma 4 at all |
| 2 | GLM outputs duplicated text | Lines 445, 457, 465, 490: orphan `</think>` consumed, raw response contains same text twice | Same response appears twice |
| 3 | Context collapses to 2048 on all models | Lines 40-42, 132-134, 236-238: `Context collapsed to 2048 (1.8% of desired)` | Models have almost no working memory |
| 4 | Context shift fails after tool calls | Lines 216-220, 306-310: `Failed to compress chat history for context shift` | Conversation dies after first tool use |
| 5 | maxTokens always 2048 | Lines 156, 260, 326, 371, 443, 485: `maxTokens=2048` | Responses cut short |
| 6 | Generation space critical | Lines 322-326, 367-371: `GENERATION SPACE CRITICAL: 1/2048 tokens available` | Model has no room to generate |
| 7 | Tool prompt is 37% of context | Lines 152, 256, 318, 363: `Tool prompt injected (2625 chars, ctx=2048, finalPct=37%)` | Most of context is tools, not conversation |
| 8 | Model loading race conditions | Lines 36-38, 85-87, 89-90: `Already loading a model` | Switching models causes errors |
| 9 | cancelGeneration called with no abortController | Lines 28, 37, 56, 67, 77-78, 86, 106, 124, 222, 406 | Harmless log spam but indicates sloppy state management |
| 10 | Models output plain text instead of tool calls | Lines 346-347, 395-396: `0 tool calls parsed` | Model ignores tools, just talks |
| 11 | Vision mmproj matched to wrong model | Lines 47-50, 138-143, 242-247: mmproj from different model matched | Vision might use wrong projector |
| 12 | Phi SWA disabled warning | Line 231: `Phi SWA is currently disabled` | Phi models may underperform |

---

## Bug 1: Gemma 4 Won't Load

### What the user sees
Selecting any Gemma 4 model immediately fails with "Failed to load model."

### What the logs show
```
llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'gemma4'
```

### What causes it
The CI build pipeline at `.github/workflows/build.yml` line 90 downloads and compiles llama.cpp from source at release tag `b8779`:

```yaml
npx --no node-llama-cpp source download --release "b8779" --gpu false --noUsageExample
```

Release `b8779` was created **before** gemma4 architecture support was added to llama.cpp. Gemma 4 support was added in PR #21309 on April 2, 2026. The current latest llama.cpp release is `b9253` (May 20, 2026).

The installed app at `C:\Program Files\guIDE\resources\app\node_modules\node-llama-cpp` contains a llama.cpp binary compiled from b8779, which does not recognize the `gemma4` architecture.

### Why previous attempts failed
Looking at the git history, builds v0.3.66 through v0.3.76 all attempted to fix this:

- **v0.3.66**: `CI: use --skipBuild for llama.cpp source download to avoid compilation failures on runners` — compilation was failing on CI
- **v0.3.67**: `Pin llama.cpp to release b9209` — tried a newer release but hit macOS API failures
- **v0.3.68-70**: API rate limit fixes when downloading llama.cpp source from GitHub
- **v0.3.71**: `CI: preserve node-llama-cpp metadata files during llama.cpp source update` — metadata files were being lost
- **v0.3.72**: `Fix A: Build llama.cpp from source (Gemma 4 support)` — explicit attempt to build from source for gemma4
- **v0.3.73-74**: CI syntax fixes for the source download command
- **v0.3.75**: `CI: auto-detect latest llama.cpp tag for Gemma4 support` — tried auto-detecting latest tag
- **v0.3.76**: `Upgrade node-llama-cpp to ^3.18.1 (Gemma 4 support)` — upgraded the npm package

The common failure pattern: newer llama.cpp releases either failed to compile on CI runners, or the source download hit GitHub API rate limits, or the node-llama-cpp metadata files got corrupted. Each attempt was reverted back to the working b8779 pin.

### How other tools handle this
- **Ollama**: Ships its own pre-compiled llama.cpp binary with each release. They update their llama.cpp submodule to the latest commit that includes gemma4 support.
- **LM Studio**: Bundles a pre-compiled llama.cpp binary. They update it with each release.
- **node-llama-cpp** (the npm package): The `source download` command is designed to let users compile llama.cpp from any release tag. The npm package itself (v3.18.1) doesn't include a pre-compiled binary — it downloads and compiles at install time or via the `source download` command.

### The fix
Change the release tag in build.yml from `b8779` to a release that includes gemma4 support. The latest release as of today is `b9253`.

The change is in 5 places in `.github/workflows/build.yml`:
- Line 90: `--release "b8779"` → `--release "b9253"` (Windows CPU)
- Line 154: `--release "b8779"` → `--release "b9253"` (Windows CUDA)
- Line 217: `--release "b8779"` → `--release "b9253"` (Linux CPU)
- Line 285: `--release "b8779"` → `--release "b9253"` (Linux CUDA)
- Line 355: `--release "b8779"` → `--release "b9253"` (macOS Metal)

**Risk**: Newer llama.cpp releases may require newer CMake or compiler versions that the CI runners don't have. The CI already installs CMake 4.2.1 and CUDA 13.1.0, which should be sufficient. If compilation fails, the specific error will tell us what's missing.

**This is not a band-aid.** The root cause is that the llama.cpp binary doesn't have the gemma4 architecture. Updating to a release that includes it is the only fix.

---

## Bug 2: GLM Outputs Duplicated Text

### What the user sees
When chatting with GLM models, the response appears twice — once in the thinking dropdown and once in the main chat area, with the same text in both places.

### What the logs show
```
[ChatEngine] orphan  response consumed — retroactively marking preceding text as thinking
```

Raw model response:
```
Hello! I'm ready to help. How can I assist you today? response
Hello! I'm ready to help. How can I assist you today?
```

The model outputs the same text twice — once before ` response` (as thinking) and once after (as the visible answer).

### What causes it — the full pipeline

**Step 1 — Backend streaming**: The model generates text character by character. `chatEngine.js` receives each chunk via `onTextChunk` (line 1669) which calls `_sfProcessChunk` (line 1097).

**Step 2 — Streaming filter**: `_sfProcessChunk` forwards text to the frontend via `_sfForward` (line 1056), which calls `onToken(text)`. When it detects the orphan ` response` tag (line 1195-1203), it emits `llm-thinking-retroactive` with `{ length: _sfVisibleChars }`. This tells the frontend: "the last N characters of visible text were actually thinking content."

**Step 3 — Frontend retroactive move**: `appStore.js` `retroactiveThinkingMove` (line 679) takes the last N characters from `chatStreamingText`, moves them to `chatThinkingText`, and converts the corresponding `text` segments to `thinking` segments in `streamingSegments`.

**Step 4 — Model continues**: After ` response`, the model outputs the same text again as its visible answer. This goes through `_sfForward` → `onToken` → `appendStreamToken` → `chatStreamingText` as new `text` segments.

**Step 5 — Finalization**: When generation ends, `ChatPanel.jsx` `finalizeStreamingMessage` (line 1294) iterates all segments and builds `messageContent`:
- Line 1372: `messageContent += seg.content` for `text` segments
- Line 1406: `messageContent += seg.content` for `thinking` segments ← **THIS IS THE BUG**

Both thinking content AND text content are concatenated into `messageContent`. Since GLM outputs the same text before and after ` response`, the same content appears in both thinking segments and text segments, and both get appended to `messageContent`.

**Step 6 — Rendering**: When rendering a finalized message with segments, the code iterates `msg.segments` and renders each one. `thinking` segments render as `FinalizedThinkingBlock` (the expandable thinking dropdown). But `msg.content` (which includes thinking text from step 5) is also used as fallback content and for search.

### How other tools handle this
- **Ollama**: Uses the model's Jinja2 chat template which includes `  ` in the assistant prefix. The template parser knows that content between `  ` and ` ` is thinking, and content after ` ` is the response. The thinking content goes to a separate thinking panel, and the response goes to the chat. The thinking content is NEVER included in the main message text.
- **LM Studio**: Same approach — chat template separates thinking from response at the template level.

### The fix
**Change finalization to NOT append thinking segment content to `messageContent`.**

In `ChatPanel.jsx`, line 1404-1408:
```js
} else if (seg.type === 'thinking') {
  messageContent += seg.content;  // ← REMOVE THIS LINE
  messageSegments.push({ type: 'thinking', content: seg.content });
}
```

Change to:
```js
} else if (seg.type === 'thinking') {
  messageSegments.push({ type: 'thinking', content: seg.content });
  // Thinking content stays in segments for FinalizedThinkingBlock rendering.
  // It is NOT appended to messageContent because that would duplicate it
  // in the main message display.
}
```

**What this means for the user**: Thinking content appears in the thinking dropdown (FinalizedThinkingBlock), exactly where it belongs. It does NOT also appear in the main message text. The main message only contains the model's actual response (text after ` response`).

**This is not hiding thinking content.** It's putting it in the correct UI location (the dropdown) instead of duplicating it in both the dropdown AND the main message.

**Edge case — messages with only thinking, no text**: The code at line 1512-1522 already handles this — if `messageContent` is empty after processing all segments, it uses a placeholder. This still works because thinking content is in segments, not in messageContent.

**Edge case — search**: `messageContent` is used for conversation search. After this fix, thinking content won't be searchable in `messageContent`. This is correct — thinking is internal reasoning, not part of the conversation.

---

## Bug 3: Context Collapses to 2048

### What the user sees
Models have almost no memory. They forget previous messages immediately. Responses are short and disconnected.

### What the logs show
```
Context collapsed to 2048 (1.8% of desired 112063).
Likely cause: GPU layers consumed too much VRAM, leaving none for KV cache.
```

This happens for Qwen (line 40-42), Llama 3.2 (line 132-134), and Phi (line 236-238).

### What causes it
The GPU layer computation at `chatEngine.js` lines 514-540 computes how many model layers to put on GPU. It uses all available VRAM for model weights, leaving almost nothing for the KV cache (which stores conversation context).

On the user's RTX 3050 Ti (4GB VRAM):
- Model weights: 2.5-3.4 GB
- After loading all layers on GPU: 0.12-0.41 GB free VRAM
- KV cache needs ~0.5 GB minimum for 2048 context
- Result: context collapses to 2048

The formula at line 514-540 computes `gpuLayers` first (maximizing GPU layers), then computes `contextSize` from remaining VRAM. This prioritizes speed (GPU layers) over context size.

### How other tools handle this
- **Ollama**: Uses a balanced approach — reserves VRAM for KV cache before allocating GPU layers. If VRAM is tight, it reduces GPU layers to free up space for context.
- **LM Studio**: Lets the user choose between "GPU Offload" (speed) and "Context Length" (memory) with a slider.

### The fix
The GPU layer computation should reserve VRAM for a minimum viable context before allocating GPU layers.

In `chatEngine.js`, the `_computeGpuLayers` function (around line 514) should:
1. First, compute how much VRAM is needed for a minimum context (e.g., 4096 tokens)
2. Subtract that from available VRAM
3. Then compute how many GPU layers fit in the remaining VRAM
4. If even minimum context doesn't fit, fall back to 2048 with a clear warning

This is a change to the VRAM budgeting formula, not a band-aid. It addresses the root cause: the formula prioritizes GPU layers over context size.

---

## Bug 4: Context Shift Fails After Tool Calls

### What the user sees
After the model uses a tool (browser, file read, etc.), the next response fails with an error. The conversation dies.

### What the logs show
```
Context shift: kept 0 items, dropped 3. Budget: 1696, used: 2723
Failed to compress chat history for context shift due to a too long prompt or system message
```

### What causes it
When context is 2048 and the model has used tools, the conversation history grows:
- System prompt: ~800 tokens
- Tool prompt: ~700 tokens (2625 chars at ~3.8 chars/token)
- User message + tool call + tool result: ~500 tokens
- Total: ~2000 tokens used, only 48 left for generation

The context shift strategy at `chatEngine.js` line 2684 tries to fit history into the remaining budget, but when the budget is negative (system prompt + tool prompt already exceed context), it fails.

### How other tools handle this
- **Ollama**: Automatically manages context by evicting old messages when context is full. Uses a sliding window that always keeps the system prompt and most recent messages.
- **LM Studio**: Same sliding window approach.

### The fix
The context shift strategy should handle the case where `budget < 0` by compressing the prompt, not by failing.

In `chatEngine.js` `_contextShiftStrategy` (line 2684), when `budget < 0`:
1. First, try using the compact tool prompt (already done — line 152 shows `compactAvailable=true`)
2. If still doesn't fit, strip the tool prompt entirely for this round (the model can still respond, just can't call tools)
3. If still doesn't fit, use an ultra-minimal system prompt: "You are a helpful AI assistant."
4. Only fail if even the ultra-minimal prompt + last message doesn't fit

This is graceful degradation — the response quality decreases but the conversation doesn't die.

---

## Bug 5: maxTokens Always 2048

### What the user sees
Responses are short. Even when context is 76800 (GLM), maxTokens is still 2048.

### What the logs show
```
Generation setup: maxTokens=2048, contextSize=76800, usedTokens=0, available=76800
```

### What causes it
The frontend default `maxResponseTokens` is 2048 (`appStore.js` line 1779, `settingsManager.js` line 23). This is passed as `maxTokens` to the backend (`ChatPanel.jsx` line 1178). The backend formula at `chatEngine.js` line 1797 caps generation at `min(availableForGeneration, userMaxTokens)`.

When `userMaxTokens = 2048` and `availableForGeneration = 76800`, the formula gives `min(76800, 2048) = 2048`. This wastes 74752 tokens of generation space.

### The fix
Change the default `maxResponseTokens` from 2048 to 0 (meaning "no cap — use all available space").

The backend already handles 0 correctly at line 1797: `(options.maxTokens > 0) ? options.maxTokens : Infinity`. When maxTokens is 0, `userMaxTokens = Infinity`, and the formula becomes `min(availableForGeneration, Infinity) = availableForGeneration`.

Changes needed:
1. `settingsManager.js` line 23: `maxResponseTokens: 2048` → `maxResponseTokens: 0`
2. `appStore.js` line 1779: `maxResponseTokens: 2048` → `maxResponseTokens: 0`
3. `appStore.js` line 1913: Same change in DEFAULTS
4. `Sidebar.jsx` line 1415: Change slider min from 256 to 0, add "Auto" label for 0

**Existing users keep their 2048 setting** until they change it. Only new users get the "auto" default.

---

## Bug 6: Generation Space Critical

### What the user sees
Model generates very short responses or fails to generate at all.

### What the logs show
```
GENERATION SPACE CRITICAL: 1/2048 tokens available, need 512. Trimming prompt.
Trimmed tool prompt to 4 tools (1095 chars)
Trimmed history to 5 messages for generation space
```

### What causes it
When context is 2048 and the prompt fills almost all of it, there's no room for generation. The code tries to trim the tool prompt and history, but trimming to 4 tools in 2048 context is still too tight.

### The fix
This is a symptom of Bug 3 (context collapse). Fixing Bug 3 will give models more context, which eliminates the generation space problem. No separate fix needed.

---

## Bug 7: Tool Prompt Is 37% of Context

### What the user sees
Models spend most of their context window on tool definitions instead of conversation.

### What the logs show
```
Tool prompt injected (2625 chars, compact, ctx=2048, finalPct=37%)
```

### What causes it
The compact tool prompt is 2625 characters describing 69 tools. In a 2048-token context, this is ~700 tokens or 37% of the total context. The model has very little room for actual conversation.

### The fix
This is a symptom of Bug 3 (context collapse). When context is 76800 (GLM), the tool prompt is only 6% of context (line 439). Fixing Bug 3 eliminates this problem for most models.

For models where context remains small even after Bug 3 fix, the compact tool prompt should be further reduced — only include the 10 most commonly used tools instead of all 69.

---

## Bug 8: Model Loading Race Conditions

### What the user sees
Switching models quickly causes "Already loading a model" errors.

### What the logs show
```
cancelGeneration called: reason=model-load
cancelGeneration: no abortController exists
API error (POST /api/models/load): Already loading a model
```

### What causes it
When the user clicks to load a new model while one is already loading, the code tries to cancel the current load and start a new one. But the cancellation doesn't properly wait for the previous load to finish, causing a race condition.

### The fix
Add a loading queue or promise tracker in `chatEngine.js`. When a new load request comes in while one is in progress, wait for the current one to finish (or properly cancel it) before starting the new one.

---

## Bug 9: cancelGeneration Log Spam

### What the user sees
Nothing visible — just log spam.

### What the logs show
```
cancelGeneration called: reason=model-load
cancelGeneration: no abortController exists
```
This appears 10+ times in the log.

### What causes it
`cancelGeneration` is called during model loading as a safety measure, but there's no generation in progress, so `abortController` is null. The warning is harmless but clutters the logs.

### The fix
Change the `cancelGeneration: no abortController exists` message from WARN to LOG level, or only log it when `reason` is not 'model-load'.

---

## Bug 10: Models Output Plain Text Instead of Tool Calls

### What the user sees
Model responds with conversational text when it should be calling a tool.

### What the logs show
```
0 tool calls parsed — model output preview: "I apologize for any confusion..."
```

### What causes it
This happens when context is too small (2048) and the tool prompt has been trimmed to 4 tools. The model doesn't have enough context to understand it should use tools, so it falls back to conversational mode.

### The fix
This is a symptom of Bug 3 (context collapse). Fixing Bug 3 gives models enough context to understand tool calling. No separate fix needed.

---

## Bug 11: Vision mmproj Matched to Wrong Model

### What the user sees
Vision features might use the wrong image projector, causing poor image understanding.

### What the logs show
```
VisionServer: Model embedding_length: unknown (from Qwen3.5-4B.Q4_K_S.gguf)
VisionServer: Found compatible mmproj: .../Qwen3.5-2B-Claude-4.6-Opus-Reasoning-Distilled-GGUF/mmproj-BF16.gguf
```

The mmproj from a 2B Qwen variant is matched to a 4B Qwen model. These may have different embedding dimensions.

### What causes it
`visionServer.js` `_findMmproj` matches mmproj files by searching nearby directories. It doesn't verify that the mmproj's embedding dimension matches the model's embedding dimension.

### The fix
In `visionServer.js`, verify that the mmproj's embedding dimension matches the model's before accepting the match. The model's embedding length is available from GGUF metadata.

---

## Summary: What To Fix and In What Order

### Fix 1: Gemma 4 Loading (Bug 1)
- **File**: `.github/workflows/build.yml`
- **Change**: `--release "b8779"` → `--release "b9253"` in 5 places
- **Impact**: Gemma 4 models can load
- **Risk**: CI compilation may fail with newer llama.cpp — need to test

### Fix 2: GLM Duplicated Text (Bug 2)
- **File**: `frontend/src/components/ChatPanel.jsx`
- **Change**: Remove `messageContent += seg.content` for thinking segments (line 1406)
- **Impact**: GLM responses no longer duplicated
- **Risk**: Messages with only thinking content need the existing placeholder fallback

### Fix 3: Context Collapse (Bug 3)
- **File**: `chatEngine.js`
- **Change**: Reserve VRAM for minimum context before allocating GPU layers
- **Impact**: Models get more context (4096+ instead of 2048), which fixes Bugs 6, 7, and 10
- **Risk**: Slightly slower inference (fewer GPU layers)

### Fix 4: Context Shift Failure (Bug 4)
- **File**: `chatEngine.js`
- **Change**: Graceful degradation when prompt doesn't fit — strip tools, then use minimal system prompt
- **Impact**: Conversations don't die after tool use
- **Risk**: Degraded response quality in extreme low-context situations (better than crashing)

### Fix 5: maxTokens Default (Bug 5)
- **Files**: `settingsManager.js`, `appStore.js`, `Sidebar.jsx`
- **Change**: Default maxResponseTokens from 2048 to 0 (auto)
- **Impact**: Models can generate longer responses when context allows
- **Risk**: None — backend already handles 0 correctly

### Fix 6: Model Loading Race (Bug 8)
- **File**: `chatEngine.js`
- **Change**: Queue or await model load requests
- **Impact**: No more "Already loading a model" errors
- **Risk**: Need to handle cancellation properly

### Fix 7: Vision mmproj Verification (Bug 11)
- **File**: `visionServer.js`
- **Change**: Verify embedding dimension match
- **Impact**: Correct mmproj used for vision
- **Risk**: May find fewer mmproj matches (correct behavior)

### Low Priority
- **Bug 9** (log spam): Change WARN to LOG
- **Bug 12** (Phi SWA): Investigate if this affects output quality

---

## What NOT To Do

These approaches have been tried and failed, or are band-aids:

- **Regex-based thinking detection**: The streaming filter already does this. Adding more regex won't fix the root cause.
- **GBNF grammar**: Failed across all 7 models tested (per project history).
- **LlamaChatSession**: RLHF mode overrides system prompt instructions (per project history).
- **Arbitrary detection thresholds**: "If model outputs X, do Y" — these are band-aids that break for different models.
- **Hiding thinking content**: Thinking content should be in the dropdown, not hidden. The fix is to put it in the RIGHT place, not remove it.
