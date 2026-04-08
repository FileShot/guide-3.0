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
  setModelState: (state) => set(state),
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
      set({ activeTabId: existing.id });
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
  chatMessages: [],       // [{id, role, content, timestamp, toolCalls?, thinking?}]
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
    const { chatMessages } = get();
    set({ chatMessages: [...chatMessages, { ...msg, id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now() }] });
  },

  setChatStreaming: (val) => {
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
    set({ chatStreaming: val, chatStreamingText: '', chatThinkingText: '', chatGeneratingTool: null, streamingSegments: [], streamingToolCalls: [], _textTokenBuffer: null, _textTokenTimer: null });
  },

  appendStreamToken: (token) => {
    // R34: Batch text token appends — accumulate in buffer, flush every 80ms
    // This prevents 100+/sec set() calls that cause the Footer (and all children) to re-render.
    const store = get();
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
  },

  appendThinkingToken: (token) => {
    const { chatThinkingText } = get();
    set({ chatThinkingText: chatThinkingText + token });
  },

  setChatGeneratingTool: (tool) => set({ chatGeneratingTool: tool }),
  setChatContextUsage: (usage) => set({ chatContextUsage: usage }),
  setChatIteration: (iter) => set({ chatIteration: iter }),

  // R39-A1 + R40: Tool call tracking with segment interleaving
  addStreamingToolCall: (tc) => {
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
    const { streamingToolCalls } = get();
    // Prefer matching a pending call with this name (handles duplicates)
    let idx = streamingToolCalls.findIndex(tc => tc.functionName === name && tc.status === 'pending');
    if (idx === -1) idx = streamingToolCalls.findIndex(tc => tc.functionName === name);
    if (idx === -1) return;
    const updated = [...streamingToolCalls];
    updated[idx] = { ...updated[idx], ...updates };
    set({ streamingToolCalls: updated });
  },

  startFileContentBlock: ({ filePath, fileKey, language, fileName }) => {
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
    const existingIdx = store.streamingFileBlocks.findIndex(b => b.fileKey === normalizedKey && !b.complete);
    if (existingIdx !== -1) {
      // Block already exists — just update text/timer state, don't create new block or segment
      set({
        activeStreamingFileKey: normalizedKey,
        chatStreamingText: currentText,
        streamingSegments: currentSegs,
        _textTokenBuffer: null,
        _textTokenTimer: null,
      });
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
  endFileContentBlock: (payload) => {
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
    const store = get();
    if (store._fileTokenTimer) clearTimeout(store._fileTokenTimer);
    if (store._textTokenTimer) clearTimeout(store._textTokenTimer);
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
      maxResponseTokens: 2048,
      contextSize: 16384,
      topP: 0.95,
      topK: 40,
      repeatPenalty: 1.1,
      seed: -1,
      // Thinking & Reasoning
      thinkingBudget: 0,        // 0 = auto, -1 = unlimited, >0 = exact cap
      reasoningEffort: 'medium', // 'low' | 'medium' | 'high'
      // Agentic Behavior
      maxIterations: 25,
      generationTimeoutSec: 0,
      snapshotMaxChars: 8000,
      enableThinkingFilter: true,
      enableGrammar: false,
      // System Prompt
      systemPrompt: '',
      customInstructions: '',
      // Hardware
      gpuPreference: 'auto',    // 'auto' | 'cpu'
      gpuLayers: -1,            // -1 = auto
      requireMinContextForGpu: false,
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
  setSettings: (s) => {
    localStorage.setItem('guIDE-settings', JSON.stringify(s));
    set({ settings: s });
  },
  updateSetting: (key, value) => set(s => {
    const next = { ...s.settings, [key]: value };
    localStorage.setItem('guIDE-settings', JSON.stringify(next));
    return { settings: next };
  }),
  resetSettings: () => {
    const DEFAULTS = {
      temperature: 0.4, maxResponseTokens: 2048, contextSize: 16384,
      topP: 0.95, topK: 40, repeatPenalty: 1.1, seed: -1,
      thinkingBudget: 0, reasoningEffort: 'medium',
      maxIterations: 25, generationTimeoutSec: 0, snapshotMaxChars: 8000,
      enableThinkingFilter: true, enableGrammar: false,
      systemPrompt: '', customInstructions: '',
      gpuPreference: 'auto', gpuLayers: -1, requireMinContextForGpu: false,
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
