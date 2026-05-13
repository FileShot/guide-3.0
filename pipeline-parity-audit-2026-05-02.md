# Pipeline Parity Audit — Server vs Electron (2026-05-02)

## Scope
This audit compares the runtime AI pipeline used by:
- Browser/server test path (`node server/main.js --dev`)
- Electron desktop app path (`electron-main.js`)

Goal: verify whether they are exactly the same pipeline and whether current build/version state reflects 3.0.14.

## Executive Result
They are not exactly the same end-to-end pipeline today.

They do share the same core engine modules (`chatEngine.js`, `mcpToolServer.js`, `ragEngine.js`, `tools/toolParser.js`), but the wrapper/orchestration layer and ai-chat option payload differ between server and Electron.

## Shared Core (Same)
- `ChatEngine` loaded by both:
  - `server/main.js` (require ChatEngine)
  - `electron-main.js` (require ChatEngine)
- `RAGEngine` loaded by both
- `MCPToolServer` loaded by both
- Tool parsing and context shift live in shared modules:
  - `tools/toolParser.js`
  - `chatEngine.js`

Implication: changes inside shared modules usually affect both paths.

## Parity Gaps (Not Same)

### 1. ai-chat options differ
Electron sends additional controls to `llmEngine.chat(...)` that server does not.

Electron path includes:
- `compactToolPrompt`
- `systemPrompt` + `rulesManager.getRulesPrompt()`
- `thinkingBudget`
- `generationTimeoutSec`

Server path includes:
- `toolPrompt`
- `systemPrompt` only
- No `compactToolPrompt`
- No `thinkingBudget`
- No `generationTimeoutSec`

Impact:
- Model behavior can diverge between browser/server tests and Electron app for the same prompt/settings.

### 2. Rules injection differs
- Electron app appends rules text into the system prompt via `rulesManager.getRulesPrompt()`.
- Server path does not.

Impact:
- Safety/behavioral constraints can differ by path even with same model.

### 3. Cancellation behavior differs
- Server cancel handlers also call `mcpToolServer.killActiveChildren('user-cancel')`.
- Electron cancel handlers only call `llmEngine.cancelGeneration(...)`.

Impact:
- Long-running tool subprocess behavior can differ when stopping generation.

### 4. Transport/runtime wrapper differs
- Server uses Express + WebSocket transport (`server/main.js`, `server/transport.js`).
- Electron uses IPC handlers and `/api-fetch` emulation in-process (`electron-main.js`).

Impact:
- Not a pure parity issue in core inference logic, but execution environment differs and can affect edge behavior.

### 5. API/version metadata drift
- `electron-main.js` `/api/health` reports `version: '2.0.0'`.
- Server likely reports different metadata depending on path state; the shared repo package is 3.0.14.

Impact:
- Diagnostic/version signals can mislead test interpretation.

## Build/Version Readiness Check (3.0.14)

### Source-of-truth version files
- Root package version: `3.0.14` (`package.json`)
- Frontend package version: `3.0.0` (`frontend/package.json`)

### UI-displayed version currently hardcoded old
- `frontend/src/components/StatusBar.jsx` shows hardcoded `v2.3.15`
- `frontend/src/App.jsx` about notification includes `guIDE 2.3.15`

Impact:
- Running app can appear to be 2.3.15 even if backend code changed.

### Installer script version hardcoded old
- `scripts/build-installers.js` has `const VERSION = '2.3.15';`

Impact:
- Produced installer filenames are stamped with 2.3.15 unless changed.

### Existing packaged artifact metadata is older
- `dist-electron/latest.yml` shows `version: 3.0.12`

Impact:
- Current dist metadata does not indicate a completed 3.0.14 packaging cycle.

## Conclusion
1. Server test path and Electron app are not exactly identical today.
2. Core AI engine modules are shared.
3. Wrapper-level differences are significant enough to create behavior drift.
4. Build/version metadata is inconsistent with 3.0.14 runtime expectations.

## What must be aligned for exact parity
1. Make ai-chat option payload identical in both entry paths.
2. Apply the same rules-injection strategy in both paths (or neither).
3. Make cancellation/subprocess termination behavior identical.
4. Unify `/api/health` version source to a single package version reference.
5. Remove hardcoded UI version strings and source from package/app version.
6. Remove hardcoded installer script version and source from package version.

## Build decision
A rebuild is needed after parity/version alignment if you want a trustworthy 3.0.14 artifact where:
- runtime behavior parity is explicit,
- UI version labels match actual version,
- installer metadata/version files match source.

## Notes
This report intentionally does not apply code changes; it is evidence-only and readiness-focused.
