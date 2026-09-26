# v0.4.95 — Cloud finish + chat panel + Cipher speed (no forced behavior)

Status: **SHIPPED v0.4.95** (operator go full plan 2026-09-26). App ships A/D/B/C/E in release. P40 S1 flat / S6 ~2.1× live. S2/S5 not applied (ctx cut needs product accept; thinking path optional).

| Ship | Status | Notes |
|------|--------|--------|
| **A** Cursor-shaped post-tool prompt (no re-ask) | **SHIPPED** | `NEXT_FROM_HISTORY`; empty prompt skipped in generate |
| **B** Scroll stays put | **SHIPPED** | Virtuoso followOutput + wheel + think pane |
| **C** Plus = blank chat | **SHIPPED** | Plus→`handleNewChat`; empty tab “New chat” |
| **D** Log `stopReason` | **SHIPPED** | `[CloudAgentic] round end … stopReason=` |
| **E** Shrink cloud prompt / tool listing | **SHIPPED** | Shorter identity + desc≤100 |
| **S1** Power 180↔250 | **DONE — flat** | left at 180 W |
| **S6** KV on GPU | **DONE — ~2.1×** | `NO_KV_OFFLOAD=0` persisted |
| **S2–S5** | PARKED / frozen | ctx bench not cut; MTP/KV-q4 keep |

Product frame (HARD): guIDE Cloud is an unbiased general-purpose IDE agent like Cursor. **No** forced tool calling, **no** keyword “continue” poke, **no** done-tool required for “Hi”. Host rule stays: no parsed tool calls → turn ends.

## 1. Problem (user words)

Cloud ends mid-task (sometimes before any tools). Chat scroll glitches. Plus does not open a blank chat. Token speed on Cipher/P40 needs to be totally optimized (context, KV quant, MTP, power, etc.).

## 2. Live log evidence (2026-09-26, `guide-main.log`, debugLogging on)

Path: `C:\Users\brend\AppData\Roaming\guide-ide\logs\guide-main.log`

| Time (UTC) | Event |
|------------|--------|
| 13:06:53 | Turn 1 `userMessageLen=11` → `DONE toolCallCount=0` (~10s). Greeting-class OK. |
| **13:09:26** | **Turn 2 `userMessageLen=671`, agent, tools on** → **13:10:19 `DONE toolCallCount=0`**. Zero tools. Premature stop on first reply. |
| 13:10:54 | Turn 3 `userMessageLen=91` → tools: `get_project_structure`, `list_directory`, then `read_file`, `list_directory`, `run_command`, `web_search` (6 tools). |
| After each tool batch | `generate called` with **`promptLen=91`** (original user text re-fed every round). |
| **13:30:36 → 13:45:52** | After last tool inject: one more generate with **`promptLen=91`**, **no further tools**, then **`DONE toolCallCount=6`**. Operator UI: final prose ended with intent to keep going (“First, reading your existing plan note…”) and the turn stopped. That is this window. |

Ignore sandbox message text. Flow is the prove.

**Plan alignment (operator 2026-09-26 10:02):** This is exactly the Ship A class — tools already ran; host re-asked the original message; model returned **announce-next-step prose with zero tool JSON**; loop correctly ended (Cursor rule). Ship A removes the re-ask. It does **not** inject a continue after that prose (banned). Ship D must log `stopReason` so length-cut vs natural stop is visible. Speed: P40 S6 (~2× decode) is already live; long thinking rounds still cost wall time until prompt tax (E) and re-ask (A) ship.

## 3. Live P40 Cipher worker (SSH `secrypt-p40` 2026-09-26)

Quality `:18787` cmdline (process 347344):

- Model: `Qwen3.8-27B-…-Q4_K_P.gguf`
- `-c 24576`
- `--cache-type-k q4_0 --cache-type-v q4_0` (already low KV quant)
- `-ngl 99 --parallel 1 -np 1 --fit off --jinja --no-kv-offload`
- FastMTP: `--spec-type draft-mtp --spec-draft-n-max 1 --spec-draft-p-min 0` + FastMTP-32K draft
- Script note: draft has `nextn_predict_layers = 1`; **drafting 3 was the slow run** (`restart-worker-only.sh`)

