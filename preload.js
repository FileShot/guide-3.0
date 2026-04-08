'use strict';

/**
 * guIDE 2.0 — Electron Preload Script (IPC Architecture)
 *
 * Exposes the full API surface to the renderer via contextBridge.
 * All communication goes through Electron IPC — no HTTP, no WebSocket.
 */
const { contextBridge, ipcRenderer } = require('electron');

// ─── Event listener helper ──────────────────────────────────────────
// Registers an IPC event listener and returns a cleanup function.
function _on(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Platform info ─────────────────────────────────────
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },

  // ── Window controls ───────────────────────────────────
  windowControls: {
    minimize:    () => ipcRenderer.invoke('win-minimize'),
    maximize:    () => ipcRenderer.invoke('win-maximize'),
    close:       () => ipcRenderer.invoke('win-close'),
    isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  },

  // ── Dialogs ───────────────────────────────────────────
  openFolderDialog: () => ipcRenderer.invoke('dialog-open-folder'),
  showItemInFolder: (fullPath) => ipcRenderer.invoke('shell-show-item', fullPath),
  modelsAdd: () => ipcRenderer.invoke('dialog-models-add'),
  openExternal: (url) => ipcRenderer.invoke('shell-open-external', url),
  showOpenDialog: () => ipcRenderer.invoke('dialog-open-folder'),

  // ── API Fetch bridge ──────────────────────────────────
  // Replaces HTTP fetch('/api/...') — routes through IPC to main process.
  apiFetch: (url, options) => ipcRenderer.invoke('api-fetch', url, options),

  // ── AI Chat (direct IPC — not through fetch bridge) ───
  aiChat: (message, context) => ipcRenderer.invoke('ai-chat', message, context),
  agentPause: () => ipcRenderer.invoke('agent-pause'),
  agentResume: () => ipcRenderer.invoke('agent-resume'),

  // ── Terminal ──────────────────────────────────────────
  terminal: {
    create:  (opts) => ipcRenderer.invoke('terminal-create', opts),
    write:   (termId, data) => ipcRenderer.invoke('terminal-write', termId, data),
    resize:  (termId, cols, rows) => ipcRenderer.invoke('terminal-resize', termId, cols, rows),
    destroy: (termId) => ipcRenderer.invoke('terminal-destroy', termId),
    onData:  (callback) => _on('terminal-data', callback),
    onExit:  (callback) => _on('terminal-exit', callback),
  },

  // ── Updater ───────────────────────────────────────────
  updater: {
    check:     () => ipcRenderer.invoke('updater-check'),
    download:  () => ipcRenderer.invoke('updater-download'),
    install:   () => ipcRenderer.invoke('updater-install'),
    getStatus: () => ipcRenderer.invoke('updater-status'),
    onStatus:  (callback) => _on('update-status', callback),
  },

  // ── Menu actions (from appMenu.js) ────────────────────
  onMenuAction: (callback) => _on('menu-action', callback),

  // ── Backend event listeners ───────────────────────────
  // LLM streaming
  onLlmToken:          (cb) => _on('llm-token', cb),
  onLlmThinkingToken:  (cb) => _on('llm-thinking-token', cb),
  onLlmToolGenerating: (cb) => _on('llm-tool-generating', cb),
  onLlmIterationBegin: (cb) => _on('llm-iteration-begin', cb),
  onLlmReplaceLast:    (cb) => _on('llm-replace-last', cb),
  onLlmStatus:         (cb) => _on('llm-status', cb),
  onLlmFileAccUpdate:  (cb) => _on('llm-file-acc-update', cb),

  // File content streaming
  onFileContentStart:  (cb) => _on('file-content-start', cb),
  onFileContentToken:  (cb) => _on('file-content-token', cb),
  onFileContentEnd:    (cb) => _on('file-content-end', cb),

  // Context & progress
  onContextUsage:      (cb) => _on('context-usage', cb),
  onAgenticProgress:   (cb) => _on('agentic-progress', cb),
  onTokenStats:        (cb) => _on('token-stats', cb),

  // Tool events
  onToolExecuting:     (cb) => _on('tool-executing', cb),
  onMcpToolResults:    (cb) => _on('mcp-tool-results', cb),
  onToolCheckpoint:    (cb) => _on('tool-checkpoint', cb),

  // File events
  onFilesChanged:      (cb) => _on('files-changed', cb),
  onOpenFile:          (cb) => _on('open-file', cb),
  onAgentFileModified: (cb) => _on('agent-file-modified', cb),

  // Model events
  onModelLoaded:       (cb) => _on('model-loaded', cb),
  onModelLoading:      (cb) => _on('model-loading', cb),
  onModelError:        (cb) => _on('model-error', cb),
  onModelsUpdated:     (cb) => _on('models-updated', cb),

  // Project events
  onProjectOpened:     (cb) => _on('project-opened', cb),

  // Todo events
  onTodoUpdate:        (cb) => _on('todo-update', cb),

  // Agent pause
  onAgentPaused:       (cb) => _on('agent-paused', cb),

  // Download events
  onDownloadStarted:   (cb) => _on('download-started', cb),
  onDownloadProgress:  (cb) => _on('download-progress', cb),
  onDownloadComplete:  (cb) => _on('download-complete', cb),
  onDownloadError:     (cb) => _on('download-error', cb),
  onDownloadCancelled: (cb) => _on('download-cancelled', cb),

  // Debug events
  onDebugEvent:        (cb) => _on('debug-event', cb),
});
