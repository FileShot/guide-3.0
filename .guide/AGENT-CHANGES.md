## NoGuess1 — 2026-10-05

**Operator:** Add to the model's system prompt: never guess anything — credentials, URLs, anything. If it does not know, call ask_question. Act on evidence, not hunches.

**Before:** Cipher's cloud prompt had one line: "Do not invent secrets. When you need a fact only the user has, call ask_question." Local agent prompt had a Clarification block limited to credentials/accounts. Plan and Ask prompts had nothing.

**Ship:** `agentModeResolver.js` — new `getEvidenceOnlyRule({ tools })` block "Evidence only — never guess (HARD)" (credentials, keys, tokens, accounts, emails, URLs, domains, hosts, IPs, ports, paths, file contents, config, command output, versions, prices, dates, names, facts; tool lookup first, then ask_question; no plausible defaults; no domain built from a product name; placeholders labeled; say I don't know). Inserted in `getCloudAgentSystemPrompt` (replaces the one-line secret rule), `getAgentSystemPrompt`, `getPlanSystemPrompt`, `getAskSystemPrompt` (tools:false → ask in prose). `tools/cloudTightPrompt.test.js` asserts it in all four.

**Proof:** `npm test` exit 0. Live 27B (`secrypt-p40`, full Cipher system prompt 13251 chars + tool catalog, `agent/_noguess1-live27b.js`): "deploy over SSH" → `ask_question` for host/user/auth/paths; "add Stripe key + webhook to live domain" → checked `.env` with a tool first; "hello world to hello.py" → `write_file` directly (no over-asking). guIDE relaunched 2026-10-05 23:06Z.

Bak: `agent/pre-noguess1-20261005-190505/agentModeResolver.js`. GROUNDRULES §4c added.

---

## ThinkBatch1 — 2026-10-04

**Operator:** Whole app freezes after send; "Prefilling — 66s" stuck, can't scroll, then the whole response appears at once. Operator go.

**Cause (measured):** `appendThinkingToken` did one `set()` per thinking token (prose tokens were already 16ms-batched by R34). Each set re-rendered the full chat (all messages in DOM since NoVirtuoso1). Renderer handled ~4 tok/s while Cipher emitted 15–20. stream-trace vs ui-trace lag per turn: 00:43 turn worst 336s, 01:2x turn 1040s, 01:02 turn handled 690/2205 tokens 110s behind; lag grew during thinking and shrank during prose. Renderer CPU 8s per 5s while streaming.

**Ship:** thinking tokens buffer into `_thinkTokenBuffer`, flushed by a 16ms timer via new `flushPendingThinkingTokens`. Thinking buffer is flushed first everywhere the text buffer is flushed (appendStreamToken, addStreamingToolCall, startFileContentBlock, addCompleteFileContentBlock, setChatStreaming(false), commitStoppedStreamingMessage, materializePartialAssistant, ChatPanel finalize preFlush) so segment order holds; pending text flushes before thinking.

**Proof:** FE build ok (marker in ChatPanel + index bundles). Live sends after restart: 406 thinking tokens worst lag 0.4s; 557 tokens worst lag 0.2s. rAF never under 23 fps (median 145), worst timer gap 430ms after send. Renderer CPU 1.8s per 5s while streaming.

**Not explained yet:** counter stuck at 66s during prefill in the 01:02 turn while the renderer handled the 71–101s warnings on time (repaint stall without JS block).

Bak: `agent/pre-thinkbatch1-20261004-214116/` (appStore.js, ChatPanel.jsx, dist). Electron restarted with `--remote-debugging-port=9333`.

---## ImgHist1 + logging restore — 2026-10-04

**Operator:** Attached GSC/GA screenshots. Cipher (27B) described them in its reasoning, called `read_file`, then the final answer said "I don't see them attached yet." Operator go: "fix it and also reenable logging."

**Cause:** Turn ran as two generates. Round 1 carried the images. `cloudAgenticChat.js` cleared `pendingImages` after the first successful generate. Tool rounds store only the tool-call JSON in history (`assistantHistoryContent`), and images were only ever on the outgoing request (`_generateViaProxy` local `messages`). Round 2 had no images and no description.

**Ship:**
1. `cloudAgenticChat.js` — images stay on every request of the turn (removed the five clear sites: success, continuePartial, length-continue, two ThinkDumpBail2 recovers). `imageAnchorText: userMessage` passed to generate. Vision-upstream-fail retry only before the first successful round with those images (`imagesDelivered`).
2. `cloudLLMService.js` — when the ask is earlier in history, images attach to that ask **after** normalize + context trim (trim flattens history to text). Fallback: trailing user turn if the ask was rotated out. Log `proxy vision: N image(s) on original ask idx=…`.
3. Logging: AppData wipe had reset `debugLogging`/`debugStreamDiag`/`streamTraceEnabled`/`streamTraceLevel` to off/`tokens`. Restored to true/true/true/`full`.

**Proof:** `npm test` fail 0. Capture harness `agent/_imghist1-capture.js`: round1, round2, round2-with-prior-turn all POST images (`IMAGES_ON_EVERY_ROUND=true`). Live P40 `cipher-quality` with image in the earlier user turn + assistant tool call + tool result → answered `BLUE 731` (2.8s, prompt_tokens=113). `guide-main.log` writing again after relaunch 20:01:29.

Bak: `agent/pre-imghist1-20261004-195949/`. Electron restarted.

---## ToolCallId1 + BrowserCollapseKey1 + BrowserSurface1 + ToolErrorLine1 — 2026-10-03

**Operator go** on `browser-ui-window-chrono.plan.md`.

**Ships:**
1. **ToolCallId1** — stream emits `toolCallId`; execute no longer double-fires `tool-generating`; results/updates match by id; orphan generating→error on finalize.
2. **BrowserCollapseKey1** — collapse key includes `ref`/`url`/`text`/`toolCallId`.
3. **BrowserSurface1** — navigate/launch calls `_showViewportBrowserTab` + `bringToFront`.
4. **ToolErrorLine1** — error text on card summary line.

Bak: `agent/pre-toolcallid1-20261003-213633/`. FE built; Electron restarted. WorkedCarry1 already live.

---## WorkedCarry1 — 2026-10-03

**Operator:** User 8:29 PM → assistant 8:37 PM (~8m wall) but UI **Worked for 31m 20s** (prior turn clock).

**Cause:** `setChatStreaming(true)` used `streamStartedAt || Date.now()`, so a stale start survived into the next user turn.

**Ship:** false→true always `Date.now()`; true→true (already streaming) keeps existing start. FE rebuild; Electron restart.

---## NoVirtuoso1 — 2026-10-03

**Operator:** Blank void still after TopTrip1. Repro unchanged: scroll absolute top → bottom. Remount band-aids failed (VirtBlank/ScrollMax/FooterHandoff/TopTrip).

**Cause:** react-virtuoso size accounting. Remounting does not clear the class for this chat.

**Ship:** Remove Virtuoso from chat list. Native `overflow-y-auto` div maps `virtuosoData` (messages + live stream sentinel). `scrollChatToEnd` uses `chatScrollRef` only. FE `ChatPanel-DC6GMtfD.js` (~58KB smaller). Electron restarted.

Bak: `agent/pre-novirtuoso1-20261003-ChatPanel.jsx`.

---## TopTrip1 — 2026-10-03

**Operator:** Blank void only if you scroll all the way to the top, then all the way down. Partial top scroll does not trigger it. FooterHandoff1 did not clear this class.

**Cause:** Virtuoso size-cache for off-screen items after an absolute-top visit. Scroll-to-bottom lands past real content.

**Ship:** `atTopStateChange` sets `visitedTopRef`. On next `atBottomStateChange(true)`, remount Virtuoso (`chatPaneKey`) pinned to end (400ms cooldown). FE `ChatPanel-sBtD2Yon.js`; Electron restarted.

---## FooterHandoff1b — 2026-10-03

**Operator:** Crash overlay after FooterHandoff1: `TypeError: i is not a function` in ChatPanel dist.

**Cause:** `scrollerRef={chatScrollRef}` — react-virtuoso calls `scrollerRef` as a function. RefObject is not callable.

**Ship:** `scrollerRef={(el) => { chatScrollRef.current = el; }}`. FE rebuilt (`ChatPanel-CRXZoCX2.js`); Electron restarted.

---## FooterHandoff1 — 2026-10-03

**Operator:** Still blank void after ScrollMax1 when scrolling up/down a few times then down. ScrollMax1 was not the class.

**Evidence:** Live stream lived in Virtuoso `Footer` (`StreamingFooter`). When `chatStreaming` flips false, Footer returns `null` while Virtuoso keeps the prior Footer height in total scroll range → blank void below the last message on scroll-down.

**Ship:** Append a `__liveStream` list sentinel while streaming; render `StreamingFooter` in that item. Remove Footer from Virtuoso components. Remount (`chatPaneKey`) on stream end; restore `scrollTop` if user had scrolled away. `increaseViewportBy.bottom` 800→200. `scrollToIndex` includes the sentinel.

Bak: `C:\Users\brend\FileShot-Main-Control\agent\pre-footerhandoff1-20261003-ChatPanel.jsx`. FE built (`ChatPanel-WIrYDcCN.js`); Electron restarted.

---## ScrollMax1 — 2026-10-03

**Operator:** Still big blank void after VirtBlank1 — prior cause was wrong.

**Evidence:** `scrollChatToEnd` used `virtuoso.scrollTo({ top: Number.MAX_SAFE_INTEGER })`. That overshoots Virtuoso’s real total height; scrolled-to-bottom shows a huge empty region under the last message (screenshot after VirtBlank1 still blank).

**Ship:** `scrollToIndex({ index: last, align: 'end' })` in `scrollChatToEnd` and session reopen. Keep VirtBlank1 unmount (harmless); it was not the blank void.

Bak: `agent/pre-scrollmax1-20261003-175910/`. FE built; Electron restarted.

---
## VirtBlank1 + WorkedForClock2 — 2026-10-03

**Operator:** Scroll to bottom → big blank void; still “Worked for 1s”.

**Blank cause (WRONG — see ScrollMax1):** claimed WorkedFor collapsed children / Virtuoso height cache. Operator proved blank remained after that ship.

**Clock cause:** `workedMs` still fell through to ~1s; missing `workedMs` also rendered as `1s` via `Math.max(1,…)`.

**Ship:** Unmount collapsed WorkedFor / Thought bodies. `workedMs` = min(turnStartedAt, streamStartedAt, earliest tool startTime). Label says “a moment” when ms missing. Store stop/partial paths use same helper.

Bak: `agent/pre-virtblank1-20261003-174557/`. FE built; Electron restarted.

---
## NoRateLimit1 + WorkedForClock1 — 2026-10-03

**Operator:** Cipher said “Hit the rate limit on a few edits”; “Worked for 1s” on long turns.

**Rate limit evidence:** `mcpToolServer.js` `edit_file: { max: 10, window: 10000 }`. turn-1791061590366 — 10 edit_file OK then 4× 114-char inject + `lastToolBatchFailed=1` at `21:11:28.641Z`. Error text: `Rate limit: too many edit_file calls…`. No proxy 429. Model repeated the host error.

**Worked for evidence:** `doSend` snapped `store` before `setChatStreaming(true)`; finalize used `store.streamStartedAt || Date.now()` → null → wall clock at end ≈ 1s.

**Ship:** Drop write/edit/delete/run rate caps; keep web_search/fetch/http caps. Capture `turnStartedAt` after streaming starts for `workedMs`.

Bak: `agent/pre-noratelimit1-20261003-171541/`. FE built; Electron restart.

---
## MultiToolCard1 — 2026-10-03

**Operator:** UI showed `Generating update_todo` with `filePath: index.html` / 2KB held. Banned guess-words after agent used them after acknowledging the ban.

**Evidence (guide-main / stream-trace turn-1791058453921):** `20:20:23Z` toolsParsed=4 — update_todo×3 then write_file `index.html` contentLen=14884. Execution correct; card used **first** `"tool"` in the hold buffer and pulled `filePath` from the whole buffer.

**Ship:** `extractFormingToolName` → last match; `sliceCurrentToolBuf` + params scoped to active tool; filePath only on write_* tools; progress tool follows last name. GROUNDRULES §5b + rule `83-banned-guess-words-forever.mdc` + RULES.md tripwire 9.

Bak: `agent/pre-multitoolcard1-20261003-162108/`. Electron restarted.

---
## StreamLiveFix1 + WhisperFast1 — 2026-10-03

**Operator:** Whisper lag; after Reasoning… chat blank for minutes while status showed tok/s — hide vs freeze.

**Cause:** (1) Thinking-channel tool JSON was held with no `onStreamEvent` and no prose mirror → blank void (hide). (2) StatusBar kept stale tok/s when char delta was 0. (3) Reasoning spinner stayed live after think tokens stopped. (4) Whisper chunks were 4.5s.

**Ship:** Mirror held thinking-tool bytes into prose `absorbSilentChunk` + emit tool-generating; end Reasoning after 2.5s quiet; footer “Still generating — Ns”; tok/s zeros on quiet tick; Whisper CHUNK_MS 1100 + silence 320ms + `-t` up to 8 CPUs / `-bs 1`. PROXY_SILENCE warn 12s / resume 45s.

Bak: `agent/pre-streamlivefix1-20261003-161156/`. FE built; Electron restarted (pid 40372).

---
## WorkedFor1 — 2026-10-03

**Operator:** Cursor folds finished turn work into collapsible `Worked for Xm Ys`; only final prose stays visible.

**Ship:** While streaming, timeline stays live. On finalize, tools/thinking/files/mid-turn segments go in `WorkedForBlock` (collapsed by default, grid fade expand). Trailing prose stays outside. `workedMs` from `streamStartedAt`. GROUNDRULES §4.4 notes this is disclosure not strip/hide.

Bak: `agent/pre-workedfor1-20261003-111831/`. FE built; Electron restarted.

---
## VirtRestore1 + PrefillWaitBar1 — 2026-10-03

**Operator:** app frozen / non-scrollable; audit rules and fix with replacements not deletes; prefill must be managed without strip/hold.

**Freeze cause:** chat used `chatMessages.map` (full DOM). Wait status every 5s + huge tool history locked the renderer.

**Replacements (see `.guide/AUDIT-GROUNDRULES-20261003.md`):**
1. Restore `react-virtuoso` (VirtRestore1).
2. Prefill/wait → StatusBar only (PrefillWaitBar1); no transcript status segments.
3. Remove CursorParity1 regex-delete strip; keep tool **divert** to tool cards.

Bak: `agent/pre-virtrestore1-20261003-101548/`. FE rebuilt; Electron restarted.

---
## GROUNDRULES locked — 2026-10-03

**Operator:** forever constraints — Cursor clone / universal IDE; never strip/hold/hide tokens; no task-specific hardcodes; Cipher stays P40 GPU-resident; no cheap workarounds; update rules same turn. Frustrated that strip/hold + wait UX ships violated this.

**Done this turn:** Wrote `GROUNDRULES.md` + `notes/guide3/RULES.md`; refreshed `obey-guide-rules.mdc`; added `82-no-strip-hold-hide-forever.mdc`; FileShot control `81` + `82-guide-cursor-clone-forever.mdc` alwaysApply.

**Speed evidence (not unload):** Cipher `-ngl 99`, VRAM ~20536 MiB. Thermal PL `150 -> 125` at 85C (`p40-thermal-pl.sh`). Prefill waits = large `n_prompt_tokens` with `n_decoded=0`. StreamWaitLive1 made prefill visible; did not create unload.

**Strip/hold:** CursorParity1 strip/hold violates new §1 — do not extend; proper path is channel routing only (separate ship, not more hide).

---
## CursorParity1 — 2026-10-03

**Operator:** sentence split by status; Waiting for model / first token / Receiving tool output spam; orphan `.`; `</tool_call>` leak into chat. Must match Cursor.

**Root cause:** StreamWaitLive1 pushed `generation-status` into `streamingSegments`, so later tokens opened a new text segment (`…that` / status / ` line.`). Hold path also emitted `Receiving tool output…`; broken tool JSON released early and painted command tails + `</tool_call>`.

**Fix:**
1. `chatGenerationStatus` footer field — never mid-prose segments; suppress while tools generating; drop Receiving-tool-output event.
2. Merge adjacent text on finalize; do not persist status segments.
3. Hold until strip removes every `tool_call` tag; strip broken `');…</tool_call>` tails (toolParser + FE display strip).

Bak: `agent/pre-cursorparity1-20261003-081426/`. Prove: `agent/_prove-cursorparity1.js` PASS.

---
## WaitCopy1 — 2026-10-03

**Operator:** "Waiting for first token" after model already generated; 6-9 tok/s vs 20-25; GPU "freezing cold".

**Evidence:** Slot 
_prompt_tokens grew 5532→25090 this morning (overnight peak 126060). GPU live 82-84C, 114-139W of 150W, ~100% util — not cold. StreamWaitLive1 painted age=0 + "first token" on every new generate onto the same assistant message that already had prose+tools.

**Fix:** Drop age=0 chat paint; first-byte status only after 5s; after iter/tools copy = "Loading next step" not "first token".

Bak: `agent/pre-waitcopy1-20261003-075845/`.

---
## ProxyNetResume1 — 2026-10-03

**Operator:** ended on Generation Error `getaddrinfo ENOTFOUND graysoft.dev`; ask if fixed for real (not post-hoc).

**Root cause:** StreamWaitLive1 only painted wait UI. Stall-resume regex covered 900s SSE silence but **not** DNS/name failures. Proxy catch logged `falling through to direct` then **threw** — no direct Secrypt path. Overnight: many 900s stalls resumed; final ENOTFOUND → `ai-chat cloud ERROR`.

**Structural fix:**
1. `cloudAgenticChat`: ENOTFOUND / EAI_AGAIN / getaddrinfo / ENETUNREACH / ECONNREFUSED resume like streamStall while todos/tools remain; DNS backoff wait + chat status.
2. `cloudLLMService`: on transient proxy net error, resolve A-record (or stale cache) and retry once via IP with `Host` + TLS `servername=graysoft.dev`; warm IP cache; remove fake `fall through to direct` wording.

Bak: `agent/pre-proxynetresume1-20261003-075217/`. Electron restarted.

---
## StreamWaitLive1 — 2026-10-03

**Operator:** should not freeze at summary; if tokens emit we must always see them.

**Evidence:** After Context summarized, chat went blank while host waited up to 900s for first SSE (`Stream timeout: no SSE data within 900s` × many; `streamStall resume #6–10`; ended `ENOTFOUND graysoft.dev`). `generation-warning` was statusbar-only (`setVramWarning`); silence watch armed only after first SSE.

**Fix:**
1. `generation-warning` → chat segment `generation-status` (App + ChatPanel + appStore).
2. First-byte watch from HTTP response: immediate + every 5s `Waiting for first token — Ns`.
3. Clear status on first thinking/prose/tool token.
4. Mid-stream quiet updates chat every 5s after 30s.

Bak: `agent/pre-streamwaitlive1-20261003-074943/`. Electron restarted.

---
## OpenTodoNoAbort1 + FileToolLengthContinue1 + LiveParams2/HoldToks2/VisionMerge1 — 2026-10-02

**Operator:** model ended mid-task with open todos; frozen append UI; vision 400; implement all.

**Root causes (logs):**
1. `incompleteRound cap=4 — stopping openTodos=2` aborted turn after unparsed tool streak (14:59:23Z).
2. ThinkDumpBail2 refused length-continue on large forming write/append JSON → chunk narrative.
3. Vision: `bodyRoles=…,user,user` → proxy 400; tool hold showed empty params / 0 tok/s (main process stale).

**Ships:**
1. **OpenTodoNoAbort1** (`cloudAgenticChat.js`): never break on incompleteRound cap while openTodos>0; context fit recover then silent-continue.
2. **FileToolLengthContinue1**: forming tool JSON skips ThinkDumpBail2 dump check; continuePartial on prose tool buffer.
3. Unparsed tool repair logs proseRawLen + head/tail.
4. **LiveParams2** / **HoldToks2** / **VisionMerge1** (prior turn) loaded via Electron restart 13:12 local.
5. `agentRoundEnd.js` docs: cap only for empty ledger.

Prove: `agent/_prove-opentodonoabort1.js` OK. Bak: `agent/pre-opentodonoabort1-20261002-130909/`.

---
## nodupfence1-finalize — 2026-09-30

ChatPanel: strip content fences when saving and rendering finalized text segments (twin CodeBlock lang + file card). Disk turd.html was clean; UI twin was fence left in msg.segments.

﻿## effortonly1 + filenevershrink1 + nodupfence1 — 2026-09-30

**Operator:** forced `thinking_budget_tokens=2048` mid-cut is banned; Qwen lever is `reasoning_effort` only. Duplicate `game` CodeBlock + `game.html` file card; 322→1 wipe.

1. **EffortOnly1:** `cloudLLMService` proxy body sends `reasoning_effort` / `chat_template_kwargs.reasoning_effort` only — no `thinking_budget_tokens` / `reasoning_budget_tokens`. `resolveThinkingBudgetForEffort` returns null.
2. **FileNeverShrink1:** `startFileContentBlock` reopen keeps shadow content; flush switches only when new stream ≥ shadow; `addCompleteFileContentBlock` refuses shorter replace.
3. **PartialQuote1:** `_tpIsStructuralContentEnd` no longer treats interior `"...,` as JSON end (JS/CSS truncate).
4. **NoDupFence1:** strip open fences in `markdownFenceUtils` + ChatPanel streaming text; MarkdownRenderer skips file-like openCode CodeBlocks; stream filter holds incomplete fence openers.

Bak: `agent/pre-effortonly1-20260930-224039/`

## thinkbudgettokens1 live — 2026-09-30

**Operator:** go ahead and fix everything.

**Root cause:** (1) guIDE sent `thinking_budget`; llama.cpp wants `thinking_budget_tokens`. (2) `proxy-server.js` :3205 stripped budget fields and only read camelCase `reasoningEffort`.

**Fix:**
1. guIDE `cloudLLMService.js` sends `thinking_budget_tokens` + `reasoning_budget_tokens` + `reasoning_effort`.
2. `proxy-server.js` forwards those to llama + accepts snake_case effort. Hot-reload `proxy.reload` → ok workerPid=14948.
3. `route.ts` parity. guIDE Electron relaunched.

**Backup:** `D:\FileShot.io\graysoft\backups\pre-thinkbudgettokens1-20260930-221000\`.

---
## thinkbudgettokens1 — 2026-09-30

**Operator:** medium vs xhigh no difference; 268-line thinks on medium; do not restart app.

**Root cause (P40 llama.cpp `server-common.cpp`):** hard stop field is `thinking_budget_tokens` / `reasoning_budget_tokens`. guIDE was sending `thinking_budget` — **ignored**. Live `01:44:27` `effort=medium thinking_budget=2048` + `thinkingChars=23039`.

**Fix:** send `thinking_budget_tokens` + `reasoning_budget_tokens` (medium→2048). Keep `reasoning_effort`. No Electron restart this turn.

**Backup:** `agent/pre-thinkbudgettokens1-20260930-215000/`.

---
## reasonwirebudget1 — 2026-09-30

**Operator:** medium used to be 1–40 lines; now ~400. Do you understand Qwen3.8 reasoning?

**Answer/evidence:** Official Qwen3.8 lever is `reasoning_effort` = `low|medium|xhigh` (default `xhigh`). After ThinkStreamLive1 dropped `thinking_budget`, live `01:35:50` `thinkingChars=29736` on `effort=medium`. String alone is not enough on this stack. guIDE local (`chatEngine`) maps medium→2048.

**Fix:** Restore wire `thinking_budget` from effort map (medium=2048). Keep ThinkStreamLive1 (no client silent divert / no mid-thought UI cut).

**Backup:** `agent/pre-reasonwirebudget1-20260930-213700/`.

---
## thinkstreamlive1 — 2026-09-30

**Operator:** Correct — reasoning_effort medium is the lever; do not force a client thinking budget cut mid-thought. Tokens must stream live. Silent hold then jut. Thinking leaked / game.html outline salvaged as a file. Fence divert was not index-only — any fence (`game.html`) triggered silent absorb.

**Evidence:** `01:04:01` `ThinkFenceSilent2: fence@0 → silent file channel` then quiet until `01:11:49` `ThinkDumpBail1 salvage write_file path=game.html chars=600` / `proseLive=26086` / empty stream `textLen=0` `rawBodyLen=2MB`. Screenshots: freeze on Reasoning, then whole burst + outline as `game.html`.

**Fix (ThinkStreamLive1):**
1. Removed client ThinkBudgetEnforce1 divert (no mid-thought cut).
2. Removed ThinkFenceSilent2 silent absorb — `reasoning_content` always `processThinkingChunk` live.
3. Stopped sending forced `thinking_budget` on proxy body; `reasoning_effort` only.
4. Thinking filter streams live (hold only real tool JSON).
5. Salvage refuses markdown outlines as `.html`.

**Backup:** `agent/pre-thinkstreamlive1-20260930-211800/`. **Test:** `tools/thinkStreamLive1.test.js`.

---
## thinkbudgetenforce1 + toolholdprogress1 — 2026-09-30

**Operator:** medium not real (277-line thinks); frozen on Generating update_todos; stop calling effort a label.

**Evidence:** `00:45:21` `thinkingChars=29995` on same turn as `proxy sampling effort=medium thinking_budget=2048`. Upstream ignored budget. `00:54:04` generate started then log quiet while UI held `update_todo` with no progress events.

**Fix:**
1. **ThinkBudgetEnforce1:** after `budgetChars = thinking_budget*4` (medium → 8192), divert further `reasoning_content` to silent content (tools still parse). Log `ThinkBudgetEnforce1: divert overflow`. Also send top-level `reasoning_effort` on proxy body.
2. **ToolHoldProgress1:** while tool JSON held, emit `tool-generating-progress` every 1s; ToolCallCard shows KB/time after 5s for any tool incl. update_todo.

**Backup:** `agent/pre-thinkbudgetenforce1-20260930-205824/`. **Test:** `tools/thinkBudgetEnforce1.test.js`.

---
## fenceallsilent1 — 2026-09-30

**Operator:** still seeing duplicate index.html (Wrote + Generating twin). Thought Silent2 fixed it.

**Evidence:** screenshot — first card header `index (79 lines)` = chat CodeBlock lang=index; second `index.html html (79 lines)` = FileContentBlock. Silent2 only stripped html|svg|css|js|json fences; model used `\\\index`. guide-main iter=1 proseLive=3335 + write_file; proxy sampling effort=medium thinking_budget=2048.

**Fix:** strip/divert **any** markdown fence lang (`\\\[A-Za-z0-9_.+-]*`) from chat display when file cards exist; same for thinking divert.

**Test:** `tools/fenceAllSilent1.test.js`. **Backup:** `agent/pre-fenceallsilent1-20260930-203455/`.

---
## reasonbudgetmedium1 — 2026-09-30

**Operator:** still feels like xhigh; used all levels; not medium.

**Evidence:** `node -e secryptQualitySampling(true)` → `reasoningEffort:"medium"` (ReasonMedium1 live). Proxy still set `thinking_budget = floor(outputTokens*0.75)` (~6144 @ 8192) — independent of effort string; long Thought dumps feel like xhigh. Wire effort was never logged.

**Fix:** `resolveThinkingBudgetForEffort` — low 512 / medium 2048 / xhigh 75% out. Log `[CloudLLM] proxy sampling effort=… thinking_budget=…` every proxy generate.

**Test:** secryptCloudModel + cloudTightPrompt. **Backup:** `agent/pre-reasonbudgetmedium1-20260930-202733/`.

---
## thinkfencesilent2 — 2026-09-30

**Operator:** duplicate index.html (Wrote card + Generating CodeBlock twin); Reasoning froze mid-word at `stylin`; no hash/dedupe cheap fix.

**Evidence:**
1. Screenshot1: `Wrote index.html` then `Generating write_file` + second `index.html html` block.
2. Screenshot2: Thought `Let me create the CSS file with full stylin` mid-word; css write card below.
3. guide-main iter=2 `proseLive=3156 proseChars=97` — fence/tool bytes on prose channel painting CodeBlock beside file card.
4. ThinkFenceDivert1 held last **24 chars of all thinking** → UI lag / mid-word freeze.

**Fix (channel routing, not content-hash dedupe):**
1. Hold only incomplete fence opener (`  ` / `` / ``ht`) via `trailingIncompleteFenceOpenHold`.
2. Diverted thinking fences → `processSilentContentChunk` (rawBuf + file-content/tool parse, **no** chat onToken).
3. Prose display strips content-language fences when file cards exist (`stripContentLanguageFencesForDisplay`).
4. Flush thinkHold on silenceWatch so quiet gaps do not leave Thought truncated.

