# Production-final plan

This is the last fix round before production. Scope is behavior that is wrong today, with the files that cause it. A rewrite of `chatEngine.js`, `mcpToolServer.js`, or `ChatPanel.jsx` is out of scope until these behaviors hold.

guIDE Cloud AI (`cipher-quality`, the P40 27B) is the path under test. Local models get the same tool and skill behavior where the pipeline is shared. Cloud context grows by quantizing that worker's KV cache and raising `n_ctx` to match.

---

## 1. Problem (user words)

Voice is late, duplicated in yellow, types "blank audio", and keeps going after Stop. Tool calls on guIDE Cloud do not build the requested project. Slash skills only rewrite the user message into a paragraph. A goal has to show a bar above the chat box and keep working until the objective is actually done. The app is heavy. Context is 16,384 today; a more quantized KV cache is what frees the room to run Cloud near 32,000. This pass has to say, for each issue, what the app does now and what it must do instead.

---

## 2. Current implementation

### 2.1 Two different "token" numbers

| Knob | Where | Value today | What it controls |
|---|---|---|---|
| Cloud context window | `cloudLLMService.js` `_getModelContextLimit` | `SECRYPT_CONTEXT_TOKENS` or **16384** | How much prompt + history + reply can exist for cipher-quality |
| Cloud reply cap | `cloudLLMService.js` `_generateViaProxy` | `Math.min(options.maxTokens \|\| 1024, 1024)` | How many tokens one Cloud reply is allowed to emit |
| Settings "max response" | `settingsManager.js` `maxResponseTokens: 0` | 0 means auto | Passed as `maxTokens: settings.maxResponseTokens \|\| -1` from `cloudAgenticChat.js` and `electron-main.js` |
| Local reply cap | `chatEngine.js` generation setup | `maxTokens > 0` is a cap; otherwise the unused part of the loaded context | Local already continues when a round stops on `maxTokens` |

The 16,000 raise is the context window (16384). It is already in the client. It was never applied to the reply cap.

Default auto (`0`) becomes `-1` before the proxy clamp. `-1` is truthy, so `Math.min(-1, 1024)` sends **`-1`**, not 1024. Any positive setting above 1024 (including 4096 or 16384) is forced back down to **1024**. Local code treats `<= 0` as "use the room left in the context". Cloud does not. The P40 worker's handling of `maxTokens: -1` is not in this repo. The client never asks Cloud for "the rest of the 16384 window", and it never continues a Cloud reply that stops because it hit the length limit. Local `chatEngine.js` already has that continuation loop. `cloudAgenticChat.js` does not.

A single `write_file` of a real page is several thousand tokens. A directory listing is a few dozen. That is why Cloud lists `.` and stops.

### 2.2 KV cache and 32,000

More quantized KV uses fewer bytes per token. The same VRAM then holds a larger context. That is the way Cloud goes from 16,384 toward 32,768.

`chatEngine.js` `kvBytesPerElement`: `f16` = 2, `q8_0` = 1, `q4_0` = 0.5. Q4 holds about twice the tokens of Q8 in the same cache. On the P40, Q4 KV beside the 27B weights is the room for `n_ctx=32768`. A shorter tool prompt keeps that extra window for the conversation and the files, instead of filling it with the catalog.

What the repo does today:

- The client still tells itself the Cloud window is 16384 (`SECRYPT_CONTEXT_TOKENS`).
- The proxy request does not carry a KV type. The worker's KV type is what actually sizes the cache. This repo's constant has to match the worker once that cache is Q4 and `n_ctx` is 32768.
- Persisted default is `q8_0` (`settingsManager.js`). The settings UI offers "Q4 (Most Context)". On every launch this migration runs and then saves:

```text
if kvCacheType is q3_0 or q4_0 or f16 → set q8_0 and save
```

So an explicit Q4 choice does not survive a restart, locally or as the policy we would ship for the worker. The in-memory UI default in `appStore.js` is `q4_0`, so the screen and the saved setting disagree until load finishes.

The Cloud system prompt is also sliced at 14,000 characters (`SECRYPT_SYSTEM_PROMPT_CHARS`), and the compact tool catalog is the full category list. `tools/cloudTightPrompt.test.js` requires that catalog to be longer than 5,000 characters. Condensing that catalog is required so the 32k window is usable.