Power: Tesla P40 **limit 180 W** (max **250 W**). Sample: draw ~120 W, util ~73–78%, VRAM ~18876/24576 MiB.

`worker.env`: `CTX=24576`, `CACHE_K/V=q4_0`, `NO_KV_OFFLOAD=1`, `PARALLEL=1`.

### Measured baseline (2026-09-26, `llama.err` + idle bench)

| Metric | Value |
|--------|--------|
| Decode (live long gen task 111384) | ~**6.9 tok/s** (`tg`) |
| Decode (completed slots in log) | ~**5.6–8.7 tok/s** eval |
| Prefill (mid prompts ~400–700 tok) | ~**110–150 tok/s** |
| Prefill (large ~4.5–5k tok) | ~**80–125 tok/s**, tens of seconds wall |
| MTP draft accept | ~**0.52–0.79**; mean draft len ~**1.5–1.8** at `n-max=1` |
| Draft GGUF | confirms `qwen35.nextn_predict_layers` (1-layer nextn) |
| Idle bench `BENCH_OK` / thinking off | `predicted_per_second` **7.93**; `draft_n_accepted=1` / `draft_n=2` |

**S3 frozen:** keep KV `q4_0` (do not raise to q8 for speed).  
**S4 frozen:** keep `spec-draft-n-max 1` until a multi-layer draft exists; accept rate already healthy for 1-token drafts.

## 4. Speed facts (answer the operator questions)

**Q8 vs Q4 for KV / weights:** Higher quant is **not** faster. **Q4 is lighter on memory bandwidth → usually faster than Q8.** Live KV is already `q4_0`. Moving KV to `q8_0` would trade quality up and speed/VRAM down. Do **not** raise KV quant for speed.

**Reduce context:** Yes for **prefill** (and some decode). 24k filled = expensive attention. Smaller `-c` or less prompt junk (system/tools/history) cuts time-to-first-token hard. Trade: less room for long agent threads.

**MTP:** Already on. `n-max=1` matches a 1-layer draft. Raising `n-max` without a better draft made it **slower** before. Speed gain here = better draft / MTP binary, not blind n-max↑.

**Power:** Cap is 180; card max 250. When util is high and draw sits under 180, raising toward 250 can help. Measure tok/s before/after.

**Other levers (largest first for “dramatically”):**

1. **Less tokens per round** — shorter system prompt (now **12894 chars**), tighter tool listing, don’t re-send original user ask every tool round (Ship A).
2. **Thinking cost** — `xhigh` burns a lot of hidden tokens. Fast path / lower effort for speed tests (quality trade).
3. **Context size** — prove 16k vs 24k tok/s on same prompt.
4. **Power 180→250** — ops ship, measure.
5. **Keep KV q4** — already optimal direction for speed.
6. **MTP** — keep n-max=1 until a stronger draft exists; measure accept rate in llama logs.
7. **Weights** — already Q4_K_P; Q8 weights would slow, not speed.
8. **Flash-attn / CUDA graphs / binary** — only if llama-server build supports and bench shows gain.
9. **Exclusive GPU** — other residents (Flux/LTX/ACE) steal VRAM/bus; exclusive LLM pack helps when measured.

## 5. Ships

### Ship A — Cursor-shaped post-tool user turn (READY)

**No force.** After tool results are in history, do **not** set `nextUserPrompt = userMessage`. Use empty / minimal next user only if generate requires a non-empty prompt (prove in code). Original task remains in history from earlier turns.

Keep: no tool JSON → end. Hi ends. Final answer ends. Parse-retry stays.

Log already shows `promptLen=91` on post-tool generates = re-ask.

### Ship B — Scroll (READY)

As prior: remove per-token auto-scroll fight; `followOutput` only at bottom; don’t clear scrolled-away on at-bottom flicker; wheel any delta; thinking panel no per-token yank.

### Ship C — Plus blank chat (READY)

Plus ≠ Trash clear. Plus → empty Current / New chat. History wipe must not resurrect live thread.