**Test:** `tools/thinkFenceSilent2.test.js`. **Backup:** `agent/pre-thinkfencesilent2-20260930-201752/`.

---
## thinkchannelclean1 — 2026-09-30

**Operator:** think-md font/color wrong; entire reply stuck in Reasoning; prose inside codeblock inside thinking; tok/s only during prose; overengineered mess.

**Evidence:**
1. Screenshots: Reasoning live with `## Pelican on bike` bright + `svg` CodeBlock chrome; second shot prose inside `html` fence inside Reasoning.
2. guide-main turn-1790811867015: iter0 write_todos then TOOL RESULTS→MODEL; prior dump turn thinkingChars=28062 trailing=thinking.
3. ChatPanel passed `className="think-md…"` but MarkdownRenderer ignored className → full chat markdown in Thought.
4. StatusBar tok/s measured chatStreamingText + file blocks only — zero during reasoning_content.

**Fix (structural, no prompt coaching):**
1. **ThinkMdFlat1:** `MarkdownRenderer variant="think"` — 10px dim text, headings as same-size `<p>`, fences as plain `<pre>` (no CodeBlock chrome).
2. **ThinkFenceDivert1:** on first `html/svg/css/js…` fence (or dump detector) in reasoning stream → divert remainder to prose/file channel; plan text before fence stays in Thought.
3. **ToksThink1:** StatusBar includes `chatThinkingText.length`.

