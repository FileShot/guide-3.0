# Plan: Native FC maxTokens Interrupt — Root Cause Fix

## 1. The Bug

The user observes a 15-minute silent generation where:
- Context usage climbs from ~14K to 19,560/19,712 (99%)
- No tool call bubbles appear in the UI
- No prose text appears in the UI
- Generation ends abruptly with `stopReason=maxTokens`
- `genTokens=1` in the diagnostic, yet ~5,233 context tokens were consumed
- The entire 15-minute generation produces nothing visible

## 2. The Evidence

### Log evidence (from previous session's log read)
- `genTokens=1` — only 1 `onTextChunk` callback fired (chatEngine.js:2203 increments this counter)
- `visibleLen=2` — only 2 characters of visible prose were produced
- `ctxUsed=19560/19712` — 99% context consumed
- `stopReason=maxTokens` — generation hit the 5,385 token budget
- No `[StreamDiag] FC` logs — FC callback's DONE log never fired
- No `[StreamDiag] PROSE` logs — no prose text was generated
- No `[StreamDiag] THINK` logs — either no thinking happened, or thinking was not logged

### Code evidence

**`genTokenCount` only counts prose tokens:**
- `@chatEngine.js:2203` — `genTokenCount++` inside `onTextChunk` only
- `@chatEngine.js:1497` — initialized to 0
- `@chatEngine.js:3269` — diagnostic uses `genTokenCount`, showing 1 when 5,385 were actually generated

**`generatedTokens` in node-llama-cpp counts ALL tokens:**
- `@LlamaChat.js:1895` — `this.generatedTokens++` on EVERY token iteration
- `@LlamaChat.js:2065-2066` — `isMaxTokensTriggered()` checks `this.generatedTokens >= this.maxTokens`
- This includes thinking tokens, prose tokens, AND FC grammar tokens

**FC params streaming loop calls `onFunctionCallParamsChunk` per token:**
- `@LlamaChat.js:1655-1660` — `this.onFunctionCallParamsChunk?.(...)` called on every yielded token
- `@LlamaChat.js:1664-1666` — BUT `handleMaxTokensTrigger("model")` can interrupt and return immediately
- When maxTokens fires mid-FC, the partial FC result is discarded — `result.functionCalls` is undefined

**`handleMaxTokensTrigger` returns a result with `stopReason=maxTokens`:**
- `@LlamaChat.js:2076-2093` — returns `{ response: ..., metadata: { stopReason: "maxTokens" } }`
- `response` only contains string segments (`.filter(segment => typeof segment === "string")`)
- FC grammar tokens are NOT string segments — they're in a different format
- So `result.response` contains only the 2 visible prose chars, not the FC params

**Native FC dispatch requires `stopReason === 'functionCalls'`:**
- `@chatEngine.js:2546` — `if (_useNativeFunctions && result.metadata?.stopReason === 'functionCalls' && result.functionCalls?.length)`
- When `stopReason=maxTokens`, this condition is false
- Falls through to prose JSON fallback path

**Prose JSON fallback finds 0 tool calls:**
- `@chatEngine.js:2655` — `parseToolCalls(fullResponse)` — but `fullResponse` is only 2 chars
- 0 tool calls found → tool loop never executes → no continuation

**No seamless continuation for maxTokens stops without tool calls:**
- The tool loop at `@chatEngine.js:2697` only runs when `parsedCalls.length > 0`
- The native FC tool loop at `@chatEngine.js:2558` only runs when `pendingCalls.length > 0`
- Neither loop executes when maxTokens stops generation with 0 tool calls
- Generation simply ends at `@chatEngine.js:3248` — "Generation complete"

**Context shift didn't fire because context wasn't full enough:**
- `@LlamaChat.js:2134-2136` — `updateShouldContextShift()` checks `nextTokenIndex >= contextSize - 1`
- `contextSize - 1 = 19711`, but `nextTokenIndex = 19560`
- 19560 < 19711, so context shift condition was NOT met
- maxTokens (5385) was hit before the context window was exhausted

**Summarizer was NOT triggered:**
- `_preflightContextBeforeGenerate` runs BEFORE generation (line 3858) — context was fine at that point
- `_generateResponseSafe` catch block (line 3882) only fires on context shift strategy errors
- No context shift occurred during generation (19560 < 19711)
- Therefore, no summarizer was triggered

## 3. The Cause

Three distinct but related root causes:

### Root Cause A: `genTokenCount` is invisible to the maxTokens budget

`genTokenCount` in chatEngine.js only counts `onTextChunk` tokens (visible prose). It does NOT count:
- Thinking tokens (handled by `onResponseChunk` with `segmentType='thought'`)
- FC grammar tokens (handled by `onFunctionCallParamsChunk`)