### Ship D — Log `stopReason` (READY)

Every Cloud generate end: log `stopReason`, `iter`, parsed tool count, prose length. Without this, EOG vs length-cut stays blind.

### Ship E — Prompt / tool listing tax (READY for LFL after measure)

Cut Cloud system + tool listing size without removing Settings-enabled tools from the listing. Measure chars and TTFT. Not a behavior force.

### Ship S6 — KV on GPU / drop `--no-kv-offload` (ops DONE 2026-09-26)

Live pack was `2b-q4-plus-27b-quality` with **both** workers on `--no-kv-offload` (~5.5 GiB free). Same decode prompt A/B after stopping 2B briefly:

| Mode | `predicted_per_second` | `prompt_per_second` | VRAM after gen |
|------|------------------------|---------------------|----------------|
| `NO_KV_OFFLOAD=1` (old) | **10.46** | 44.29 | ~18792 MiB |
| `NO_KV_OFFLOAD=0` (KV on GPU) | **21.83** | 65.38 | ~19528 MiB |

**~2.09× decode.** Draft accept 115/115 both runs. Restored 2B alongside; both healthy. Persisted `NO_KV_OFFLOAD=0` in `config/worker.env` (bak `worker.env.bak-nkvo0-*`). Live quality cmdline no longer has `--no-kv-offload`.

**Caveat:** Old comment kept KV in RAM to share with Flux/LTX/ACE. Current pack has no Flux/LTX/ACE. If those return and VRAM OOMs, set `NO_KV_OFFLOAD=1` again.

### Ship S1 — Power ceiling bench (ops DONE 2026-09-26)

Same prompt A/B (`max_tokens=256`, thinking off):

| Limit | `predicted_per_second` | `prompt_per_second` | draw after |
|-------|------------------------|---------------------|------------|
| **250 W** | **10.681** | 44.76 | ~82 W @ 1531 MHz |
| **180 W** | **10.681** | 12.99 | ~84 W @ 1531 MHz |

Decode tok/s **unchanged**. Draw stayed ~80 W (under both caps), so power was not the decode bottleneck on this load. Prefill delta is not treated as a power win (run-order / cache). **Left at 180 W** (matches `gpu-power-cap.sh` default floor).

### Ship S2 — Context size bench (ops READY)

Bench `-c 16384` vs `24576` same prompt (quality worker). Record TTFT + tok/s. Ship only if product accepts shorter window.

### Ship S3 — Keep KV q4 (document; no change)

Do not “optimize” by raising KV to q8. Document in ops notes.

### Ship S4 — MTP accept-rate audit (ops READY)

From llama err/out logs: draft accept rate at n-max=1. Only change draft model / binary if evidence says so. Do not raise n-max without that.

### Ship S5 — Thinking effort speed path (product READY for plan; needs go)

Optional: Cloud “fast” vs “quality” thinking effort without changing agent loop. Not default-force tools.

## 6. `/goal` skill — does it fix premature ending?

**No, not by itself.** `skills/goal/SKILL.md` tells the model to keep calling tools until requirements are verified and to emit `GOAL_COMPLETE`. That is **prompt text**. The host still `break`s on a prose-only reply with no tool JSON (same as Cursor). Older `Goal check:` continue injects were removed on purpose (`PLAN-lfl-cloud-pipeline.md`). `/goal` can help a well-behaved model; it does **not** replace Ship A and it is **not** forced tool calling.

## 7. Validation

- **A:** After tools, log must show post-tool `promptLen` is **not** the full original task length; long agent tasks keep tool rounds; Hi still one-shot; no continue inject.
- **B/C:** Manual UI.
- **D:** Premature stops show `stopReason=` in guide-main.
- **S*:** tok/s + TTFT tables before/after; no silent quality regression claim without a same-prompt bench.

## 8. Execute order

On `go Ship X` or `go` listing ships: A→D→B→C for app; S1–S5 as named ops. One surgical change per go unless operator names several in one message. Backup → edit → test → (app) commit/tag/CI; (ops) restart worker + bench.