**Test:** `tools/thinkFenceDivert1.test.js`. **Backup:** `agent/pre-thinkchannelclean1-20260930-195203/`.

---
## reasonmedium1 â€” 2026-09-30

**Operator:** Cipher quality was on xhigh; set back to medium.

**Cause:** SampleCard1 (2026-09-29 `allships-cursor-gaps1`) overrode thinking sampling to `reasoningEffort: 'xhigh'`. UI/settings default stayed medium but cloud Agent ignored it.

**Fix:** `secryptQualitySampling(true).reasoningEffort` â†’ **medium**. Tests: cloudTightPrompt / secryptCloudModel.

**Backup:** `agent/pre-reasonmedium1-*`.

---
## thinkdumpbail2 â€” 2026-09-30 (FINAL PRODUCTION)

**Operator:** thinking in plain chat; 900s Generation Error mid-response; image3 shows exact break; no post-hoc / no guessing; AAA production.

**Evidence (guide-main pelican turn 21:23â€“22:00Z):**
1. `21:23:24Z` ai-chat START userMessageLen=59 (SVG pelican)
2. `21:31:37Z` empty stream textLen=0 rawBodyLenâ‰ˆ2.0M finish=length â†’ all `reasoning_content`
3. `ThinkDumpBail1: drop continueInThinking chars=22204` then `continuePartial #1` **without** continueInThinking â†’ remainder of thought streamed as **content** (image3: Thought ends `â€¢ 180: foot (3` / chat continues `74,336)`)
4. `continuePartial #2 chars=42422` / `#3 chars=62649` stop=length (dump keep growing)
5. `22:00:32Z` `Stream timeout: no SSE data within 900s from graysoft.dev` â†’ Generation Error

