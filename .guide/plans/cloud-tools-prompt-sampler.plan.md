# v0.4.94 — Cloud tools, prompt, sampler

Status: SHIPPED as `0.4.94` on `go`.

Repo: `D:\guide-3.0-v0.4.82`. Version today: `package.json` `0.4.93`. This ship is `0.4.94`.

`notes/guide3/RULES.md` and `/memories/guide-master.md` are not in this tree. This plan follows `.github/copilot-instructions.md`, `.github/instructions/response-discipline.instructions.md`, `.cursor/rules/plan-structure.mdc`, and `.cursor/rules/plan-execute-ship.mdc`.

Copilot bans a model-named branch and a keyword detector. This plan deletes the keyword tool filter. The shorter prompt is the cloud path, for every cloud model, not a Qwen string check. The sampler is the published Qwen3.8-27B card, applied only to the existing `cipher-quality` worker. Local GGUF profiles stay as they are.

## 1. Problem (user words)

Settings has toggles to enable and disable tools. Cipher still shows about eleven tools. The toggles are real and must stay toggles. Every tool that is enabled must be visible in the system prompt. The prompt is long, holds the model's hand, and is not a general IDE assistant. The cloud prompt can differ from the local prompt. The loaded model is a Sonnet-class Qwen 3.8 27B, so the cloud prompt stays short. Temperature and the other sampler fields must match that model's card. A greeting or any reply that needs no tool ends the turn. There is no completion tool and no second round that demands a tool.

## 2. Current implementation

Settings toggles live in `frontend/src/stores/appStore.js` (`guIDE-enabled-tools`) and `frontend/src/components/Sidebar.jsx` `ToolToggles`. A missing key uses `DEFAULT_ENABLED_TOOLS` (most tools on). `ChatPanel.jsx` params (about lines 1845–1903) send `toolsEnabled` and do not send the per-tool map. `electron-main.js` `runCloudAgenticChat` settings (about lines 906–917) also omit it. The toggles never reach the model.

`cloudAgenticChat.js` lines 27–48 `CLOUD_CORE_TOOLS` / `selectCloudToolDefs` then keep 11 names (`read_file`, `write_file`, `edit_file`, `append_to_file`, `list_directory`, `find_files`, `grep_search`, `run_command`, `write_todos`, `update_todo`, `ask_question`) and add browser, git, or memory tools only when the user message matches a word list. Lines 175–185 write that subset with `getCompactToolHint`, plus a line that orders `write_file` JSON. That is the eleven-tool list. It is not the settings screen.

`buildCloudSystemPrompt` (`chatEngine.js` lines 6065–6103) with `tightContext: false` uses `getAgentSystemPrompt()` (`agentModeResolver.js` lines 286–333). That text includes how-to-respond rules, a browser and login section, todo rules, and worked patterns for writing a file, editing, running a command, web search, the browser, finding files, and greetings. `cloudLLMService.js` lines 828–841 then cut the system string at `SECRYPT_SYSTEM_PROMPT_CHARS` (14000) and can drop the tool section.

The agent loop (`cloudAgenticChat.js` lines 380–417) ends when a reply has no parsed tool call. `looksLikeEmptyBuildPromise` (lines 117–122) and `CLOUD_FORCE_TOOLS_PROMPT` (lines 110–112) scan the reply for build/create/write words and nudge once. A reply such as "let me read the project" does not match, so the turn ends. Ask mode already ends at line 380.

`genBase` (lines 243–254) has `temperature` and `topP`. `_generateViaProxy` (lines 870–880) sends `temperature` and `enable_thinking` only. `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`, and `reasoning_effort` are not in the body. Settings has no presence-penalty control. Reasoning effort buttons are `low`, `medium`, `high` (`Sidebar.jsx` line 1988).

