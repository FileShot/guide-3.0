/**

 * Global Application State — Zustand store

 *

 * Single source of truth for the entire frontend. Manages:

 *   - Connection state (WebSocket)

 *   - Model state (loaded, loading, info)

 *   - Project state (path, file tree)

 *   - Editor state (open tabs, active file)

 *   - Chat state (messages, streaming)

 *   - Panel state (visible panels, sizes)

 *   - UI state (sidebar, activity bar, command palette)

 */

import { create } from 'zustand';

function _uiLog(msg) {
  try { window.electronAPI?.uiLog?.(String(msg)); } catch (_) {}
}



function canonicalizeStreamingFilePath(filePath) {

  if (!filePath) return '';



  const normalized = String(filePath)

    .trim()

    .replace(/\\/g, '/')

    .replace(/\/+/g, '/');



  if (!normalized) return '';

  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;

}



function findActiveStreamingFileBlockIndex(blocks, fileKey) {

  if (!Array.isArray(blocks) || blocks.length === 0) return -1;

  if (fileKey) {

    const keyedIdx = blocks.findIndex(b => b.fileKey === fileKey && !b.complete);

    if (keyedIdx !== -1) return keyedIdx;

  }

  for (let idx = blocks.length - 1; idx >= 0; idx--) {

    if (!blocks[idx].complete) return idx;

  }

  return -1;

}