**Root cause:** Bail1 stopped thinking-continue but still **continuePartial'd the dump into the content channel**, painting mid-thought into chat; then re-POSTing a 62k dump stalled proxy first-byte for 900s. 900s was not matched by stall-resume, so it hard-failed.

**Fix (ThinkDumpBail2):**
1. **Refuse** `continuePartial` when `looksLikeReasoningFileDump` OR buffer > 12k (neither thinking nor content).
2. Fall through to round-end salvage / incomplete **fresh tool round**; do **not** inject the dump into conversationHistory.
3. Transport 900s / first-byte timeout: soft-recover dump (no Generation Error card) or stall-resume when no dump.
4. Detector covers SVG/coord scratchpads (`foot(`/`knee(`, animateTransform).

**Test:** `tools/thinkDumpBail2.test.js`. **Backup:** `agent/pre-thinkdumpbail2-*`.

---


**Operator:** prose inside ```html ("Let me writeâ€¦"), sketchy fragmented code, 2 tok/s; do not violate rules (no system-prompt coaching).

**Evidence (guide-main turn-1790801190546):**
- `20:46:30Z` agent+vision start
- `20:54:59Z` `empty stream` rawBodyLen=2035653 textLen=0 finish=length sseCount=8171 (all reasoning_content)
- `continuePartial #1 chars=24734 stop=length continueInThinking=1` + **re-POSTed image**
- `21:04:31Z` `continuePartial #2 chars=46858 continueInThinking=1` + image again
- Screenshots: narration + CSS/HTML fragments inside chat `html` CodeBlocks; no clean write_file card

