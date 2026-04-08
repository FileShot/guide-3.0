# Context Management Research — guIDE 3.0

> Research compiled for the next model building the pipeline.
> Every strategy below has been researched from primary sources (GitHub repos, papers, official docs).

---

## THE PROBLEM

guIDE runs LLMs locally with finite context windows (2K–128K tokens depending on hardware/model). The user asks the model to generate code — sometimes very long files. The context fills up:
- System prompt tokens + user message tokens + generated tokens = context limit
- When context is full, generation must either stop, crash, or be managed

**Two distinct sub-problems:**
1. **Mid-generation**: The model is generating a long response and hits the context wall
2. **Multi-turn**: After many conversation turns, old history fills the context before any generation starts

Each sub-problem requires a different solution. Most of guide-2.0's failures came from trying to solve both with one system.

---

## STRATEGY 1 — StreamingLLM / Attention Sinks

**Source:** MIT HAN Lab, ICLR 2024 — [arxiv.org/abs/2309.17453](https://arxiv.org/abs/2309.17453)
**Code:** [github.com/mit-han-lab/streaming-llm](https://github.com/mit-han-lab/streaming-llm)
**Stars:** 7.2K | **Integrated by:** NVIDIA TensorRT-LLM, HuggingFace Transformers

### How It Works
- Keep the first ~4 tokens in the KV cache permanently ("attention sinks")
- Maintain a sliding window of the N most recent tokens
- When cache is full, evict the oldest non-sink tokens
- Re-index positions to cache positions (not original text positions)

### Why Attention Sinks Exist
LLMs learn to offload excess attention scores to the first few tokens (regardless of their semantic content). When those tokens are evicted from a sliding window, the attention distribution breaks — the model loses coherence and generates garbage (broken unicode, repeated words, nonsense).

Keeping just 4 initial tokens as permanent "sinks" completely prevents this collapse.

### Key Properties
- Constant memory usage (window size is fixed)
- Stable perplexity — proven up to **4 million tokens**
- 22.2x faster than sliding window with recomputation
- Does NOT expand the context window — model only sees recent tokens
- Does NOT enable long-range recall — old middle content is lost

### Relevance to guIDE
**Solves sub-problem 1 (mid-generation) excellently.** During long file generation, the model can keep generating coherently by evicting old generated tokens while keeping the attention sinks + system prompt + most recent generation. The output stays fluent.

**Does NOT solve sub-problem 2 (multi-turn).** Old conversation turns are simply evicted — the model forgets them entirely. For multi-turn, need a separate system.

### Implementation Notes
- Already integrated in llama.cpp at the C++ level
- node-llama-cpp handles this through its context shift mechanism
- No model fine-tuning needed — works on any pretrained model
- Window size can be configured (larger = more memory, more context)

---

## STRATEGY 2 — node-llama-cpp Context Shift (Built-in)

**Source:** [node-llama-cpp.withcat.ai/guide/chat-context-shift](https://node-llama-cpp.withcat.ai/guide/chat-context-shift)
**API:** `LlamaChatSession` and `LlamaChat` classes

### How It Works
- When chat history exceeds the context sequence size, a "context shift" is triggered
- The default strategy is `eraseFirstResponseAndKeepFirstSystem`:
  - Truncate the oldest model responses (from their beginning)
  - Or remove them completely
  - If a response is fully removed, the prompt before it is also removed
  - First system prompt is always preserved
- The library handles KV cache management automatically

### Custom Strategy API
```typescript
contextShift: {
  strategy({ chatHistory, chatWrapper, maxTokensCount, tokenizer, lastShiftMetadata }) {
    // Receive full chat history
    // Return shorter chat history that fits within maxTokensCount
    // Return metadata that persists to next shift call
    return { chatHistory: newHistory, metadata: {} };
  }
}
```

### Key Properties
- Chat-level abstraction (works with message objects, not raw tokens)
- System prompt always preserved
- Custom strategies can use ANY logic: prioritization, summarization, etc.
- `lastShiftMetadata` allows strategies to persist state between shifts
- If custom strategy returns history that's too long, evaluation throws an error

### Relevance to guIDE
**This is the primary integration point.** node-llama-cpp already handles the low-level KV cache mechanics. guIDE's pipeline code only needs to provide a custom `strategy` function. The strategy function receives the full chat history and returns a shorter version.

**This is what guide-2.0's Solution A (nativeContextStrategy.js) was trying to use.** The implementation was correct in concept but accumulated bugs over 57 patch cycles.

### What a Clean Implementation Looks Like
1. Use `LlamaChatSession` directly (node-llama-cpp handles everything)
2. Provide a custom contextShift strategy that:
   - Always keeps system prompt (item 0)
   - Always keeps last user message + current model response
   - Summarizes or removes old turns to fit within budget
   - Returns clean history

---

## STRATEGY 3 — llama.cpp Native Context Shift (C++ Level)

**Source:** llama.cpp server implementation
**Bug history:** [github.com/ggml-org/llama.cpp/issues/3969](https://github.com/ggml-org/llama.cpp/issues/3969)

### How It Works
- When the KV cache is full during text generation:
  - `n_keep` tokens are preserved (typically system prompt)
  - `n_discard` tokens are removed from the middle of the cache
  - Remaining tokens are kept (recent context + generation in progress)
  - KV cache positions are shifted to fill the gap

### Known Issues
- **Infinite context shift loop** (issue #3969): Under certain conditions, the context shift triggers repeatedly without progress. This has affected multiple models (Llama, Mistral, DeepSeek, etc.) across multiple GPU backends (CUDA, Vulkan, ROCm). The workaround is setting `--n-predict` to cap generation length.
- This bug was a primary failure mode in guide-2.0

### Key Properties
- Operates at the C++ inference engine level — below node-llama-cpp
- No control from JavaScript over the shift mechanism
- Purely mechanical: evict old tokens, shift positions
- No semantic understanding of what's being evicted

### Relevance to guIDE
**This is what happens "below" node-llama-cpp's context shift.** When node-llama-cpp's chat-level strategy runs, the underlying llama.cpp engine performs this KV cache shift. guIDE should NOT try to control this directly — let node-llama-cpp handle the bridge.

---

## STRATEGY 4 — Self-Extend

**Source:** [arxiv.org/abs/2401.01325](https://arxiv.org/abs/2401.01325)
**Implementation:** llama.cpp PR #4810 (merged)

### How It Works
- Extends context without fine-tuning using grouped attention
- Divides attention into groups with a group factor G
- Recent tokens (within window W): full attention with sequential positions
- Older tokens: compressed positions by factor G (attend with "zoomed out" view)
- KV cache positions are updated via RoPE shifting

### Example (G=4, W=512)
- Process 512 tokens normally
- Update KV positions: [0, 512) -> [0, 128) (compressed by 4x)
- Process next 512 tokens with full positions
- Update old KV positions again
- Result: 4x effective context extension

### Key Properties
- Up to 4x context extension demonstrated (LLaMA 7B: 4K -> 16K)
- No fine-tuning required
- Maintains attention quality for recent tokens
- Older tokens have "blurry" but present attention
- Integrated in llama.cpp passkey branch

### Relevance to guIDE
**Useful but not a primary solution.** Extends the context window so the problem hits later, but doesn't eliminate it. At 4x extension, a 4K model becomes 16K — but you still need a strategy when 16K fills up. Best used in combination with other strategies.

---

## STRATEGY 5 — Sliding Window with Recomputation

### How It Works
- When context is full, keep only the most recent N tokens
- Discard all earlier KV cache state
- Recompute the KV cache from scratch for the N kept tokens
- Continue generation with fresh cache

### Key Properties
- Correct: produces exactly the same output as a fresh prompt
- Extremely slow: 22.2x slower than StreamingLLM (reprocessing all N tokens)
- High latency during shifts (user sees a pause in generation)
- Simple to implement

### Relevance to guIDE
**Avoid as primary strategy.** The recomputation pause is unacceptable for an IDE user experience (generation freezes for seconds during recomputation). However, could be used as a fallback — if all else fails, recompute from scratch rather than crash.

---

## STRATEGY 6 — Summarization-Based Context Compression

### How It Works
- When context is getting full, take old conversation turns
- Use the LLM itself (or a smaller model) to summarize them
- Replace the full turns with a compact summary
- Continue with the summary in place of the original

### Key Properties
- Preserves semantic content (if summarization is good)
- Progressive: can summarize progressively as context grows
- Risky: summarization quality directly affects all future responses
- Recursive risk: summarizing summaries compounds information loss
- Performance cost: summarization itself consumes inference time
- The summarizer itself needs context to summarize (chicken-and-egg)

### Relevance to guIDE
**This is what guide-2.0 tried with ConversationSummarizer and rollingSummary.** It was one of the most problematic components because:
1. Summarization quality was inconsistent (small models produce bad summaries)
2. The summarization step competed with generation for context
3. When summaries were bad, all subsequent responses were affected
4. 57 patch cycles couldn't fix the interaction between summarization and generation

**If used in guide-3.0, keep it simple:**
- Only summarize when context is above 80% full
- Use a fixed, tested prompt for summarization
- Never summarize summaries (max 1 level deep)
- Always keep the original last 2-3 turns verbatim

---

## STRATEGY 7 — Hybrid: RAG + Context Window

### How It Works
- Maintain a vector database of previous conversation turns
- When context is full, evict old turns from the context
- When generating, retrieve relevant old turns via similarity search
- Inject retrieved context into the prompt alongside recent history

### Key Properties
- Infinite long-term memory (database has no size limit)
- Selective recall: only relevant past context is retrieved
- Requires embedding model + vector database infrastructure
- Additional complexity and latency
- Retrieval quality depends on embedding quality

### Relevance to guIDE
**Future enhancement, not first priority.** guIDE already has `ragEngine.js` and `memoryStore.js` in the codebase. This could be activated later for long-term project context. Not needed for basic code generation.

---

## WHAT PRODUCTION TOOLS ACTUALLY DO

> These are the context management strategies used by real, shipped, widely-used local LLM tools.
> None of them have solved the problem perfectly. But each reveals a different design philosophy.

### KoboldCpp (21K+ stars, actively maintained)

KoboldCpp has **three tiers** of context management, evolved over time:

**Tier 1: Smart Context (`--smartcontext`, deprecated)**
- Reserves 50% of context as a "spare buffer"
- When full: truncate the first half of context (e.g., top 1024 tokens of a 2048 context), shift remaining half up
- New tokens fill the freed space without reprocessing
- When freed space exhausts, repeat the truncation
- **Bus analogy from the docs:** "Instead of kicking 5 people off when the bus is full, kick off half. Then for the next 5 stops, people can board freely."
- Trades max usable context (only 50%) for reduced reprocessing frequency
- **Marked as outdated/not recommended by the developer**

**Tier 2: ContextShift (`--noshift` to disable, enabled by default)**
- Uses KV cache shifting to remove old tokens and add new ones **without any reprocessing**
- No context space is consumed (unlike Smart Context)
- Works only with GGUF models
- Overrides Smart Context if both are enabled
- "Your outputs may be different with shifting enabled, but both seem equally coherent"
- **This is what node-llama-cpp wraps** as its context shift API

**Tier 3: FastForwarding (`--nofastforward` to disable, enabled by default)**
- AI skips reused tokens in context that were already processed in the previous turn
- Only new/changed tokens are processed
- Complementary to ContextShift (reuse existing KV, skip reprocessing)

**Application-level memory (Kobold Lite UI):**
- **Memory** — always injected at the start of every prompt (like a system prompt)
- **Author's Note** — injected near the end of the prompt (influences style/direction of current scene)
- **World Info** — conditionally injected based on keyword matching (encyclopedia-style facts triggered by context)

**Also notable:**
- `--smartcache` — saves KV cache snapshots to RAM for session switching. Can reload old conversation states without reprocessing.
- Sliding Window Attention (`--useswa`) — reduces KV cache memory but is NOT compatible with ContextShift

**Key insight for guIDE:** KoboldCpp's evolution FROM Smart Context TO ContextShift mirrors what guide-2.0 should have done — stop reserving/rotating/compacting and just let the KV cache shift handle it at the engine level. The application layer (Memory/Author's Note/World Info) handles semantic persistence separately.

---

### text-generation-webui (oobabooga, 44K+ stars)

**Context management strategy: Simple truncation. That's it.**

The key parameter is `truncation_length`:
```
prompt_length = min(truncation_length - max_new_tokens, prompt_length)
```

When the prompt exceeds `truncation_length - max_new_tokens`, old content is simply cut from the beginning. No summarization, no compression, no intelligent eviction.

Additional relevant parameters:
- `auto_max_new_tokens` — expands max_new_tokens to fill available context
- `encoder_repetition_penalty` — penalizes tokens NOT in the prior text ("hallucinations filter")
- Character's "Context" field — always at the top of the prompt, never truncated (equivalent to system prompt)

**Key insight for guIDE:** The most popular local LLM UI (44K stars) gets by with plain truncation. No elaborate context management. The character context is always preserved (system prompt equivalent). Everything else is expendable. This suggests that simple turn eviction is an acceptable v1 strategy for most users.

---

### SillyTavern (Summarize Extension)

**Context management strategy: LLM-powered progressive summarization.**

SillyTavern handles context overflow through a dedicated Summarize extension:

**How it works:**
1. Trigger: "Update every X messages" (configurable interval, default ~5)
2. When triggered, take old messages and send them to an LLM with a summarization prompt
3. The summary is stored per-message in chat metadata
4. Summary is injected into the prompt via a `{{summary}}` template macro
5. Summarized messages are then eligible for removal from the active prompt

**Configuration options:**
- Target summary length (words)
- API response length (tokens)
- Max messages per request (how many old messages to summarize at once)
- Raw blocking / Raw non-blocking / Classic modes
- Can use the main model API or a separate Extras API (BART model with ~1024 token context)
- Manual editing and pausing of summaries
- Magic wand auto-calculates optimal intervals: `max summary buffer = context size - summarization prompt - previous summary - response length`

**Two modes:**
- **Raw mode** — recommended for non-llama.cpp backends. Sends full text to the LLM.
- **Classic mode** — recommended for llama.cpp backends. "Reuses processed prompts" — leverages KV cache continuity.

**Key insight for guIDE:** SillyTavern's approach is EXACTLY what guide-2.0's ConversationSummarizer was trying to do. The difference: SillyTavern makes it a user-configurable extension with manual controls, not a pipeline-embedded automatic system. The user can pause, edit, and rollback summaries. They control the trigger frequency. This gives the user agency over information loss — the opposite of guide-2.0's fully automatic (and fully broken) approach.

**Cross-reference:** SillyTavern's "Classic mode" for llama.cpp specifically addresses KV cache reuse — something guide-2.0's contextManager.js destroyed by clearing the cache during compaction.

---

### LM Studio (Closed Source)

**Context management strategy: Delegates entirely to llama.cpp's built-in ContextShift.**

LM Studio's documentation does not expose any custom context management features. The chat documentation covers UI features (create chat, folders, drag/drop, split view) but never mentions context overflow handling. The FAQ says "The model doesn't 'learn' from chats."

Since LM Studio uses llama.cpp under the hood, it likely relies on llama.cpp's default KV cache shifting with no additional application-level management.

**Key insight for guIDE:** Even a commercial product (LM Studio) doesn't build custom context management on top of llama.cpp. They let the engine handle it. This reinforces the principle: don't fight the engine.

---

## RESEARCH SYSTEMS

> These are more experimental/academic approaches. Not directly usable in guIDE, but the concepts are relevant.

### MemGPT / Letta (21.9K stars, UC Berkeley)

**Paper:** [arxiv.org/abs/2310.08560](https://arxiv.org/abs/2310.08560) — "MemGPT: Towards LLMs as Operating Systems"
**Code:** [github.com/letta-ai/letta](https://github.com/letta-ai/letta)

**Core concept: Virtual context management inspired by OS hierarchical memory.**

Just as an operating system provides the illusion of large memory by moving data between fast (RAM) and slow (disk) tiers, MemGPT manages different memory tiers to provide extended context within a limited context window.

**Three memory tiers:**
1. **Main context (= RAM)** — The actual LLM context window. Limited to the model's max tokens. Contains: system prompt, current conversation, working memory.
2. **Recall storage (= cache)** — Recent conversation history stored outside context. Searchable. The LLM can pull relevant recent messages back into main context.
3. **Archival storage (= disk)** — Long-term knowledge stored in a vector database. Unlimited size. The LLM can store and retrieve facts, documents, accumulated knowledge.

**The LLM manages its own memory via function calls:**
- `core_memory_append(label, content)` — add to working memory
- `core_memory_replace(label, old, new)` — edit working memory
- `archival_memory_insert(content)` — save to long-term storage
- `archival_memory_search(query)` — retrieve from long-term storage
- `conversation_search(query)` — search recent conversation history

**"Interrupts" for control flow:**
- The system uses "interrupts" (inspired by OS interrupts) to handle events like user messages, timer events, or memory pressure signals
- The LLM decides how to respond to interrupts, including memory management actions

**Key properties:**
- Requires a model GOOD ENOUGH to manage its own memory reliably via function calls
- Originally designed for GPT-4 class models (now recommends Opus 4.5 / GPT-5.2)
- Now a commercial platform (Letta) — moved beyond the academic paper
- Works best with high-capability models that can reason about memory management

**Cross-reference with guide-2.0:**
- guide-2.0's `conversationSummarizer.js` was a crude version of MemGPT's memory management — tracking goals, completed steps, key findings
- The critical difference: MemGPT lets the MODEL decide what to store/retrieve; guide-2.0's pipeline decided for the model
- **NOT suitable for guIDE v1** because it requires powerful models (Opus 4.5+) while guIDE must work with 0.5B-200B models
- **Conceptually relevant** for future: when running larger models (13B+), letting the model manage its own context could reduce pipeline complexity

---

### InfLLM (Tsinghua University, 2024)

**Paper:** [arxiv.org/abs/2402.04617](https://arxiv.org/abs/2402.04617) — "InfLLM: Training-Free Long-Context Extrapolation for LLMs with an Efficient Context Memory"
**Code:** [github.com/thunlp/InfLLM](https://github.com/thunlp/InfLLM)

**Core concept: Block-level context memory with selective attention.**

Instead of evicting old context, InfLLM stores distant contexts in external memory units and retrieves RELEVANT blocks for attention computation.

**How it works:**
1. Divide input into fixed-size blocks
2. Process initial blocks normally
3. When context fills, evict old blocks to external memory (CPU RAM or disk)
4. For each new token, determine which old blocks are relevant (via a lookup mechanism)
5. Load relevant blocks back for attention computation
6. Only attend to: initial tokens (attention sinks) + relevant retrieved blocks + recent tokens

**Key properties:**
- **Training-free** — no fine-tuning needed
- Tested up to **1,024K tokens** (1 million)
- Memory blocks can be offloaded to CPU RAM (not just GPU VRAM)
- Lookup mechanism identifies relevant past blocks efficiently
- Comparable performance to models continually pre-trained on long sequences

**Cross-reference with guide-2.0:**
- This is conceptually similar to what guide-2.0's RAG engine does (retrieve relevant context), but applied at the attention layer level
- NOT usable in guIDE directly (requires model architecture modifications or custom inference engine)
- **Conceptual takeaway:** The most promising academic approaches don't throw away old context — they store it externally and retrieve selectively. This validates the "RAG + context window" hybrid (Strategy 7) as a future direction.

---

### StreamingLLM (MIT HAN Lab, ICLR 2024)

**Additional detail beyond Strategy 1:**

The FAQ explicitly states limitations relevant to guIDE:
- "Is the context window expanded?" — **No.** Only recent tokens + attention sinks are kept.
- "Can I input a book for summarization?" — **No.** Only the concluding paragraphs would be recognized.
- "Ideal use case?" — **Streaming applications like multi-round dialogue** where the model operates on recent context without cache refresh.

The key insight: StreamingLLM works at the **inference/KV cache level** and is already integrated into llama.cpp. It's not something guIDE needs to implement — it happens automatically beneath node-llama-cpp's context shift API.

---

## CROSS-REFERENCE: Research vs. guide-2.0 Failures

> This section maps each guide-2.0 failure to what the research shows.

### Failure: THREE Competing Systems (contextManager + proactive rotation + nativeContextStrategy)

| What guide-2.0 did | What production tools do |
|---|---|
| 3 independent systems managing the same resource | KoboldCpp: 1 system (ContextShift), application-level memory is separate |
| contextManager cleared KV cache | No production tool manually clears KV cache |
| Proactive rotation at 70% preempted native strategy | No production tool preemptively rotates |
| Each system had different triggers/thresholds | KoboldCpp evolved through 3 tiers, each replacing the previous — never concurrent |

**Verdict:** Every production tool uses ONE context management mechanism. KoboldCpp's evolution explicitly deprecated Smart Context in favor of ContextShift. text-generation-webui uses simple truncation. SillyTavern's summarization is an optional extension, not a competing system. **guide-2.0's architectural mistake was unique to guide-2.0.**

---

### Failure: Over-Engineered nativeContextStrategy.js (200+ lines, 5+ named patches)

| What guide-2.0 did | What production tools do |
|---|---|
| Custom token estimation (CHARS_PER_TOKEN: 3.5) | text-generation-webui: uses actual tokenizer |
| Complex truncateModelItem with embedded JSON detection | KoboldCpp: no application-level item truncation |
| R13-Fix-D1, R30-Fix, T42-Fix, Fix-T1-B patches | No production tool has named patches in context strategy |
| Segment splitting for embedded tool JSON | N/A — production tools don't have agentic tool calls in context shift |

**Verdict:** guide-2.0's strategy function tried to understand the CONTENT of what it was compressing (tool call JSON, file content, prose). No production tool does this. They all treat context as opaque token sequences. The strategy should be: keep recent, drop old. No content inspection.

**Exception:** guIDE IS different from chat tools — it has agentic tool calls with structured JSON. This means the strategy function may need to be slightly smarter than KoboldCpp's (which has no tool calls). But "slightly smarter" means keeping complete tool call/result pairs together, NOT parsing embedded JSON segments.

---

### Failure: ConversationSummarizer (Template-based task ledger)

| What guide-2.0 did | What production tools do |
|---|---|
| Zero-LLM-cost template-based summaries | SillyTavern: uses actual LLM for summarization |
| Automatic, always-on | SillyTavern: user-configurable interval, can be paused/edited |
| Tracked goals/steps/findings in fixed template | SillyTavern: free-form summary text |
| Summaries were injected automatically | SillyTavern: uses `{{summary}}` macro in user-controllable template |
| No way to review/edit summaries | SillyTavern: explicit manual editing |

**Verdict:** If summarization is used, it should be either (a) LLM-powered (like SillyTavern) for quality, or (b) not used at all in v1 (like text-generation-webui's approach). guide-2.0's template ledger was a middle ground that had neither good quality nor simplicity.

---

### Failure: 32 Different Continuation Message Paths

| What guide-2.0 did | What production tools do |
|---|---|
| 32 different nextUserMessage assignments | KoboldCpp: "Continue bot replies" is a UI toggle, sends empty submit |
| Each path had different context amounts | SillyTavern: continuation is simply resuming the model's response |
| Complex nesting analysis, symbol extraction | text-generation-webui: "Continue" button, no special context |

**Verdict:** Continuation in production tools is either (a) the user pressing a button to resume generation, or (b) the UI automatically requesting another generation turn. No production tool constructs elaborate continuation messages with head/tail/symbols/nesting annotations. The model already has its own output in the KV cache — it can continue from where it stopped.

**However:** guIDE's code generation is a harder problem than chat. A 500-line file generation that hits context mid-way DOES need some continuation guidance. But this should be ONE function, not 32 paths. And it should be minimal: "Continue the file from line N" — not a full analysis of brace nesting.

---

### Failure: KV Cache Contamination After Tool Execution

| What guide-2.0 did | What production tools do |
|---|---|
| Reused KV cache after write_file tool calls | No production tool chains tool calls with KV cache reuse |
| Model continued with stale "writing HTML" attention patterns | N/A — production tools don't have agentic tool execution |
| Required explicit KV cache clearing after tools | N/A |

**Verdict:** This is unique to guIDE's agentic architecture and has no analogue in production chat tools. It's a real problem that needs a real solution — but it's a pipeline problem, not a context management problem. The context shift strategy should not be responsible for KV cache hygiene after tool execution.

---

### Failure: Infinite Context Shift Loop (llama.cpp issue #3969)

| What guide-2.0 did | What production tools do |
|---|---|
| No maxTokens cap, context shift could loop forever | KoboldCpp: has "Amount to Generate" slider, caps generation length |
| Added generation timeout as band-aid | text-generation-webui: `max_new_tokens` is always set |
| | SillyTavern: generation length is always configured |

**Verdict:** Every production tool sets a maximum generation length. llama.cpp's infinite shift loop only triggers when there's no generation cap. Setting `maxTokens` / `n_predict` is the correct fix, not a band-aid. guide-2.0 eventually discovered this but only after many band-aid attempts.

---

## WHAT APPROACHES ARE GENUINELY NEW (Not Attempted by guide-2.0)

1. **MemGPT's self-managed memory** — The model itself decides what to store/retrieve via function calls. guide-2.0 never tried this; the pipeline always decided for the model. *Requires powerful models.*

2. **InfLLM's block-level retrieval** — Evicted context blocks are retrieved selectively for attention, not lost forever. guide-2.0 either kept context or dropped it entirely. *Requires custom inference engine.*

3. **SillyTavern's user-controlled summarization** — User can see, edit, pause, and rollback summaries. guide-2.0's summarization was fully automatic with no user visibility. *Implementable in guIDE.*

4. **KoboldCpp's smartcache** — KV cache snapshots saved to RAM for session switching. Can reload old conversation states without reprocessing. guide-2.0 never tried session state snapshots. *Interesting for multi-chat.*

5. **Simple truncation with no management (text-generation-webui)** — Just cut old content. No compression, no summarization, no rotation. guide-2.0 never tried the "do nothing" approach. *Valid for v1.*

---

## RECOMMENDED ARCHITECTURE FOR guIDE 3.0

Based on this research — including analysis of 6 production tools, 3 academic papers, and a complete cross-reference with guide-2.0's failures — the recommended approach uses **three layers**:

### Layer 1: Attention Sinks (Automatic — llama.cpp handles this)
- The C++ engine already preserves attention sink tokens
- No code needed — this happens automatically
- This prevents the model from generating garbage during long outputs

### Layer 2: node-llama-cpp Custom Context Shift Strategy
- Use `LlamaChatSession` or `LlamaChat` with a custom `contextShift.strategy`
- Strategy logic:
  1. Always keep system prompt (first item)
  2. Always keep last user message + current response (last items)
  3. Fill remaining budget with most recent complete turns
  4. Drop oldest turns first (no summarization in v1)
  5. If turns still don't fit, truncate oldest remaining response from beginning
- This handles both mid-generation shifts and multi-turn accumulation
- Start simple — just drop old turns. Add summarization later if needed.

### Layer 3: Seamless Continuation (Application Level)
- When `maxTokens` is reached but the response is incomplete:
  - Detect truncation (no closing tag, code block unclosed, etc.)
  - Send a continuation prompt: "Continue from where you stopped"
  - Append the continuation to the original response in the UI
- This is the ONLY piece that needs custom pipeline code
- Keep it simple: detect truncation + send continuation + merge in UI

### What NOT to Do
1. **Don't build a competing context manager** — node-llama-cpp already handles context shifts
2. **Don't use 3 systems** — guide-2.0 had contextManager, continuationHandler, and nativeContextStrategy all fighting each other
3. **Don't pre-emptively rotate** — let context actually fill up before taking action
4. **Don't summarize in v1** — summarization adds complexity and bugs. Drop old turns instead. Add summarization in v2 only if users demand long-range recall.

---

## SOURCES

| Resource | URL |
|----------|-----|
| StreamingLLM Paper (ICLR 2024) | https://arxiv.org/abs/2309.17453 |
| StreamingLLM Code | https://github.com/mit-han-lab/streaming-llm |
| Attention Sinks Blog | https://huggingface.co/blog/tomaarsen/attention-sinks |
| Self-Extend PR | https://github.com/ggml-org/llama.cpp/pull/4810 |
| node-llama-cpp Context Shift Guide | https://node-llama-cpp.withcat.ai/guide/chat-context-shift |
| node-llama-cpp Chat Session Guide | https://node-llama-cpp.withcat.ai/guide/chat-session |
| llama.cpp Infinite Shift Bug | https://github.com/ggml-org/llama.cpp/issues/3969 |
| KoboldCpp Wiki (Context Shift, Smart Context) | https://github.com/LostRuins/koboldcpp/wiki |
| text-generation-webui Parameters | https://github.com/oobabooga/text-generation-webui/wiki/03-%E2%80%90-Parameters-Tab |
| SillyTavern Summarize Extension | https://docs.sillytavern.app/usage/core-concepts/summarize/ |
| SillyTavern Context Template | https://docs.sillytavern.app/usage/core-concepts/context-template/ |
| MemGPT Paper | https://arxiv.org/abs/2310.08560 |
| Letta (MemGPT) Code | https://github.com/letta-ai/letta |
| InfLLM Paper | https://arxiv.org/abs/2402.04617 |
| InfLLM Code | https://github.com/thunlp/InfLLM |
| LM Studio Documentation | https://lmstudio.ai/docs |

---

## KEY TAKEAWAYS

1. **StreamingLLM/Attention Sinks** is the gold standard for maintaining coherent generation across long outputs. It's already built into llama.cpp. Don't fight it — use it.

2. **node-llama-cpp's context shift API** is the correct integration point. It provides a clean TypeScript hook where you receive chat history and return shorter history. The library handles KV cache management. USE THIS.

3. **The infinite context shift loop** (llama.cpp issue #3969) is a known bug that was the primary failure mode in guide-2.0. Setting `maxTokens` (n_predict) is a genuine fix, not a band-aid — it prevents the engine from entering the loop.

4. **Don't summarize old turns in v1.** The ConversationSummarizer was one of guide-2.0's biggest failure points. Simple turn eviction (drop oldest, keep system prompt + recent) is sufficient and has zero failure modes. If summarization is added later, make it user-visible and user-controllable (like SillyTavern), not automatic and hidden.

5. **Seamless continuation** is an application-level concern, not an engine-level one. It should be a simple "detect truncation -> send continuation prompt -> merge in UI" loop. Nothing more. Every production tool uses a simple "Continue" button. No nesting analysis. No symbol extraction.

6. **The three-layer architecture** (attention sinks + context shift strategy + seamless continuation) is clean, orthogonal, and each layer has exactly one job. This is the opposite of guide-2.0's three competing systems.

7. **Every production tool uses ONE context management mechanism.** KoboldCpp deprecated Smart Context for ContextShift. text-generation-webui uses plain truncation. LM Studio delegates to llama.cpp. Multiple competing systems are a design error, not a feature.

8. **No production chat tool inspects the content of context entries during eviction.** guide-2.0's nativeContextStrategy parsed embedded JSON, detected tool calls, extracted content fields. This is over-engineering. Context entries are opaque — keep recent, drop old.

9. **The most advanced research approaches (MemGPT, InfLLM) store evicted context externally and retrieve it selectively.** This is conceptually equivalent to RAG. guIDE already has RAG infrastructure. When context is evicted, storing it in a retrievable format is a viable future enhancement.

10. **guide-2.0's failures were unique to guide-2.0.** No production tool had three competing systems. No production tool used template-based summarization. No production tool had 32 continuation message paths. The bugs were self-inflicted architectural mistakes, not inherent limitations of the problem domain.
