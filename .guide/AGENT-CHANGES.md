# AGENT-CHANGES — 2026-09-28

## `cursorprovider1` — SHIPPED 2026-09-28 18:58

**What:** New cloud provider `cursor` in guIDE via `@cursor/sdk` (not OpenAI chat/completions — that path 404s on api.cursor.com).
**UI:** Provider list shows Cursor; paste `crsr_…` key (or use encrypted store).
**Key:** Saved encrypted to `%APPDATA%\guide-ide\api-keys.enc` provider=`cursor` (not in source).
**Prove:** `Cursor.models.list` → **42 models**. Agent create/send works. Live generate returns Cursor **usage limit** until monthly reset **2026-10-18** (account Pro limit — not a guIDE wiring fail).
**Files:** `cursorCloudProvider.js`, `cloudLLMService.js`, `cloudAgenticChat.js`, `ChatPanel.jsx`, `electron-main.js`, dependency `@cursor/sdk`.

## `cruise150fixed` — SHIPPED 2026-09-28 18:41


**Decision:** Fixed cruise **150 W**. Never 195/180 as default.
**Why:** Thinking-on bench tok/s ~20@125 / ~21@150 / ~22@180 (+~1–2). Two hard OptiPlex resets tonight while PL was allowed at 180–195 with thermal paused. Death class = PSU rail under high budget, not GPU 95°C.
**Applied:** `p40-thermal-pl.sh` cruise=150 + enforce-if-raised; `gpu-power-cap.sh` 150; `@reboot nvidia-smi -pl 150` (was 195). Live PL set 150.

## `p40harddie1` + `voicestopsend1` — SHIPPED 2026-09-28 18:16


**Operator correction:** “PC hasn’t shut down” from the chair — Linux still shows unclean reboot. Prior-boot journal ends **17:36:01** keepalive; next boot governor **17:39:40**; `uptime` was ~31m at 18:09. Thermal last pre-gap heartbeat: **17:36:35 temp=72C draw=175.91W pl=195W**. No GPU 91/92 trip. Same class as earlier: **PSU rail under ~180W**, not GPU overheat.

**Root fix (prevention):** Restored **draw-based PL cut** that `cycle195` removed.
- cruise **195W**
- draw ≥**160W**/4s → **150W** (`psu_protect`)
- temp ≥**70C** → 150W; ≥**85C**/≥**92C** → **125W**
- recover to 195 only when ≤**62C** and draw <**130W**/10s

**Prove:** quality gen → draw **178W** @ **47C** → log `PL 195W -> 150W (draw=178.11W>=160W/4s psu_protect)` at **18:15:16**; host stayed up; recovered **150→195** at 18:15:33 when cool.

**Also:** `voicestopsend1` — `ChatPanel.jsx` Send / queue-send stops offline Whisper. FE rebuilt; guIDE relaunched from `D:\guide-3.0-v0.4.82`.

**Bak:** P40 `p40-thermal-pl.sh.bak-p40harddie1-*`; client `agent/pre-p40harddie1-20260928-1812/`.

**Cannot claim:** hardware PSU identity. This stops the measured death class (sustained ~180W at moderate temp).

## `cycle195` — operator thermal cycle (2026-09-28 17:30)

**Policy (live):** cruise **195W**; ≥**91°C** → **150W** (0s hold); ≥**92°C** → **125W** (HW min, proven `PL125_OK`); stay down until ≤**88°C**/5s → jump **195W**. Poll **1s**. Goal: never reach HW shutdown **95°C**.

**Models confirmed:** 27B `-ngl 99` KV on GPU (no `--no-kv-offload`); 2B `-ngl 0` + `--no-kv-offload` (CPU). Both health OK.

**Evidence:** Last thermal heartbeat before death **15:44:46** `temp=62C draw=178.86W pl=200W` — **not** a GPU overheat trip. Journal ends unclean (no shutdown). UI froze on thinking “I” / “No Model”. Context was **17%** (no summarizer).

**Confirmed contributors (not a single named chip):**
1. Hard power-loss under GPU load at **moderate temp** (~62C) / high draw (~179W).
2. `p40-keepalive.sh` every 2m treated **CPU `ngl=0` 2B as broken** and tried to **restart it onto the GPU** while 27B held ~19GB VRAM — fight logged continuously (`chat-fast on RAM ngl=0 — restart onto GPU`).

**Applied:** cruise **185W** + draw≥170W/8s→140W; recover from orphaned 150W; keepalive accepts CPU 2B; `p40-start-fast-llm.sh` default `NGL=0`; boot-pack `-pl 185`.

**Cannot claim:** “will never crash again” — root component (PSU vs wall vs board) is **not** identified in journal (no Xid/MCE). Power budget + stop GPU fight is the evidence-backed mitigation.

