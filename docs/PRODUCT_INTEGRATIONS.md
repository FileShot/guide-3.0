# guIDE Integrations Roadmap

Cloud IDE parity goals for guIDE as a local-first alternative to Cursor, Windsurf, and similar products.

## What exists today

| Area | Status |
|------|--------|
| **Agent Git tools** | `git_status`, `git_commit`, `git_diff`, `git_log`, `git_branch`, `git_stash`, `git_reset`, `git_push`, etc. via MCP tools |
| **Git UI** | Sidebar Git panel — status, stage/unstage; branch name in store |
| **Browser automation** | Playwright + viewport iframe fallback (v0.3.173+) |
| **Terminal** | node-pty integrated terminal; agent `run_command` / `terminal_run` |
| **Extensions scaffold** | `extensionManager.js` — custom manifest format; install/enable/disable; **`main.js` not executed yet** |
| **Rules / memory** | Project rules, scratchpad, save_memory tools |

## VS Code extensions — honest scope

**Full VS Code extension compatibility is not a drop-in feature.** It requires the entire `vscode.*` API (commands, languages, debug adapters, webviews, activation events, marketplace protocol).

### Recommended tiers

| Tier | Scope | Effort | Priority |
|------|--------|--------|----------|
| **A — guIDE native extensions** | Run `main.js` with a small guIDE API (commands, settings hooks) | Medium | High |
| **B — Curated CLI/LSP adapters** | Prettier, ESLint, etc. via CLI or language servers, not VSIX | Medium | High |
| **C — LSP-first IntelliSense** | Monaco + language servers (TS, Python, Rust, …) | Medium | **Highest user impact** |
| **D — Open VSX subset** | Load VSIX with shim for common APIs | Large | Research |
| **E — Full VS Code Extension Host** | Marketplace parity with Cursor/Windsurf | Very large | Long-term |

**Near-term recommendation:** Tier **C** (LSP) + Tier **A** (native extensions API).

## Git — UI gaps (174–175)

Agent tools cover most git operations. UI should mirror them:

- [ ] Commit message input + commit button in Git panel
- [ ] Push / pull actions
- [ ] Branch picker in status bar (data already in `gitBranch` store)
- [ ] Staged file diff viewer (partial DiffViewer exists)
- [ ] Discard changes per file

## Other cloud-IDE expectations (backlog)

1. **LSP / IntelliSense** — biggest perceived gap vs cloud IDEs
2. **Multi-root workspaces**
3. **Inline completions** (local model path)
4. **Extension marketplace UI** wired to ExtensionManager
5. **Remote SSH / dev containers** (later)
6. **Settings sync** (later)

## Browser vs shell debugging

Agents should use `browser_navigate`, `fetch_webpage`, and Playwright tools — not `run_command` to launch `chrome.exe` or debug Playwright binaries. v0.3.174+ enforces this in tool prompts and command timeout hints.
