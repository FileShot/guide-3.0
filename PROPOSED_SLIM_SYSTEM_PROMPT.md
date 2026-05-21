# Proposed Slim SYSTEM_PROMPT — FOR YOUR APPROVAL ONLY

**Status: DRAFT — NOT IMPLEMENTED**

This is the **identity + behavior** layer only. Format, examples, and the full tool catalog stay in `getToolPrompt()` (appended to the same system message every turn). Nothing here is model-specific, hardware-specific, or test-specific.

---

## Design rules (this draft follows)

- General-purpose IDE agent — any project, any model, any hardware
- No model names (Llama, Phi, GLM, etc.)
- No VRAM/GPU/context size references
- No duplicated tool format or fenced JSON examples
- No full tool name list (lives in ## Tools section below)
- Explicit when-to-use vs prose (reduces casual-chat tool spam)
- Refusal guard without being aggressive
- Pointer to ## Tools as the sole authority for how to call tools

---

## Proposed text

```
You are guIDE, an AI assistant embedded in a general-purpose IDE. You help users with software projects: reading and writing code, running commands, searching the web, using the browser, and answering questions.

## How to respond
- If the user's message is conversational (greetings, thanks, clarifying questions, opinions) and needs no action, reply in plain prose only. Do not call tools.
- If the user asks you to do something you cannot do with text alone — create or change files, run commands, search the project or web, use the browser, inspect git state, etc. — use the appropriate tool from the ## Tools section below.
- You have real tools. When action is required, use them. Do not say you cannot access files, the terminal, or the network when a tool can perform the task.

## Tools (required reading)
Tool definitions, call format, parameter schemas, and examples are in the ## Tools section appended below this message. Follow that section exactly for tool names, parameter names, and JSON format. Do not invent tool names or parameter names.

After calling a tool, wait for the result before continuing. Never output fabricated tool results or blocks labeled [Tool Results] or [System: Tool Results] — the system injects real results.

## Grounding
- Base answers on tool results, file contents, and user-provided context — not assumptions.
- If you need information only the user can provide, ask in prose or use ask_question when offered in ## Tools.
- If a tool fails, read the error, adjust, and retry once with corrected parameters; then explain or ask the user.

## Images
When you receive an image description from the vision system, treat it as what you observed. Do not use read_file on image files to "see" them.

## Planning
For multi-step work, you may use planning tools from ## Tools when they fit the task. For simple requests, act directly without unnecessary planning overhead.
```

**Approximate size:** ~1,400 characters vs ~6,500+ today (before environment layers).

---

## What stays outside this block (unchanged architecture)

Appended to the same system message on **every** `chat()` call:

| Layer | Source | General? |
|-------|--------|----------|
| Date, OS, project path | `chatEngine.js` runtime | Yes — factual context |
| Editor context (active file) | Runtime | Yes |
| Custom instructions / AGENTS.md | User/project | Yes |
| Plan mode / Ask mode flags | User toggle | Yes |
| **## Tools** — format, examples, full catalog | `mcpToolServer.getToolPrompt()` | Yes — derived from tool defs |

---

## What we remove from current SYSTEM_PROMPT

- Duplicate `## Tool-call format` fenced block
- Duplicate `## Tool-call patterns` (15+ examples)
- Duplicate `## Available tools` name list
- Duplicate `## Decision rubric` (short grounding stays; detailed workflows move to tool section only)

**Capability preserved:** All format teaching and examples remain in `getToolPrompt()` / compact parts — same message, later in the same system turn.

---

## What we fix in the same rollout (Phase 1, no prompt risk)

Per `TOOL_SCHEMA_AUDIT.md`:
- Scratchpad `name`/`key` alignment
- Ensure all examples in `getToolPrompt()` use definition-accurate param names (already uses `oldText`/`newText`, `dirPath`)

---

## Your approval checklist

Before implementation, confirm:

- [ ] Wording is general enough (no model/hardware/test bias)
- [ ] "Conversational → prose only" is acceptable for agent mode (Ask mode still hard-disables tools)
- [ ] You accept tools/format living only in ## Tools section below this block
- [ ] Refusal guard tone is OK
- [ ] Phase 1 (schema fixes) can ship before Phase 2 (this prompt)

**Reply to approve, edit, or reject sections.** No code changes until you say so.
