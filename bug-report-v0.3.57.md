# Bug Report — v0.3.57 Test Session

**Date:** 2026-05-16  
**Tester:** Brendan Gray  
**Version:** v0.3.57  
**Models Tested:** Qwen3.5-4B-Q4_K_M, Qwen3.5-0.8B-Q8_0  

---

## BUG-1 — Vision Server Uses Wrong MMPROJ When Switching Models

### Summary
When switching from the 4B model to the 0.8B model, the vision server was started with the 4B model path and its mmproj file instead of the 0.8B model's mmproj.

### Log Evidence
```
[VisionServer] Model embedding_length: unknown (from Qwen3.5-4B-Q4_K_M.gguf)
[VisionServer] Found compatible mmproj: D:\models\qwen3.5\Qwen3.5-4B-GGUF\mmproj-Qwen3.5-4B-BF16.gguf

[VisionServer] Model embedding_length: unknown (from Qwen3.5-0.8B-Q8_0.gguf)
[VisionServer] Found compatible mmproj: D:\models\StaffPix\mmproj-F32.gguf

[VisionServer] Starting llama-server: ... -m D:\models\qwen3.5\Qwen3.5-4B-GGUF\Qwen3.5-4B-Q4_K_M.gguf
  --mmproj D:\models\qwen3.5\Qwen3.5-4B-GGUF\mmproj-Qwen3.5-4B-BF16.gguf ...
```

The 0.8B model's mmproj (`mmproj-F32.gguf`) was found during `checkAvailability()`, but `_ensureRunning()` started the server with the 4B model path.

### Code Evidence
`visionServer.js:253-269` — `_ensureRunning()` prioritizes `_lastCaptionArgs` over `_modelPath`/`_mmprojPath`:
```js
async _ensureRunning() {
  if (this._ready) return true;
  // Restart from previous start args (server was stopped after caption)
  if (this._lastCaptionArgs) {
    console.log('[VisionServer] Restarting vision server on demand...');
    const port = await this.start(this._lastCaptionArgs.modelPath, this._lastCaptionArgs.options);
    return port > 0;
  }
  // First start: use modelPath + mmprojPath stored during checkAvailability()
  ...
}
```

`_lastCaptionArgs` is set in `start()` at line 222-223 and is **never cleared** when `checkAvailability()` is called for a different model.

### Root Cause
`visionServer._lastCaptionArgs` persists across model switches. When a new model is loaded, `checkAvailability()` updates `_modelPath` and `_mmprojPath`, but `_ensureRunning()` uses `_lastCaptionArgs` first, which still points to the previous model.

### Impact
- Wrong model weights loaded for vision captioning
- mmproj/model mismatch can produce garbage captions or crash llama-server
- User cannot reliably use vision with multiple models in one session

### Fix
Clear `_lastCaptionArgs` in `checkAvailability()` when the model path changes.

---

## BUG-2 — 0.8B Model Wrote Logo Design Markdown Instead of Analyzing Image

### Summary
When given an image to analyze, the 0.8B model produced a logo design markdown file instead of simply describing the image in chat.

### Log Evidence
The model's response included:
```
Would you like me to:
- Create a new file describing this logo?
- Help you generate an image of this logo using AI tools?
- Analyze the codebase for any related files?
```

The vision system injected a detailed caption into the context, but the 0.8B model interpreted "analyze this image" as "create a design document about this image" and called `write_file`.

### Code Evidence
`chatEngine.js:611-612` — Attachment handling:
```js
this._recentlyWrittenFiles.clear(); // reset per chat() call
```

The SYSTEM_PROMPT (lines 133-231) does not explicitly tell the model NOT to write files when asked to analyze an image. The vision capability section (lines 216-217) says:
```
When the user attaches an image, your vision system automatically analyzes it...
```

But there is no rule saying "If the user asks you to analyze an image, describe it in chat. Do NOT write a file unless explicitly asked."

### Root Cause
Small models (0.8B) have weaker instruction following. Without an explicit rule in SYSTEM_PROMPT, the model defaults to its training behavior: when seeing an image + "analyze", it creates a document. The SYSTEM_PROMPT assumes the model will just chat about the image, but doesn't enforce this.