## GO ALL — `PLAN-THINK-FREEZE-IDLE1H-20260928.md` — SHIPPED

**Operator:** “go everything / go all ships” after P40 hard-died again and “Let” freeze.

| Ship | Status | What / proof |
|------|--------|----------------|
| `p40up1` | SHIPPED | Host up; `:8787`/`:18787`/`:18788` health OK; PL 200 W |
| `thermhard1` | SHIPPED | Script `+x`; hot@**88**/3s→150, emerg@**90**→125, soak 120s@150→125; hb 60s; `@reboot` uses **`bash`** path (Permission denied fix). Systemd unit on disk — needs passworded sudo once to enable. Live governor running. |
| `gendie1` | SHIPPED (no separate code) | Crash wiped llama/queue window; class = host death + quiet stream. Covered by thermhard1 + thinkfreezewatch1. Historical preempt at **14:52:22**. |
| `queuepreempt1` | SHIPPED | Per-backend `_chat_gen_socks`. Lab: `cipher-quality` stream + concurrent `secrypt-fast` → quality **19757** bytes, route p40+fast, **no** cross-backend preempt. Also added `secrypt-p40`/`cipher` to `QUEUE_QUALITY_MODEL_IDS`. Bak `p40-gpu-queue.py.bak-queuepreempt1-*` |
| `thinkfreezewatch1` | SHIPPED | After first SSE: warn @30s quiet; soft-stall @120s → existing stall resume |
| `proxyidle1h` | SHIPPED | `PROXY_STREAM_IDLE_MS=3600000` |

**Client bak:** `agent/pre-go-all-20260928-153119/`  
**Relaunch:** `npm start` from `D:\guide-3.0-v0.4.82`

## `stallnever1` — Generation Error “Stream stalled from graysoft.dev” must not kill agent turns

**Live evidence (guide-main.log):** turn `turn-1790609585212` hit `Stream idle timeout: no data for 600s` five times (16:52 / 17:13 / 17:31 / 18:12 / 18:24Z). After resume #4 the 5th throw became `ai-chat cloud ERROR` → UI Generation Error. Context was **msgs≈99–100** with huge tool injects; P40 still in long prefill/think. Earlier same day: four `ETIMEDOUT 192.168.1.65:8787` then hard error.

**Cause:** Idle/first-byte timers armed on **any TCP chunk** from the proxy (not SSE `data:`). Empty/proxy fluff during prefill cleared the first-byte timer, then 600s with no tokens → stall. Agentic resume capped at **4**.

**Fix:**
- `cloudLLMService.js`: first-byte + idle only on SSE `data:` lines; `PROXY_FIRST_BYTE_MS` 180s → **900s** for long 128k prefill.
- `cloudAgenticChat.js`: while open todos (or tools already used this turn), allow stall resumes up to **40** instead of dying at 4.

**Bak:** `agent/pre-stallnever1-20260928-1445/`

## P40 hard crash + thermal harden (2026-09-28 ~11:09)

**Crash:** Previous boot journal ends unclean at **11:08:57** EDT; next boot **11:11:39**. No graceful shutdown. Thermal log had **zero PL drops** after cruise was raised to **200 W** (Sep 27 20:57). HW slowdown is ~92°C; old emerg threshold was **93°C** with **15s hold** — too late/slow. Competing policies: `@reboot -pl 180` vs thermal cruise **200** vs `gpu-power-cap.sh` floor-forced **≥195** (broke the systemd unit’s intended 150).

**Boot verify after reload:** 27B IQ4_XS on GPU (`-ngl 99`, `-c 131072`, `draft-mtp,ngram-mod`, n-max 1); 2B on CPU (`-ngl 0 --no-kv-offload`). Both health OK. Idle VRAM at 128k: **used ~19240 / free ~5200 MiB**.

**Applied:** `p40-thermal-pl.sh` → cruise **200 W**, hot **85°C/3s→150W**, emerg **90°C/0s→125W**, recover to 200 at **≤84°C/30s**. `@reboot -pl` **180→200**. `gpu-power-cap.sh` default **200**. Live PL confirmed **200 W**. Systemd unit still embeds `Environment=150` (no passwordless sudo to patch); thermal overrides within ~30s of boot.

## Full plan ship — `PLAN-MIDTURN-BGTERM-TEMP-20260928.md` — SHIPPED

