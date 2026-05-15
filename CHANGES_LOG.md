# guIDE 3.0 — Changes Log

> Every code change must be logged here. Context windows expire. If it's not here, it's lost.

---

## 2026-05-15 — CRITICAL: Fix _ensurePage false-dead bug — browser restarts at about:blank during SAML redirects (B15)

### Problem
Clicking the BrightSpace Launcher on mycampus.maine.edu opens a popup that triggers SAML redirects.
During these redirects, `_ensurePage()` uses `page.evaluate(() => true)` to check page liveness.
But `evaluate()` throws when the JS execution context is being destroyed/recreated mid-navigation,
falsely marking the live page as dead. This causes `_ensurePage()` to close the entire browser
and relaunch at about:blank — losing all session state, cookies, and navigation progress.

This happened 3 times in a single session (log lines 818, 1231, 1630), each time producing
the same crash: click BrightSpace Launcher → SAML redirect → evaluate throws → browser killed → about:blank.

### Root Cause
`_ensurePage()` at lines 225 and 237-238 used `page.evaluate(() => true)` as the liveness check.
The B15 fix (using `isClosed()` instead) was already applied to `click()` popup handling at lines
808 and 821, but was NEVER applied to `_ensurePage()` itself. This is the exact bug documented
in the code comment at lines 805-807.

### Fix
- **browserManager.js `_ensurePage()` (lines 222-282)**: Replaced `evaluate(() => true)` with `isClosed()`
  at both locations (primary check + surviving-pages scan). Added retry loop (3 attempts with
  waitForLoadState + waitForTimeout) for pages that aren't closed but have evaluate fail mid-navigation.
  Only declares a page dead after all retries exhaust AND isClosed() confirms closure.
- Surviving-pages scan now uses `isClosed()` instead of `evaluate()`, so it finds pages that are
  mid-navigation instead of skipping them.

### Files Changed
- `browserManager.js` lines 222-282 (function `_ensurePage`)
- `package.json` version 0.3.53 → 0.3.54

### Impact
- Browser no longer restarts at about:blank when clicking links that trigger SAML redirects
- Popup/new-tab navigation works correctly through redirect chains
- Session cookies and login state preserved across navigation events

---

## 2026-05-15 — CRITICAL: Fix PL8 role TDZ bug — browser_snapshot crashed on every call (B8)

### Problem
PL8 added link-aware text limits: `(tag === 'a' || role === 'link') ? 200 : 120` on line 331 of browserManager.js.
But `const role` was declared on line 334 — 3 lines AFTER its first use. JavaScript `const` has a Temporal Dead Zone:
accessing it before declaration throws `ReferenceError: Cannot access 'role' before initialization`.
This crashed `getSnapshot()` on EVERY call, making browser_snapshot return `success:false` 100% of the time.
The model then looped calling browser_snapshot 220 times, browser_navigate 32 times, and read_file 26 times.
The browser subsystem was completely non-functional.

### Root Cause
Variable declaration order bug introduced by PL8. `role` used before declared. Same pattern in iframe section (line 483)
but iframe section never got the link-aware text limit — it was hardcoded to 80 chars.

### Fix
- **browserManager.js line 329-334**: Moved `const role = el.getAttribute('role') || ''` BEFORE `textLimit` computation.
  Now `role` is available when the ternary evaluates. No more ReferenceError.
- **browserManager.js line 481-485**: Same fix for iframe interactive elements. Also applied link-aware text limit
  (200 for links, 120 for others) instead of the old hardcoded 80 chars.

### Files Changed
- `browserManager.js` lines 328-334, 480-485

### Impact
- browser_snapshot now works on ALL sites (not just Brightspace — the TDZ crash affected every page)
- Link text preserved up to 200 chars on both main frame and iframe elements
- 704 ReferenceError crashes eliminated per session

---



## 2026-05-15 — Settings audit: 4 dead settings wired + frontend-backend sync (S1–S7)

### Problem

Full pipeline audit of all settings revealed 4 "dead" settings that were defined in the UI but never consumed by the inference engine, plus a critical frontend-backend sync gap that made hardware settings (gpuLayers, contextSize, kvCacheType) stale after user changes.

1. `maxIterations` — slider in UI, sent in chatContext, but never extracted or enforced in `chatEngine.js`. Tool loop had no iteration cap.
2. `generationTimeoutSec` — slider in UI, sent in chatContext, but never extracted. No timeout existed around `generateResponse()`. Old `chatEngine.js` had this code but it was lost in rewrite.
3. `maxResponseTokens` — field in UI, sent as `maxTokens` in chatContext, but `chatEngine.js` computed `genOptions.maxTokens` from context space alone, ignoring the user value entirely.
4. `reasoningEffort` — Low/Medium/High buttons in UI, sent in chatContext, but `chatEngine.js` never read it. Pure placebo.
5. Frontend `updateSetting()` wrote to localStorage only — never called `POST /api/settings`. Backend `settingsManager` reads from `settings.json`, a completely separate store. Hardware settings changed in UI were never persisted to backend, so model reload read stale values.
6. Frontend default mismatches: `maxIterations` was 25 in frontend vs 0 in backend; `kvCacheType` was `q3_0` in frontend vs `q4_0` in backend (after migration).
7. Visual sync feedback UI existed in Sidebar but was never triggered because `updateSetting()` never called `setSettingsSyncState`.

### Changes

1. **S1 — Frontend-backend settings sync** (`appStore.js`): `updateSetting()` now calls `POST /api/settings` after localStorage save, with `setSettingsSyncState` feedback. Hardware settings changes now persist to `settings.json` so model reload reads correct values.

2. **S2 — Wire maxIterations** (`electron-main.js`, `server/main.js`, `chatEngine.js`): Pass `maxIterations` from settings to `chat()`. Tool loop `while` condition now checks `this._toolRoundCount < maxIterations`. When limit hit, injects system message telling model to summarize. 0 = unlimited (default, matches current behavior).

3. **S3 — Wire generationTimeoutSec** (`electron-main.js`, `server/main.js`, `chatEngine.js`): Pass `generationTimeoutSec` from settings to `chat()`. Before `generateResponse()`, sets `setTimeout` that calls `this._abortController.abort()` after N seconds. Timer cleared on completion. 0 = disabled (default).

4. **S4 — Wire maxResponseTokens** (`chatEngine.js`): `genOptions.maxTokens` now computed as `Math.max(512, Math.min(availableForGeneration, userMaxTokens))` where `userMaxTokens = options.maxTokens > 0 ? options.maxTokens : Infinity`. User-set limit is respected; 0/-1 = unlimited.

5. **S5 — Wire reasoningEffort** (`chatEngine.js`): When `thinkingBudget` is 0 (auto), maps `reasoningEffort` to thinking token budget: low=512, medium=2048, high=8192. Explicit `thinkingBudget` setting overrides this.

6. **S6 — Fix frontend default mismatches** (`appStore.js`): `maxIterations` default changed 25→0 (match backend). `kvCacheType` default changed `q3_0`→`q4_0` (match backend migration). Both in initial settings object and `resetSettings()`.

7. **S7 — Visual sync feedback** (`Sidebar.jsx`): Already existed — shows "Saving..." (blue) → "Saved" (green) → "Save failed" (red). Was dead because `updateSetting()` never triggered it. Now works via S1.

### Root cause

- S1: `updateSetting()` was localStorage-only. Backend `settingsManager` reads `settings.json`. Two completely separate stores.
- S2-S5: Settings were sent in `chatContext.params` from `ChatPanel.jsx` but never extracted in `electron-main.js` or consumed in `chatEngine.js`.
- S6: Frontend defaults were written independently of backend defaults and never synchronized after backend migrations.
- S7: `setSettingsSyncState` was defined but never called from `updateSetting()`.



---



## 2026-05-15 — Pipeline limiting factor fixes (PL1–PL8)

### Problem

Full browser test walkthrough of a university portal (login → BrightSpace → course → syllabus → assessments) identified 8 structural pipeline limitations that make web automation difficult or impossible for models, especially smaller ones:

1. Snapshot page text was uncompressed — repeated lines, overlong lines, decorative noise consumed context without helping the model act.
2. Tool result injection used a flat 32K char cap regardless of tool type or model context size — too aggressive for browser snapshots, too generous for file reads. Hardcoded number violated Rule 9.
3. Iframe content showed no scroll metadata — model had no way to know content was scrollable beyond the visible portion.
4. Dropdown menus needed 4 tool calls instead of 2 — post-click snapshot was taken before dropdown animation completed.
5. Same-URL clicks (tab switches, AJAX updates) returned "SAME PAGE" with no indication whether content actually changed — model might retry thinking the click failed.
6. Popup/tab navigation gave no context about where the model came from — it didn't know the previous page URL.
7. Ref numbers reset every snapshot — model could reuse stale refs from a previous page and click wrong elements.
8. Element text was truncated at 80 chars — long link text (course names) was cut off before identifying information appeared.