const useAppStore = create((set, get) => ({

  // ─── Connection ────────────────────────────────────────

  connected: false,

  setConnected: (val) => set({ connected: val }),



  // ─── Model ─────────────────────────────────────────────

  modelLoaded: false,

  modelLoading: false,

  modelInfo: null,

  modelLoadProgress: 0,

  availableModels: [],

  setModelState: (state) => {

    set(state);

    // Initialize context ring on model load so it's visible immediately

    if (state.modelLoaded && state.modelInfo?.contextSize) {

      const current = useAppStore.getState().chatContextUsage;

      if (!current || current.total !== state.modelInfo.contextSize) {

        set({ chatContextUsage: { used: 0, total: state.modelInfo.contextSize } });

      }

    }

  },

  setAvailableModels: (models) => set({ availableModels: models }),



  // ─── Cloud Provider ───────────────────────────────────

  cloudProvider: null,

  cloudModel: null,

  setCloudProvider: (p) => set({ cloudProvider: p }),

  setCloudModel: (m) => set({ cloudModel: m }),



  // ─── Project ───────────────────────────────────────────

  projectPath: null,

  fileTree: [],

  fileTreeLoading: false,

  setProjectPath: (p) => {

    set({ projectPath: p, showWelcomeScreen: false });

    if (p) get().addRecentFolder(p);

  },

  setFileTree: (tree) => set({ fileTree: tree, fileTreeLoading: false }),

  setFileTreeLoading: (val) => set({ fileTreeLoading: val }),



  // ─── Editor Tabs ───────────────────────────────────────

  openTabs: [],       // [{id, path, name, extension, content, modified, language}]

  activeTabId: null,



  openFile: (fileInfo) => {

    const { openTabs } = get();

    const existing = openTabs.find(t => t.path === fileInfo.path);

    if (existing) {

      // If new content was provided, update the existing tab.
      // This fixes the bug where clicking a file from the keep/undo area
      // fetches fresh content via API but openFile() ignored it because
      // the tab already existed (e.g. from a streaming file block with empty content).
      if (fileInfo.content !== undefined && fileInfo.content !== existing.content) {
        const updated = openTabs.map(t => t.path === fileInfo.path ? {
          ...t,
          content: fileInfo.content,
          originalContent: fileInfo.content,
          modified: false,
        } : t);
        set({ openTabs: updated, activeTabId: existing.id });
      } else {
        set({ activeTabId: existing.id });
      }

      return;

    }

    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const tab = {

      id,

      path: fileInfo.path,

      name: fileInfo.name || fileInfo.path.split(/[\\/]/).pop(),

      extension: fileInfo.extension || fileInfo.path.split('.').pop(),

      content: fileInfo.content || '',

      originalContent: fileInfo.content || '',

      modified: false,

      language: _detectLanguage(fileInfo.extension || fileInfo.path.split('.').pop()),

    };

    set({ openTabs: [...openTabs, tab], activeTabId: id });

  },



  // R46-C: Open browser panel as an editor tab instead of sidebar

  openBrowserTab: () => {

    const { openTabs } = get();

    const existing = openTabs.find(t => t.type === 'browser');

    if (existing) {

      set({ activeTabId: existing.id });

      return;

    }

    const id = `tab-browser-${Date.now()}`;

    const tab = {

      id,

      type: 'browser',

      path: '__browser__',

      name: 'Browser',

      extension: '',

      content: '',

      modified: false,

    };

    set({ openTabs: [...openTabs, tab], activeTabId: id });

  },



  closeTab: (tabId) => {

    const { openTabs, activeTabId } = get();

    const idx = openTabs.findIndex(t => t.id === tabId);

    const newTabs = openTabs.filter(t => t.id !== tabId);

    let newActive = activeTabId;

    if (activeTabId === tabId) {

      if (newTabs.length === 0) {

        newActive = null;

      } else if (idx >= newTabs.length) {

        newActive = newTabs[newTabs.length - 1].id;

      } else {

        newActive = newTabs[idx].id;

      }

    }

    set({ openTabs: newTabs, activeTabId: newActive });

  },



  setActiveTab: (tabId) => set({ activeTabId: tabId }),



  updateTabContent: (tabId, content) => {

    const { openTabs } = get();

    set({

      openTabs: openTabs.map(t =>

        t.id === tabId

          ? { ...t, content, modified: content !== t.originalContent }

          : t

      ),

    });

  },



  markTabSaved: (tabId) => {

    const { openTabs } = get();

    set({

      openTabs: openTabs.map(t =>

        t.id === tabId

          ? { ...t, originalContent: t.content, modified: false }

          : t

      ),

    });

  },



  // R46-B: Preview request flag — Sidebar sets this when play button clicked,

  // EditorArea picks it up to activate preview mode on the newly opened tab

  previewRequested: false,

  setPreviewRequested: (val) => set({ previewRequested: val }),



  // ─── Chat ──────────────────────────────────────────────

  chatMessages: (() => {

    try {

      const saved = localStorage.getItem('guIDE-session-messages');

      if (saved) {

        const parsed = JSON.parse(saved);

        if (Array.isArray(parsed) && parsed.length > 0) return parsed;

      }

    } catch {}

    return [];

  })(),       // [{id, role, content, timestamp, toolCalls?, thinking?}]

  chatStreaming: false,

  chatStreamingText: '',

  chatThinkingText: '',

  chatGeneratingTool: null,  // {functionName, paramsText, done}

  chatContextUsage: null,    // {used, total}

  chatIteration: null,       // {iteration, maxIterations}

  streamingFileBlocks: [],   // [{filePath, language, fileName, content, complete}]

  activeStreamingFileKey: null,

  // R33-Phase4: Chronological segments for correct interleaving of text and file blocks

  streamingSegments: [],     // [{type:'text', content}, {type:'file', index}]

  // R39-A1: Live tool call tracking for ToolCallCard rendering during streaming

  streamingToolCalls: [],    // [{functionName, params, status, startTime, result, duration}]



  addChatMessage: (msg) => {

    console.log('[appStore] addChatMessage:', msg.role, msg.content?.substring(0, 50));

    const { chatMessages } = get();

    const updated = [...chatMessages, { ...msg, id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now() }];

    set({ chatMessages: updated });

    // Persist session — keep last 200 messages to avoid localStorage overflow

    try {

      const toSave = updated.length > 200 ? updated.slice(-200) : updated;

      localStorage.setItem('guIDE-session-messages', JSON.stringify(toSave));

    } catch {}

  },



  // Edit a user message in-place and truncate all messages after it

  editChatMessage: (messageId, newContent) => {

    const { chatMessages } = get();

    const idx = chatMessages.findIndex(m => m.id === messageId);

    if (idx === -1) return;

    const updated = [...chatMessages.slice(0, idx), { ...chatMessages[idx], content: newContent }];

    set({ chatMessages: updated });

    try {

      const toSave = updated.length > 200 ? updated.slice(-200) : updated;

      localStorage.setItem('guIDE-session-messages', JSON.stringify(toSave));

    } catch {}

    return updated;

  },



  setChatStreaming: (val) => {

    console.log('[appStore] setChatStreaming:', val);

    if (!val) {

      // R34: Flush any pending text token buffer before clearing streaming state

      const store = get();

      if (store._textTokenTimer) clearTimeout(store._textTokenTimer);

      if (store._textTokenBuffer) {

        const buf = store._textTokenBuffer;

        const newText = store.chatStreamingText + buf;

        const segs = store.streamingSegments;

        let newSegs;

        if (segs.length > 0 && segs[segs.length - 1].type === 'text') {

          newSegs = [...segs];

          const lastSeg = newSegs[newSegs.length - 1];

          newSegs[newSegs.length - 1] = { ...lastSeg, content: lastSeg.content + buf };

        } else {

          newSegs = [...segs, { type: 'text', content: buf }];

        }

        set({ chatStreamingText: newText, streamingSegments: newSegs, _textTokenBuffer: null, _textTokenTimer: null });

      }

    }

    // R56-Fix-A: Clear streaming state on BOTH true and false transitions.

    // Previously only cleared on false. Late-arriving IPC token events after

    // setChatStreaming(false) could write to chatStreamingText. When the next

    // response started with setChatStreaming(true), those stale tokens were

    // NOT cleared, causing previous response text to bleed into the new one.

    set({
      chatStreaming: val,
      chatStreamingText: '',
      chatThinkingText: '',
      chatGeneratingTool: null,
      streamingSegments: [],
      streamingToolCalls: [],
      streamingFileBlocks: [],
      activeStreamingFileKey: null,
      _textTokenBuffer: null,
      _textTokenTimer: null,
      _fileTokenBuffer: null,
      _fileTokenTimer: null,
    });

  },



  replaceLastStreamingChunk: (originalLength, replacement) => {

    const store = get();

    if (store._textTokenTimer) clearTimeout(store._textTokenTimer);

    let currentText = store.chatStreamingText;

    if (store._textTokenBuffer) {

      currentText += store._textTokenBuffer;

    }

    const keepLen = Math.max(0, currentText.length - originalLength);

    const newText = currentText.slice(0, keepLen) + (replacement || '');

    const segs = [...store.streamingSegments];

    for (let i = segs.length - 1; i >= 0; i--) {

      if (segs[i].type === 'text') {

        const segContent = segs[i].content;

        const segKeepLen = Math.max(0, segContent.length - originalLength);

        const newSegContent = segContent.slice(0, segKeepLen) + (replacement || '');

        if (newSegContent) {

          segs[i] = { ...segs[i], content: newSegContent };

        } else {

          segs.splice(i, 1);

        }

        break;

      }

    }

    set({

      chatStreamingText: newText,

      streamingSegments: segs,

      _textTokenBuffer: null,

      _textTokenTimer: null,

    });

  },



  appendStreamToken: (token) => {

    // R34: Batch text token appends — accumulate in buffer, flush every 80ms

    // This prevents 100+/sec set() calls that cause the Footer (and all children) to re-render.

    const store = get();

    if (!store.chatStreaming) {

      console.warn('[appStore] appendStreamToken called while chatStreaming=false, token=', token.substring(0, 30));

    }

    if (!store._textTokenBuffer) {

      store._textTokenBuffer = token;

      store._textTokenTimer = setTimeout(() => {

        const s = get();

        if (!s._textTokenBuffer) return;

        const buf = s._textTokenBuffer;

        const newText = s.chatStreamingText + buf;

        const segs = s.streamingSegments;

        let newSegs;

        if (segs.length > 0 && segs[segs.length - 1].type === 'text') {

          newSegs = [...segs];

          const lastSeg = newSegs[newSegs.length - 1];

          newSegs[newSegs.length - 1] = { ...lastSeg, content: lastSeg.content + buf };

        } else {

          newSegs = [...segs, { type: 'text', content: buf }];

        }

        set({ chatStreamingText: newText, streamingSegments: newSegs, _textTokenBuffer: null, _textTokenTimer: null });

      }, 80);

      set({ _textTokenBuffer: token, _textTokenTimer: store._textTokenTimer });

    } else {

      // Just accumulate — no state update, no re-render

      store._textTokenBuffer += token;

    }

    if (typeof token !== 'string') {

      console.error('[appStore] appendStreamToken: token is not string!', typeof token, token);

    }

  },



  appendThinkingToken: (token) => {

    const store = get();
    const segs = store.streamingSegments;
    let newSegs;

    // Defensive: backend may send object or string; normalize to string
    const tokenStr = typeof token === 'string' ? token : (token?.content || '');

    // Chronological thinking: create/append thinking segments in streamingSegments
    // so thinking blocks appear interleaved with prose, not all at the top.
    if (segs.length > 0 && segs[segs.length - 1].type === 'thinking') {
      newSegs = [...segs];
      const lastSeg = newSegs[newSegs.length - 1];
      newSegs[newSegs.length - 1] = { ...lastSeg, content: lastSeg.content + tokenStr };
    } else {
      // New thinking block — create a new segment (model started thinking again after prose)
      newSegs = [...segs, { type: 'thinking', content: tokenStr }];
    }

    set({
      chatThinkingText: store.chatThinkingText + tokenStr,
      streamingSegments: newSegs,
    });

  },



  setChatGeneratingTool: (tool) => set({ chatGeneratingTool: tool }),

  setChatContextUsage: (usage) => set({ chatContextUsage: usage }),

  setChatIteration: (iter) => set({ chatIteration: iter }),



  // R39-A1 + R40: Tool call tracking with segment interleaving

  addStreamingToolCall: (tc) => {

    console.log('[appStore] addStreamingToolCall:', tc?.functionName, tc?.status);

    // Flush pending text buffer before inserting tool segment (same pattern as startFileContentBlock)

    const store = get();

    if (store._textTokenTimer) clearTimeout(store._textTokenTimer);

    let currentText = store.chatStreamingText;

    let currentSegs = store.streamingSegments;

    if (store._textTokenBuffer) {

      const buf = store._textTokenBuffer;

      currentText = currentText + buf;

      if (currentSegs.length > 0 && currentSegs[currentSegs.length - 1].type === 'text') {

        currentSegs = [...currentSegs];

        const lastSeg = currentSegs[currentSegs.length - 1];

        currentSegs[currentSegs.length - 1] = { ...lastSeg, content: lastSeg.content + buf };

      } else {

        currentSegs = [...currentSegs, { type: 'text', content: buf }];

      }

    }

    const newToolCalls = [...store.streamingToolCalls, tc];

    const toolIndex = newToolCalls.length - 1;

    const newSegs = [...currentSegs, { type: 'tool', toolIndex }];

    set({

      streamingToolCalls: newToolCalls,

      streamingSegments: newSegs,

      chatStreamingText: currentText,

      _textTokenBuffer: null,

      _textTokenTimer: null,

    });

  },

  updateStreamingToolCall: (name, updates) => {

    console.log('[appStore] updateStreamingToolCall:', name, updates?.status);

    const { streamingToolCalls } = get();

    // Prefer matching a pending or generating call with this name (handles duplicates)

    let idx = streamingToolCalls.findIndex(tc => tc.functionName === name && (tc.status === 'pending' || tc.status === 'generating'));

    if (idx === -1) idx = streamingToolCalls.findIndex(tc => tc.functionName === name);

    if (idx === -1) {

      console.warn('[appStore] updateStreamingToolCall: no matching tool call for', name);

      return;

    }

    const updated = [...streamingToolCalls];

    updated[idx] = { ...updated[idx], ...updates };

    set({ streamingToolCalls: updated });

  },



  startFileContentBlock: ({ filePath, fileKey, language, fileName }) => {

    console.log('[appStore] startFileContentBlock:', fileKey || filePath);

    // R34: Flush pending text buffer before starting file block (ensures correct segment ordering)

    const store = get();

    const normalizedKey = fileKey || canonicalizeStreamingFilePath(filePath);

    if (store._textTokenTimer) clearTimeout(store._textTokenTimer);

    let currentText = store.chatStreamingText;

    let currentSegs = store.streamingSegments;

    if (store._textTokenBuffer) {

      const buf = store._textTokenBuffer;

      currentText = currentText + buf;

      if (currentSegs.length > 0 && currentSegs[currentSegs.length - 1].type === 'text') {

        currentSegs = [...currentSegs];

        const lastSeg = currentSegs[currentSegs.length - 1];

        currentSegs[currentSegs.length - 1] = { ...lastSeg, content: lastSeg.content + buf };

      } else {

        currentSegs = [...currentSegs, { type: 'text', content: buf }];

      }

    }

    // R37-Step4: If a block with the same filePath already exists, resume into it
    // instead of creating a new block. This prevents multiple blocks appearing
    // for the same file across continuation iterations.
    // FIX: Also resume into COMPLETE blocks — when the model re-writes the same file
    // in a continuation round, the previous block is complete, and without this check
    // a duplicate block+segment would be created, causing the file to render twice.
    const existingIdx = store.streamingFileBlocks.findIndex(b => b.fileKey === normalizedKey);

    if (existingIdx !== -1) {

      const existingBlock = store.streamingFileBlocks[existingIdx];

      if (existingBlock.complete) {
        // Previous write of this file is complete — reset it for the new write.
        // Keep the same block index so existing segment references stay valid.
        const updatedBlocks = [...store.streamingFileBlocks];
        updatedBlocks[existingIdx] = {
          ...existingBlock,
          content: '',
          complete: false,
        };
        set({
          activeStreamingFileKey: normalizedKey,
          streamingFileBlocks: updatedBlocks,
          chatStreamingText: currentText,
          streamingSegments: currentSegs,
          _textTokenBuffer: null,
          _textTokenTimer: null,
        });
      } else {
        // Block already exists and is still streaming — just update active key
        set({
          activeStreamingFileKey: normalizedKey,
          chatStreamingText: currentText,
          streamingSegments: currentSegs,
          _textTokenBuffer: null,
          _textTokenTimer: null,
        });
      }

      return;

    }

    const newBlocks = [...store.streamingFileBlocks, {

      filePath,

      fileKey: normalizedKey,

      language,

      fileName,

      content: '',

      complete: false,

    }];

    const newSegs = [...currentSegs, { type: 'file', index: newBlocks.length - 1 }];

    set({

      activeStreamingFileKey: normalizedKey,

      streamingFileBlocks: newBlocks,

      streamingSegments: newSegs,

      chatStreamingText: currentText,

      _textTokenBuffer: null,

      _textTokenTimer: null,

    });

  },

  appendFileContentToken: (chunk) => {

    // R33-Phase2: Batch token appends to reduce re-renders.

    // Instead of calling set() on every token (100+/sec → stuttering),

    // accumulate in a pending buffer and flush every 100ms (~10 renders/sec).

    const store = get();

    if (typeof chunk !== 'string') {

      console.error('[appStore] appendFileContentToken: chunk is not string!', typeof chunk, chunk);

    }

    const targetIdx = findActiveStreamingFileBlockIndex(store.streamingFileBlocks, store.activeStreamingFileKey);

    if (targetIdx === -1) return;

    if (!store._fileTokenBuffer) {

      store._fileTokenBuffer = chunk;

      store._fileTokenTimer = setTimeout(() => {

        const s = get();

        if (!s._fileTokenBuffer) return;

        const buf = s._fileTokenBuffer;

        const flushIdx = findActiveStreamingFileBlockIndex(s.streamingFileBlocks, s.activeStreamingFileKey);

        if (flushIdx === -1) {

          set({ _fileTokenBuffer: null, _fileTokenTimer: null });

          return;

        }

        const updated = [...s.streamingFileBlocks];

        const last = { ...updated[flushIdx] };

        last.content += buf;

        updated[flushIdx] = last;

        set({ streamingFileBlocks: updated, _fileTokenBuffer: null, _fileTokenTimer: null });

      }, 100);

      set({ _fileTokenBuffer: chunk, _fileTokenTimer: store._fileTokenTimer });

    } else {

      // Accumulate into existing buffer — no state update needed, just mutate

      set({ _fileTokenBuffer: store._fileTokenBuffer + chunk });

    }

  },

  /**
   * Atomically add a complete file block + segment in one set().
   * Used for native function-calling writes where start/token/end IPC events
   * can arrive in the same tick before React/Zustand flushes — the burst path
   * dropped content and left only ToolCallCard bubbles visible.
   */
  addCompleteFileContentBlock: ({ filePath, fileKey, language, fileName, content }) => {
    const store = get();
    const normalizedKey = fileKey || canonicalizeStreamingFilePath(filePath);
    if (!normalizedKey || content == null) return;

    if (store._textTokenTimer) clearTimeout(store._textTokenTimer);
    if (store._fileTokenTimer) clearTimeout(store._fileTokenTimer);

    let currentText = store.chatStreamingText;
    let currentSegs = store.streamingSegments;

    if (store._textTokenBuffer) {
      const buf = store._textTokenBuffer;
      currentText = currentText + buf;
      if (currentSegs.length > 0 && currentSegs[currentSegs.length - 1].type === 'text') {
        currentSegs = [...currentSegs];
        const lastSeg = currentSegs[currentSegs.length - 1];
        currentSegs[currentSegs.length - 1] = { ...lastSeg, content: lastSeg.content + buf };
      } else {
        currentSegs = [...currentSegs, { type: 'text', content: buf }];
      }
    }

    const existingIdx = store.streamingFileBlocks.findIndex(
      b => b.fileKey === normalizedKey,
    );
    let newBlocks;
    let fileIndex;

    if (existingIdx !== -1) {
      newBlocks = [...store.streamingFileBlocks];
      newBlocks[existingIdx] = {
        ...newBlocks[existingIdx],
        content: String(content),
        complete: true,
      };
      fileIndex = existingIdx;
    } else {
      newBlocks = [
        ...store.streamingFileBlocks,
        {
          filePath,
          fileKey: normalizedKey,
          language,
          fileName,
          content: String(content),
          complete: true,
        },
      ];
      fileIndex = newBlocks.length - 1;
      currentSegs = [...currentSegs, { type: 'file', index: fileIndex }];
    }

    console.log('[appStore] addCompleteFileContentBlock:', normalizedKey, `(${String(content).length} chars)`);

    set({
      streamingFileBlocks: newBlocks,
      streamingSegments: currentSegs,
      chatStreamingText: currentText,
      activeStreamingFileKey: null,
      _textTokenBuffer: null,
      _textTokenTimer: null,
      _fileTokenBuffer: null,
      _fileTokenTimer: null,
    });
  },

  endFileContentBlock: (payload) => {

    console.log('[appStore] endFileContentBlock:', payload?.fileKey || payload?.filePath);

    // R33-Phase2: Flush any pending buffered tokens before marking complete

    const store = get();

    const targetKey = payload?.fileKey || canonicalizeStreamingFilePath(payload?.filePath) || store.activeStreamingFileKey;

    if (store._fileTokenTimer) {

      clearTimeout(store._fileTokenTimer);

    }

    const { streamingFileBlocks } = store;

    if (streamingFileBlocks.length === 0) {

      set({ activeStreamingFileKey: null, _fileTokenBuffer: null, _fileTokenTimer: null });

      return;

    }

    const targetIdx = findActiveStreamingFileBlockIndex(streamingFileBlocks, targetKey);

    if (targetIdx === -1) {

      set({ activeStreamingFileKey: null, _fileTokenBuffer: null, _fileTokenTimer: null });

      return;

    }

    const updated = [...streamingFileBlocks];

    const last = { ...updated[targetIdx] };

    if (store._fileTokenBuffer) {

      last.content += store._fileTokenBuffer;

    }

    last.complete = true;

    updated[targetIdx] = last;

    set({ activeStreamingFileKey: null, streamingFileBlocks: updated, _fileTokenBuffer: null, _fileTokenTimer: null });

  },

  // R37-Step8: Expanded state for file content blocks, keyed by filePath.

  // Lives in the store so it survives component unmount/remount during streaming iterations.

  fileBlockExpandedStates: {},

  setFileBlockExpanded: (key, val) => set(s => ({

    fileBlockExpandedStates: { ...s.fileBlockExpandedStates, [key]: val }

  })),

  // Plan F: per-file lint errors emitted by backend after write_file/edit_file

  fileLintErrors: {},

  setFileLintErrors: (filePath, data) => set(s => ({

    fileLintErrors: { ...s.fileLintErrors, [filePath]: data }

  })),

  clearFileLintErrors: () => set({ fileLintErrors: {} }),



  clearFileContentBlocks: () => {

    const store = get();

    if (store._fileTokenTimer) clearTimeout(store._fileTokenTimer);

    if (store._textTokenTimer) clearTimeout(store._textTokenTimer);

    set({ activeStreamingFileKey: null, streamingFileBlocks: [], streamingSegments: [], _fileTokenBuffer: null, _fileTokenTimer: null, _textTokenBuffer: null, _textTokenTimer: null });

  },

  // R27-D: Update file block content with full accumulated content from append operations

  updateFileBlockContent: ({ filePath, fileKey, fullContent }) => {

    const { streamingFileBlocks } = get();

    if (streamingFileBlocks.length === 0) return;

    const updated = [...streamingFileBlocks];

    // Find the block matching this filePath, or fall back to last block

    const normalizedKey = fileKey || canonicalizeStreamingFilePath(filePath);

    let idx = updated.findIndex(b => b.fileKey === normalizedKey);

    if (idx === -1) idx = findActiveStreamingFileBlockIndex(updated, normalizedKey);

    if (idx === -1) return;

    updated[idx] = { ...updated[idx], content: fullContent };

    set({ streamingFileBlocks: updated });

  },



  clearChat: () => {

    console.log('[appStore] clearChat');

    const store = get();

    if (store._fileTokenTimer) clearTimeout(store._fileTokenTimer);

    if (store._textTokenTimer) clearTimeout(store._textTokenTimer);

    try { localStorage.removeItem('guIDE-session-messages'); } catch {}

    set({

      chatMessages: [],

      chatStreaming: false,

      chatStreamingText: '',

      chatThinkingText: '',

      chatGeneratingTool: null,

      chatContextUsage: null,

      chatIteration: null,

      chatFilesChanged: [],

      activeStreamingFileKey: null,

      streamingFileBlocks: [],

      streamingSegments: [],

      messageQueue: [],

      todos: [],

      _fileTokenBuffer: null, _fileTokenTimer: null,

      _textTokenBuffer: null, _textTokenTimer: null,

    });

  },



  // ─── Files Changed (by AI) ────────────────────────────

  chatFilesChanged: [], // [{path, name, linesAdded, linesRemoved}]

  setChatFilesChanged: (files) => set({ chatFilesChanged: files }),

  addChatFileChanged: (file) => set(s => {

    const existing = s.chatFilesChanged.find(f => f.path === file.path);

    if (existing) {

      return {

        chatFilesChanged: s.chatFilesChanged.map(f =>

          f.path === file.path

            ? { ...f, linesAdded: file.linesAdded || 0, linesRemoved: file.linesRemoved || 0 }

            : f

        ),

      };

    }

    return { chatFilesChanged: [...s.chatFilesChanged, file] };

  }),



  // ─── Chat Attachments ─────────────────────────────────

  chatAttachments: [], // [{id, name, type, url, size}]

  addChatAttachment: (attachment) => set(s => ({

    chatAttachments: [...s.chatAttachments, { ...attachment, id: Date.now() + Math.random() }],

  })),

  removeChatAttachment: (id) => set(s => ({

    chatAttachments: s.chatAttachments.filter(a => a.id !== id),

  })),

  clearChatAttachments: () => set({ chatAttachments: [] }),



  // ─── Conversation Branching ─────────────────────────────

  chatBranches: [],        // [{id, label, messages, timestamp}]

  activeBranchId: null,

  branchChat: (label) => {

    const { chatMessages } = get();

    const id = `branch-${Date.now()}`;

    const branch = {

      id,

      label: label || `Branch ${get().chatBranches.length + 1}`,

      messages: JSON.parse(JSON.stringify(chatMessages)),

      timestamp: Date.now(),

    };

    set(s => ({ chatBranches: [...s.chatBranches, branch], activeBranchId: id }));

  },

  restoreBranch: (branchId) => {

    const { chatBranches } = get();

    const branch = chatBranches.find(b => b.id === branchId);

    if (!branch) return;

    // Save current state as a branch before restoring

    const { chatMessages } = get();

    const currentBranch = chatBranches.find(b => b.id === get().activeBranchId);

    if (currentBranch && currentBranch.messages !== chatMessages) {

      currentBranch.messages = JSON.parse(JSON.stringify(chatMessages));

    }

    set({

      chatMessages: JSON.parse(JSON.stringify(branch.messages)),

      activeBranchId: branchId,

      chatStreaming: false,

      chatStreamingText: '',

      chatThinkingText: '',

    });

  },

  deleteBranch: (branchId) => set(s => ({

    chatBranches: s.chatBranches.filter(b => b.id !== branchId),

    activeBranchId: s.activeBranchId === branchId ? null : s.activeBranchId,

  })),



  // ─── Task Runner ────────────────────────────────────────

  taskScripts: [],        // [{name, command}] from package.json scripts

  taskScriptsLoading: false,

  runningTasks: [],       // [{name, pid, startTime}]

  loadTaskScripts: async () => {

    const projectPath = get().projectPath;

    if (!projectPath) return;

    set({ taskScriptsLoading: true });

    try {

      const r = await fetch(`/api/files/read?path=${encodeURIComponent(projectPath + '/package.json')}`);

      const data = await r.json();

      if (data.success && data.content) {

        const pkg = JSON.parse(data.content);

        const scripts = Object.entries(pkg.scripts || {}).map(([name, command]) => ({ name, command }));

        set({ taskScripts: scripts, taskScriptsLoading: false });

      } else {

        set({ taskScripts: [], taskScriptsLoading: false });

      }

    } catch (_) {

      set({ taskScripts: [], taskScriptsLoading: false });

    }

  },

  runTaskScript: (scriptName) => {

    const api = window.electronAPI;

    if (api?.terminal) {

      const projectPath = get().projectPath || '';

      const escaped = projectPath.replace(/"/g, '\\"');

      // Find or create a terminal and run the script

      api.terminal.create({ cwd: projectPath }).then(id => {

        if (id) api.terminal.write(id, `npm run ${scriptName}\r`);

      }).catch(() => {

        // Fallback: write to existing terminal

        const termTabs = get().terminalTabs;

        if (termTabs.length > 0) {

          api.terminal.write(termTabs[0].id, `npm run ${scriptName}\r`);

        }

      });

    }

  },



  // ─── Message Queue ────────────────────────────────────

  messageQueue: [], // [{id, text}]

  addQueuedMessage: (text) => set(s => ({

    messageQueue: [...s.messageQueue, { id: Date.now() + Math.random(), text }],

  })),

  removeQueuedMessage: (id) => set(s => ({

    messageQueue: s.messageQueue.filter(m => m.id !== id),

  })),

  updateQueuedMessage: (id, text) => set(s => ({

    messageQueue: s.messageQueue.map(m => m.id === id ? { ...m, text } : m),

  })),

  clearMessageQueue: () => set({ messageQueue: [] }),



  // ─── Diff Viewer ──────────────────────────────────────

  diffState: null, // { original, modified, title } or null

  openDiff: (original, modified, title) => set({ diffState: { original, modified, title } }),

  closeDiff: () => set({ diffState: null }),



  // ─── MCP Servers ──────────────────────────────────────

  mcpServers: JSON.parse(localStorage.getItem('guIDE-mcp-servers') || '[]'),

  addMcpServer: (server) => set(s => {

    const servers = [...s.mcpServers, { ...server, id: Date.now(), enabled: true }];

    localStorage.setItem('guIDE-mcp-servers', JSON.stringify(servers));

    return { mcpServers: servers };

  }),

  removeMcpServer: (id) => set(s => {

    const servers = s.mcpServers.filter(sv => sv.id !== id);

    localStorage.setItem('guIDE-mcp-servers', JSON.stringify(servers));

    return { mcpServers: servers };

  }),

  toggleMcpServer: (id) => set(s => {

    const servers = s.mcpServers.map(sv => sv.id === id ? { ...sv, enabled: !sv.enabled } : sv);

    localStorage.setItem('guIDE-mcp-servers', JSON.stringify(servers));

    return { mcpServers: servers };

  }),



  // ─── Todo List (from AI) ───────────────────────────────

  todos: [],

  setTodos: (todos) => set({ todos }),



  // ─── Pending Question (from ask_question tool) ────────

  pendingQuestion: null, // { question, options, allowMultiple }

  setPendingQuestion: (q) => set({ pendingQuestion: q }),

  clearPendingQuestion: () => set({ pendingQuestion: null }),

  // ─── Pending Permission Request (from execution policy) ──
  pendingPermission: null, // { id, toolName, params, reason }
  setPendingPermission: (req) => set({ pendingPermission: req }),
  clearPendingPermission: () => set({ pendingPermission: null }),
  respondPermission: (reqId, approved) => {
    set({ pendingPermission: null });
    window.electronAPI?.respondPermission?.(reqId, approved);
  },

  // ─── VRAM Warning (statusbar-only, not intrusive overlay) ──

  vramWarning: '',

  setVramWarning: (msg) => set({ vramWarning: msg }),

  clearVramWarning: () => set({ vramWarning: '' }),



  // ─── Panels & Layout ───────────────────────────────────

  sidebarVisible: true,

  sidebarWidth: 260,

  panelVisible: true,

  panelHeight: 200,

  chatPanelVisible: true,

  chatPanelWidth: 380,

  zoomLevel: 1,

  activeActivity: 'explorer', // 'explorer' | 'search' | 'git' | 'chat' | 'extensions' | 'settings'

  activePanelTab: 'terminal', // 'terminal' | 'output' | 'problems'



  // ─── Extensions ────────────────────────────────────────

  extensions: [],

  extensionCategories: ['all'],

  extensionsLoading: false,

  setExtensions: (list) => set({ extensions: list }),

  setExtensionCategories: (cats) => set({ extensionCategories: cats }),

  setExtensionsLoading: (val) => set({ extensionsLoading: val }),



  // ─── Debug ─────────────────────────────────────────────

  debugSessionId: null,

  debugSessionState: 'inactive', // 'inactive' | 'running' | 'paused' | 'stopped'

  debugStackFrames: [],

  debugScopes: [],

  debugVariables: {},     // { [ref]: [...variables] }

  debugOutput: [],        // string[]

  debugError: null,



  setDebugSession: (id, state) => set({ debugSessionId: id, debugSessionState: state || 'running' }),

  clearDebugSession: () => set({

    debugSessionId: null, debugSessionState: 'inactive',

    debugStackFrames: [], debugScopes: [], debugVariables: {}, debugError: null,

  }),

  setDebugStackFrames: (frames) => set({ debugStackFrames: frames }),

  setDebugScopes: (scopes) => set({ debugScopes: scopes }),

  setDebugVariables: (ref, vars) => set(s => ({

    debugVariables: { ...s.debugVariables, [ref]: vars },

  })),

  addDebugOutput: (text) => set(s => {

    const next = [...s.debugOutput, text];

    return { debugOutput: next.length > 500 ? next.slice(-500) : next };

  }),

  clearDebugOutput: () => set({ debugOutput: [] }),

  setDebugError: (err) => set({ debugError: err }),



  handleDebugEvent: (data) => {

    const s = get();

    switch (data.event) {

      case 'initialized':

        s.addDebugOutput('--- Debug session initialized ---\n');

        break;

      case 'stopped':

        set({ debugSessionState: 'paused' });

        // Auto-fetch stack trace

        if (s.debugSessionId) {

          fetch(`/api/debug/stackTrace?sessionId=${s.debugSessionId}`)

            .then(r => r.json())

            .then(d => { if (d.success) set({ debugStackFrames: d.stackFrames || [] }); })

            .catch(() => {});

        }

        break;

      case 'continued':

        set({ debugSessionState: 'running', debugStackFrames: [], debugScopes: [], debugVariables: {} });

        break;

      case 'terminated':

        s.addDebugOutput(`\n--- Debug session ended (exit code: ${data.exitCode ?? 0}) ---\n`);

        set({ debugSessionId: null, debugSessionState: 'stopped' });

        break;

      case 'output':

        if (data.output) s.addDebugOutput(data.output);

        break;

    }

  },



  // TODO highlighting

  todoItems: [],

  todoLoading: false,

  setTodoItems: (items) => set({ todoItems: items }),

  setTodoLoading: (v) => set({ todoLoading: v }),

  scanTodos: async () => {

    set({ todoLoading: true });

    try {

      const r = await fetch('/api/todos/scan', { method: 'POST' });

      const data = await r.json();

      if (data.todos) set({ todoItems: data.todos });

    } catch (_) {}

    set({ todoLoading: false });

  },



  toggleSidebar: () => set(s => ({ sidebarVisible: !s.sidebarVisible })),

  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(600, w)) }),

  togglePanel: () => set(s => ({ panelVisible: !s.panelVisible })),

  setPanelHeight: (h) => set({ panelHeight: Math.max(100, Math.min(600, h)) }),

  toggleChatPanel: () => set(s => ({ chatPanelVisible: !s.chatPanelVisible })),

  setChatPanelWidth: (w) => set({ chatPanelWidth: Math.max(300, Math.min(800, w)) }),

  setZoomLevel: (z) => set({ zoomLevel: z }),

  zoomIn: () => set(s => ({ zoomLevel: Math.min(2, +(s.zoomLevel + 0.1).toFixed(1)) })),

  zoomOut: () => set(s => ({ zoomLevel: Math.max(0.5, +(s.zoomLevel - 0.1).toFixed(1)) })),

  zoomReset: () => set({ zoomLevel: 1 }),

  setActiveActivity: (a) => set(s => {

    if (s.activeActivity === a && s.sidebarVisible) {

      return { sidebarVisible: false };

    }

    return { activeActivity: a, sidebarVisible: true };

  }),

  setActivePanelTab: (t) => set({ activePanelTab: t }),



  // ─── Command Palette ───────────────────────────────────

  commandPaletteOpen: false,

  toggleCommandPalette: () => set(s => ({ commandPaletteOpen: !s.commandPaletteOpen })),

  closeCommandPalette: () => set({ commandPaletteOpen: false }),



  // ─── Notifications ─────────────────────────────────────

  notifications: [],

  addNotification: (notification) => {

    const id = `notif-${Date.now()}`;

    const { notifications } = get();

    set({ notifications: [...notifications, { ...notification, id }] });

    // Auto-dismiss after 5s

    setTimeout(() => {

      const { notifications: current } = get();

      set({ notifications: current.filter(n => n.id !== id) });

    }, notification.duration || 5000);

  },

  dismissNotification: (id) => {

    const { notifications } = get();

    set({ notifications: notifications.filter(n => n.id !== id) });

  },



  // ─── Terminal Output ───────────────────────────────────

  terminalOutput: [],

  appendTerminalOutput: (line) => {

    const { terminalOutput } = get();

    const newOutput = [...terminalOutput, line];

    if (newOutput.length > 5000) newOutput.splice(0, newOutput.length - 5000);

    set({ terminalOutput: newOutput });

  },

  clearTerminalOutput: () => set({ terminalOutput: [] }),



  // ─── LLM Status ────────────────────────────────────────

  llmStatus: null,

  setLlmStatus: (status) => set({ llmStatus: status }),



  // ─── GPU Info ──────────────────────────────────────────

  gpuInfo: null,

  setGpuInfo: (info) => set({ gpuInfo: info }),



  // ─── Settings ──────────────────────────────────────────

  settings: (() => {

    const DEFAULTS = {

      // LLM / Inference

      temperature: 0.4,
      _defaultTemperature: 0.4,

      maxResponseTokens: 0, // 0 = auto (use all available context space)

      contextSize: 0,

      topP: 0.95,

      topK: 40,

      repeatPenalty: 1.1,
      _defaultRepeatPenalty: 1.1,

      seed: -1,

      // Thinking & Reasoning

      thinkingBudget: 2048,     // 0 = auto (node-llama-cpp default), -1 = unlimited, >0 = exact cap

      reasoningEffort: 'medium', // 'low' | 'medium' | 'high'

      // Agentic Behavior

      maxIterations: 25,

      generationTimeoutSec: 0,

      snapshotMaxChars: 8000,

      enableThinkingFilter: false,

      enableGrammar: false,

      enableNativeFC: false,

      autoLintFix: true,       // Plan F: auto-inject lint correction after file writes

      enableSubAgents: false,  // Plan G: allow model to spawn isolated sub-agents

      // System Prompt

      systemPrompt: '',

      customInstructions: '',

      guideInstructionsPath: '',  // Path to .guide-instructions.md file

      // Hardware

      gpuPreference: 'auto',    // 'auto' | 'cpu'

      gpuLayers: -1,            // -1 = auto

      requireMinContextForGpu: false,
      vramBalance: 'balanced',

      kvCacheType: 'q4_0',      // 'f16' | 'q8_0' | 'q4_0' | 'q3_0' | 'q4_1' | 'off' — lower = more context, less precision

      // Command execution
      commandShell: 'powershell', // Windows default for run_command: 'powershell' | 'cmd'

      // Editor

      fontSize: 14,

      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",

      tabSize: 2,

      wordWrap: 'on',

      minimap: true,

      lineNumbers: 'on',

      bracketPairColorization: true,

      formatOnPaste: false,

      formatOnType: false,

    };

    try {

      const stored = JSON.parse(localStorage.getItem('guIDE-settings') || '{}');

      return { ...DEFAULTS, ...stored };

    } catch { return DEFAULTS; }

  })(),

  settingsSyncStatus: 'idle', // 'idle' | 'saving' | 'saved' | 'error'

  settingsSyncError: null,

  settingsLastSyncedAt: null,

  /** Skip App.jsx debounced settings POST until this timestamp (after updateSetting or model-load sync). */
  settingsSkipDebounceUntil: 0,

  setSettingsSyncState: (state) => set({

    settingsSyncStatus: state.status ?? 'idle',

    settingsSyncError: state.error ?? null,

    settingsLastSyncedAt: state.at ?? null,

  }),

  setSettings: (s) => {

    localStorage.setItem('guIDE-settings', JSON.stringify(s));

    set({ settings: s });

  },

  updateSetting: (key, value) => {
    const t0 = Date.now();
    _uiLog(`updateSetting START key=${key} value=${JSON.stringify(value)}`);
    const next = { ...get().settings, [key]: value };
    let json = '';
    try {
      json = JSON.stringify(next);
      _uiLog(`updateSetting before localStorage jsonLen=${json.length}`);
      localStorage.setItem('guIDE-settings', json);
      _uiLog(`updateSetting after localStorage ms=${Date.now() - t0}`);
    } catch (e) {
      _uiLog(`updateSetting localStorage ERROR ${e.message}`);
    }
    set({ settings: next, settingsSkipDebounceUntil: Date.now() + 2000 });
    get().setSettingsSyncState({ status: 'saving', at: Date.now() });
    _uiLog(`updateSetting before fetch POST key=${key}`);
    return fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json || JSON.stringify(next),
    }).then(r => {
      if (!r.ok) throw new Error(`Settings save failed (${r.status})`);
      return r.json();
    }).then(() => {
      _uiLog(`updateSetting fetch OK key=${key} ms=${Date.now() - t0}`);
      get().setSettingsSyncState({ status: 'saved', at: Date.now() });
    }).catch(e => {
      _uiLog(`updateSetting fetch ERROR key=${key} ${e.message} ms=${Date.now() - t0}`);
      get().setSettingsSyncState({ status: 'error', error: e.message, at: Date.now() });
      throw e;
    }).finally(() => {
      _uiLog(`updateSetting END ms=${Date.now() - t0}`);
    });
  },

  resetSettings: () => {

    const DEFAULTS = {

      temperature: 0.4, maxResponseTokens: 0, contextSize: 0,

      topP: 0.95, topK: 40, repeatPenalty: 1.1, seed: -1,

      thinkingBudget: 2048, reasoningEffort: 'medium',

      maxIterations: 0, generationTimeoutSec: 0, snapshotMaxChars: 8000,

      enableThinkingFilter: false, enableGrammar: false,

      enableNativeFC: false,

      autoLintFix: true, enableSubAgents: false,

      commandShell: 'powershell',

      kvCacheType: 'q4_0',

      systemPrompt: '', customInstructions: '', guideInstructionsPath: '',

      gpuPreference: 'auto', gpuLayers: -1, requireMinContextForGpu: false, vramBalance: 'balanced',

      fontSize: 14, fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",

      tabSize: 2, wordWrap: 'on', minimap: true, lineNumbers: 'on',

      bracketPairColorization: true, formatOnPaste: false, formatOnType: false,

    };

    localStorage.setItem('guIDE-settings', JSON.stringify(DEFAULTS));

    set({ settings: DEFAULTS });

  },



  // ─── Editor Cursor ─────────────────────────────────────

  editorCursorPosition: { line: 1, column: 1 },

  setEditorCursorPosition: (pos) => set({ editorCursorPosition: pos }),



  // ─── Editor Selection ────────────────────────────────

  editorSelection: null, // { chars: number, lines: number } or null

  setEditorSelection: (sel) => set({ editorSelection: sel }),



  // ─── Editor Format ────────────────────────────────────

  editorEol: 'LF',

  setEditorEol: (v) => set({ editorEol: v }),

  editorEncoding: 'UTF-8',

  setEditorEncoding: (v) => set({ editorEncoding: v }),

  editorIndentSize: 2,

  setEditorIndentSize: (v) => set({ editorIndentSize: v }),

  editorIndentType: 'spaces',

  setEditorIndentType: (v) => set({ editorIndentType: v }),



  // ─── Editor Diagnostics ────────────────────────────────

  editorDiagnostics: { errors: 0, warnings: 0 },

  setEditorDiagnostics: (d) => set({ editorDiagnostics: d }),



  // ─── Symbol Outline ────────────────────────────────────

  symbolOutline: [],       // [{name, kind, line, indent}]

  setSymbolOutline: (symbols) => set({ symbolOutline: symbols }),



  // ─── Git Branch ────────────────────────────────────────

  gitBranch: 'main',

  setGitBranch: (b) => set({ gitBranch: b }),



  // ─── Git File Statuses ────────────────────────────────

  gitFileStatuses: {}, // { [relativePath]: 'M' | 'A' | '?' | 'D' }

  setGitFileStatuses: (statuses) => set({ gitFileStatuses: statuses }),



  // ─── Global Search ─────────────────────────────────────

  searchQuery: '',

  searchResults: [],       // [{file, line, column, text, matchLength}]

  searchLoading: false,

  setSearchQuery: (q) => set({ searchQuery: q }),

  setSearchResults: (results) => set({ searchResults: results, searchLoading: false }),

  setSearchLoading: (val) => set({ searchLoading: val }),



  // ─── Dialogs ───────────────────────────────────────────

  showNewProjectDialog: false,

  setShowNewProjectDialog: (v) => set({ showNewProjectDialog: v }),



  // ─── Welcome Screen ───────────────────────────────────

  showWelcomeScreen: true,

  setShowWelcomeScreen: (v) => set({ showWelcomeScreen: v }),



  // ─── Welcome Guide ────────────────────────────────────

  showWelcomeGuide: !localStorage.getItem('guIDE-hide-welcome-guide'),

  setShowWelcomeGuide: (v) => set({ showWelcomeGuide: v }),

  dismissWelcomeGuideForever: () => {

    localStorage.setItem('guIDE-hide-welcome-guide', 'true');

    set({ showWelcomeGuide: false });

  },



  // ─── Recent Folders ────────────────────────────────────

  recentFolders: JSON.parse(localStorage.getItem('guIDE-recent-folders') || '[]'),

  addRecentFolder: (folderPath) => set(s => {

    const filtered = s.recentFolders.filter(p => p !== folderPath);

    const updated = [folderPath, ...filtered].slice(0, 10);

    localStorage.setItem('guIDE-recent-folders', JSON.stringify(updated));

    return { recentFolders: updated };

  }),



  // ─── Default Model ────────────────────────────────────

  defaultModelPath: localStorage.getItem('guIDE-default-model') || null,

  setDefaultModelPath: (path) => {

    if (path) localStorage.setItem('guIDE-default-model', path);

    else localStorage.removeItem('guIDE-default-model');

    set({ defaultModelPath: path });

  },



  // ─── Tool Toggles ─────────────────────────────────────

  enabledTools: JSON.parse(localStorage.getItem('guIDE-enabled-tools') || '{}'),

  toggleTool: (name) => set(s => {

    const updated = { ...s.enabledTools, [name]: !(s.enabledTools[name] ?? true) };

    localStorage.setItem('guIDE-enabled-tools', JSON.stringify(updated));

    return { enabledTools: updated };

  }),

  setEnabledTools: (tools) => {

    localStorage.setItem('guIDE-enabled-tools', JSON.stringify(tools));

    set({ enabledTools: tools });

  },



  // ─── Token Stats ───────────────────────────────────────

  tokenStats: null,

  setTokenStats: (stats) => set({ tokenStats: stats }),



  // ─── GPU Memory ────────────────────────────────────────

  gpuMemory: null,

  setGpuMemory: (mem) => set({ gpuMemory: mem }),



  // ─── App Version (single source of truth — pulled from package.json via IPC) ───

  appVersion: '',

  setAppVersion: (v) => set({ appVersion: String(v || '') }),



  // ─── Model Downloads ──────────────────────────────────

  modelDownloads: {},

  updateModelDownload: (id, data) => set(s => ({

    modelDownloads: { ...s.modelDownloads, [id]: data },

  })),

  removeModelDownload: (id) => set(s => {

    const next = { ...s.modelDownloads };

    delete next[id];

    return { modelDownloads: next };

  }),



  // ─── Model Favorites ──────────────────────────────────

  favoriteModels: JSON.parse(localStorage.getItem('guIDE-favorite-models') || '[]'),

  toggleFavoriteModel: (modelPath) => set(s => {

    const favs = s.favoriteModels.includes(modelPath)

      ? s.favoriteModels.filter(p => p !== modelPath)

      : [...s.favoriteModels, modelPath];

    localStorage.setItem('guIDE-favorite-models', JSON.stringify(favs));

    return { favoriteModels: favs };

  }),



  // ─── Terminal Tabs ─────────────────────────────────────

  terminalTabs: [{ id: 'term-1', name: 'Terminal 1' }],

  activeTerminalTab: 'term-1',

  addTerminalTab: () => {

    const { terminalTabs } = get();

    const num = terminalTabs.length + 1;

    const id = `term-${Date.now()}`;

    set({ terminalTabs: [...terminalTabs, { id, name: `Terminal ${num}` }], activeTerminalTab: id });

  },

  closeTerminalTab: (id) => {

    const { terminalTabs, activeTerminalTab } = get();

    if (terminalTabs.length <= 1) return;

    const newTabs = terminalTabs.filter(t => t.id !== id);

    let newActive = activeTerminalTab;

    if (activeTerminalTab === id) {

      newActive = newTabs[newTabs.length - 1].id;

    }

    set({ terminalTabs: newTabs, activeTerminalTab: newActive });

  },

  setActiveTerminalTab: (id) => set({ activeTerminalTab: id }),



  // ─── Live Server ───────────────────────────────────────

  liveServerRunning: false,

  liveServerPort: null,

  liveServerUrl: null,

  setLiveServerStatus: (status) => set({

    liveServerRunning: status.running,

    liveServerPort: status.port,

    liveServerUrl: status.url,

  }),

}));



