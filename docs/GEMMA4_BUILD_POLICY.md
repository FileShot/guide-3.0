# Gemma 4 — agent policy (read before any Gemma work)

## Do not mislead the user

- **Never** claim Gemma 4 works in guIDE until the user has loaded a Gemma 4 GGUF in a **shipped installer** and `guide-main.log` shows successful load (no `unknown architecture 'gemma4'`).
- **Never** say CI is "on the right track" or "almost there" because verify passed, tarball downloaded, or `llama-arch.cpp` contains `gemma4` in **source** — that is not a working binary.
- **Never** re-litigate that "Gemma is a chatEngine problem" — the user knows it is a native llama.cpp binary issue.

## What was tried many times (v0.3.70–v0.3.94)

- Pin `b9209` / `b8954` / `b9253` and **compile** llama in GitHub Actions via `node-llama-cpp source build`
- Full 9-platform matrix blocking release when Mac/Linux fail
- Tarball download, git init, verify scripts, C++17 flags, `--gpu cuda` — still no published Gemma-capable Windows installer from this repo

**v0.3.85** shipped **npm prebuilt** llama (**b8390**). Gemma 4 does **not** load. That was an intentional tradeoff after compile CI kept failing.

## What actually ships today

`node-llama-cpp@3.18.1` → `@node-llama-cpp/win-x64-cuda` prebuilt metadata: **b8390** (no `gemma4` at runtime).

Gemma 4 in guIDE requires a **newer compiled** `llama-addon.node` than that prebuild. Compiling it in CI has repeatedly failed or run 2+ hours without a release.

## Allowed next steps (only with user ask)

1. **Ship a green build** — `npm ci` (postinstall prebuilts), no CI source compile; Gemma 4 still unsupported until prebuild updates.
2. **New `node-llama-cpp` npm** with Gemma-capable prebuilt binaries — then bump dependency and release.
3. **One-off local/self-hosted** compile the user runs; copy binaries into the app — not "fixed in CI" until proven.
4. **External backend** (Ollama / LM Studio API) — product change, not llama pin.

## Forbidden without proof

- Another full-matrix `source build` on all runners "to get gemma4"
- Metadata-only tarball swap without recompiling the addon
- chatEngine hacks for `gemma4` architecture