### Changes

1. **PL1 — Smart snapshot compression** (`browserManager.js` `getSnapshot`): Added `_compressPageText()` that deduplicates identical lines, trims lines over 200 chars, and collapses consecutive blank lines. Preserves ALL unique content (assignments, due dates, etc.) while removing visual noise. Smart truncation in `chatEngine.js` preserves ALL interactive element refs and only truncates page text section, using head+tail pattern with "call browser_scroll to see more" hint.

2. **PL2 — Runtime-computed per-tool inject budgets** (`chatEngine.js`): Replaced fixed `MAX_TOOL_RESULT_INJECT_CHARS = 32000` with `BASE_TOOL_RESULT_INJECT_CHARS` + `TOOL_INJECT_MULTIPLIERS` map. Actual cap computed at runtime as `max(8000, contextSize * 4 * 0.25) * multiplier`. Browser tools get 1.5x, file/web tools get 0.25–0.5x. Works for any model from 2K to 128K context (Rule 9 compliant).

3. **PL3 — Iframe scroll metadata** (`browserManager.js` `_ensureRefs` + `getSnapshot`): Both same-origin and cross-origin iframe sections now include scrollability info: `scrollable: 30% visible — use browser_scroll to see more`. Model can see that more content exists beyond the visible portion.

4. **PL4 — Dropdown timing + menuitem hint** (`browserManager.js` click handler): Added 500ms extra wait after click for dropdown animation. Post-click pageState now detects `role="menuitem"` in snapshot and says "a dropdown menu opened — click one directly using its ref number."

5. **PL5 — DOM fingerprint change detection** (`browserManager.js` click handler): Before click, captures lightweight DOM fingerprint (interactive element count + first 200 chars of body text). After click, compares fingerprints. Same-URL clicks now get one of three messages: "dropdown opened", "content changed (tab switch)", or "content unchanged — try different element."

6. **PL6 — Popup context info** (`browserManager.js` popup handler): Added `previousUrl` field to popup click results. pageState for navigated popups now says "you switched from [previous URL] to [current URL]" so the model knows where it came from.

7. **PL7 — Stale-ref detection** (`browserManager.js`): Added `_snapshotGen` counter and `_refGenMap` (ref→generation mapping). New `_isStaleRef()` method checks if a ref belongs to the current snapshot generation. Added stale-ref check before `_resolveRef()` in `browser_click`, `browser_type`, `selectOption`, `hover`, and `fillForm`. Stale refs return clear error: "Call browser_snapshot to get fresh element refs." Ref format `[ref=N]` is unchanged — no model retraining needed.

8. **PL8 — Element text limit increase + general link text cleaning** (`browserManager.js` `_ensureRefs`): Link text limit raised from 80→200 chars, other elements 80→120 chars. Href limit raised 80→150 chars. Added general-purpose regex cleanup for link text: strips trailing registration codes (`NNNN.XXXX-XX.NNNNN.N`) and date suffixes (`Ends Mon DD, YYYY at HH:MM AM/PM`). No site-specific strings.

9. **PL1 — General scroll guidance** (`chatEngine.js` SYSTEM_PROMPT): Added "If a snapshot shows content is truncated or you need to see more of the page (e.g., content below the fold), call browser_scroll to scroll down, then browser_snapshot to see the new content." — general wording, no test-specific references.

### Root cause

- PL1: Flat truncation cut from the end of a monolithic string, which could remove element refs the model needed to act.
- PL2: Hardcoded 32K cap was wrong for 4K context models and insufficient for 128K context models.
- PL3: Model had zero information about scrollable iframe content — it couldn't know more existed.
- PL4: 800ms wait was too short for CSS-animated dropdown menus.
- PL5: `navigated: false` gave no signal about whether the click had any effect on the DOM.
- PL6: Model lost track of where it was when switching tabs — no previous URL in result.
- PL7: Ref numbers reset every snapshot; model could click a stale ref from a previous page.
- PL8: 80-char limit was arbitrary and too short for long link text common in LMS/portal sites.



---



## 2026-05-15 — Browser navigation fixes (B8–B11)

### Problem

1. Clicking links that trigger SAML SSO redirects (e.g., BrightSpace Launcher on UMS portal) resulted in `about:blank` — Playwright falsely detected a popup event, the code killed the original page, the popup died, and `_ensurePage` launched a brand new blank browser. Happened 3 times in one session.

2. `_ensurePage()` immediately launched a new browser when `this._page` was dead, even if the browser process was still alive with surviving pages in its context.

3. `browser_select_option` was called on `<a>` elements (not `<select>`) because the snapshot didn't distinguish dropdowns from links — no `[SELECT]` marker existed.

4. `ask_question` options weren't appearing as clickable buttons — small models embedded option descriptions in the question text string instead of passing them as the `options` array parameter.

### Changes

1. **B8 — Popup false-positive resilience** (`browserManager.js` click handler): Instead of blindly switching to any popup Playwright detects, now checks BOTH the popup and original page for real URLs after the click. If the popup is on `about:blank` but the original page navigated, keeps the original (popup was a SAML redirect artifact). Only switches to popup if it has a real, non-blank URL. Prevents the about:blank death spiral.

2. **B9 — _ensurePage surviving page recovery** (`browserManager.js` `_ensurePage`): When `this._page` is dead, checks `this._browser.contexts()` for any alive pages before launching a new browser. If found, switches to the surviving page. Only relaunches browser if no usable pages exist.

3. **B10 — [SELECT] marker in snapshot** (`browserManager.js` `_ensureRefs` + iframe frame eval): Added `[SELECT]` marker to `<select>` elements in both main frame and iframe snapshots, matching the existing `[SUBMIT]` pattern. Models can now distinguish dropdowns from links.

4. **B11 — ask_question clickable options guidance** (`mcpToolServer.js` tool definition + `chatEngine.js` SYSTEM_PROMPT): Rewrote tool description to emphasize options MUST be in the `options` array parameter for clickable buttons. Updated SYSTEM_PROMPT with explicit example format. Prevents small models from embedding options in question text.

### Root cause

- B8: Popup handling assumed `waitForEvent('popup')` only fires for intentional `target=_blank` links. SAML redirect chains can trigger transient popup events that don't represent real navigation targets. The code killed the original page before verifying the popup was useful.
- B9: `_ensurePage` treated a dead page as a dead browser. These are different failure modes — the browser can be alive with other pages.
- B10: No visual indicator for `<select>` elements in the snapshot. The model saw text content near an element and guessed it was a dropdown option.
- B11: Tool description didn't emphasize that the `options` array is what creates clickable UI. Small models took the path of least resistance (embedding in text).

---



## 2026-05-15 — Tool parser alias fix + popup liveness fix (B12–B15)

### Problem

1. `vscode_askQuestions` tool call silently dropped — `normalizeToolCall` lowercased the tool name to `vscode_askquestions`, but the alias key in `TOOL_NAME_ALIASES` was mixed-case (`vscode_askQuestions`). JavaScript object key lookup is case-sensitive, so the alias was never found, and the tool was rejected as invalid. Model fell back to plain text or `ask_question` with malformed params.

2. BrightSpace Launcher click → 27x repetitive loop over 1h14m. Click triggered popup event, B8 resilience kept original page, but `navigated` was hardcoded `true` in the popup path — model thought it navigated, saw same page, retried.

3. Popup liveness check `evaluate(() => true)` threw during SAML redirect (JS execution context being destroyed/recreated), falsely marking live popups as dead. B8 then closed the "dead" popup and kept the original page. The popup that would have navigated to BrightSpace was killed on every attempt.

### Changes

1. **B12 — TOOL_NAME_ALIASES case normalization** (`toolParser.js`): Added runtime normalization loop that lowercases all alias keys at module load. Added broad alias coverage for every VALID_TOOLS entry in underscore-joined lowercase form (e.g., `browsernavigate`, `readfile`, `runcommand`). Fixed `vscode_askQuestions` → `vscode_askquestions` key. Any future mixed-case alias is automatically normalized.

2. **B13 — Click navigated flag reflects actual URL change** (`browserManager.js` popup resilience path): Changed hardcoded `navigated: true` to `navigated = this._page.url() !== urlBefore`. Added `pageState` message that tells the model the popup failed and suggests navigating directly.

3. **B15 — Popup liveness check uses isClosed()** (`browserManager.js` click handler): Replaced `evaluate(() => true)` with `page.isClosed()` for both popup and original page liveness checks. `isClosed()` is a Playwright API that checks page state without executing JS in the page context, so it doesn't throw during navigation. This prevents live popups from being falsely marked dead during SAML redirects.