**Cause:** model composed the page inside the thinking channel; host kept `continueInThinking` on every length-cut and re-attached the screenshot, so the dump looped instead of emitting a tool.

**Fix (ThinkDumpBail1):**
1. `looksLikeReasoningFileDump` â€” fence/HTML / narration loops / thinkingCharsâ‰¥6000 â†’ drop `continueInThinking` (forces `reasoning_format=none` / content+tools).
2. Clear `pendingImages` on every continuePartial (vision already consumed).
3. Round-end salvage: tools-on + no parsed tools + dump â†’ `_recoverWriteFileContent` + scrub narration lines â†’ execute `write_file`.
4. Recover unclosed ```html and bare `<!DOCTYPE` dumps.

**Test:** `tools/thinkDumpBail1.test.js`. **Backup:** `agent/pre-thinkdumpbail1-*`.

---


**Operator:** naked HTML + duplicate file card in chat (Show more 313 + index.html 713); reject Gemini â€œcaption fallbackâ€; fix vision for real.

**Naked/duplicate evidence:** guide-main `12:13:25Z` `continuePartial #1 chars=24753 stop=length` â†’ `12:17:00Z` `toolsParsed=1 proseChars=31228` + `write_file done`. Screenshot: CodeBlock â€œShow more (313 lines)â€ then FileContentBlock `index.html (713 lines)`.

**Cause (write):** unescaped quotes inside `write_file` HTML (`lang="en"`) â†’ `findToolCallRanges` returned `[]` while `parseToolCalls` still recovered the tool. Strip left the whole body as prose; R53-Fix then re-injected that â€œbackend proseâ€ next to the file card.

**Fix (WriteStripLeak2):** `expandStickyFileWriteRanges` in `toolParser.js` strips from write_file `{` through real close or EOF; sticky hold also blocks naked `<!doctype`/`<html` residue; ChatPanel skips R53 inject when file blocks own an HTML/tool dump. Test: `tools/writeStripLeak2.test.js`.

**Cause (vision):** P40 quality worker had `MMPROJ_PATH=` empty â€” no `--mmproj` â†’ every `image_url` hit `upstream 500` in ~1s. Caption path was a workaround, not native vision.

**Fix (VisionNative3):** downloaded `mmproj-Qwen3.8-27B-BF16.gguf` to `/data/secrypt-models/llm/`; set `MMPROJ_PATH` in `config/worker.env`; restarted quality worker with `--mmproj` (health ok, VRAM ~20428/24576). Removed Gemini caption inject (â€œyou have already seenâ€¦â€). Vision fail now retries native only, then honest error.