**Bak:** `D:\guide-3.0-v0.4.82\agent\pre-fullplan-20260928-102907\` (named touch files).  
**P40 bak:** `/home/brendan/secrypt-p40/scripts/restart-worker-only.sh.bak-p40specspeed1-20260928-103600` + matching `worker.env.bak-p40specspeed1-*`.

| Ship | What | Prove |
|------|------|-------|
| `midturnprose1` | `tools/agentRoundEnd.js` + `cloudAgenticChat.js` — tools this turn + ledger never touched → incomplete (`mid-turn-prose`) | `node tools/agentRoundEnd.test.js` OK; smoke `roundIsIncomplete` true when toolsUsedThisTurn>0 && !ledger |
| `tempbump01` | `cloudLLMService.js` `secryptQualitySampling(true).temperature` **1.0 → 1.1** | `cloudTightPrompt.test.js` asserts 1.1; instruct stays 0.7 |
| `bgterminal1` | `mcpToolServer.js` `run_command.background` + list/read/stop; IPC + preload; ChatPanel `BackgroundTerminalDropdown` | FE dist contains “Stop background shell”; host map `_backgroundShells` present; relaunch `D:\guide-3.0-v0.4.82` |
| `p40specspeed1` | P40 `--spec-type draft-mtp,ngram-mod` A/B n-max 1 vs 2 | Results `/tmp/p40specspeed1-20260928-103600.txt`: baseline **19.34** → ngram_nmax1 **20.88** → ngram_nmax2 **20.37**. **Keep n-max=1**. Live: `-c 131072`, `draft-mtp,ngram-mod`, `--spec-draft-n-max 1`, health ok |
| `bsnaphref1` | `browserManager.js` `String(href).substring(...)` | Marker in live file (lines ~570/700/734) |
| `bsnapfailhard1` | Click path returns `success:false` + `snapError` when snapshot fails | Marker `bsnapfailhard1` + fail returns at ~1000/1099 |
| `bscreenshotnovision1` | Screenshot saves PNG under `.guide/screenshots/`; inject path/ack only | `browserManager.screenshot` + `toolResultInjection` strip base64 |

**Relaunch:** Electron main PID from `D:\guide-3.0-v0.4.82\node_modules\electron\dist\electron.exe .` (cwd v0.4.82). FE build `frontend/dist` 2026-09-28 10:34.

**Operator note:** Brightspace Content click-with-snapshot is code-proven; live CIS 251 Content page lab is the visitor prove when credentials/session available.

## `cursorjsonl1` — SHIPPED 2026-09-28 19:02

**What:** Electron lacks `node:sqlite`; Cursor Agent.create default store threw Generation Error. Always pass `JsonlLocalAgentStore` under `%APPDATA%\guide-ide\cursor-agent-store`.
**Prove:** Agent.create with jsonl store = CREATE_OK (send may still hit Pro usage limit).
**File:** `cursorCloudProvider.js`.


## `cursorworker1` — SHIPPED 2026-09-28 19:08

**Crash:** guide-main.log stopped after `[CursorSDK] create ... store=jsonl`; Electron Agent.send native-crashed (crashpad). System Node survives.
**Fix:** Always spawn system Node worker `cursorCloudProviderWorker.js` from Electron (`D:\Server\node.exe`).
**Quota note:** IDE Auto chat uses a different pool than Agent SDK + `crsr_` API key. API key path returns Pro usage limit until spend limit / 10/18 reset — that must show as Generation Error, not crash the app.
**Files:** `cursorCloudProvider.js`, `cursorCloudProviderWorker.js`.


## `cursorautoacct1` — 2026-09-28 19:10

**Why IDE Auto works but guIDE fails:** IDE login = `merklegarland@gmail.com`. guIDE `crsr_` key = `fileshots@proton.me` (key name `guide`). Different accounts / pools. Model `default` already IS Auto.
**Change:** UI labels Auto; usage-limit error annotates key account email; provider note says same-account key required.


## `cursorpool3` — SHIPPED 2026-09-28 19:16

**What:** Sticky 3-key Cursor pool. Stay on active key until usage/rate limit, then advance and persist index + cooldown until monthly reset.
**Keys (masked):** brendan36363@gmail.com, brendan.gray@maine.edu, merklegarland@gmail.com.
**Prove:** idx0+1 usage-limit → rotate; idx2 (IDE account) returned `POOL_OK`. Sticky activeIndex=2 persisted.
**Files:** `cursorKeyPool.js`, `cloudLLMService.js` sticky+usage-limit rotate, `electron-main.js` hydrate, `scripts/save-cursor-pool.js`.


## `cursoradmin1` — SHIPPED 2026-09-28 20:05

**What:** Cursor provider admin-only for license email `brendan36363@gmail.com`. Others do not see it in provider list; API 403s. Not a Pro/Cipher paywall.
**License signing:** Public CER copied from `D:\IDE\certs\guide-codesign.cer` into `build/` + `certs/`. GH secrets `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` already present (2026-09-27).
**Release matrix:** Enabled `build-windows-cuda`, `build-linux-cuda`, `build-mac` for Build & Release.