### 2.3 What a skill does here today

There are five names: `/skills`, `/goal`, `/plan`, `/ask`, `/automate`. They are duplicated in `skills/registry.js` and `frontend/src/lib/slashSkills.js`.

On send, `ChatPanel.jsx` `doSend` calls `resolveSlashSkill`. For `/goal build a shop` the user's text is replaced with a short paragraph that starts `GOAL (do not stop at planning...` and that paragraph is what the model receives. `/plan` and `/ask` also flip `chatMode`. `/skills` prints the hardcoded list and does not call the model. Nothing reads a skill file. Nothing checks a done condition. The cloud loop is the same loop as a normal message, so it still exits after a listing.

### 2.4 What initiating a skill does in Cursor (the behavior to match)

A skill is a `SKILL.md` procedure. Invoking it loads that file and the agent follows the steps with tools until the skill's own done condition.

Examples of what that causes, in this environment:

- A create-skill invocation makes the agent write a `SKILL.md` (frontmatter plus the procedure) into the skills directory. The user sentence is the request. The skill text is the instructions that get executed.
- A loop invocation parses the interval and arms a timer that re-runs the prompt. It does not paraphrase "please keep going".
- A goal is a durable objective: the agent keeps using tools until the objective is satisfied, and the session remembers the objective across turns.

guIDE's slash handler does the paraphrase and then uses the normal chat loop. That is why `/goal` cannot finish a site.

### 2.5 Cloud tool loop (the screenshot)