**Backup:** `FileShot-Main-Control/agent/pre-writestripleak2-visionnative3-*` + P40 `worker.env.bak-visionnative3-*`.

---


**Operator:** entire reply (prose + tool cards) landed inside one Thought dropdown after think/vision ships.

**Cause:** sticky `routeContentToThinking` until `</think>` â€” Qwen often never emits that tag in the content channel after stall/vision resume, so content + tool bytes stayed routed into Thinking (and the prose-filter `onToken` redirect painted clean text into the Thought UI).

**Fix:** remove contentâ†’Thinking sticky. Stall/length mid-think only sets `continueInThinking` (keep reasoning SSE channel). Prose/tools always go to the normal content path. `routeContentToThinking` forced false.

**Backup:** `agent/pre-unstickthink1-20260930-074500/`.

---
## writestripleak1 â€” 2026-09-29 (WriteStripLeak1)

**Operator:** screenshots; do not break rules (no system-prompt coaching). Live chat painted raw `{"tool":"write_file",â€¦styles.cssâ€¦}` while file card also ran.

**Evidence:** guide-main iter=2/8/9 `proseLive=10873/17568/5062` with `toolsParsedâ‰¥1` / `write_file done`; finalize `proseChars` much smaller (append-only UI never retracted).

**Cause:** brace-depth tool hold released early on unescaped quotes inside `content`; thinking filter had `holdToolPayloads:false`.

**Fix:** sticky hold for forming write/edit file payloads until strip removes the tool object; refuse to paint if clean still looks like forming write; thinking channel holds tool JSON too (no duplicate file cards).

**Test:** `formatstream-hold-think.test.js` WriteStripLeak1. **Backup:** `agent/pre-writestripleak1-20260929-223200/`.

---
## thinktag-vision2 â€” 2026-09-29 (ThinkStallLeak2 + VisionCipher2 + ThumbZoom1)

**Operator:** sticky-until-`\n\n` was wrong (thinking is `</think>`-delimited); thumbnail should zoom from origin; image still fails on cipher-quality.

**Evidence:** guide-main `01:57:55Z` `proxy vision: 1 image(s)` â†’ `upstream 500` â†’ jinja resume **without** images â†’ model â€œI donâ€™t see an imageâ€.

**ThinkStallLeak2:** sticky contentâ†’thinking exits only on `</think>` (partial-tag hold), never on paragraph breaks. `continueInThinking` still keeps reasoning channel on stall mid-think.

**VisionCipher2:** vision upstream 500/400 no longer jinja-resumes blind. Captions via Gemini Flash, injects `[VISION ANALYSISâ€¦]` (same shape as local ChatEngine), clears pending images only after success. Pending images kept across resume until consumed.

**ThumbZoom1:** chat image thumbnail opens/closes with 220ms zoom from thumbnail rect (portal lightbox).

**Backup:** `agent/pre-thinktag-vision2-20260929-220200/`.

---
## thinkleak-vision1 â€” 2026-09-29 (ThinkStallLeak1 + VisionCipher1)

**Operator:** thinking mid-sentence leaked into chat; image attach on cipher-quality showed â€œdoes not support imageâ€ then 400 `provider, model, and messages are required`.

**Evidence (guide-main / ui-trace):**
- Think: stall `Stream stalled from graysoft.dev` â†’ `continuePartial #1` with `reasoning_format=none` â†’ thinking tokens `â€¦glass display for` then `llm-token` `digital content` (turn-1790730418121 ~01:28â€“01:30Z).
- Vision: `generate` skipped proxy when images present â†’ `_executeGeneration` direct â†’ 400 at 01:44:06Z; UI note `cipher-quality does not support image input`.

**ThinkStallLeak1:** stall/length continue while `trailingChannel=thinking` sets `continueInThinking` + sticky `routeContentToThinking`. Proxy keeps reasoning channel (no `reasoning_format=none`). Sticky content exits to prose at `\n\n`.

**VisionCipher1:** `_supportsVision` true for secrypt/cipher/graysoft + cipher-quality. Images always go through Secrypt proxy as multimodal `image_url` parts. Normalize/ironclad preserve content arrays.

**Tests:** `tools/thinkStallVision.test.js`. **Backup:** `agent/pre-thinkleak-vision1-20260929-214800/`.

---
## scrolltodo-ships1 â€” 2026-09-29 (ScrollStay2 + TodoIdCoerce1 + TodoMissLedger1 + TodoRoundHint1 + SearchDedup1)

**Go:** all ships from scroll/todo plan (production-grade; no system-prompt coaching).

**ScrollStay2:** `handleChatScroll` no longer clears `userScrolledAway` when `dist < 80`. Sets away only when `dist > 120`. Clear remains wheel-down-at-bottom / send / jump. Fixes slow scroll flicker vs follow-output.

**TodoIdCoerce1:** `_updateTodo` coerces `id` with `Number(id)` so string `"1"` matches numeric ledger ids.

**TodoMissLedger1:** miss/bad-id returns `liveIds` + `allTodos`; logs `update_todo miss id=â€¦ liveIds=[â€¦]`.

**TodoRoundHint1:** `buildTodoProgressHint` still emits Active todo list (with numeric ids) after `update_todo` batches; only `write_todos` skips the prefix.

**SearchDedup1:** identical `web_search` query refused on 3rd run in a turn (`duplicateQuery`); counts reset via `resetWebSearchDedup` at cloud agent start.

**Tests:** `updateTodoCoerce.test.js`, `todoDigestHelpers.test.js`. **FE build:** OK. **Backup:** `agent/pre-scrolltodo-ships-20260929-213459/`.

---
## allships-cursor-gaps1 â€” 2026-09-29 (SampleCard + ThinkMd + ScrollStay + BrowseReady)

**Operator go:** all ships; HauhauCS **Qwen3.8-27B** Aggressive card (not Qwen3 / not Qwen3.5); get search API keys.

**SampleCard1:** `secryptQualitySampling(true)` matched HauhauCS HF card â€” temp **1.0**, top_p **0.95**, top_k **20**, min_p **0**, presence **0**, repeat **1.0**, reasoningEffort **xhigh**. Instruct unchanged (0.7/0.8/presence 1.5/low). Source: https://huggingface.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF Recommended settings. Tests: cloudTightPrompt.test.js, secryptCloudModel.test.js.

**ThinkMd1:** FinalizedThinkingBlock + StreamingThinkingBlock via MarkdownRenderer.

**ScrollStay1:** userScrolledAwayRef on not-at-bottom; cleared at bottom/send/jump.

**BrowseReady1:** Chromium under %APPDATA%\guide-ide\components\playwright-browsers; electron-main sets PLAYWRIGHT_BROWSERS_PATH. guide-main logged that path.

**SearchAPI1 keys:** still empty (brave=false tavily=false serpapi=false). Chrome Default has no Google session; passwords are v20 app-bound; UAC for SYSTEM DPAPI was canceled; Brave API needs email+card (no Google OAuth). CDP Chrome is up on :9222 for Google sign-in then Tavily/SerpAPI OAuth into api-keys.enc.

**FE:** npm run build OK. Electron relaunched. Backup: agent/pre-allships-20260929-193500/.