### Root cause

- B12: `normalizeToolCall` lowercased tool names at line 333, but `TOOL_NAME_ALIASES` keys were defined in mixed case. The alias existed but was unreachable. `vscode_askQuestions` was the only mixed-case key, but the bug would affect any future mixed-case alias.
- B13: B8's popup resilience path hardcoded `navigated: true` because it assumed any popup event meant navigation. When the popup died (due to B15 bug), the original page hadn't navigated, but the result said it had — misleading the model into retrying.
- B15: `evaluate(() => true)` requires a live JS execution context in the page. During SAML redirect chains, the old context is destroyed and a new one is created — `evaluate()` throws during this transition. `isClosed()` is a Playwright-level check that doesn't depend on JS context state.



---



## 2026-04-20 — Install Playwright + fix browser loop + reduce inject cap



### Problem

Three bugs observed in tool-chaining test (news headline fetch):

1. `browser_navigate` succeeded (iframe mode) but `browser_snapshot` always returned `"No browser page open"` — no Playwright was installed, so DOM tools were unusable. Model looped navigate→snapshot→navigate→dedup→final continuation→more tools.

2. Dedup break message said "continue with different tools or parameters if more work remains" → model generated more tool calls in the final continuation (sent nothing to user).

3. `MAX_TOOL_RESULT_INJECT_CHARS = 32000` was too large: one `fetch_webpage` result (~10K tokens) nearly filled the entire 11,359-token history budget. After 2 fetches, context shifted and dropped the original user message. Model hallucinates about conversation ("the snippet you shared...").



### Changes

1. `npm install playwright --save` (using D:\Server\npm.cmd + PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, then `npx playwright install chromium`). Playwright 1.59.1 installed, chromium-1217 binary present. `package.json` updated.

2. `tools/mcpBrowserTools.js` `_browserNavigate()`: Added `if (!this.browserManager._page) { await this.browserManager.launchPlaywright(); }` before `browserManager.navigate(url)` — auto-launches Playwright (headless Chromium) on first browser_navigate call so `browser_snapshot` and all DOM tools work immediately after navigation.

3. `chatEngine.js` dedup break message: Changed from "Continue the task with different tools or parameters if more work remains. Only write a prose reply when the task is fully done." to "All tool calls in this round were already executed. No more tool calls are permitted. Write your final reply to the user now." — removes permission to continue tooling.

4. `chatEngine.js` `MAX_TOOL_RESULT_INJECT_CHARS`: `32000` → `10000` — fits ~2,500 tokens, allowing 3-4 tool results to coexist in the 11,359-token history budget without triggering aggressive context shifts.



### Root cause

- Bug 1: browserManager.navigate() fell back to iframe mode (no Playwright), then DOM tools checked `this._page` (null) → always failing. Playwright needed to be installed AND launched on first use.

- Bug 2: "Continue with different tools" was genuinely permissive — the model chose that option since the task was incomplete.

- Bug 3: A 32,000-char result ≈ 8,000 tokens — nearly the entire available body budget. History shifted after every large fetch, deleting the user's original message from context.



### Not changed

- `webSearch.js` raw HTTP cap: 5MB (unchanged from previous session)

- `mcpToolServer.js` tool result per-field cap: 40,000 chars — inject cap is now the binding constraint

- Server PID: 30288, port 3000



---



## 2026-04-20 — Raise fetch cap to 5MB + add message/response content logging



### Problem

1. `fetch_webpage` returned `"Response too large"` for Google News and other heavy JS sites because `webSearch.js` hard-capped raw HTTP response at 2MB

2. Backend logs showed only `argsLen=X` / `responseLen=Y` — actual user message and model text not visible, making debugging impossible without asking the user what they sent



### Changes

1. `webSearch.js` L77 (`_nodeFetch` GET path): `2 * 1024 * 1024` → `5 * 1024 * 1024`

2. `webSearch.js` L117 (`_nodePost` POST path): `2 * 1024 * 1024` → `5 * 1024 * 1024`

3. `server/main.js` `ai-chat` handler: added `console.log(\`[Chat] User: ${userMessage.slice(0,300)}\`)` before `llmEngine.chat()`

4. `chatEngine.js` L885: `generateResponse returned` log now appends `\nText: <first 300 chars>`

5. `chatEngine.js` L1052: `Final continuation (post-dedup)` log now appends `\nText: <first 300 chars>`

6. `chatEngine.js` L1109: `Continuation after tools` log now appends `\nText: <first 300 chars>`



### Root cause

- Bug 1: 2MB cap was set for memory safety but is too low for real news/content sites

- Bug 2: Log lines were purely statistical — no content visibility



### Not changed

- `_electronFetch` has no size cap but is Electron-only and inactive in web-server mode

- Downstream limits unchanged: 40,000 chars/field in mcpToolServer, 32,000 chars inject cap in chatEngine



---



### Problem

1. `browser_navigate` returned `{"success":false,"error":"this.browserManager.navigate is not a function"}` — `server/main.js` was calling `mcpToolServer.setBrowserManager({ parentWindow: mainWindow })` with a plain stub object before the real `BrowserManager` was instantiated. All browser tool methods call `this.browserManager.navigate()`, which doesn't exist on the stub.

2. Model was wrapping narration text in `\`\`\`vbnet` (or other language-labeled) code fences between tool calls. SYSTEM_PROMPT had no rule against this.



### Changes

1. `server/main.js`: Removed the early stub `setBrowserManager({ parentWindow: mainWindow })` call. Moved the real wiring to after `const browserManager = new BrowserManager(...)` — added `mcpToolServer.setBrowserManager(browserManager)` so the full BrowserManager instance (with `.navigate()` and `.parentWindow`) is passed.

2. `chatEngine.js` `SYSTEM_PROMPT_ORIGINAL` `## Rules` section: Added rule — "Do NOT wrap narration text, step descriptions, or reasoning in code fences. Code fences are only for tool-call JSON (```json fences) or actual code samples requested by the user."



### Root cause

- Bug 1: Initialization order — `setBrowserManager` was called at L124 but `new BrowserManager()` was at L136. The stub had `parentWindow` but no class methods.

- Bug 2: No explicit instruction in system prompt; model used language-labeled fences for step narration by default.



### Not changed

- Playwright not installed — browser tools fall back to `BrowserManager.navigate()` (preview iframe via IPC or noop in web-server mode). This is correct behavior.

- Fetch truncation pipeline unchanged: raw HTTP 2MB → per-field 40,000 chars → inject cap 32,000 chars.



---



## 2026-04-17 — Match live GraySoft typography more closely and slim the search control



### Problem

The prior pass still had non-matching GraySoft brand typography, the in-page search strip carried too much chrome, and the metadata pills were wasting vertical space by sitting under the description instead of under the hero image.



### Changes

1. Added the live-site `Audiowide` brand treatment to the header/footer wordmark in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js), while keeping header nav and footer links on the same `Inter` sizing/color pattern measured from graysoft.dev.

2. Replaced the chunky in-page search controls in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js) with a slimmer search bar and a compact scope dropdown on the right.

3. Moved the metadata pills into the hero image column in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js) so they occupy the empty vertical space beneath the logo/image instead of pushing the main text column downward.

4. Regenerated the static pages and browser-validated that the compact search still returns live results for `allenai` on the target page.



### Remaining gap

This pass is closer to the live GraySoft typography and structure, but it still is not a pixel-perfect mirror of every live page spacing detail.



---



## 2026-04-17 — Move search into page body and align header/footer closer to GraySoft



### Problem

The first search pass crowded the fixed header, the model-page nav still carried `Roadmap`, the top stats remained visually heavy, and the footer did not follow the live GraySoft footer pattern.



### Changes

1. Removed `Roadmap` from the model-page header nav in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js).

2. Moved the global model search UI out of the fixed header and into its own in-page band near the top of [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js), while keeping the generated `_search` artifacts and client-side behavior intact.

3. Tightened the stat-card typography and spacing again in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js) to reduce the bulk of the top card.

4. Replaced the footer in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js) with a GraySoft-style minimal footer using the live site’s product-link pattern.

5. Regenerated the static pages and browser-validated that the header nav now reads `Projects / Models / About / FAQ / Contact`, the in-page search still returns live results for `allenai`, and the footer now follows the GraySoft product-link structure.



### Remaining gap

This pass improves structure and typography, but it does not attempt a pixel-identical clone of every live GraySoft spacing and font treatment.



---



## 2026-04-17 — Compact hero layout and add generated global model search



### Problem

The enriched model page still felt too tall at the top, the quantization sidebar looked visually disconnected from the benchmarks section, and there was no way to jump between generated model pages from the page header. The static output also had no generated search artifact for a real header search UI to query.



