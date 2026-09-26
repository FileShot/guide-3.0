# v0.4.96 — Cloud 2B context summarizer

Status: **SHIPPED v0.4.96** — operator go 2026-09-26.

## Problem (user words)

Cloud agentic work uses heuristic condensation when the 24k window fills. That drops decisions/errors and is weaker than Cursor-shaped compaction. The P40 already keeps Qwen 2B (`cipher-fast` :18788) loaded next to 27B. Use that 2B only for summarizing, with UI “Context summarizing” / “Context summarized”, without changing how FileShot or other platforms talk to the same 2B worker.

## Current implementation

- `tools/cloudContextFit.js` drops oldest turns and prepends a regex-built notice (`buildDroppedSummary`).
- Local `chatEngine` can LLM-summarize dropped context; Cloud does not.
- Live P40: quality `:18787` 27B + fast `:18788` 2B always loaded. App routes agent to `cipher-quality`.

## Proposed change

1. Add `tools/cloudContextSummarize.js`: dedicated summarizer system prompt; call `cipher-fast` with `enableThinking: false`, empty history, short max tokens, hard timeout; validate output; fall back to heuristic.
2. Wire into `cloudAgenticChat` `applyFit` after every rotate (including overflow shrink / length-stop rotate).
3. Emit `context-summarize` stream events; FE renders a thinking-style dropdown (“Context summarizing…” → “Context summarized”).
4. Isolation: per-request system prompt on guIDE only. No worker.env change. No FileShot / other-platform prompt change. 27B path unchanged.

**Outcome if applied:** long Cloud agent jobs keep a real progress memory after rotate; other 2B chatbots unchanged.

**Edge cases:** 2B timeout/quota/junk → heuristic notice + `phase: fallback`. Cancel mid-summarize → skip upgrade. Non-Secrypt Cloud providers skip 2B call (heuristic only).

## Validation

- Unit: prompt constants, validateSummary accept/reject, replaceCondensedNotice wiring (mocked generate).
- `npm test` green.
- Manual: long Cloud agent job triggers rotate → UI shows Context summarizing → notice in history is LLM text with TASK/DONE/NEXT; other apps still get normal 2B replies without summarizer prompt.
- Ship: bump `0.4.96`, commit, tag, push, CI green.

## LFL (execute on go — already ordered)

| File | Change |
|------|--------|
| `tools/cloudContextSummarize.js` | NEW — prompt + `summarizeDroppedContextFast` |
| `tools/cloudContextSummarize.test.js` | NEW |
| `cloudAgenticChat.js` | async applyFit → 2B upgrade + events |
| `preload.js` | `onContextSummarize` |
| `frontend/src/App.jsx` | handle `context-summarize` |
| `frontend/src/stores/appStore.js` | `setContextSummarizeSegment` |
| `frontend/src/components/ChatPanel.jsx` | ContextSummarizeBlock + finalize segment |
| `package.json` | `0.4.96` + test script entry |
