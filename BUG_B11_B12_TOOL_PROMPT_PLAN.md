# B11/B12 Tool Prompt Consolidation Plan

**Status: PROPOSAL ONLY — NOT IMPLEMENTED. Awaiting your approval.**

**Goal:** One authoritative tool path the model sees every turn — format, catalog, when-to-use — without duplicating examples in two places. Fix spurious tool calls on casual chat (B12) without causing refusals on action requests (your concern).

---

## How it works today (answer to “do they see getToolPrompt every time?”)

**Yes.** On every `chat()` call:

1. `electron-main.js` builds `toolPrompt = mcpToolServer.getToolPrompt()` and passes it to `chatEngine.chat()`.
2. `chatEngine.js` assembles `_chatHistory[0]` **fresh each message**:
   ```
   _chatHistory[0].text = basePrompt + '\n\n' + effectiveToolPrompt
   ```
3. `basePrompt` = `SYSTEM_PROMPT` + date/OS/project/editor layers.
4. `effectiveToolPrompt` = from `buildBudgetProportionalToolPrompt()`:
   - **full** `getToolPrompt()` if it fits budget, OR
   - **budget-parts** from `getCompactToolHint()` category chunks, OR
   - **trimmed** tail-cut of full prompt.

5. User message appended as `_chatHistory[1]` (or later index after multi-turn).
6. `generateResponse(_chatHistory)` sends all of this to the model **every turn**.

So the model **always** gets tool docs on every message in agent mode (not Ask mode). The problem is not “they don’t see tools” — it’s **they see tools twice**, and the first copy (`SYSTEM_PROMPT`) is example-heavy **before** the real catalog even starts.

---

## What each layer currently contains

| Layer | Source | Contents |
|-------|--------|----------|
| System identity | `SYSTEM_PROMPT` in `chatEngine.js` | Identity, when-to-use, **format block**, **~15 fenced examples**, tool name list, decision rubric, rules |
| Environment | `chatEngine.js` layers 2–3 | Date, OS, project path, editor context, plan/ask mode |
| Tool catalog | `mcpToolServer.getToolPrompt()` | Format + write_file example + strict rules + **every tool with params** + common patterns |
| Budget fallback | `getCompactToolHint()` parts | Same header example + categories until budget exhausted |

**Duplication:** Format taught twice. Examples overlap (read_file, write_file, list_directory, web_search, browser, ask_question). Tool names listed twice. Small models latch onto the **first** big block of JSON examples → spurious tools on “hi”.

**Why same Llama works elsewhere:** LM Studio/Ollama typically use a short system prompt + optional tools API or a single template block — not 15k chars of duplicated fenced JSON before “hi”.

---

## Design principle (addresses your refusal worry)

> **Remove duplication, not capability.**

We are **not** proposing “no examples anywhere.” We propose:

1. **System prompt** = who you are + **when** to use tools vs prose + one line pointing to the tool section below + refusal guard (“you have real tools”).
2. **Tool section** (`getToolPrompt` / compact parts) = **the only place** for format, examples, full catalog, param schemas, workflows.

The tool section **already** includes:
- Fenced JSON format
- `read_file` example
- `write_file` example with content-in-params
- RIGHT/WRONG formatting guidance
- Every tool with `name(param:type*)` and description
- Common patterns (web chain, browser workflow)

Removing examples from `SYSTEM_PROMPT` does **not** remove them from what the model sees — they stay in the appended tool block on the same system message.

---

## Proposed split

### A. Slim `SYSTEM_PROMPT` (~25 lines, not ~110)

Keep:
- Identity (guIDE agent)
- **When to use tools vs prose** (casual chat → prose; action requests → tools)
- “You have real tools — do not refuse when action is needed”
- “Tool definitions, format, and examples are in the **## Tools** section below — follow that exclusively”
- Vision note, never fabricate `[Tool Results]`

Remove from system prompt (move authority to tool section only):
- `## Tool-call format` fenced block
- `## Tool-call patterns` (all fenced examples)
- `## Available tools` name list
- Duplicate decision rubric that repeats tool section rules

Keep in system prompt (behavior, not catalog):
- Short decision hints: “internet → web tools; project files → file tools; don’t web_search for local files” (3–4 bullets max, no JSON)

### B. Single tool authority — `mcpToolServer.js`

`getToolPrompt()` / `_buildToolPrompt()` remains source of truth for:
- Format + examples
- Full catalog from `getToolDefinitions()`
- Common patterns + strict rules

Enhance (not shrink capability):
1. **Header always wins budget** — `buildBudgetProportionalToolPrompt` must always include part[0] (format + example) even when context is tight; never drop header to fit categories.
2. **Tier-aware example count** (wire `modelProfiles.prompt.fewShotExamples`):
   - tiny/small: 1 format example + 1 write_file example (already in header)
   - medium+: add 2–3 pattern examples (web chain, edit_file) in `### Common Patterns`
3. **Fix B11 scratchpad** — tool def says `name`, executor expects `key`; accept both in `_writeScratchpad` / `_readScratchpad`.
4. **Param names in catalog match executor** — audit mismatches (scratchpad first).

### C. Wire dead `modelProfiles` knobs

| Profile field | Use |
|---------------|-----|
| `prompt.style: 'compact'` | Prefer budget-parts assembly; lower `maxToolBudgetPct` slightly so identity layers breathe |
| `prompt.toolPromptStyle` | `'full'` vs `'compact'` catalog density |
| `generation.maxToolsPerTurn` | Cap parsed calls per round (currently unenforced) |
| `prompt.fewShotExamples` | Extra fenced examples in tool section only |

Apply when `family=llama|phi` and `tier=tiny|small` first.

