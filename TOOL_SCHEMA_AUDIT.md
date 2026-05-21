# Tool Schema Audit — Definition vs Executor vs Prompts

**Date:** 2026-05-21  
**Scope:** All 69 tools in `mcpToolServer._getAllToolDefs()`  
**Script:** `scripts/audit-tool-schema.mjs` (re-run after fixes)

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 2 | Definition param name ≠ executor param name (no alias) |
| HIGH | 3 | SYSTEM_PROMPT examples teach wrong param names |
| MEDIUM | 3 | Ghost handlers (executable but not in catalog) |
| LOW | 1 | `_buildToolPrompt` references undefined tool name |

Most other tools are aligned. File/browser tools have extensive **alias normalization** in `_normalizeFsParams`, `_normalizeBrowserParams`, and `toolParser.normalizeToolCall` — those are intentional for model output drift, not bugs.

---

## CRITICAL — Fix required (Phase 1)

### `write_scratchpad` / `read_scratchpad`

| Layer | Param for identifier |
|-------|---------------------|
| Tool definition | `name` (required) |
| `_writeScratchpad` / `_readScratchpad` | `key` |
| `toolParser.normalizeToolCall` | No `name` → `key` alias |
| `_normalizeFsParams` | No scratchpad handling |

**Impact:** Any model following the catalog sends `{ name: "..." }` → executor ignores it → `"key must be a non-empty string"`. B11.

**Fix (pick one, recommend A):**
- **A (preferred):** Executor accepts `params.name || params.key`; store as `key` internally. One line in normalizeToolCall for scratchpad tools.
- **B:** Change definition to `key` to match executor (breaks models already trained on `name` from current catalog).

---

## HIGH — Wrong examples in `SYSTEM_PROMPT` (chatEngine.js)

These teach param names that **do not match** the tool definition or executor:

| Example in SYSTEM_PROMPT | Correct param (definition + executor) | Mitigated at runtime? |
|--------------------------|----------------------------------------|------------------------|
| `edit_file` → `old_string`, `new_string` | `oldText`, `newText` | Partially: `old_text` alias in toolParser only; **not** `old_string` |
| `list_directory` → `path` | `dirPath` | Yes: `_normalizeFsParams` maps `path` → `dirPath` at execute time |

**Impact:** Models copy SYSTEM_PROMPT examples literally → `edit_file` calls fail or pass undefined `oldText`. This is a **prompt bug**, not a model bug.

**Fix:** When slimming SYSTEM_PROMPT, remove these examples entirely (tool section already uses correct names). If any example remains anywhere, it must match `getToolDefinitions()` exactly.

---

## MEDIUM — Ghost handlers (not in catalog)

Handlers exist in `executeTool` switch but **no** entry in `_getAllToolDefs()` or `VALID_TOOLS`:

| Handler | Behavior |
|---------|----------|
| `browser_list_elements` | Alias for `browser_snapshot` |
| `browser_wait_for_element` | Wraps `_browserWaitFor` |
| `browser_select` | Alias for `browser_select_option` |

**Impact:** Model cannot see these in tool catalog; if it hallucinates the name, parser rejects (not in VALID_TOOLS) unless added to aliases. `_buildToolPrompt` lists `browser_list_elements` in a category string but tool is undefined — catalog inconsistency.

**Fix:** Either add definitions (if we want them callable) or remove from `_buildToolPrompt` and keep as parser aliases only.

---

## LOW — Description inconsistencies (non-breaking)

| Item | Note |
|------|------|
| `write_todos` description | Says `"in_progress"`; schema accepts `"in-progress"`; executor accepts both + `completed` for update |
| `update_todo` SYSTEM example | Uses `"completed"`; executor normalizes to `done` ✓ |

---

## Tools verified aligned (sample)

Executor reads match definition for: `read_file`, `write_file`, `run_command`, `web_search`, `fetch_webpage`, `save_memory`, `get_memory`, `save_rule`, `ask_question`, `browser_navigate`, `browser_click`, `git_*`, etc.

Normalization layers cover common drift: `path`/`filePath`, `selector`/`ref`, `query`/`pattern`, etc.

---

## Audit policy going forward

1. **Single source of truth:** `getToolDefinitions()` param names = executor = all prompt examples.
2. **Aliases:** Only in `_normalizeFsParams` / `toolParser` — document in definition description when helpful.
3. **Re-run:** `node scripts/audit-tool-schema.mjs` before any prompt consolidation PR.
4. **Expand script:** Future pass — auto-extract all `params.X` from switch cases vs definitions.