The Qwen3.8-27B card (https://huggingface.co/Qwen/Qwen3.8-27B) and the HauhauCS Aggressive card:

- Thinking: temperature 1.0, top_p 0.95, top_k 20, min_p 0.0, presence_penalty 0.0, repetition_penalty 1.0, reasoning_effort xhigh
- Non-thinking: temperature 0.7, top_p 0.80, top_k 20, min_p 0.0, presence_penalty 1.5, repetition_penalty 1.0, enable_thinking false

Saved settings use presence 1.5 while thinking is on. That is the non-thinking card. `buildStructuredOutputSampling` in `generationProfiles.js` forces agent presence to at least 1.0 and repeat penalty to at least 1.12. The cloud request does not use that function. Local profiles stay on it.

The P40 boot unit `/etc/systemd/system/secrypt-gpu-power-cap.service` sets `SECRYPT_GPU_POWER_LIMIT_W=150`. The live limit was set to 180 W. A reboot returns it to 150. `sudo -n` can run `nvidia-smi`. It cannot edit the unit.

## 3. Proposed change

One release, `0.4.94`. Local chat keeps `getAgentSystemPrompt()` and its full local tool path. Cloud changes are the sections below.

### 3.1 Settings toggles decide the cloud tool list

New file `frontend/src/lib/enabledTools.js`. Move `DEFAULT_ENABLED_TOOLS` and the tool-name list out of `Sidebar.jsx` into this module. Export:

```javascript
export function isToolEnabled(name, enabledTools) {
  if (enabledTools && Object.prototype.hasOwnProperty.call(enabledTools, name)) {
    return !!enabledTools[name];
  }
  return DEFAULT_ENABLED_TOOLS.has(name);
}

export function resolveEnabledToolMap(enabledTools) {
  const map = {};
  for (const name of ALL_TOOL_NAMES) map[name] = isToolEnabled(name, enabledTools);
  return map;
}
```

`Sidebar.jsx` `isEnabled` calls `isToolEnabled`. No new tool is added.

`ChatPanel.jsx` params gain:

```javascript
enabledTools: resolveEnabledToolMap(useAppStore.getState().enabledTools),
```

`electron-main.js` passes `enabledTools: settings.enabledTools` inside the `runCloudAgenticChat` settings object.

`cloudAgenticChat.js` after `filterToolDefinitions`:

```javascript
if (settings.enabledTools && typeof settings.enabledTools === 'object') {
  filteredDefs = filteredDefs.filter((d) => settings.enabledTools[d.name] === true);
}
```

Delete the `isSecryptCloud && !mode.planning` call to `selectCloudToolDefs`. Delete `CLOUD_CORE_TOOLS`, `selectCloudToolDefs`, and its export. A tool switched off stays out. A tool switched on is in the list on every message, including a message that does not contain "browser" or "git".

### 3.2 Full tool text, same prompt every cloud request

Replace the `isSecryptCloud` compact branch (lines 175–185). The cloud tool text is one line per enabled tool: name, parameters, description. It does not include the example header from `getAgentToolPromptHeader` or the Common patterns footer from `getAgentToolCatalogRules`. Delete the appended `CRITICAL: When asked to build/create files...` string.

Delete `cloudLLMService.js` lines 828–841 (the `SECRYPT_SYSTEM_PROMPT_CHARS` cut). `fitCloudHistory` already fits the window. Cutting the system string is what hides tools.

### 3.3 Short cloud identity

Add `getCloudAgentSystemPrompt()` in `agentModeResolver.js` and export it. Do not edit `getAgentSystemPrompt()`. Local mode keeps that text.

```javascript
function getCloudAgentSystemPrompt() {
  return 'You are guIDE, a general-purpose AI inside an IDE.\n\n'
    + 'The tools below are the ones switched on in Settings. A * marks a required parameter. Call a tool as one JSON object: {"tool":"<name>","params":{...}}. Do not invent tools, parameters, or tool results.\n\n'
    + 'Use a tool when the work needs one. Reply in prose when it does not.\n'
    + 'Do not end your response while the user\'s request is still unfinished.\n\n'
    + 'Do not invent secrets, passwords, or codes. When you need a fact only the user has, call ask_question.\n\n'
    + 'Application files go in the project root. .guide/ is IDE metadata.\n';
}
```

Cloud never includes `generate_image` in the tool list (cloud path cannot generate images), even if that toggle is on.

In `runCloudAgenticChat`, after `resolveAgentMode`, when `!mode.askOnly && !mode.planning`:

```javascript
mode.baseSystemPrompt = getCloudAgentSystemPrompt();
```

Ask mode and plan mode keep their existing prompts. `tightContext` stays false. The cloud-channels block in `buildCloudSystemPrompt` stays.

### 3.4 A reply with no tool call ends the turn

Delete `CLOUD_FORCE_TOOLS_PROMPT` and `looksLikeEmptyBuildPromise`, and delete the block at lines 399–416 that continues the loop when the prose matches build/create/write words.

No `done` tool. No injected "continue" message. Ask mode, plan mode, and agent mode all end when the reply contains no tool call. "Hi" is one reply. A coding request ends when the model stops calling tools, or at `maxIter`, whichever comes first. The model calls a tool in the same reply when the work needs one. The app does not invent a second turn.

### 3.5 Qwen 3.8 sampler on cipher-quality

Add `qwen38` to `generationProfiles.js` next to `qwen36`, citing `https://huggingface.co/Qwen/Qwen3.8-27B`:

```javascript
qwen38: profile(
  { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1.0 },
  { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1.0 },
  { source: 'https://huggingface.co/Qwen/Qwen3.8-27B', vendorDocSection: 'Thinking vs instruct' },
  { thinkTokens: { mode: 'budget', budget: 2048 }, reasoningEffort: 'xhigh' },
),
```

Do not pass this profile through `buildStructuredOutputSampling` for the cloud request. That helper would raise presence penalty and repeat penalty off the card.

In `cloudLLMService.js`, export:

```javascript
function secryptQualitySampling(thinkingOn) {
  const card = thinkingOn
    ? { temperature: 1.0, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1.0, reasoningEffort: 'xhigh' }
    : { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1.0, reasoningEffort: 'low' };
  return card;
}
```

`runCloudAgenticChat` `genBase`, when `isSecryptCloud` is true, spreads `secryptQualitySampling(thinkingOn)` over temperature, topP, topK, minP, presencePenalty, repeatPenalty, and reasoningEffort. Other cloud providers keep `settings.temperature` and `settings.topP`.

`_generateViaProxy` body adds, from `options`:

```javascript
top_p: options.topP,
top_k: options.topK,
min_p: options.minP,
presence_penalty: options.presencePenalty,
repeat_penalty: options.repeatPenalty,
chat_template_kwargs: {
  enable_thinking: thinkingOn,
  reasoning_effort: options.reasoningEffort || (thinkingOn ? 'xhigh' : 'low'),
  preserve_thinking: thinkingOn,
},
```

`temperature: options.temperature ?? 0.7` so a real zero is not replaced.

`Sidebar.jsx` reasoning buttons become `['low', 'medium', 'high', 'xhigh']`.

On `go`, read the handler for `POST /api/ai/proxy` on the host that serves graysoft.dev. If it drops `top_p`, `top_k`, `min_p`, `presence_penalty`, `repeat_penalty`, or `chat_template_kwargs`, add those fields to the llama-server request in that same handler. Do not invent a second proxy.

### 3.6 Tests

`tools/cloudTightPrompt.test.js`:

- Delete the `selectCloudToolDefs(..., 'build a file sharing website')` asserts (lines 31–33).
- Assert a defs list filtered by `{ read_file: true, browser_navigate: false }` keeps `read_file` and drops `browser_navigate` with no dependence on the user sentence.
- Assert `getCloudAgentSystemPrompt()` does not contain `Pattern —`.
- Assert `buildCloudSystemPrompt` of that identity plus `getToolPromptForTools` for a two-tool list contains both tool names.
- Keep the `cipher-quality` context assert at 24576.

`tools/secryptCloudModel.test.js` (or the tight-prompt test): `secryptQualitySampling(true)` equals temperature 1, topP 0.95, topK 20, minP 0, presencePenalty 0, repeatPenalty 1, reasoningEffort `xhigh`. `secryptQualitySampling(false)` equals the instruct card.

Do not change `assertAgentStructured` in `tools/samplingProfile.test.js`. Local agent sampling stays on that floor.

### 3.7 P40 power cap (not in the git tag)

Live limit is 180 W until reboot. Persist 180:

- `/etc/systemd/system/secrypt-gpu-power-cap.service`: `SECRYPT_GPU_POWER_LIMIT_W=150` becomes `180`
- `/home/brendan/secrypt-p40/scripts/gpu-power-cap.sh`: default `LIMIT_W` 150 becomes 180

`sudo -n nvidia-smi` works. `sudo -n` cannot edit those files. On `go`, write a one-shot unit or a sudoers-allowed script the operator can approve. Do not leave an interactive password prompt as the only step. After reboot, `nvidia-smi -q -d POWER` must show limit 180.00 W.

### 3.8 Edge cases

- Tools off (`toolsEnabled: false`) or ask mode: empty tool list. The reply is the whole turn.
- Plan mode: existing tool allow-list. A reply with no tool call ends the turn.
- A user who switches a tool off: that name is absent from the system prompt and from execution filtering. The model cannot call it through the prompt.
- A full catalog plus history that exceeds 24576: `fitCloudHistory` condenses older turns. It does not delete the tool section by the 14000-character cut, because that cut is removed.
- "Hi" in agent mode: one prose reply, then the turn ends. No tool is requested.
- Non-secrypt cloud providers: full enabled tools and the short cloud identity. Their sampler stays the settings the user set, plus the new proxy fields when the proxy is used.

## 4. Validation

Node tests in section 3.6 pass. `npm test` passes. `cd frontend && npm run build` passes.

A cloud agent request log shows one system prompt that contains `browser_navigate` when that toggle is on and the user message does not contain the word browser. The same request with that toggle off does not contain `browser_navigate`.

The proxy JSON for `cipher-quality` with thinking on contains temperature 1, top_p 0.95, top_k 20, min_p 0, presence_penalty 0, repeat_penalty 1, and `reasoning_effort` `xhigh`.

"Hi" in agent mode is one prose reply and the turn ends. A reply that calls `read_file` runs that tool and continues the loop. A later reply with no tool call ends the turn. Ask mode still ends on the first reply.

## 5. Execute order (frozen on `go`)

1. Backup the edited source files into a timestamped folder under the repo. Do not copy a database.
2. Apply sections 3.1–3.6 only. No extra prompt lines. No keyword list.
3. Bump `package.json` to `0.4.94`.
4. `npm test`. If the frontend changed, `cd frontend && npm run build`.
5. Commit, `git push` the release branch, `git tag v0.4.94`, `git push origin v0.4.94`.
6. `gh run list` and watch that run until `completed success`.
7. Persist the 180 W cap (section 3.7) on `secrypt-p40`.
8. Read the graysoft proxy handler and forward the sampler fields if they are dropped.

`go` runs this list. It does not reopen the prompt wording.
