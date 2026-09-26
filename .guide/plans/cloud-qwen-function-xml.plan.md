# v0.4.97 — Cloud tool dialect: keep JSON + accept Qwen `<function=`

Status: **SHIPPED v0.4.97** — operator go 2026-09-26; CI Windows CUDA only for this tag.

## Problem (user words)

Cipher sometimes emits JSON tool calls, sometimes Qwen-native `<function=…>` / `<parameter=…>`. Last fail leaked XML and stopped with `toolsParsed=0`. Shipping takes hours — this deploy must cover both dialects and the prompt hole from the last ship.

## Log evidence (v0.4.96)

```
20:48:55 round end iter=0 stopReason=stop toolsParsed=0 proseChars=142
20:48:55 ai-chat DONE: toolCallCount=0
```

UI showed mangled `<function=list_directory>` / `<parameter=…>`. Not Ship A (no tools had run). Not length-stop.

## Correction (operator): we did have tool examples

Correct. Through **v0.4.89** Secrypt Cloud used `mcpToolServer.getCompactToolHint(...)`, which starts with `getAgentToolPromptHeader({ compact: true })` — JSON fence format + concrete `read_file` / `write_file` / `edit_file` / `run_command` examples.

**v0.4.94** (`c9ffc6f`) replaced that with bare `buildCloudToolListing` — name list only, **no** format header/examples. **v0.4.95** Ship E only truncated descriptions to 100 chars on that already-stripped listing.

| Piece | v0.4.89 Cloud (working pattern) | Live 0.4.96 |
|--------|----------------------------------|-------------|
| Tool catalog | `getCompactToolHint` + compactDescriptions | `buildCloudToolListing` name list |
| JSON format + examples | **Yes** (compact header) | **Removed in 0.4.94** |
| Desc length | compactDescriptions | slice 100 |

So the examples were stripped in **0.4.94**, not invented-missing forever. Model fell back to Qwen `<function=` — host still does not parse that dialect.

## Proposed change (both required in one ship)

### A — Prompt: restore Cloud compact tool catalog (prefer JSON)

Replace `buildCloudToolListing(...)` with the **0.4.89 Secrypt path**:

```js
toolPrompt = mcpToolServer.getCompactToolHint('default', {
  toolDefs: filteredDefs,
  planning: mode.planning,
  compactDescriptions: true,
}).join('');
```

That restores the JSON fence header + examples. Settings tool filter (`filteredDefs`) stays. Do **not** document `<function=` as preferred.

Optional: drop the separate thin `buildCloudToolListing` or keep it unused — prefer delete if nothing else imports it.

### B — Parser: additive dialects (never break JSON)

In `tools/toolParser.js` **add** Method for:

```
<function=TOOL_NAME>
<parameter=KEY>VALUE</parameter>
…
</function>
```

- Map tool name via existing aliases / VALID_TOOLS.
- Params object from parameter tags (trim values).
- Run **alongside** existing JSON / fence / tool_code paths (order: existing first or XML first — either OK if dedupe by signature).
- `looksLikeToolAttempt`: also true on `/<function\s*=/i`.
- `stripToolCallText` + streaming hold: remove `<function=…</function>` (and orphan open) so UI never shows markup.

Malformed mashups (screenshot: command fragment between tags): parse what is well-formed; if zero valid tools but `<function=` present → existing repair retry (`looksLikeToolAttempt` true).

### C — Tests (must pass before tag)

1. Pure JSON fence → still parses (regression).
2. Pure `<function=list_directory><parameter=dirPath>.</parameter></function>` → one call.
3. Screenshot-shaped mangled string → `looksLikeToolAttempt` true; strip leaves prose; best-effort parse ≥0 tools.
4. Mixed prose + JSON unchanged.
5. Cloud tool prompt (via getCompactToolHint) includes ```json and example `{"tool":`.
6. Regression: Settings-filtered toolDefs still only list enabled tools.

### D — Ship

Bump **0.4.97**, commit, tag, CI green.

## What this ship does NOT do

- Force tools after clean prose.
- Change 27B/2B weights or sampler.
- Teach the model to prefer `<function=` (JSON remains the instructed format).
- Touch FileShot / other platforms’ 2B chatbot prompts.

## Validation

- Unit suite above.
- Manual after install: SaaS-style agent prompt → log `toolsParsed≥1`, tool cards, **no** raw `<function=` in chat; a second turn that already used JSON still works.

## Execute order

1. A prompt header restore  
2. B parser + strip + looksLike  
3. C tests  
4. D release  