### Impact
- Small models waste tool calls writing unnecessary files
- User gets unexpected file creation instead of a simple description
- Breaks the "just analyze this image" use case for small models

### Fix
Add an explicit SYSTEM_PROMPT rule: "When the user attaches an image and asks you to analyze or describe it, respond in chat with your analysis. Do NOT write a file unless the user explicitly asks you to save the analysis to a file."

---

## BUG-3 — File Viewer Shows Empty Content for Newly Written Files

### Summary
When clicking a newly written file from either the "files changed" banner above chat or the file explorer, the editor viewport displays empty content even though the file has content on disk.

### Log Evidence
```
[ChatEngine] Tool #5 write_file executed in 611ms, success=true
[ChatEngine] Tool result for write_file: {"success":true,"path":"C:\\Users\\brend\\school\\file_sharing\\index.html","isNew":false}
```

The write succeeded. The file exists on disk with content.

### Code Evidence
**Frontend click handler** — `ChatPanel.jsx:2682-2712`:
```js
const res = await api.apiFetch(`/api/files/read?path=${encodeURIComponent(f.path)}`);
const data = await res.json();
if (data.content !== undefined) {
  useAppStore.getState().openFile({ path: f.path, content: data.content });
}
```

**openFile in appStore** — `appStore.js:165-191`:
```js
openFile: (fileInfo) => {
  const { openTabs } = get();
  const existing = openTabs.find(t => t.path === fileInfo.path);
  if (existing) {
    if (fileInfo.content !== undefined && fileInfo.content !== existing.content) {
      // update tab content
    } else {
      set({ activeTabId: existing.id }); // just activate, don't update
    }
    return;
  }
  // create new tab...
}
```

**Backend file read** — `electron-main.js:676-683`:
```js
if (p === '/api/files/read' && method === 'GET') {
  const filePath = q.path;
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(currentProjectPath || '', filePath);
  const content = fs.readFileSync(fullPath, 'utf8');
  return { content, path: fullPath, extension: ext, name: path.basename(fullPath) };
}
```

**Backend file write** — `electron-main.js:684-691`:
```js
fs.writeFileSync(fullPath, content || '', 'utf8');
```

### Root Cause Analysis
The `openFile` logic has a subtle bug: if the tab already exists and `fileInfo.content === existing.content`, it only activates the tab without updating. For a newly written file, the initial tab might have been opened with empty content (e.g., from a streaming file block or previous failed read). If the API then returns the correct content, but the `existing.content` is ALSO empty string (not undefined), then `'' !== ''` is false, and the tab is not updated.

Additionally, if the file was opened from the explorer without fetching content first (content=undefined), `openFile` just activates the existing tab. If that existing tab was opened with empty content, it stays empty.

### Impact
- User cannot view newly written files without closing the tab first
- Breaks the "click to view" workflow for AI-generated files
- Creates confusion about whether the file was actually written

### Fix
In `openFile` (appStore.js), always update tab content when `fileInfo.content !== undefined`, regardless of whether it matches `existing.content`. Also ensure explorer clicks fetch content before opening.

---

## BUG-4 — Thinking Bubbles Finalize Out of Chronological Order

### Summary
During streaming, thinking bubbles appear in correct chronological order (interleaved with text). But when the message finalizes, all thinking text collapses into a single block at the TOP of the message.

### Code Evidence
**Streaming rendering** — `ChatPanel.jsx:424-556` (StreamingFooter):
```jsx
{streamingSegments.map((seg, i) => {
  if (seg.type === 'text' && seg.content && seg.content.trim()) { ... }
  if (seg.type === 'thinking' && seg.content && seg.content.trim()) { ... }
  // thinking segments are interleaved with text segments
})}
```

**Finalized rendering** — `ChatPanel.jsx:2225-2232`:
```jsx
{msg.thinking && <FinalizedThinkingBlock text={msg.thinking} />}

{msg.segments && (msg.fileBlocks || msg.toolCalls) ? (
  msg.segments.map((seg, i) => { ... })
) : (
  <MarkdownRenderer content={msg.content} />
)}
```