`cloudAgenticChat.js` asks the model for a ```json tool block, parses it with `tools/toolParser.js`, runs it through `mcpToolServer.js`, and injects the result as a fake user message.

What the screenshot shows, mapped to code:

- "Listed ." is `ToolCallCard.jsx`. The done verb for `list_directory` is "Listed" and the detail is `dirPath`, which the prompt example sets to `"."`. The file names are behind the expand click. `_listDirectory` does return `{ success, items }`.
- The compact Cloud header in `agentModeResolver.js` `getAgentToolPromptHeader` shows examples for `read_file`, `edit_file`, and `list_directory`. The `write_file` example exists only on the non-compact header, which Cloud does not use.
- The shared system prompt tells the model to call `run_terminal_command`. That name is not in `VALID_TOOLS`. The alias list has `run_terminal_cmd`, not `run_terminal_command`.
- `get_project_structure` recursively lists the whole tree (`_getProjectStructure` → `_listDirectory(..., true)`) and is in the compact catalog, so a build request spends a round dumping the project.
- When the visible reply is under 240 characters and any tool ran, `ChatPanel.jsx` finalization writes `**Tool run** (N call): …` into the saved assistant message. `sanitizeCloudConversationHistory` does not remove that line, so the next turn's history contains it and the model types it back as prose, glued to the next sentence.

### 2.6 Voice

`frontend/src/lib/offlineVoiceStream.js` slices the mic into ~800ms chunks. `voiceService.js` `transcribe` starts a new `whisper-cli` process per chunk, model load included, and the jobs are serial. A sentence is a queue of full process starts. That is the multi-second gap between words.

Each successful chunk calls both `onPartialText` and `onFinalText`. Partial text accumulates in `voiceLiveText`, drawn in the accent color above the textarea. Final text is appended into the textarea. The yellow line is a second copy of committed text, kept until Stop.

The silence gate is `rms < SILENCE_RMS * 0.25` (0.000875). Chunks quieter than speech still pass, especially with the 200ms overlap prepended from the previous chunk. whisper.cpp writes no-speech audio as "blank audio" / `[BLANK_AUDIO]`. The service returns that string as `success: true`. Nothing filters it.

`stop()` sets `running = false`, flushes the tail (often silence), and waits up to 30s for the queue. Late results still call `onFinalText`. Stop does not kill `whisper-cli` and does not ignore stale callbacks. The button flips off while "blank audio" is still being appended.

### 2.7 Weight that shows up as bugs

These are in scope because they cause wrong behavior or make the app feel broken. They are not an invitation to split the large files first.

- `ChatPanel.jsx` mounts the message list with `key={chatGenerationEpoch}`, so every send destroys and recreates the list.
- Finalization in that file compensates for IPC ordering, empty segments, and short replies by inventing text (`**Tool run**`, forced messages). Those strings become model context.
- `electron-main.js` constructs `ChatEngine`, `MCPToolServer`, `MediaEngine`, `CloudLLMService`, `VoiceService`, and `BrowserManager` at startup, including when the user is only chatting with Cloud.
- `notes/guide3/RULES.md` is referenced by `.cursor/rules/obey-guide-rules.mdc` and is not in the tree. Agents working this repo have no copy of the failure-pattern list that rule points at.

---

## 3. Proposed change

Outcome if this plan is applied: Cloud can write a multi-file site in one request, slash skills run a procedure until its done condition, voice commits one transcript and Stop halts it, and the context numbers mean what the UI says. Outcome if it is not applied: those stay as they are now.

### 3.1 Cloud reply budget

**Intended.** Cipher-quality runs with Q4 KV and `n_ctx=32768`. The client constant `SECRYPT_CONTEXT_TOKENS` is 32768 to match. One Cloud round may use the unused part of that window, with a reserved output floor large enough for a file write (4096 tokens unless the window is tighter). `maxResponseTokens: 0` means that rule, the same as local. A positive user cap is honored up to the room left in the window. The 1024 ceiling is removed. If a round stops because it hit the length limit mid-`write_file` or mid-sentence, `cloudAgenticChat.js` continues in the same user turn, the way `chatEngine.js` already continues locally, and the next round may `append_to_file` or finish the JSON. The client does not send `maxTokens: -1`.

The worker process has to be started at that KV type and context. The proxy body today has no KV field, so the change is the worker launch config plus this client's 32768 constant, in the same pass. A shorter Cloud tool catalog (section 3.2) is what keeps the extra tokens available.

**Files.** `cloudLLMService.js` (`_getModelContextLimit`, `_generateViaProxy`, `_trimToContextLimit` call site), `cloudAgenticChat.js` (continuation when the provider stops on length), the cipher-quality worker launch config. Update `tools/cloudTightPrompt.test.js` so it locks the context at 32768 and asserts the reply budget is not clamped to 1024.

**Local Q4 persistence.** Stop rewriting an explicit `q4_0` or `f16` back to `q8_0` on load. New installs default to `q4_0` so local context gets the same room. Align `appStore.js` with that default. A saved F16 or Q8 stays what the user saved.

### 3.2 Cloud tool prompt and loop

**Intended.** A build request in agent mode emits `write_file` / `edit_file` / `run_command` and keeps going until the files exist or the model stops with the work done. One directory listing is allowed. A second listing of the same path is not a completed turn.

**Changes.**

- Cloud compact header includes a `write_file` example. Remove the instruction to call `list_directory` before creating files the user just asked for.
- Replace `run_terminal_command` in `getAgentSystemPrompt` with `run_command`.
- Cloud agent catalog for a normal coding turn: `read_file`, `write_file`, `edit_file`, `append_to_file`, `list_directory`, `find_files`, `grep_search`, `run_command`, `write_todos`, `update_todo`, `ask_question`. Browser, git, memory, and `get_project_structure` stay available when the user asks for them, and they are not in the default Cloud prompt. This is what leaves the 32768 window for the work.
- `list_directory` results injected into the model are names and types, not a JSON blob of absolute paths. The tool card's one line shows the count and up to three names (`Listed 12 — src, package.json, README.md`).
- Delete the `**Tool run**` sentence from finalization. Tool activity stays in tool segments / `ToolCallCard` only. `sanitizeCloudConversationHistory` drops any leftover `**Tool run**` lines already stored in old chats.

**Files.** `agentModeResolver.js`, `cloudAgenticChat.js`, `mcpToolServer.js` (`getCompactToolHint` cloud path only), `frontend/src/components/chat/ToolCallCard.jsx`, `frontend/src/components/ChatPanel.jsx` (finalization block around the tool summary), `tools/toolResultInjection.js`.

### 3.3 Skills

**Current.** Five names, two copies, and a paragraph rewrite. No bar above the input. When the model stops, the turn is over. Nothing asks whether the objective is done.

**Intended.** Typing `/name` loads that skill's `SKILL.md` and the agent follows it. The user bubble shows the slash text they typed. The model receives the skill's rules plus the argument. There is no second paraphrased copy in `frontend/src/lib/slashSkills.js`.

guIDE ships the same skill set that is installed here, as `skills/<id>/SKILL.md`, with the same rules. Tool names inside a skill point at guIDE tools (`write_file`, `write_todos`, `run_command`, git, the goal state). A skill that only describes another product's private API is rewritten onto the guIDE tool that does that job, and the rules of the skill stay.

#### `/goal` — pursue to completion

This is the one with UI, not only a prompt.

When `/goal <objective>` is sent:

1. Empty objective shows `Usage: /goal <objective>` and does not arm anything.
2. There is no deadline, token budget, or turn budget. A leading `30m` / `2h` is rejected as a time limit (say that time-limited goals are not supported) and the rest becomes the objective. "Every" is `/loop`, not `/goal`.
3. A thin bar appears directly above the chat input. It shows the objective text. It has a pause button. It has toggles for the run options that already exist on the agent (auto-continue, tools, plan/ask/agent). Pause freezes the loop; resume continues the same objective. The bar stays until the goal is complete or the user dismisses it.
4. The first turn does real work immediately. Creating the goal is not the end of the turn.
5. The objective stays the full objective. The agent does not shrink it to whatever fits in one reply.

Auto-nudge. If the model ends a response on its own — stop token, a short "I'll do that next" reply, or a tool round that did not finish the objective — the runtime does not return the turn to the user. It sends one continuation, in the same turn, whose only question is: is every requirement of the goal true in the current files and command output? If any requirement is unverified or false, the model keeps working. If the evidence shows every requirement is true, the goal is marked complete and the bar clears. Stopping work is not completion. A plan, a promise, or a directory listing is not completion.

The bar's pause is the only user stop. A paused goal does not auto-nudge. Resume continues the audit.

#### The rest of the installed skills

Each one is a real procedure the slash menu can launch. `/skills` lists them from disk.

| Skill | Rule the agent follows |
|---|---|
| `/goal` | Bar, pause, toggles, auto-nudge until the objective is proven done. |
| `/loop` | Recurring run of a prompt on an interval. Not a goal. |
| `/automate` | Build a scheduled or triggered workflow in this project (script plus how it runs). Ask once if trigger, action, or outcome is missing. |
| `/autopilot` | Keep the current branch merge-ready: conflicts, then review comments, then failing checks. Re-read live state every pass. Do not weaken CI to make it pass. |
| `/review` | Ask which review, then run that one. |
| `/review-bugbot` | Review the current changes for bugs. |
| `/review-security` | Review the current changes for security issues. |
| `/canvas` | Produce the analytical artifact as a live view beside the chat when the answer is data, a timeline, or a table. |
| `/create-hook` | Add a project hook the user asked for, wired so it actually runs. |
| `/create-rule` | Add a persistent project rule file. |
| `/create-skill` | Add a new `skills/<name>/SKILL.md` with name, description, and the procedure. |
| `/create-subagent` | Add a focused sub-agent definition the user can invoke. |
| `/migrate-to-skills` | Turn existing rule files into skills. |
| `/split-to-prs` | Split the current work into small reviewable branches. |
| `/new-repo` | Create the project repo and push it. |
| `/share` | Save or share the project. |
| `/origin` | Install or repair the origin CLI when the user is on that host. |
| `/sdk` | Follow the SDK procedure when the user is wiring the agent SDK. |
| `/shell` | Run the shell task the user named, in the project. |
| `/statusline` | Configure the CLI status line the user asked for. |
| `/update-cli-config` | Change the CLI config they named. |
| `/update-cursor-settings` | Change editor settings they named (`settings.json`). |
| `/onboard` | Walk a new project through first-run setup. |
| `/rename-chat` | Rename the current chat from the conversation. |

Slash commands from the composer menu that are not skill files, same bar of the menu:

| Command | What it does |
|---|---|
| `/add-plugin` | Install a plugin from the marketplace. |
| `/remove-plugin` | Uninstall an installed plugin. |
| `/run-everything` | Enable run-everything for this agent (commands are not approval-gated for this chat). |
| `/apply-worktree` | Apply the staged worktree changes the user is asking to take. |

Discovery: app `skills/<id>/SKILL.md`, project `.guide/skills/<id>/SKILL.md` (project wins on id clash), user `<userData>/skills/<id>/SKILL.md`. One loader, `skills/registry.js`. The menu reads name and description from the files.

`/goal` depends on 3.1 and 3.2. Without a reply budget and a tool loop that can write files, the nudge will keep listing the directory.

### 3.4 Voice

**Intended.** While the mic is on, words appear once, in the textarea, within about a second of a phrase ending. The line above the box is status only ("Listening", "Transcribing"). Silence adds nothing. Stop ends transcription immediately: no further words, including "blank audio".

**Changes in `voiceService.js` and `offlineVoiceStream.js`.**

- One Whisper process for the listening session. Feed it phrase-sized audio (speech, then a short silence), not an 800ms spawn loop.
- Commit text only through `onFinalText`. `onPartialText` is removed. Status uses `onStatus`.
- Drop no-speech strings before they reach the UI: `blank audio`, `[BLANK_AUDIO]`, `[silence]`, and a chunk that is only that phrase repeated.
- Do not enqueue a chunk whose level is under the speech threshold. Do not flush a silent tail on Stop.
- `stop()` kills the Whisper process, clears the queue, and bumps a session id so a late callback cannot append.

### 3.5 Weight, bounded

Do these because they are specific and they remove failure modes. Do not split the large files in this round.

- Remove `key={chatGenerationEpoch}` from the chat list so a send does not remount every message.
- After 3.2, delete the finalization branch that invents `**Tool run**` text. Leave the IPC-lag correction alone unless a test shows it still duplicates prose.
- Construct `BrowserManager`, `MediaEngine`, and `VoiceService` on first use. Cloud chat must not start a browser or Whisper at launch.

### 3.6 Edge cases

- Stop pressed while a Whisper chunk is inside the process: process is killed, partial text already committed stays, nothing new is appended.
- `write_file` body longer than one round: continuation appends; the file on disk is complete; the chat does not show a cut-off JSON blob as the answer.
- `/goal` with no folder open: the existing temp-project behavior in `_writeFile` still applies. Pause stops the nudge. A turn that ends without proof of completion starts another round. The skill does not call `get_project_structure` in a loop.
- Old chats that already contain `**Tool run**`: sanitizer strips those lines before the next Cloud request.
- User sets max response to 2048: Cloud uses 2048, not 1024, provided the window has room.
- User sets KV to Q4 and restarts: the setting is still Q4. Cloud context constant is 32768.
- Project skill and builtin share an id: the project file wins.

---

## 4. Validation

Run `npm test` after each workstream. Run `cd frontend && npm run build` after voice, tool-card, or chat-list changes.

| Case | Pass |
|---|---|
| Cloud reply budget | Context limit is 32768. A request with `maxResponseTokens: 0` sends a positive budget equal to the unused part of that window, floored for a file write, and never sends `-1` or a silent 1024 clamp. A positive cap of 4096 is sent as 4096. |
| Build | Prompt: "file sharing website, modern compact theme". Project gains the HTML/CSS/JS files. Transcript has no `Tool run`. Listing card shows names, not only "Listed .". |
| Length stop | A write that exceeds one round still produces a complete file via continuation in the same turn. |
| `/goal` | Bar above the input shows the objective, pause, and the run toggles. User bubble is the slash text. If the model stops before the files exist, another round starts and the model has to say whether the goal is done. Pause halts that. Complete clears the bar only after the files exist. |
| `/skills` | Menu lists the skill table above, plus a fixture `.guide/skills/demo/SKILL.md`. |
| Voice | A spoken sentence appears once in the box. Yellow line is status. Five seconds of silence does not type "blank audio". Stop adds nothing further. |
| KV | Save Q4, restart, value is still Q4. Cloud context constant is 32768, matching a Q4 KV worker. |
| Launch | Cold start with Cloud selected does not spawn whisper-cli or the browser. |

---

## Order

1. Reply budget and Cloud continuation (3.1), otherwise builds cannot finish.
2. Tool prompt, catalog, cards, and `Tool run` removal (3.2).
3. Skill loader, the goal bar, auto-nudge, and the rest of the skill set (3.3).
4. Voice session (3.4).
5. List remount, lazy services, KV migration (3.5 and the local half of 3.1).

Ship only when the validation table is green. Do not open a second architecture pass in the same change.