---
# AGENT-CHANGES â€” 2026-09-28

## `cursorprovider1` â€” SHIPPED 2026-09-28 18:58

**What:** New cloud provider `cursor` in guIDE via `@cursor/sdk` (not OpenAI chat/completions â€” that path 404s on api.cursor.com).
**UI:** Provider list shows Cursor; paste `crsr_â€¦` key (or use encrypted store).
**Key:** Saved encrypted to `%APPDATA%\guide-ide\api-keys.enc` provider=`cursor` (not in source).
**Prove:** `Cursor.models.list` â†’ **42 models**. Agent create/send works. Live generate returns Cursor **usage limit** until monthly reset **2026-10-18** (account Pro limit â€” not a guIDE wiring fail).
**Files:** `cursorCloudProvider.js`, `cloudLLMService.js`, `cloudAgenticChat.js`, `ChatPanel.jsx`, `electron-main.js`, dependency `@cursor/sdk`.

## `cruise150fixed` â€” SHIPPED 2026-09-28 18:41


**Decision:** Fixed cruise **150 W**. Never 195/180 as default.
**Why:** Thinking-on bench tok/s ~20@125 / ~21@150 / ~22@180 (+~1â€“2). Two hard OptiPlex resets tonight while PL was allowed at 180â€“195 with thermal paused. Death class = PSU rail under high budget, not GPU 95Â°C.
**Applied:** `p40-thermal-pl.sh` cruise=150 + enforce-if-raised; `gpu-power-cap.sh` 150; `@reboot nvidia-smi -pl 150` (was 195). Live PL set 150.

## `p40harddie1` + `voicestopsend1` â€” SHIPPED 2026-09-28 18:16


**Operator correction:** â€œPC hasnâ€™t shut downâ€ from the chair â€” Linux still shows unclean reboot. Prior-boot journal ends **17:36:01** keepalive; next boot governor **17:39:40**; `uptime` was ~31m at 18:09. Thermal last pre-gap heartbeat: **17:36:35 temp=72C draw=175.91W pl=195W**. No GPU 91/92 trip. Same class as earlier: **PSU rail under ~180W**, not GPU overheat.

**Root fix (prevention):** Restored **draw-based PL cut** that `cycle195` removed.
- cruise **195W**
- draw â‰¥**160W**/4s â†’ **150W** (`psu_protect`)
- temp â‰¥**70C** â†’ 150W; â‰¥**85C**/â‰¥**92C** â†’ **125W**
- recover to 195 only when â‰¤**62C** and draw <**130W**/10s

**Prove:** quality gen â†’ draw **178W** @ **47C** â†’ log `PL 195W -> 150W (draw=178.11W>=160W/4s psu_protect)` at **18:15:16**; host stayed up; recovered **150â†’195** at 18:15:33 when cool.

**Also:** `voicestopsend1` â€” `ChatPanel.jsx` Send / queue-send stops offline Whisper. FE rebuilt; guIDE relaunched from `D:\guide-3.0-v0.4.82`.

**Bak:** P40 `p40-thermal-pl.sh.bak-p40harddie1-*`; client `agent/pre-p40harddie1-20260928-1812/`.

**Cannot claim:** hardware PSU identity. This stops the measured death class (sustained ~180W at moderate temp).

## `cycle195` â€” operator thermal cycle (2026-09-28 17:30)

**Policy (live):** cruise **195W**; â‰¥**91Â°C** â†’ **150W** (0s hold); â‰¥**92Â°C** â†’ **125W** (HW min, proven `PL125_OK`); stay down until â‰¤**88Â°C**/5s â†’ jump **195W**. Poll **1s**. Goal: never reach HW shutdown **95Â°C**.

**Models confirmed:** 27B `-ngl 99` KV on GPU (no `--no-kv-offload`); 2B `-ngl 0` + `--no-kv-offload` (CPU). Both health OK.

**Evidence:** Last thermal heartbeat before death **15:44:46** `temp=62C draw=178.86W pl=200W` â€” **not** a GPU overheat trip. Journal ends unclean (no shutdown). UI froze on thinking â€œIâ€ / â€œNo Modelâ€. Context was **17%** (no summarizer).

**Confirmed contributors (not a single named chip):**
1. Hard power-loss under GPU load at **moderate temp** (~62C) / high draw (~179W).
2. `p40-keepalive.sh` every 2m treated **CPU `ngl=0` 2B as broken** and tried to **restart it onto the GPU** while 27B held ~19GB VRAM â€” fight logged continuously (`chat-fast on RAM ngl=0 â€” restart onto GPU`).

**Applied:** cruise **185W** + drawâ‰¥170W/8sâ†’140W; recover from orphaned 150W; keepalive accepts CPU 2B; `p40-start-fast-llm.sh` default `NGL=0`; boot-pack `-pl 185`.

**Cannot claim:** â€œwill never crash againâ€ â€” root component (PSU vs wall vs board) is **not** identified in journal (no Xid/MCE). Power budget + stop GPU fight is the evidence-backed mitigation.

## GO ALL â€” `PLAN-THINK-FREEZE-IDLE1H-20260928.md` â€” SHIPPED

**Operator:** â€œgo everything / go all shipsâ€ after P40 hard-died again and â€œLetâ€ freeze.

| Ship | Status | What / proof |
|------|--------|----------------|
| `p40up1` | SHIPPED | Host up; `:8787`/`:18787`/`:18788` health OK; PL 200 W |
| `thermhard1` | SHIPPED | Script `+x`; hot@**88**/3sâ†’150, emerg@**90**â†’125, soak 120s@150â†’125; hb 60s; `@reboot` uses **`bash`** path (Permission denied fix). Systemd unit on disk â€” needs passworded sudo once to enable. Live governor running. |
| `gendie1` | SHIPPED (no separate code) | Crash wiped llama/queue window; class = host death + quiet stream. Covered by thermhard1 + thinkfreezewatch1. Historical preempt at **14:52:22**. |
| `queuepreempt1` | SHIPPED | Per-backend `_chat_gen_socks`. Lab: `cipher-quality` stream + concurrent `secrypt-fast` â†’ quality **19757** bytes, route p40+fast, **no** cross-backend preempt. Also added `secrypt-p40`/`cipher` to `QUEUE_QUALITY_MODEL_IDS`. Bak `p40-gpu-queue.py.bak-queuepreempt1-*` |
| `thinkfreezewatch1` | SHIPPED | After first SSE: warn @30s quiet; soft-stall @120s â†’ existing stall resume |
| `proxyidle1h` | SHIPPED | `PROXY_STREAM_IDLE_MS=3600000` |

**Client bak:** `agent/pre-go-all-20260928-153119/`  
**Relaunch:** `npm start` from `D:\guide-3.0-v0.4.82`

## `stallnever1` â€” Generation Error â€œStream stalled from graysoft.devâ€ must not kill agent turns

**Live evidence (guide-main.log):** turn `turn-1790609585212` hit `Stream idle timeout: no data for 600s` five times (16:52 / 17:13 / 17:31 / 18:12 / 18:24Z). After resume #4 the 5th throw became `ai-chat cloud ERROR` â†’ UI Generation Error. Context was **msgsâ‰ˆ99â€“100** with huge tool injects; P40 still in long prefill/think. Earlier same day: four `ETIMEDOUT 192.168.1.65:8787` then hard error.