**Message finalization** — `ChatPanel.jsx:1518-1533`:
```js
useAppStore.getState().addChatMessage({
  role: 'assistant',
  content: messageContent || '',
  segments: messageSegments.length > 0 ? messageSegments : undefined,
  fileBlocks: messageFileBlocks.length > 0 ? messageFileBlocks : undefined,
  toolCalls: hasToolCalls ? finalToolCalls : undefined,
  thinking: thinkingText || undefined,  // <-- ALL thinking text as a single string
});
```

### Root Cause
`msg.thinking` is a single string that aggregates ALL thinking text from the entire response. It is rendered at the top of the message (line 2228) before any segments. But during streaming, thinking was correctly interleaved with text via `streamingSegments`.

The message has `msg.segments` (which may or may not include thinking segments) and a separate `msg.thinking` field. The finalized view prioritizes `msg.thinking` at the top, destroying the chronological order.

### Impact
- User loses the chronological context of when the model thought vs wrote prose
- Makes it hard to follow the model's reasoning process on complex tasks
- Streaming and finalized views are inconsistent

### Fix
Instead of storing `thinking` as a single top-level string, include thinking as segments in `messageSegments` at the correct chronological positions. Remove the separate `msg.thinking` rendering path.

---

## BUG-5 — Model Got Stuck in a Loop

### Summary
The model repeatedly called `create_directory` many times in sequence, suggesting it entered a loop creating directories.

### Log Evidence
```
2026-05-17T00:27:04.820Z LOG   [ChatEngine] Tool #1 create_directory executed in 2ms, success=true
2026-05-17T00:27:05.973Z LOG   [ChatEngine] Tool #2 create_directory executed in 1ms, success=true
2026-05-17T00:27:27.618Z LOG   [ChatEngine] Tool #1 create_directory executed in 1ms, success=true
2026-05-17T00:27:29.785Z LOG   [ChatEngine] Tool #2 create_directory executed in 1ms, success=true
2026-05-17T00:27:32.058Z LOG   [ChatEngine] Tool #3 create_directory executed in 1ms, success=true
2026-05-17T00:27:34.292Z LOG   [ChatEngine] Tool #4 create_directory executed in 1ms, success=true
2026-05-17T00:27:36.523Z LOG   [ChatEngine] Tool #5 create_directory executed in 1ms, success=true
2026-05-17T00:27:38.881Z LOG   [ChatEngine] Tool #6 create_directory executed in 2ms, success=true
2026-05-17T00:27:41.233Z LOG   [ChatEngine] Tool #7 create_directory executed in 1ms, success=true
2026-05-17T00:27:43.542Z LOG   [ChatEngine] Tool #8 create_directory executed in 1ms, success=true
```

### Root Cause
Without the full user prompt, the exact cause is unclear. Possible explanations:
1. The model was building a directory structure and didn't receive clear feedback that directories already existed
2. The `create_directory` tool returns `{success:true}` even when the directory already exists, so the model keeps calling it
3. Context rotation or continuation may have caused the model to forget it already created directories
4. Small models (0.8B tested) are more prone to repetitive tool calling

### Impact
- Wastes inference time and tool execution cycles
- Model never completes the actual task
- User has to manually stop the generation

### Fix
This requires more investigation with the exact user prompt. Potential fixes:
- Make `create_directory` return `"already exists"` when the directory exists, so the model knows to stop
- Add a SYSTEM_PROMPT rule: "Do not create directories that already exist. Check with list_directory first."
- Consider this a model capability issue for 0.8B models, but the pipeline should still prevent infinite loops

---

## BUG-6 — Critical Crash: TypeError: g.content.trim is not a function

### Summary
The application crashed with a frontend error: `TypeError: g.content.trim is not a function`. This is a fatal React render error that stops the entire chat panel.

### Crash Evidence
```
TypeError: g.content.trim is not a function
    at _Y (file:///C:/Program%20Files/guIDE/resources/app/frontend/dist/assets/ChatPanel-ayLroauI.js:624:1879)
```