Meanwhile, `generatedTokens` in node-llama-cpp counts ALL tokens and is the counter that triggers `maxTokens`. This means:
- chatEngine.js has NO visibility into how many tokens have been generated
- The diagnostic `genTokens=1` is misleading — 5,385 tokens were actually generated
- There is no way for chatEngine.js to know that the generation is approaching maxTokens

### Root Cause B: maxTokens interrupts native FC generation, partial result discarded

When the model enters the native FC grammar path (generating function call params), `generatedTokens` continues incrementing. If `generatedTokens >= maxTokens` fires mid-FC:
1. `handleMaxTokensTrigger("model")` at `@LlamaChat.js:1664` returns immediately
2. The partial FC params are NOT included in `result.functionCalls` (only populated when `stopReason=functionCalls`)
3. `result.response` only contains the 2 visible prose chars
4. chatEngine.js falls through to prose JSON fallback, finds 0 tool calls
5. No continuation is triggered
6. 15 minutes of generation produces nothing

### Root Cause C: No seamless continuation for maxTokens stops without tool calls

RULES.md Section 2 defines "Seamless continuation" as a core system: "when generation hits maxTokens, the pipeline continues in the same response without user intervention." This is currently ONLY implemented inside the tool loop (after tool execution, a continuation generation is triggered). There is NO continuation for:
- Prose-only generation that hits maxTokens (response truncated mid-sentence)
- Native FC generation interrupted by maxTokens (partial FC discarded)

## 4. How Other Tools Handle This

- **Ollama**: Generation stops at `num_predict` limit. No automatic continuation. User must send another message.
- **LM Studio**: Same behavior — stops at max_tokens. No continuation.
- **llama.cpp CLI**: Stops at `n_predict` limit. No continuation.
- **Claude/GPT APIs**: Return `finish_reason: "length"`. Caller decides whether to continue with another API call.
- **Continue.dev**: Implements continuation by sending the partial response back as context and requesting more.

The industry standard is: the CALLER handles maxTokens continuation, not the inference engine. node-llama-cpp correctly returns `stopReason=maxTokens` — it's chatEngine.js's responsibility to continue.

## 5. The Fix

### Fix 1: Track all generated tokens in chatEngine.js

**File:** `chatEngine.js`
**Location:** `onTextChunk` callback (line ~2203), `onResponseChunk` callback (line ~2212), `onFunctionCallParamsChunk` callback (line ~2295)

Add a new counter `totalGenTokens` that increments on EVERY token callback:
- In `onTextChunk`: `totalGenTokens++` (already have `genTokenCount++`)
- In `onResponseChunk`: when `chunk.segmentType === 'thought'`, increment `totalGenTokens` by the token count from `chunk.tokens?.length || 1`
- In `onFunctionCallParamsChunk`: increment `totalGenTokens` by 1 per chunk (each chunk is one token yield from `evaluateWithContextShift`)

Update the inference diagnostic at line 3269 to log both `genTokens=${genTokenCount}` (prose only) and `totalGenTokens=${totalGenTokens}` (all tokens).

**Observable effect:** The diagnostic will show the real token count, making maxTokens budget tracking visible.

### Fix 2: Seamless continuation for maxTokens stops

**File:** `chatEngine.js`
**Location:** After the tool loop ends (after line 3232), before "Generation complete" log (line 3248)

Add a continuation loop that triggers when `stopReason === 'maxTokens'` and no tool calls were dispatched:

```
// Seamless continuation: when maxTokens stops generation without tool calls,
// continue generating from where the model left off.
let continuationRound = 0;
const MAX_CONTINUATION_ROUNDS = 10; // safety limit
while (stopReason === 'maxTokens' && continuationRound < MAX_CONTINUATION_ROUNDS) {
  continuationRound++;
  const ctxUsedNow = this._sequence?.nextTokenIndex || 0;
  const ctxAvailNow = contextSize - ctxUsedNow;
  if (ctxAvailNow < MIN_GENERATION_TOKENS) break; // no room to continue
  
  genOptions.maxTokens = Math.max(MIN_GENERATION_TOKENS, ctxAvailNow);
  console.log(`[ChatEngine] Seamless continuation #${continuationRound}: maxTokens=${genOptions.maxTokens}, ctxUsed=${ctxUsedNow}/${contextSize}`);
  
  // Reset streaming filter state for continuation
  _sfBuf = ''; _sfDepth = 0; _sfActive = false; /* ... all _sf* resets ... */
  
  result = await this._generateResponseSafe(genOptions, {
    contextSize,
    onStreamEvent,
    functions: _useNativeFunctions ? functions : undefined,
    documentFunctionParams: _useNativeFunctions ? true : undefined,
    userMaxTokensCap: userMaxTokens,
  });
  
  this._chatHistory = result.lastEvaluation.cleanHistory;
  if (onContextUsage && this._sequence) {
    onContextUsage({ used: this._sequence.nextTokenIndex, total: this._context.contextSize });
  }
  
  const contStopReason = result.metadata?.stopReason || 'natural';
  const contResponse = result.response || '';
  fullResponse += contResponse;
  
  // If this continuation produced tool calls, break out to the tool dispatch logic
  if (_useNativeFunctions && contStopReason === 'functionCalls' && result.functionCalls?.length) {
    // Re-enter native FC dispatch — need to handle this carefully
    break; // let the existing native FC path handle it on next iteration
  }
  
  const contParsed = parseToolCalls(contResponse);
  if (contParsed.length > 0) {
    // Tool calls found in continuation — break out to prose tool dispatch
    break;
  }
  
  stopReason = contStopReason;
  if (contStopReason !== 'maxTokens') break; // natural end or other stop
}
```

**Observable effect:** When maxTokens stops generation, the pipeline automatically continues. For native FC interrupted by maxTokens, the continuation gives the model another chance to complete the function call. For prose-only generation, the continuation picks up where the response left off.

### Fix 3: Surface partial FC result on maxTokens interrupt

**File:** `chatEngine.js`
**Location:** After `_generateResponseSafe` returns (line ~2489), before tool dispatch

When `stopReason=maxTokens` and `_useNativeFunctions` is true, check if any FC params were partially generated. If so, log a warning and emit a `generation-warning` event to the UI:

```
if (_genStopReason === 'maxTokens' && _useNativeFunctions) {
  console.warn(`[ChatEngine] maxTokens interrupted native FC generation — ${totalGenTokens} tokens generated, partial FC result discarded`);
  if (onStreamEvent) {
    onStreamEvent('generation-warning', {
      message: 'Generation hit token limit during tool call — continuing',
      suggestion: 'The model will continue generating to complete the tool call.',
    });
  }
}
```

**Observable effect:** The user sees a warning that a tool call was interrupted, rather than 15 minutes of silence.

### Fix 4: Remove [StreamDiag] FORWARD log bloat

**File:** `chatEngine.js`
**Location:** `_sfForward` function

Reduce the FORWARD diagnostic counter from every ~100 chars to every ~1000 chars, or remove it entirely since the investigation is complete. The counter was added in v0.3.143 as a diagnostic and is now bloating the log file.

## 6. What Could Go Wrong

- **Continuation loop could run indefinitely:** The `MAX_CONTINUATION_ROUNDS=10` safety limit prevents this. Each round also checks `ctxAvailNow < MIN_GENERATION_TOKENS`.
- **Continuation could produce duplicate content:** The model sees its previous partial output in the context and should continue from where it left off. But some models might repeat the last few tokens. This is an inherent risk of continuation — it exists in the tool loop continuation too.
- **Native FC continuation might not complete the FC:** After maxTokens interrupts FC generation, the continuation generation starts fresh. The model may not re-enter the FC grammar path — it might generate prose instead. This is acceptable: the prose will be visible to the user, and if it contains tool call JSON, the prose parser will catch it.
- **Context could fill during continuation:** If context shift fires during a continuation, `_generateResponseSafe`'s catch block handles it. The continuation loop will see the new `stopReason` and break.
- **Streaming filter state reset:** The `_sf*` variables must be reset for each continuation round, just like they are in the tool loop continuation (lines 3133-3159). Missing any reset could cause UI corruption.
- **`totalGenTokens` may not exactly match `generatedTokens`:** The token count from `onResponseChunk` chunks may differ from node-llama-cpp's internal `generatedTokens` due to token batching. This is acceptable — the counter is for diagnostic visibility, not for budget enforcement.

## 7. What's Been Tried Before

- **v0.3.143 Issue 3 (R53-Fix):** Fixed ChatPanel.jsx finalization to use `result.text` as authoritative prose. This fixed the IPC ordering lag but did NOT address the maxTokens interrupt issue.
- **Native FC streaming callback wiring (earlier):** The `onFunctionCallParamsChunk` callback was correctly wired in chatEngine.js:2295-2374. This ensures FC params ARE streamed when the callback fires. But it doesn't help when maxTokens interrupts FC generation before completion.
- **Thinking budget cap (line 3873):** `thoughtTokens` is capped to 75% of maxTokens to prevent thinking from consuming the entire budget. But this cap doesn't account for FC grammar tokens — the remaining 25% may not be enough for a large FC params payload.

No previous fix has addressed the core issue: **maxTokens interrupts native FC generation, the partial result is discarded, and no continuation is triggered.**

## 8. Implementation Order

1. **Fix 1** (totalGenTokens counter) — diagnostic visibility, no behavior change
2. **Fix 4** (FORWARD log bloat) — cleanup, no behavior change
3. **Fix 3** (partial FC warning) — user-facing warning, no behavior change
4. **Fix 2** (seamless continuation) — the actual behavior fix, most complex

Fix 2 is the critical fix. It requires careful implementation of the continuation loop with all the streaming filter resets and tool dispatch re-entry logic. The existing tool loop continuation (lines 3133-3231) serves as a reference implementation — the new continuation should follow the same pattern.
