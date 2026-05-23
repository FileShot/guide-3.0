# Phase B — production approach (single path, code-based)

**Status:** Implemented in v0.3.103 (`chatEngine.js`). Investigation from **actual code** + [node-llama-cpp context shift guide](https://node-llama-cpp.withcat.ai/guide/chat-context-shift). Not from `CHANGES_LOG.md`.

**No option menu.** This is the one approach production clients use, adapted to guIDE’s architecture.

---

## Short and narrow

When the bucket is almost full, **drop oldest chat turns** until the **real token count** of the full prompt (system + tools + history) fits — measured with the same tokenizer the model uses — then continue generation. Never show the raw library error to the user.

---

## Item 4 clarification (all tools, not one)

Phase C change is in the **`for (const fc of pendingCalls)` loop** in `chatEngine.js` (~2341). Every native tool call uses `fc.functionName` — all ~69 tools when native FC is active.

What was wrong before:

- Only **`write_file`** was hidden in the **UI** (`App.jsx` skipped `FILE_WRITE_OPS`).
- Backend always logged every native tool; UI just didn’t show most of them.

What we changed:

- Emit `tool-generating` + `tool-executing` for **every** native tool name.
- Stop skipping `write_file` / `create_file` / `append_to_file` in the UI handler.

Prose path was already generic (`tool-generating` fires for any `"tool":` in JSON). Native path now matches.

---

## What the code does today (facts)

| Piece | Location | Behavior |
|--------|----------|----------|
| System + tools in one message | `chatEngine.js` ~1385 | `_chatHistory[0].text = basePrompt + toolPrompt` |
| Tool result size cap | `chatEngine.js` ~2576–2612 | Per-tool cap from `BASE_TOOL_RESULT_INJECT_CHARS` (32000 base) × context ratio × `TOOL_INJECT_MULTIPLIERS` (e.g. `fetch_webpage: 0.5`) |
| Between-round compaction | `chatEngine.js` ~2755–2851 | Summarize **old** tool-result user messages when history > 6 msgs |
| Context shift | `chatEngine.js` ~3283–3470 | Char/`tokenize(item)` estimates; budget = `maxTokensCount * 0.92` |
| On shift failure | node-llama-cpp | Throws: *“default context shift strategy did not return a history that fits”* |

**Gap (from log + node-llama-cpp docs):** `_contextShiftStrategy` does **not** verify the returned history with `generateContextState` + tokenizer before return. Estimates can say “fits” while the **rendered** prompt (what LlamaChat actually feeds the model) does not.

Official requirement ([node-llama-cpp guide](https://node-llama-cpp.withcat.ai/guide/chat-context-shift)):

> Return a chat history that when **tokenized** will be shorter than `maxTokensCount`. If invalid / too long → evaluation aborts with error.

Official fix pattern ([discussion #394](https://github.com/withcatai/node-llama-cpp/discussions/394)):

> Use the chat wrapper’s **`generateContextState`** on the candidate history, then tokenize, and loop until under the limit.

That is the industry-standard contract — not “pick truncation OR budget OR recovery.”

---

## The one production approach (Phase B implementation)

### Principle

**Rendered-token fit:** A generation or continuation only starts when `tokenCount(render(fullHistory)) + reserveForNewTokens ≤ contextSize`.

**Shift = drop oldest middle turns** (keep system slot + latest work), same as llama.cpp / Ollama / node-llama-cpp examples — not exotic summarization first.

**Tool results:** Keep existing inject caps and between-round compaction (`chatEngine.js` 2576+, 2755+). Shift handles what’s already in `chatHistory`.

### Implementation steps (single PR)

1. **`_measureRenderedTokens(chatHistory, tokenizer)`**  
   - Call `this._chat.generateContextState({ chatHistory, availableFunctions })` when native FC tools are active (pass converted defs).  
   - Tokenize rendered state; return count.  
   - Fallback: current per-item estimate only if `generateContextState` unavailable.

2. **Rewrite `_contextShiftStrategy`**  
   - `budget = floor(maxTokensCount * 0.92) - reservedGenerationTokens` (e.g. 512–1024).  
   - Keep `chatHistory[0]` (system+tools) but allow **replace with minimal system stub** only if still over budget after dropping all middle messages.  
   - Drop oldest user/model pairs from the middle (never drop latest user message / in-flight assistant).  
   - After each drop pass, **re-measure with `_measureRenderedTokens`**.  
   - Loop until `measured ≤ budget` or only `[systemStub, lastUser, lastModel]` remain.  
   - **Assert before return:** if still `> budget`, truncate `lastItem` text (tool-result messages: keep head per existing `RE_TOOL_OR_SYSTEM_INJECT` logic).

3. **Pre-flight before every `generateResponse` (including continuations)**  
   - If `this._sequence.nextTokenIndex + measuredHistory + reserve > contextSize * threshold` (e.g. 85%), run shift **before** calling generate — don’t wait for library failure at 74% UI meter.

4. **Last resort (still not “hide error”)**  
   - If after maximum compression it still does not fit: abort **this turn** with a single user-facing message: *“Context full — start a new session or reduce tool-heavy task.”*  
   - Log full diagnostics (measured tokens, budget, history msg count, system char len).  
   - This should be unreachable on normal 4GB–128GB hardware once (2)–(3) are correct; it is a safety net, not the main path.

### What we are NOT doing as the primary fix

- Menu of “budget fix vs truncate vs recovery.”
- Trusting `CHANGES_LOG.md` for caps (code at 2576+ is source of truth).  
- Relying on char/3 guesses without a final `generateContextState` check.  
- Returning raw node-llama-cpp exception strings to the UI.

### Research note (llama-server)

Recent llama.cpp server discussions stress **client-side compaction** before send when input already exceeds context — server may return 400 instead of silent truncate. guIDE is the client; **we** must compact before `generateResponse`. That matches step (3).

---

## Test criteria (Phase B done when)

1. Reproduce path: multi-tool web fetch at ~70% UI context → **no** “context shift strategy” error; generation continues or shows intentional “context full” safety net only in extreme case.  
2. Log lines include `renderedTokens=… budget=…` on every shift.  
3. Works on 4GB VRAM / 8k–30k ctx and on large-RAM configs (same code path, no hardcoded 8k).  
4. User message at 79% UI does not guarantee failure (meter vs measured tokens documented in log).

---

## Approval

Implement Phase B per this document only — no alternate branches.