### Code Evidence
**Backend sends thinking tokens in two different formats:**

Raw text path — `chatEngine.js:987`:
```js
onStreamEvent('llm-thinking-token', {
  content: toEmit,
  position: _sfVisibleChars - toEmit.length
});
```

Native onResponseChunk path — `chatEngine.js:1382`:
```js
onStreamEvent('llm-thinking-token', chunk.text);
```

**Frontend receives without normalizing** — `App.jsx:129-131`:
```js
case 'llm-thinking-token':
  s.appendThinkingToken(data);
  break;
```

**appendThinkingToken does not validate type** — `appStore.js:645-666`:
```js
appendThinkingToken: (token) => {
  const store = get();
  const segs = store.streamingSegments;
  let newSegs;
  if (segs.length > 0 && segs[segs.length - 1].type === 'thinking') {
    newSegs = [...segs];
    const lastSeg = newSegs[newSegs.length - 1];
    newSegs[newSegs.length - 1] = { ...lastSeg, content: lastSeg.content + token };
  } else {
    // BUG: token could be an object here!
    newSegs = [...segs, { type: 'thinking', content: token }];
  }
  set({ ... });
}
```

**Crash site** — `ChatPanel.jsx:426` (and 448, 2236):
```js
if (seg.type === 'text' && seg.content && seg.content.trim()) { ... }
if (seg.type === 'thinking' && seg.content && seg.content.trim()) { ... }
```

### Root Cause
The `llm-thinking-token` IPC event sends either:
- An **object** `{ content: string, position: number }` from the raw text path
- A **string** `chunk.text` from the native onResponseChunk path

The frontend's `appendThinkingToken` always treats it as a string. When the raw text path fires and creates a new thinking segment, `seg.content` becomes the **object** instead of a string. Later, `seg.content.trim()` is called on this object, producing the crash.

`appendStreamToken` has a type guard (`typeof token !== 'string'`) at line 635, but `appendThinkingToken` has no such guard.

### Impact
- Fatal crash of the chat panel
- User loses the entire conversation state
- Requires app restart or "Try to Recover"

### Fix
Normalize the thinking token data in the backend so `llm-thinking-token` always sends a plain string. OR add a type guard in `appendThinkingToken` to extract `.content` if the token is an object.

---

## CROSS-CUTTING ISSUE — Object is Disposed Error

### Summary
Multiple `Object is disposed` errors appeared in the log, coinciding with the crash.

### Log Evidence
```
2026-05-17T00:32:40.619Z LOG   [ChatEngine] dispose START
2026-05-17T00:32:40.619Z LOG   [ChatEngine] _dispose START
2026-05-17T00:32:40.625Z LOG   [ChatEngine] dispose START
2026-05-17T00:32:40.625Z LOG   [ChatEngine] _dispose START
2026-05-17T00:32:41.493Z ERROR [ChatEngine] chat() CATCH: Error: Object is disposed
2026-05-17T00:32:41.494Z ERROR [electron-main] ai-chat local ERROR: Object is disposed
```

### Root Cause
The frontend crash (BUG-6) likely triggered React's error boundary or component unmount, which called `dispose()` on the ChatEngine. But the backend generation was still running, and subsequent token callbacks tried to use the disposed model/context, producing the `Object is disposed` error.

This is a **secondary effect** of BUG-6, not an independent bug.

---

## RECOMMENDED FIX PRIORITY

1. **BUG-6 (Crash)** — Highest priority. Fatal error stops the app.
2. **BUG-1 (Wrong mmproj)** — High priority. Wrong model for vision is silently broken.
3. **BUG-3 (Empty file viewer)** — High priority. Core IDE functionality broken.
4. **BUG-4 (Thinking order)** — Medium priority. UX issue, not fatal.
5. **BUG-2 (0.8B logo file)** — Medium priority. Model behavior, SYSTEM_PROMPT fix.
6. **BUG-5 (Loop)** — Lower priority. Needs more data to confirm root cause.