### D. Casual chat vs action (B12 — behavioral, not keyword filter)

Without removing tool docs:

1. **Stronger when-to-use in slim system prompt** (first thing model reads):
   - Greetings, small talk, clarifying questions → **prose only, zero tool blocks**
   - Explicit file/command/browser/web requests → tools

2. **Do not auto-execute** tool calls parsed from responses that are **only** `ask_question` / `list_directory` when user message is under N chars and matches no action verbs — **defer this** until slim prompt tested; it’s the only risky behavioral gate.

3. **Log per turn:** `toolPrompt mode=full|budget-parts, chars=N, partsUsed=M` (already partial) + `systemPromptChars, toolPromptChars` so you can verify what Llama actually saw.

---

## Injection diagram (after change)

```
_chatHistory[0]  type: system
├── SLIM_SYSTEM_PROMPT          (~25 lines: identity, when-to-use, pointer)
├── Layer 2: date, OS, project
├── Layer 3: editor context
├── Layer 4: plan/ask mode flags
└── TOOL_SECTION                (getToolPrompt OR budget-parts — ONLY copy)
    ├── ## Tools + format + examples
    ├── every tool + params
    └── common patterns + rules

_chatHistory[1+]  user / model turns
└── [System: Tool Results] only after real tool execution (unchanged)
```

One system message, two logical sections — model sees both every turn. Same as today structurally; less redundant content.

---

## Why this should not cause refusals

| Your worry | Mitigation |
|------------|------------|
| “Won’t know format” | Format + fenced example stay in tool section header (part 0, never dropped) |
| “Won’t know all tools” | Full catalog unchanged in `getToolPrompt()`; compact mode still lists all categories until budget runs out |
| “Won’t call tools on ‘create a file’” | Slim system keeps when-to-use + refusal guard; tool section keeps write_file example + “NEVER say I can’t” |
| “Dumb models need examples” | Examples move, not delete; tiny/small tiers keep minimal set in tool header; optional 1–2 extra in patterns |
| “Context too small, tools truncated” | Fix: header part mandatory; log warning if `Browser Extended` dropped; B01 context helps |

---

## Verify plan (before/after)

### Must still work
1. Fresh chat: “create a file called test.txt with hello world” → `write_file` with content in params
2. “search the web for X” → `web_search` then `fetch_webpage`
3. “read package.json” → `read_file`
4. Phi story request → prose OR valid scratchpad with `name`/`key` (after B11 fix)

### Must improve
1. Fresh chat: “hi” → prose only, no `ask_question` / `list_directory`
2. Log shows one tool block, not duplicated format in system section
3. `write_scratchpad` with `name` param succeeds

### Regression watch
- 2048 context + full tool catalog → ensure header + file ops categories always present
- Custom `settings.systemPrompt` override path (currently replaces basePrompt entirely — separate bug, document don’t fix in this pass unless you want)

---

## Files touched (implementation phase)

| File | Change |
|------|--------|
| `chatEngine.js` | Slim `SYSTEM_PROMPT`; optional profile-aware assembly; mandatory header in budget builder |
| `mcpToolServer.js` | Scratchpad name/key; tier examples in `_buildToolPrompt` if needed |
| `modelProfiles.js` | No schema change; document wired fields |
| `CHANGES_LOG.md` | After implement |
| `BUG_TRACKER_v0.3.88.md` | B11/B12 status |

**Not in scope:** Ask mode (already suppresses tools), grammar mode, frontend changes.

---

## Phase 1 — schema audit (before prompt changes)

Full audit: [TOOL_SCHEMA_AUDIT.md](./TOOL_SCHEMA_AUDIT.md)  
Re-run: `node scripts/audit-tool-schema.mjs`

**CRITICAL mismatches found:**
- `write_scratchpad` / `read_scratchpad`: def `name`, executor `key`
- `SYSTEM_PROMPT` examples: `edit_file` uses `old_string`/`new_string` (def: `oldText`/`newText`); `list_directory` uses `path` (def: `dirPath`)

**Ghost handlers (no catalog entry):** `browser_list_elements`, `browser_wait_for_element`, `browser_select`

## Slim system prompt — approval required

Draft for your review: [PROPOSED_SLIM_SYSTEM_PROMPT.md](./PROPOSED_SLIM_SYSTEM_PROMPT.md)

**Principles:** general-purpose only — no model names, no hardware, no test-specific wording. Tool format/catalog/examples stay in `getToolPrompt()` every turn; system block is identity + when-to-use + pointer.

## Phased rollout (recommended)

**Phase 1 — schema + logging (no prompt surgery)**
- Fix all CRITICAL param mismatches from TOOL_SCHEMA_AUDIT.md (scratchpad first)
- Resolve ghost handler / catalog inconsistency
- Add injection logging (chars, mode, partsUsed)
- Mandatory tool header in budget builder
- Re-run audit script

**Phase 2 — slim SYSTEM_PROMPT (requires your approval of PROPOSED_SLIM_SYSTEM_PROMPT.md)**
- Slim `SYSTEM_PROMPT`; pointer to ## Tools
- Verify with Llama + Phi on hi + create file + web search

**Phase 3 — profiles**
- Wire `modelProfiles` compact/full + maxToolsPerTurn
- Tune tiny/small tiers from test results

**Phase 4 — optional B12 gate**
- Only if Phase 2 insufficient for casual chat spurious calls

---

## Explicitly NOT doing

- Removing all tool examples globally
- Removing full tool catalog
- Keyword filters on user messages (“hi”, “thanks”) as primary fix
- Moving tool catalog to user message role
- Separate tool prompt file the model might miss