### Changes

1. Tightened the hero spacing and stat-card footprint in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js) to reduce vertical bulk without removing metadata.

2. Restacked the benchmark and related-quantization sections in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js) so quantizations render below benchmarks as a full-width card band instead of a sidebar.

3. Added a generated static search index in [tools/graysoft-html-pipeline/src/index.js](tools/graysoft-html-pipeline/src/index.js) under `output/models/_search/{all,author,model}/` so model pages can search other generated pages without relying on the React frontend.

4. Added a styled global header search UI and client-side search logic in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js), including `All`, `Model`, and `Author` filter buttons.

5. Regenerated the corpus and browser-validated the local page so the new header search returned live results for `allenai` and the `_search` shard fetch returned HTTP `200`.



### Remaining gap

This is still a lightweight static-site search, not a full ranked search engine. Search currently operates against generated shard files rather than a dedicated search service.



---



## 2026-04-17 — Fix HF repo-path enrichment for slash-based model IDs



### Problem

README enrichment and file-tree enrichment were silently broken for repos with IDs like `author/model`. The client encoded the slash inside the path segment, so Hugging Face returned HTTP `400` for README fetches and `Invalid repo name ... includes an url-encoded slash` for tree fetches. That left model pages with generic descriptions, no hero image, and `Unknown` file sizes. The related-quantizations API query also returned unrelated global models.



### Changes

1. Added path-safe repo encoding in [tools/graysoft-html-pipeline/src/pipeline/hfClient.js](tools/graysoft-html-pipeline/src/pipeline/hfClient.js) so model IDs are encoded by segment instead of encoding `/` itself.

2. Switched text fetches in [tools/graysoft-html-pipeline/src/pipeline/hfClient.js](tools/graysoft-html-pipeline/src/pipeline/hfClient.js) to use text-friendly accept headers for README and HTML page retrieval.

3. Replaced the broken related-quantizations API lookup in [tools/graysoft-html-pipeline/src/pipeline/hfClient.js](tools/graysoft-html-pipeline/src/pipeline/hfClient.js) with extraction from the Hugging Face HTML search page for `other=base_model:quantized:<modelId>`.

4. Re-scraped `allenai/olmOCR-2-7B-1025` and regenerated static HTML, which populated README-derived hero content, quick links, benchmark HTML, correct quantized variants, and real file sizes.



### Remaining gap

The HTML quantization fallback currently yields model IDs without downloads/likes/library stats, so related-quantization cards render those values as empty data. That needs a separate approved follow-up if the page should display richer quantization metadata.



---



## 2026-04-17 — Enrich model pages with README content and all-file downloads



### Problem

The first model-page pass assumed every page should be GGUF-first. That produced empty-looking download sections for non-GGUF repositories such as BF16 safetensors models, and the page was missing README-derived model-card content like images, long descriptions, quick links, and benchmark tables.



### Changes

1. Added authenticated retry-aware text fetching plus README and related-quantization enrichment in [tools/graysoft-html-pipeline/src/pipeline/hfClient.js](tools/graysoft-html-pipeline/src/pipeline/hfClient.js).

2. Wired README parsing and related quantization lookup into scrape ingestion in [tools/graysoft-html-pipeline/src/index.js](tools/graysoft-html-pipeline/src/index.js).

3. Updated normalization to use README summary as the description fallback and preserve enriched card data in [tools/graysoft-html-pipeline/src/pipeline/normalize.js](tools/graysoft-html-pipeline/src/pipeline/normalize.js).

4. Reworked the static template in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js) to show all repository files, richer hero content, quick links, benchmark table rendering, related quantizations, tighter header typography, and a denser layout.



### Current blocker

Existing rows in corpus.db still reflect older scrape passes until individual models are re-scraped with the new enrichment path, so preview accuracy for file sizes and card-derived content depends on refreshing those models.



---



## 2026-04-17 — Build graysoft-html-pipeline ingestion baseline



### Scope

Implemented the first end-to-end data pipeline in [tools/graysoft-html-pipeline](tools/graysoft-html-pipeline) for ingesting Hugging Face model metadata/files into SQLite, generating static model HTML, and generating sitemap shards at 2000 URLs each.



### Changes

1. Switched pipeline DB layer from better-sqlite3 to sqlite/sqlite3 in [tools/graysoft-html-pipeline/package.json](tools/graysoft-html-pipeline/package.json) and [tools/graysoft-html-pipeline/src/storage/db.js](tools/graysoft-html-pipeline/src/storage/db.js).

2. Added HF API client in [tools/graysoft-html-pipeline/src/pipeline/hfClient.js](tools/graysoft-html-pipeline/src/pipeline/hfClient.js).

3. Added scrape command wiring and async DB ingestion flow in [tools/graysoft-html-pipeline/src/index.js](tools/graysoft-html-pipeline/src/index.js).

4. Expanded normalization coverage in [tools/graysoft-html-pipeline/src/pipeline/normalize.js](tools/graysoft-html-pipeline/src/pipeline/normalize.js).

5. Expanded schema and migration support in [tools/graysoft-html-pipeline/src/storage/schema.sql](tools/graysoft-html-pipeline/src/storage/schema.sql) and [tools/graysoft-html-pipeline/src/storage/db.js](tools/graysoft-html-pipeline/src/storage/db.js).

6. Expanded generated model template content in [tools/graysoft-html-pipeline/src/templates/modelPage.js](tools/graysoft-html-pipeline/src/templates/modelPage.js).



### Current blocker

Live HF API requests from this IP now return HTTP 429 with a message requiring authenticated requests using HF_TOKEN, so scrape validation cannot proceed without either a token or a local snapshot import source.



---



## 2026-04-13 — Replace GBNF tool calling with raw text parsing



### Problem

Tool calling is 0% functional. `functionCalls=0` across ALL tests (10+ tests, 7+ models). Small models either ignore GBNF grammar constraints (generate text instead of structured calls) or loop indefinitely (repeat same call 20 times). Meanwhile, `tools/toolParser.js` (728-line multi-format parser) and `mcpToolServer.getToolPrompt()` (comprehensive prompt with examples) exist in the codebase but were never wired into chatEngine.js.



### Root Cause

Three gaps in chatEngine.js:

1. `toolPrompt` passed by server/main.js but never destructured — comprehensive mcpToolServer prompt discarded

2. `genOptions.functions` set GBNF grammar — small models can't use it (PAST_FAILURES.md Category 6)

3. `toolParser.parseToolCalls()` never imported or called — 728 lines of battle-tested parsing unused



### Changes (chatEngine.js ONLY)

1. **Line 8**: Added `const { parseToolCalls, repairToolCalls } = require('./tools/toolParser');`

2. **Line 123**: Added `toolPrompt` to options destructuring

3. **Lines 127-135**: System prompt now prefers `toolPrompt` (from mcpToolServer, with format examples + "use write_file" rule) over `_buildToolPrompt(functions)` (flat list, no examples)

4. **Lines 164-166**: Removed `genOptions.functions` and `genOptions.documentFunctionParams` (GBNF disabled)

5. **Lines 180-250**: Replaced dead GBNF loop (`stopReason === 'functionCalls'`, never triggered) with raw text parsing loop: `parseToolCalls(fullResponse)` → `repairToolCalls()` → execute via `executeToolFn` → add results to history → regenerate → repeat until no tool calls or MAX_TOOL_ITERATIONS



### Design Details

- `roundStart` index tracks where each generation round starts in `fullResponse` — prevents re-executing tool calls from previous rounds

- Tool results fed back as `{type: 'user', text: '[Tool Results]\n...'}` — gives model natural continuation context

- `repairToolCalls()` handles edge cases: empty content recovery, filePath inference, dropped call recovery

- `_buildToolPrompt()` and `convertToolDefs()` kept as fallbacks but not used when `toolPrompt` is available

- No changes to `_contextShiftStrategy`, SYSTEM_PROMPT, server/main.js, or any other file



### What Should Change