function _detectLanguage(ext) {

  const map = {

    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',

    ts: 'typescript', tsx: 'typescriptreact',

    py: 'python', pyw: 'python',

    html: 'html', htm: 'html',

    css: 'css', scss: 'scss', sass: 'scss', less: 'less',

    json: 'json', jsonc: 'json',

    md: 'markdown', mdx: 'markdown',

    xml: 'xml', svg: 'xml',

    yaml: 'yaml', yml: 'yaml',

    toml: 'toml',

    sh: 'shell', bash: 'shell', zsh: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell',

    sql: 'sql',

    rs: 'rust',

    go: 'go',

    java: 'java',

    kt: 'kotlin', kts: 'kotlin',

    swift: 'swift',

    c: 'c', h: 'c',

    cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',

    cs: 'csharp',

    rb: 'ruby',

    php: 'php',

    r: 'r',

    lua: 'lua',

    dart: 'dart',

    vue: 'vue',

    svelte: 'svelte',

    graphql: 'graphql', gql: 'graphql',

    dockerfile: 'dockerfile',

    makefile: 'makefile',

    ini: 'ini', cfg: 'ini', conf: 'ini',

    env: 'dotenv',

    gitignore: 'ignore',

    txt: 'plaintext', log: 'plaintext',

  };

  return map[(ext || '').toLowerCase()] || 'plaintext';

}



export default useAppStore;