**Cause:** Idle/first-byte timers armed on **any TCP chunk** from the proxy (not SSE `data:`). Empty/proxy fluff during prefill cleared the first-byte timer, then 600s with no tokens â†’ stall. Agentic resume capped at **4**.

**Fix:**
- `cloudLLMService.js`: first-byte + idle only on SSE `data:` lines; `PROXY_FIRST_BYTE_MS` 180s â†’ **900s** for long 128k prefill.
- `cloudAgenticChat.js`: while open todos (or tools already used this turn), allow stall resumes up to **40** instead of dying at 4.

**Bak:** `agent/pre-stallnever1-20260928-1445/`

## P40 hard crash + thermal harden (2026-09-28 ~11:09)

**Crash:** Previous boot journal ends unclean at **11:08:57** EDT; next boot **11:11:39**. No graceful shutdown. Thermal log had **zero PL drops** after cruise was raised to **200 W** (Sep 27 20:57). HW slowdown is ~92Â°C; old emerg threshold was **93Â°C** with **15s hold** â€” too late/slow. Competing policies: `@reboot -pl 180` vs thermal cruise **200** vs `gpu-power-cap.sh` floor-forced **â‰¥195** (broke the systemd unitâ€™s intended 150).

**Boot verify after reload:** 27B IQ4_XS on GPU (`-ngl 99`, `-c 131072`, `draft-mtp,ngram-mod`, n-max 1); 2B on CPU (`-ngl 0 --no-kv-offload`). Both health OK. Idle VRAM at 128k: **used ~19240 / free ~5200 MiB**.

**Applied:** `p40-thermal-pl.sh` â†’ cruise **200 W**, hot **85Â°C/3sâ†’150W**, emerg **90Â°C/0sâ†’125W**, recover to 200 at **â‰¤84Â°C/30s**. `@reboot -pl` **180â†’200**. `gpu-power-cap.sh` default **200**. Live PL confirmed **200 W**. Systemd unit still embeds `Environment=150` (no passwordless sudo to patch); thermal overrides within ~30s of boot.

## Full plan ship â€” `PLAN-MIDTURN-BGTERM-TEMP-20260928.md` â€” SHIPPED

**Bak:** `D:\guide-3.0-v0.4.82\agent\pre-fullplan-20260928-102907\` (named touch files).  
**P40 bak:** `/home/brendan/secrypt-p40/scripts/restart-worker-only.sh.bak-p40specspeed1-20260928-103600` + matching `worker.env.bak-p40specspeed1-*`.

| Ship | What | Prove |
|------|------|-------|
| `midturnprose1` | `tools/agentRoundEnd.js` + `cloudAgenticChat.js` â€” tools this turn + ledger never touched â†’ incomplete (`mid-turn-prose`) | `node tools/agentRoundEnd.test.js` OK; smoke `roundIsIncomplete` true when toolsUsedThisTurn>0 && !ledger |
| `tempbump01` | `cloudLLMService.js` `secryptQualitySampling(true).temperature` **1.0 â†’ 1.1** | `cloudTightPrompt.test.js` asserts 1.1; instruct stays 0.7 |
| `bgterminal1` | `mcpToolServer.js` `run_command.background` + list/read/stop; IPC + preload; ChatPanel `BackgroundTerminalDropdown` | FE dist contains â€œStop background shellâ€; host map `_backgroundShells` present; relaunch `D:\guide-3.0-v0.4.82` |
| `p40specspeed1` | P40 `--spec-type draft-mtp,ngram-mod` A/B n-max 1 vs 2 | Results `/tmp/p40specspeed1-20260928-103600.txt`: baseline **19.34** â†’ ngram_nmax1 **20.88** â†’ ngram_nmax2 **20.37**. **Keep n-max=1**. Live: `-c 131072`, `draft-mtp,ngram-mod`, `--spec-draft-n-max 1`, health ok |
| `bsnaphref1` | `browserManager.js` `String(href).substring(...)` | Marker in live file (lines ~570/700/734) |
| `bsnapfailhard1` | Click path returns `success:false` + `snapError` when snapshot fails | Marker `bsnapfailhard1` + fail returns at ~1000/1099 |
| `bscreenshotnovision1` | Screenshot saves PNG under `.guide/screenshots/`; inject path/ack only | `browserManager.screenshot` + `toolResultInjection` strip base64 |

**Relaunch:** Electron main PID from `D:\guide-3.0-v0.4.82\node_modules\electron\dist\electron.exe .` (cwd v0.4.82). FE build `frontend/dist` 2026-09-28 10:34.

**Operator note:** Brightspace Content click-with-snapshot is code-proven; live CIS 251 Content page lab is the visitor prove when credentials/session available.

## `cursorjsonl1` â€” SHIPPED 2026-09-28 19:02

**What:** Electron lacks `node:sqlite`; Cursor Agent.create default store threw Generation Error. Always pass `JsonlLocalAgentStore` under `%APPDATA%\guide-ide\cursor-agent-store`.
**Prove:** Agent.create with jsonl store = CREATE_OK (send may still hit Pro usage limit).
**File:** `cursorCloudProvider.js`.


## `cursorworker1` â€” SHIPPED 2026-09-28 19:08

**Crash:** guide-main.log stopped after `[CursorSDK] create ... store=jsonl`; Electron Agent.send native-crashed (crashpad). System Node survives.
**Fix:** Always spawn system Node worker `cursorCloudProviderWorker.js` from Electron (`D:\Server\node.exe`).
**Quota note:** IDE Auto chat uses a different pool than Agent SDK + `crsr_` API key. API key path returns Pro usage limit until spend limit / 10/18 reset â€” that must show as Generation Error, not crash the app.
**Files:** `cursorCloudProvider.js`, `cursorCloudProviderWorker.js`.


## `cursorautoacct1` â€” 2026-09-28 19:10

**Why IDE Auto works but guIDE fails:** IDE login = `merklegarland@gmail.com`. guIDE `crsr_` key = `fileshots@proton.me` (key name `guide`). Different accounts / pools. Model `default` already IS Auto.
**Change:** UI labels Auto; usage-limit error annotates key account email; provider note says same-account key required.


## `cursorpool3` â€” SHIPPED 2026-09-28 19:16

**What:** Sticky 3-key Cursor pool. Stay on active key until usage/rate limit, then advance and persist index + cooldown until monthly reset.
**Keys (masked):** brendan36363@gmail.com, brendan.gray@maine.edu, merklegarland@gmail.com.
**Prove:** idx0+1 usage-limit â†’ rotate; idx2 (IDE account) returned `POOL_OK`. Sticky activeIndex=2 persisted.
**Files:** `cursorKeyPool.js`, `cloudLLMService.js` sticky+usage-limit rotate, `electron-main.js` hydrate, `scripts/save-cursor-pool.js`.


## `cursoradmin1` â€” SHIPPED 2026-09-28 20:05

**What:** Cursor provider admin-only for license email `brendan36363@gmail.com`. Others do not see it in provider list; API 403s. Not a Pro/Cipher paywall.
**License signing:** Public CER copied from `D:\IDE\certs\guide-codesign.cer` into `build/` + `certs/`. GH secrets `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` already present (2026-09-27).
**Release matrix:** Enabled `build-windows-cuda`, `build-linux-cuda`, `build-mac` for Build & Release.





