Model should receive the comprehensive tool prompt with format examples. If it outputs tool call JSON in any of 7+ supported formats (XML `<tool_call>`, ```json fences, raw JSON, function-call syntax, etc.), `parseToolCalls` will detect and execute them. If model still outputs raw text without tool calls, behavior is identical to before (no regression).



---



## 2026-04-13 — Pin user message in context shift strategy



### Problem

After context rotation, the model lost the user's original request. The `_contextShiftStrategy` allocated ALL remaining budget (after system prompt) to the response tail, leaving 0 tokens for the user message. The user message was dropped as a "middle item" on every rotation. Result: model generated 25,793 lines of repetitive ASCII art across 93 rotations because it had no knowledge of the original task.



### Root Cause

Line `availableForLastItem = budget - systemTokens - 20` sized the response tail to fill the ENTIRE remaining budget. With budget=6266, systemTokens≈1500, the response consumed ~4746 tokens, leaving only ~10 tokens — far too few for the user message (~500 tokens).



### Fix

In `_contextShiftStrategy()` (chatEngine.js):

1. Find the most recent user-type message in the middle items

2. Reserve its token count in the budget before truncating the response

3. Skip it during the middle-item fill loop (already accounted for)

4. Include it in the output history in chronological order using index-based ordering

5. Changed budget line to: `availableForLastItem = budget - systemTokens - pinnedUserTokens - 20`



### Effect

After rotation, model sees [system + user message + response tail] instead of [system + response tail]. Response tail is ~500 tokens shorter (~12K chars instead of ~14K), but model retains knowledge of the task.



---



## 2026-04-13 — Restore backup chatEngine.js (context shift fix)



### Problem

The git HEAD (v2.3.15) had a BROKEN `_contextShiftStrategy` that returned a plain array instead of `{ chatHistory, metadata }`. This caused `TypeError: Cannot read properties of undefined (reading 'slice')` in node-llama-cpp's `addAvailableFunctionsSystemMessageToHistory`. The strategy silently fell back to the default (eraseFirstResponseAndKeepFirstSystem), which cannot trim the current in-progress response. Result: generation stops at 100% context, zero context rotation.



### Root Cause

The guide-3.0-backup copy at `C:\Users\brend\guide-3.0-backup\chatEngine.js` had the CORRECT version (437 lines) with proper `{ chatHistory, metadata }` return format AND response truncation logic. The git HEAD had a broken version (397 lines) that lost `_lastEvaluation` tracking, `_buildToolPrompt`, and correct context shift return format.



### Change

- Copied `guide-3.0-backup/chatEngine.js` to `guide-3.0/chatEngine.js`

- Replaced the backup's one-line SYSTEM_PROMPT with the current detailed version (tool usage instructions, continuation note, rules)

- Restored: `_contextShiftStrategy` with correct `{ chatHistory, metadata }` return format

- Restored: Response truncation from beginning when single response exceeds budget

- Restored: `_lastEvaluation` tracking and `lastEvaluationContextWindow` passing

- Restored: `_buildToolPrompt` for dynamic tool usage instructions



### Observable Effect

Context shift should no longer crash. When context fills, the strategy truncates the current response from the beginning (keeping most recent content) and returns proper format. Generation should continue after context shift instead of stopping at 100%.



---



## 2026-04-10 — Change AB: Pre-seeded conversation history with native chat tokens



### Problem

Change AA (behavioral examples in SYSTEM_PROMPT) failed. sysChars confirmed at 8497 — model received the examples. But they appeared as plain text inside the system message using `User:`/`Assistant:` labels, NOT the model's native `<|im_start|>user` / `<|im_end|>` / `<|im_start|>assistant` tokenizer format. The model cannot treat plain-text examples in the system prompt as "prior successful interactions" — they're just instructions. Training prior (output code blocks for coding requests) dominated.



### Root cause refinement

Behavioral examples MUST use the model's native chat format to be effective. When examples are real entries in `_chatHistory`, `LlamaChatSession` formats them with the correct Jinja template tokens. The model sees them as prior context in its exact training format, and in-context learning activates.



### Change AB — chatEngine.js: Pre-seeded initial conversation history



**File:** `chatEngine.js`

**Changes:**

- Reverted SYSTEM_PROMPT `## Examples` section (Change AA removed — no effect, ~400 tokens overhead recovered)

- Added `_buildInitialHistory()` private method returning 7-item array: system message + 3 example exchange pairs (write_file, append_to_file, plain text question)

- Replaced both `this._chatHistory = [{ type: 'system', text: SYSTEM_PROMPT }]` initializations (in `initialize()` and `resetSession()`) with `this._chatHistory = this._buildInitialHistory()`



**Examples seeded:**

1. User: "create an entry point for the project" → Model: `{"tool":"write_file",...}`  

2. User: "the file is getting long, keep adding the remaining code" → Model: `{"tool":"append_to_file",...}`

3. User: "what does a closure do in JavaScript" → Model: plain text (no tool)



**What stays unchanged:** Generation parameters (Change Z), toolPrompt from mcpToolServer, context shift strategy, all parsing logic.



**Test result:** FAILED — same failure as all previous changes. rawLen=22,616, stopReason=eogToken, 0 tool calls. Model wrote full HTML as chat text.



**Revert path:** Superseded by Change AC.



---



## 2026-04-10 — Change AC: LlamaCompletion (raw text) instead of LlamaChat (chat template)



### Root cause (confirmed)

`LlamaChatSession` → `QwenChatWrapper` applies `<|im_start|>user<|im_end|><|im_start|>assistant` tokens → activates RLHF-trained "helpful assistant" mode. In this mode the model outputs markdown code blocks for every file request. This overrides ALL prompt-level instructions — proven across 11 changes (S through AB).



Evidence: guide-2.0 R20-R21 used the same model (Qwen3.5-2B-Q8_0), same library (node-llama-cpp 3.18.1), with raw text completion → write_file calls worked.



### Solution

Switch from `LlamaChat`/`generateResponse` to `LlamaCompletion`/`generateCompletionWithMeta`. No chat template = no RLHF mode activation. Model receives raw text prompt and must produce raw text output. Tool call examples in the prompt are plain JSON, not fenced code blocks.



### Change AC — chatEngine.js: Full API switch



**File:** `chatEngine.js`

**Changes:**



1. **Constructor**: `_chat → _completion`, `_chatHistory → _conversationLog []`, removed `_lastEvaluation`

2. **initialize()**: Import `LlamaCompletion` instead of `LlamaChat`; instantiate `this._completion = new LlamaCompletion({ contextSequence })`; init `_conversationLog = []`

3. **chat()**: Removed system-prompt mutation logic; `effectiveToolPrompt` computed once; `_conversationLog.push({ role: 'user', text: userMessage })`

4. **generateOnce()**: Calls `this._completion.generateCompletionWithMeta(prompt, genOptions)` with `disableContextShift: true` and `customStopTriggers: ['\nUser:', '\n\nUser:', '<|im_end|>']`; removed `contextShift.strategy` and `lastEvaluationContextWindow`

5. **Tool loop**: History tracked via `_conversationLog` (push assistant + tool results); removed `_lastEvaluation` / `cleanHistory` updates

6. **Final state**: `_conversationLog.push({ role: 'assistant', text: rawResponse })` instead of lastEvaluation update

7. **resetSession()**: `_conversationLog = []` + `sequence.clearHistory()`

8. **_dispose()**: `_completion = null; _conversationLog = []`

9. **REMOVED**: `_buildInitialHistory()` (Change AB artifact), `_contextShiftStrategy()` (80 lines — no longer needed)

10. **ADDED**: `_buildPrompt(toolPrompt)` — builds raw text prompt: SYSTEM_PROMPT + toolPrompt + 3 examples + `_conversationLog` serialized as `User:`/`Assistant:` lines

11. **ADDED**: `_trimHistoryToFit(toolPrompt)` — pre-generation context trim: while tokenCount > 0.75*contextSize, drops oldest 2 entries from `_conversationLog` (keeps current user message)



**Test project:** test-changeac-1

**Test result:** PENDING



**Revert path:** `git restore chatEngine.js`



---



## 2026-04-10 — Change AA: Behavioral few-shot examples in SYSTEM_PROMPT (REVERTED)



### Problem

Model never calls tools. Changes S-Z all failed. Root cause analysis determined:

1. `LlamaChatSession` puts the model in "assistant response" mode — fine-tuning strongly biases toward outputting code blocks in chat rather than tool call JSON.

2. The system prompt had rules ("for file operations use the file tools") but NO worked examples showing the model what a correct response looks like. Rules are weaker than training priors for a 2B model in chat mode.

3. Switching to raw completion was considered but rejected because the `_contextShiftStrategy` is tied to `LlamaChatSession`'s `chatHistory` structure — the working context rotation would break.



### Hypothesis

In-context learning (behavioral few-shot examples) can override training priors by showing the model the exact expected output pattern, not just instructions. The model learns from examples in the system prompt: "when user asks to create a file → call write_file, not code block in chat."



### Change AA — chatEngine.js: SYSTEM_PROMPT behavioral examples



**File:** `chatEngine.js`

**Constant:** `SYSTEM_PROMPT`

**Change:** Added `## Examples` section after the `## Rules` section with 12 behavioral examples covering: write_file (new file), append_to_file (continue writing), write_file×2 (multiple files), read_file, edit_file, run_command, list_directory, grep_search, web_search, browser_navigate, and 2 plain text responses (no tool needed).



**What stays unchanged:** Generation parameters (Change Z), all parsing logic, toolPrompt from mcpToolServer, context shift strategy.



**Test result:** PENDING



**Revert path:** `git restore chatEngine.js`



---



## 2026-04-10 — Change Z: Sampling parameters — match guide-2.0 working defaults



### Problem

Model never calls tools. Changes S-Y all modified system prompt text and parser routing. All failed. Root cause investigation compared the actual `generateResponse()` call parameters between guide-2.0 (known to call write_file for simple tasks) and guide-3.0.



Found: guide-2.0 uses temperature=0.4, topP=0.95, topK=40, repeatPenalty=1.1. Guide-3.0 defaulted to temperature=0.7, no topP/topK/repeatPenalty constraints. At temperature 0.7 without sampling constraints, the model's probability distribution is flatter — the training distribution attractor (write code in chat) competes more evenly with the instruction-following signal (call write_file). For complex tasks with strong training distribution pull, the training distribution wins.



### Change Z — chatEngine.js: Match sampling parameters to guide-2.0 defaults



**File:** `chatEngine.js`

**Function:** `chat()`, `generateOnce()`, `genOptions` block

**Changes:**

- `temperature: options.temperature ?? 0.7` → `options.temperature ?? 0.4`

- `topP: options.topP` → `options.topP ?? 0.95`

- `topK: options.topK` → `options.topK ?? 40`

- `repeatPenalty: options.repeatPenalty ? { penalty: options.repeatPenalty } : undefined` → `{ penalty: options.repeatPenalty ?? 1.1 }`



**What stays unchanged:** All prompt text (SYSTEM_PROMPT, toolPrompt), all parsing logic, all event wiring, all context shift logic.



**Revert path:** `git restore chatEngine.js`



---



## 2026-04-10 — Structured system prompt + concrete tool format example



### Problem: Model writes code as text instead of calling tools despite full tool prompt being active

Change X confirmed the full tool prompt (4566 chars, 20 tools) reaches the model. Parser works (found run_command call). But model still wrote 25,483 chars of HTML as text, 0 proper tool calls. Investigation found:

1. guide-3.0's SYSTEM_PROMPT was abstract paragraphs ("use the appropriate tool") — guide-2.0/original IDE had structured "## When to Use Tools" categories that worked

2. guide-3.0's format instruction had abstract placeholder `{"tool":"name","params":{...}}` — guide-2.0 had a concrete example with real tool name and params

3. guide-3.0's tool categories were bare labels — no usage context for when to use each category



### Change Y — chatEngine.js + mcpToolServer.js: Structured prompt + format example



**chatEngine.js — SYSTEM_PROMPT (lines 10-30):**

- Replaced abstract paragraph-form prompt with structured sections

- Added "## When to Use Tools" with one entry per tool category (file, web, terminal, browser, git, memory, analysis, planning) — all categories treated equally

- Added "## Continuation" section for seamless continuation

- Added "## Rules" section with behavioral expectations (verify tool results, retry failures, create all requested files, use exact filenames)

- Category entries describe WHEN to use each category, not which specific tool to pick

- Conversation/text response listed LAST, not first



**mcpToolServer.js — _buildToolPrompt() (line 2853):**

- Format instruction changed from abstract `{"tool":"name","params":{...}}` to more concrete `{"tool":"tool_name","params":{"param":"value"}}`

- Added concrete `Example:` block with real tool call: `{"tool":"list_directory","params":{"dirPath":"."}}`

- Category headers changed from bare labels to descriptive labels with usage context (e.g. "File Operations — for creating, reading, modifying, or deleting files and directories")

- All 6 categories have equal usage descriptions — no tool prioritized over another



**Revert path:** `git restore chatEngine.js mcpToolServer.js`



---



## 2026-04-10 — Wire chatEngine to existing tool infrastructure



### Problem: Model writes code as text instead of calling tools (882 lines of HTML as text, 0 tool calls)

chatEngine.js had its own SIMPLIFIED _buildToolPrompt() (flat list, no categories, no rules) and SIMPLIFIED _parseToolCalls() (only 2 detection methods). The same codebase already had battle-tested versions in mcpToolServer.js (full prompt with categories, patterns, "NEVER output full file content as code blocks") and tools/toolParser.js (7+ detection methods, 50+ tool name aliases, truncated recovery, XML/JSON/function-call syntax). chatEngine wasn't using them.



Guide-2.0 live test confirmed: same model (Qwen3.5-2B) with the full tool prompt + full parser successfully called write_file to create hello.txt.



### Change X — chatEngine.js + server/main.js: Use existing tool infrastructure



**chatEngine.js:**

- Added `const { parseToolCalls } = require('./tools/toolParser');` import

- `chat()` now destructures `toolPrompt` from options

- When `toolPrompt` is provided (full prompt from mcpToolServer), uses it instead of calling `this._buildToolPrompt(functions)` — log message: "Using full tool prompt (N chars)"

- `_parseToolCalls()` body replaced: delegates to `parseToolCalls()` from toolParser, maps `{tool, params}` → `{name, params}` format, computes cleanText by stripping fenced/XML/raw tool blocks



**server/main.js:**

- Added `const toolPrompt = mcpToolServer.getToolPrompt();` after building tool definitions

- Passes `toolPrompt` in llmEngine.chat() options



**What stays unchanged:**

- `_buildToolPrompt()` method remains as fallback (used when no toolPrompt passed)

- `convertToolDefs()` unchanged

- Tool loop, event wiring (Change V), streaming logic unchanged

- No new files, no new abstractions



**Revert path:** `git restore chatEngine.js server/main.js`



---



## 2026-04-10 — Tool call format change + output suppression removed



### Problem: <tool_call> XML format recognized by 3/7 models (all Qwen). Output suppression hides tool call content from UI.

7-model test results: Qwen3 0.6B, Qwen2.5 0.5B, Qwen3 4B followed `<tool_call>` XML tags. Llama 3.2, EXAONE 4.0, Qwen2.5 1.5B, Qwen3.5 2B did not. EXAONE produced correct JSON without wrapper tags. The streaming buffer `flushSafeText()` mechanism suppressed tool call content from the UI, violating guide-master.md line 101.



### Change S — chatEngine.js: Remove output suppression from streaming buffer



**Removed:**

- `TOOL_START`/`TOOL_END` constants from `generateOnce()`

- `streamBuffer`, `inToolCall`, `toolCallBuffer` state variables

- `flushSafeText()` function — the entire streaming buffer state machine

- Post-generation buffer flush logic (orphan tag handling, remaining buffer flush)



**Replaced with:** Direct passthrough — every chunk from `onTextChunk` goes to `fullResponse` and `onToken` immediately. All model output is visible in the UI.



### Change T — chatEngine.js: Switch tool call format from `<tool_call>` XML to ` ```json ` markdown fences



**_buildToolPrompt():**

- OLD format instruction: `<tool_call>\n{"name":"tool_name","params":{...}}\n</tool_call>`

- NEW format instruction: ` ```json\n{"tool":"write_file","params":{"filePath":"index.html","content":"hello"}}\n``` `

- JSON key changed: `"name"` → `"tool"` (less ambiguous — "name" conflicts with parameter names)

- Concrete example with real tool values instead of placeholder `tool_name`

- Explicit rules: one tool per block, always use fences, wait for result



**_parseToolCalls():**

- OLD: Single method scanning for `<tool_call>JSON</tool_call>` blocks

- NEW: Two-method parser:

  1. ` ```json ` fenced code blocks — regex extracts JSON from markdown fences, checks for `"tool"` key

  2. Raw JSON fallback — regex matches `{"tool":"...","params":{...}}` without fences (handles EXAONE-like models)

- Return interface unchanged: `{ toolCalls: [{name, params}], cleanText }`

- Non-tool ` ```json ` blocks (e.g. code examples) pass through — only blocks with a `"tool"` key are treated as tool calls



**Rationale:** Markdown code fences (` ```json `) appear in every LLM training corpus (GitHub code, Stack Overflow, documentation). `<tool_call>` XML tags appear in none. Choosing a format models already know reduces the need for complex multi-fallback parsers.



**Revert path:** `git restore chatEngine.js`



---



## 2026-04-10 — Truncated JSON brace recovery in _parseToolCalls



### Problem: Model hits eogToken before writing final closing brace(s) in tool call JSON

Qwen3-0.6B emitted a ```json fenced write_file call with 5495 chars of properly escaped HTML content. JSON was structurally complete except for missing final `}` to close the outer object. JSON.parse failed at position 5494. Tool call was detected but never executed — no file created.



### Change U — chatEngine.js: Add brace recovery to _parseToolCalls



**Where:** `_parseToolCalls()`, Method 1 catch block (fence detection)



**What:** When JSON.parse fails on a fenced code block, try appending up to 3 closing `}` characters. After each append, retry JSON.parse. If it succeeds and has a `"tool"` key, accept the recovered tool call.



**Why not a band-aid:** The model generated structurally valid JSON with properly escaped content (162 `\n` sequences). The only defect was a missing trailing brace — the model's eogToken fired before completing the structure. This recovers clearly-intended structure, not patching bad output.



**Revert path (all changes S+T+U):** `git restore chatEngine.js`



---



## 2026-04-10 — Wire backend tool events to frontend display system



### Problem: Raw tool call JSON visible in chat UI as code block

After Changes S+T+U, the model correctly generates ```json fenced tool calls, the parser extracts them, and tools execute. But the raw JSON `{"tool":"write_file","params":{...}}` was streamed as `llm-token` events during generation and rendered in the chat UI as a visible code block. The backend computed `cleanText` (response minus JSON) but never sent it to the frontend. The backend never emitted `file-content-start/token/end` events that the frontend's `FileContentBlock` component expects.



### Change V — chatEngine.js + server/main.js + App.jsx + appStore.js: Event wiring



**chatEngine.js:**

- Added `onStreamEvent` to destructured options

- After `_parseToolCalls()` finds tool calls:

  - Emits `llm-replace-last` with `{ originalLength: rawResponse.length, replacement: parsed.cleanText }` — tells frontend to strip the raw JSON from display and replace with clean text

  - Cleans `fullResponse` to match

- Before each tool execution:

  - Emits `tool-executing` — triggers tool card display (file ops skipped per R42-Fix-4)

  - For tools with `params.content` + `params.filePath`: emits `file-content-start` (with language from file extension), `file-content-token` (full content), `file-content-end` — triggers FileContentBlock display

- After each tool execution:

  - Emits `mcp-tool-results` — triggers tool completion card (file ops skipped per R42-Fix-4)



**server/main.js:**

- Added `onStreamEvent: (eventName, data) => mainWindow.webContents.send(eventName, data)` to ai-chat handler options



**App.jsx:**

- `llm-replace-last` handler now calls `s.replaceLastStreamingChunk(data.originalLength, data.replacement)`



**appStore.js:**

- Added `replaceLastStreamingChunk(originalLength, replacement)` method:

  - Flushes pending 80ms token buffer

  - Trims last `originalLength` characters from `chatStreamingText`

  - Appends `replacement` text

  - Updates last text segment in `streamingSegments` to match

  - Preserves previous segments (file blocks, tool cards from earlier iterations)



**Expected result:** User sees actual file content in a FileContentBlock (filename header + syntax-highlighted code), not raw JSON wrapper. Clean text (if any) before/after the tool call remains visible.



**Revert path (Change V only):** `git restore chatEngine.js server/main.js frontend/src/App.jsx frontend/src/stores/appStore.js`



---



## 2026-04-10 — Raw text parsing replaces GBNF function calling



### Problem: GBNF structured function calling fails across all model families

Tested 7 models / 6 families with node-llama-cpp's `genOptions.functions` + `documentFunctionParams: true`. 0 of 7 worked correctly. Category A (4 models) always pick text mode. Category B (3 models) loop the same function call 20 times. See PAST_FAILURES.md Category 6 for full test results.



### Change R — chatEngine.js: Raw text parsing (replaces GBNF function calling)



**Removed:**

- `genOptions.functions = functions` — no longer passing GBNF function definitions to generateResponse

- `genOptions.documentFunctionParams = true` — no longer using GBNF parameter documentation

- Entire GBNF-based tool call loop (`while (stopReason === 'functionCalls')` block)

- GBNF diagnostic log (replaced with new logging)



**Added:**

- `_parseToolCalls(text)` method — extracts `<tool_call>{"name":"...","params":{...}}</tool_call>` blocks from model text output. Returns `{ toolCalls: [{name, params}], cleanText }`.

- Streaming buffer in `generateOnce()` — holds back last 11 chars (length of `<tool_call>`) to prevent tool call content from reaching the UI. Text before `<tool_call>` is streamed normally. Text inside `<tool_call>...</tool_call>` is suppressed.

- Text-based tool call loop — after generation: parse raw response → execute tool calls → add `[Tool Result: toolName]\nresult` to chatHistory as user message → generate again → repeat.

- Fallback: if `fullResponse` is empty and no tools ran, shows `rawResponse` so user always sees something.



**Modified:**

- `_buildToolPrompt()` — added TOOL CALL FORMAT section telling the model the exact `<tool_call>` JSON format. Removed "chain tools in sequence" instruction (now: "call one tool at a time and wait for its result").



**Not changed:** server/main.js, mcpToolServer.js, convertToolDefs(), context shift strategy, frontend. The `functions` object is still created and passed to `chat()` but used only for building the system prompt — not for GBNF.



**Revert path:** `git restore chatEngine.js` reverts to the GBNF baseline state. Or for full revert of all uncommitted changes: `git restore chatEngine.js mcpToolServer.js frontend/src/components/ChatPanel.jsx CHANGES_LOG.md model-config.json PAST_FAILURES.md`



---



## 2026-04-09 (session 3, continued) — Tool calling improvements + UI fixes



### Problem: 0 tool calls at baseline. Model generates code as text instead of calling tools.

FileShot test: 781 lines HTML as text, stopReason=eogToken, functionCalls=0. System prompt had weak tool guidance, tool prompt was file-biased, only 12 tools enabled, tool descriptions contained legacy Format: hints and behavioral instructions.



### Change L — chatEngine.js: Production system prompt (SYSTEM_PROMPT constant)

- **OLD**: "You are guIDE, a helpful AI coding assistant running locally. You help users write code, answer questions, and assist with software development tasks. Be concise and direct."

- **NEW**: 4-paragraph prompt covering: (1) identity as local AI with tool access, (2) when to use tools — any action including files, commands, search, browse, analyze, (3) when to use text — questions, explanations, discussions, (4) code quality + follow existing conventions

- **Rationale**: Model needs explicit instruction that it has tools and should use them for actions.



### Change M — chatEngine.js: General _buildToolPrompt (replaces file-biased version)

- **OLD**: TOOL USAGE RULES listing specific file/grep/web tool categories with "you MUST use" imperatives

- **NEW**: AVAILABLE TOOLS section with parameter signatures (e.g. `- write_file (filePath: string, content: string): description`) followed by 4 general TOOL USAGE rules: use tools for actions, chain tools for multistep, prefer tools over text output, use text for questions/explanations

- **Rationale**: Previous version only instructed model about file tools. Browser, git, search, and system tools were not mentioned.



### Change N — chatEngine.js: DEFAULT_ENABLED_TOOLS expanded from 12 to 20

- **Added 8 tools**: search_codebase, delete_file, rename_file, git_status, git_diff, git_commit, install_packages, analyze_error

- **Categories covered**: File ops (10), Search (2), Web (2), Terminal (2), Git (3), Debug (1)

- **Remaining 46 tools**: Available but disabled by default, toggleable in settings



### Change O — mcpToolServer.js: Cleaned all 66 tool descriptions

- Removed `Format: {"tool":"name",...}` hints from all descriptions (legacy text-parsing hints, already stripped by convertToolDefs)

- Removed behavioral imperatives from descriptions (e.g. "ALWAYS use this tool", "NEVER output file contents", "Call this before naming or assuming any files exist")

- Kept descriptions factual: what the tool does, not how the model should behave

- Behavioral instructions belong in the system prompt, not individual tool descriptions



### Change P — chatEngine.js: GBNF diagnostic log

- Added generation config log before first generateResponse call

- Logs: function count, documentFunctionParams state, system prompt character length, lastEvaluation presence

- Purpose: Diagnostic — confirms GBNF function calling grammar is active during generation



### Change Q — ChatPanel.jsx: Directory-specific recent chats

- Session save now includes `projectPath` in the saved session object

- Session display filters by current `projectPath` — only shows sessions from the same project

- If no project is open, shows all sessions (fallback)



---



## 2026-04-08 — Context Management System (3 changes to chatEngine.js)



### Problem: No context management existed in guide-3.0

chatEngine.js had no context shift strategy (used default), maxTokens: -1 (unlimited — triggers infinite context shift loop per llama.cpp #3969), and no continuation mechanism (model stops mid-file and that's the end).



### Change A — chatEngine.js: Custom context shift strategy (_contextShiftStrategy method)

- ADDED: `_contextShiftStrategy()` method (lines 259-293)

- Logic: Always keeps system prompt (first item) + current response (last item). Fills remaining budget from most recent turns backward. Uses actual `tokenizer.tokenize()` for token counting — NOT character estimation. 10% safety margin on budget.

- No content inspection. No JSON parsing. No segment splitting. Items are opaque.

- Passed to `generateResponse()` via `contextShift: { strategy: this._contextShiftStrategy.bind(this) }`



### Change B — chatEngine.js: maxTokens default (lines 110-113)

- CHANGED: `maxTokens: options.maxTokens || -1` → computed default

- Formula: `Math.min(options.maxTokens > 0 ? options.maxTokens : Infinity, Math.floor(ctxSize * 0.8))`

- Caps any single generation at 80% of context size

- Prevents the infinite context shift loop (llama.cpp issue #3969)

- Every production tool (KoboldCpp, text-generation-webui, SillyTavern) sets a generation length cap



### Change C — chatEngine.js: Continuation loop (lines 148-189)

- ADDED: After first `generateResponse()`, if `stopReason === 'maxTokens'`, automatically:

  1. Adds continuation user message: "Continue exactly where you stopped. Do not repeat any content."

  2. Calls `generateResponse()` again with updated history + lastEvaluation

  3. Tokens stream via same `onToken` callback — UI sees continuous text

  4. Repeats until stopReason !== 'maxTokens' or 50 continuations reached

- ONE continuation path. ONE prompt. No nesting analysis. No symbol extraction.

- Returns `{ text, stopReason, continuations }` — caller knows how many continuations occurred.



### What was NOT added:

- No summarization (old turns are dropped, not summarized)

- No second or third system

- No proactive rotation

- No content inspection in the shift strategy

- No template-based task ledger

- Total: ~70 lines of new code



---



## 2026-04-08 (session 2) — Removed continuation loop, added context ring + tool calling



### Root Cause of Boundary Artifacts

Testing at 2048 context revealed boundary artifacts at continuation points:

- HTML entity encoding (`&lt;` instead of `<`) after continuation

- Markdown code fence (` ```html `) appearing at continuation boundary

- Model starts a NEW response after "Continue" message, creating a seam



The continuation loop (Change C above) was the source. The native context shift (Change A) works seamlessly — the model never knows a shift happened. The fix: remove the continuation loop entirely.



### Change D — chatEngine.js: REMOVED continuation loop (Change B + C undone)

- **File**: chatEngine.js, chat() method

- **Removed**: maxTokens computation (Change B), MAX_CONTINUATIONS, continuationCount, lastStopReason, the entire while loop, completion logging

- **Result**: chat() now makes a single generateResponse() call. The model generates until it naturally stops (eogToken). Context shifts happen transparently via Change A.

- **Rationale**: Native context shift handles context compression during generation without interrupting the model. No restart, no new code block, no boundary artifacts.



### Change E — chatEngine.js + server/main.js: Context progress ring events

- **File**: chatEngine.js, chat() method

- **Added**: `onContextUsage` callback option, throttled to fire every ~50 text chunks

- **Data**: `{ used: this._sequence.nextTokenIndex, total: this._context.contextSize }`

- **File**: server/main.js, ai-chat handler

- **Added**: `onContextUsage: (data) => mainWindow.webContents.send('context-usage', data)`

- **Frontend**: StatusBar.jsx already has ContextRing component reading chatContextUsage from store. App.jsx already handles 'context-usage' events. This change connects the backend to the existing frontend.



### Change F — chatEngine.js + server/main.js: Native tool calling via node-llama-cpp (UPDATED in session 3)

- **File**: chatEngine.js, chat() method

- **Added**: `functions`, `executeToolFn`, `onToolCall` options

- **Added**: Tool call loop: when `stopReason === 'functionCalls'`, executes each tool via `executeToolFn`, adds results to chat history, calls `generateResponse()` again. Loops until model stops calling tools.

- **Added**: Static `convertToolDefs()` method — converts mcpToolServer format (array of {name, description, parameters}) to node-llama-cpp's `ChatModelFunctions` format ({name: {description, params: GbnfJsonSchema}})

- **Added**: `ChatEngine.DEFAULT_ENABLED_TOOLS` — set of 12 core tools enabled by default

- **File**: server/main.js, ai-chat handler

- **Added**: Builds ChatModelFunctions from mcpToolServer.getToolDefinitions(), passes to llmEngine.chat() with executeToolFn callback that calls mcpToolServer.executeTool()

- **Added**: Default disabled tools set at startup — all tools except the 12 defaults are disabled

- **Added**: `onToolCall` sends 'tool-call' events to frontend

- **Key**: Uses node-llama-cpp's NATIVE function calling (GBNF grammar constrains output). NOT text-based parsing from guide-2.0. The model outputs structured function calls, not JSON blocks in text.



---



## 2026-04-08 (session 3) — 4 fixes to chatEngine.js after first tool call test



### Test Results That Prompted These Changes

- 796 lines generated, 1 context shift, 100% context reached

- BUG-1: Context shift strategy returned 9343 tokens for 6635 budget — node-llama-cpp fell back to default

- BUG-2: File incomplete (JS cut mid-function) — consequence of BUG-1

- BUG-3: Model never called tools — system prompt had no tool guidance



### Change G — chatEngine.js: Context shift strategy handles oversized lastItem

- **File**: chatEngine.js, `_contextShiftStrategy()` method (lines ~294-377)

- **Root cause**: When the model's current response (lastItem) is very large (800+ line HTML file), `systemItem + lastItem` alone exceeds the budget. The strategy returned the full oversized history, causing node-llama-cpp to reject it and fall back to its default strategy.

- **What changed**:

  - Budget reduced from 90% to 85% of maxTokensCount (more conservative margin for tokenization estimation error)

  - Added `getItemText()` helper that handles both `.text` and `.response` items (including non-string elements via JSON.stringify)

  - When `systemTokens + lastItemTokens > budget`: truncates lastItem from the BEGINNING, keeping the most recent content (the end of the response). Uses actual tokenizer with iterative reduction (max 5 iterations) to find the right truncation point.

  - Rebuilt item preserves original type: `.response` items get `[truncatedText]`, `.text` items get `truncatedText`

- **Observable effect**: Context shift should now return a valid history that node-llama-cpp accepts. The "strategy did not return a history that fits" warning should not appear.



### Change H — chatEngine.js: Tool-use instructions in system prompt

- **File**: chatEngine.js, `chat()` method + new `_buildToolPrompt()` method

- **Root cause**: SYSTEM_PROMPT was "You are guIDE, a helpful AI coding assistant..." with zero mention of available tools. The model had no reason to produce function calls even with GBNF grammar enabled.

- **What changed**:

  - `chat()` now augments the system prompt with tool descriptions when `functions` are provided

  - New `_buildToolPrompt(functions)` method: generates a tool list with names and descriptions, plus instructions on when to use tools vs inline code

  - Base prompt preserved — tool instructions are appended, not replaced

- **Observable effect**: Model should now be aware of available tools and prefer using them for file operations instead of generating inline code.



### Change I — chatEngine.js: Tool call iteration limit (MAX_TOOL_ITERATIONS = 20)

- **File**: chatEngine.js, `chat()` method, tool call while loop

- **Root cause**: The `while (stopReason === 'functionCalls' && ...)` loop had no upper bound. If the model kept producing function calls indefinitely, the loop would run forever.

- **What changed**: Added `totalToolCalls < MAX_TOOL_ITERATIONS` to while condition. Warning logged when limit reached.

- **Observable effect**: Tool call loop guaranteed to terminate after 20 iterations.



### Change K — chatEngine.js: Production-ready tool prompt (_buildToolPrompt)

- **File**: chatEngine.js, `_buildToolPrompt()` method

- **What changed**: Replaced basic one-line tool guidance with detailed TOOL USAGE RULES section. Explicitly instructs the model when to use each tool category (file tools for file operations, grep_search/find_files for search, list_directory for exploration, run_command for execution, web_search/fetch_webpage for web lookups). Explains tool chaining (read_file then edit_file then run_command). Clearly distinguishes when to respond with text vs. when to use tools. Uses imperative language ("you MUST use") for file operations.

- **Observable effect**: Model should more reliably use tools for file operations instead of generating inline code. System prompt now gives explicit decision rules for tool selection.



### Change J — chatEngine.js: Improved token estimation for response items

- **File**: chatEngine.js, `_contextShiftStrategy()`, `getItemText()` helper

- **Root cause**: Old `estimateTokens()` only handled string elements in `.response` arrays via `filter(r => typeof r === 'string')`. Non-string elements (function call objects etc.) were silently dropped, causing underestimation.

- **What changed**: `getItemText()` now maps ALL response array elements — strings pass through directly, non-strings are JSON.stringified. Gives accurate token estimation for all item types.

- **Observable effect**: More accurate context budget calculations, especially when chat history contains function call/result items.

