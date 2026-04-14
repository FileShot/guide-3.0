/**
 * App — Root component. Connects WebSocket, routes events to store, renders layout.
 */
import { useEffect, useCallback } from 'react';
import useAppStore from './stores/appStore';
import ThemeProvider from './components/ThemeProvider';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import NewProjectDialog from './components/NewProjectDialog';
import WelcomeScreen from './components/WelcomeScreen';
import WelcomeGuide from './components/WelcomeGuide';

export default function App() {
  const store = useAppStore();

  const handleEvent = useCallback((event, data) => {
    const s = useAppStore.getState();
    // Log all events except high-frequency token streaming
    if (event !== 'llm-token' && event !== 'llm-thinking-token' && event !== 'context-usage') {
      console.log(`[App] Event received: '${event}'`, typeof data === 'string' ? data.substring(0, 100) : data);
    }
    switch (event) {
      case 'connection-ready':
        // Fetch initial state
        fetch('/api/models').then(r => r.json()).then(d => {
          s.setAvailableModels(d.models || []);
          s.setModelState({ modelLoaded: d.status?.isReady || false, modelInfo: d.status?.modelInfo || null });
        }).catch(() => {});
        fetch('/api/project/current').then(r => r.json()).then(d => {
          if (d.projectPath) {
            s.setProjectPath(d.projectPath);
            fetch(`/api/files/tree?path=${encodeURIComponent(d.projectPath)}`).then(r => r.json()).then(t => {
              s.setFileTree(t.items || []);
            }).catch(() => {});
          }
        }).catch(() => {});
        fetch('/api/settings').then(r => r.json()).then(d => s.setSettings(d)).catch(() => {});
        break;

      // LLM streaming events
      case 'llm-token':
        s.appendStreamToken(data);
        break;
      case 'file-content-start':
        s.startFileContentBlock(data);
        break;
      case 'file-content-token':
        s.appendFileContentToken(data);
        break;
      case 'file-content-end':
        s.endFileContentBlock(data);
        break;
      case 'llm-thinking-token':
        s.appendThinkingToken(data);
        break;
      case 'llm-tool-generating':
        s.setChatGeneratingTool(data);
        break;
      case 'llm-iteration-begin':
        break;
      case 'llm-replace-last':
        s.replaceLastStreamingChunk(data.originalLength, data.replacement);
        break;

      // Context & progress
      case 'context-usage':
        s.setChatContextUsage(data);
        break;
      case 'agentic-progress':
        s.setChatIteration(data);
        break;
      case 'token-stats':
        s.setTokenStats(data);
        break;

      // Tool events — backend sends arrays: [{tool, params}, ...]
      case 'tool-executing': {
        // File write ops are displayed via FileContentBlock (backend emits file-content-* events)
        const FILE_WRITE_OPS = new Set(['write_file', 'create_file', 'append_to_file']);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const toolName = item.tool || item.functionName || item.name;
          if (FILE_WRITE_OPS.has(toolName)) continue;
          s.addStreamingToolCall({
            functionName: toolName,
            params: item.params || item.arguments,
            status: 'pending',
            startTime: Date.now(),
          });
        }
        break;
      }
      case 'mcp-tool-results': {
        const FILE_WRITE_OPS_R = new Set(['write_file', 'create_file', 'append_to_file']);
        const results = Array.isArray(data) ? data : [data];
        for (const item of results) {
          const name = item.tool || item.functionName || item.name;
          if (FILE_WRITE_OPS_R.has(name)) continue;
          s.updateStreamingToolCall(name, {
            status: item.result?.error || item.success === false ? 'error' : 'success',
            result: item.result,
            duration: Date.now() - (s.streamingToolCalls.find(tc => tc.functionName === name && tc.status === 'pending')?.startTime || Date.now()),
          });
        }
        break;
      }
      case 'tool-checkpoint': {
        const cps = Array.isArray(data) ? data : [data];
        for (const item of cps) {
          const name = item.tool || item.functionName || item.name;
          s.updateStreamingToolCall(name, { checkpoint: item });
        }
        break;
      }

      // File events
      case 'files-changed':
        if (s.projectPath) {
          fetch(`/api/files/tree?path=${encodeURIComponent(s.projectPath)}`).then(r => r.json()).then(t => {
            s.setFileTree(t.items || []);
          }).catch(() => {});
        }
        break;
      case 'open-file':
        if (typeof data === 'string') {
          fetch(`/api/files/read?path=${encodeURIComponent(data)}`).then(r => r.json()).then(f => {
            if (f.content !== undefined) {
              s.openFile({ path: f.path, name: f.name, extension: f.extension, content: f.content });
            }
          }).catch(() => {});
        }
        break;
      case 'agent-file-modified':
        if (data?.filePath) {
          const tab = s.openTabs.find(t => t.path === data.filePath);
          if (tab) {
            // R51-Fix: Don't markTabSaved — keep the tab in a modified state
            // so dirty diff decorations (green/red gutter) show the AI's changes.
            // originalContent stays as-is (the pre-AI state), content gets updated.
            s.updateTabContent(tab.id, data.newContent || '');
          }
          // R51-Fix: Populate chatFilesChanged so the keep/undo banner appears
          // above the chat input when the AI creates or modifies files.
          const fileName = data.filePath.split(/[\\/]/).pop() || data.filePath;
          const oldContent = tab?.content || '';
          const newContent = data.newContent || '';
          const oldLines = oldContent.split('\n').length;
          const newLines = newContent.split('\n').length;
          s.addChatFileChanged({
            path: data.filePath,
            name: fileName,
            linesAdded: data.isNew ? newLines : Math.max(0, newLines - oldLines),
            linesRemoved: data.isNew ? 0 : Math.max(0, oldLines - newLines),
          });
        }
        break;

      // Model events
      case 'llm-status':
        s.setLlmStatus(data);
        if (data?.state === 'ready') {
          s.setModelState({ modelLoaded: true, modelLoading: false, modelInfo: data.modelInfo });
        } else if (data?.state === 'loading') {
          s.setModelState({ modelLoading: true, modelLoadProgress: data.progress || 0 });
        } else if (data?.state === 'error') {
          s.setModelState({ modelLoading: false });
          s.addNotification({ type: 'error', message: `Model error: ${data.message}` });
        }
        break;
      case 'model-loaded':
        s.setModelState({ modelLoaded: true, modelLoading: false, modelInfo: data });
        s.addNotification({ type: 'info', message: `Model loaded: ${data?.name || 'unknown'}` });
        break;
      case 'model-loading':
        s.setModelState({ modelLoading: true });
        break;
      case 'model-error':
        s.setModelState({ modelLoading: false });
        s.addNotification({ type: 'error', message: data?.error || 'Model load error' });
        break;
      case 'models-updated':
        if (Array.isArray(data)) s.setAvailableModels(data);
        break;

      // Project
      case 'project-opened':
        if (data?.path) {
          s.setProjectPath(data.path);
          fetch(`/api/files/tree?path=${encodeURIComponent(data.path)}`).then(r => r.json()).then(t => {
            s.setFileTree(t.items || []);
          }).catch(() => {});
        }
        break;

      // Todo
      case 'todo-update':
        if (Array.isArray(data)) s.setTodos(data);
        break;

      // Agent pause
      case 'agent-paused':
        break;

      // File content accumulation update
      case 'llm-file-acc-update':
        // R27-D: Update the streaming file block with full accumulated content
        if (data?.filePath && data?.fullContent) {
          s.updateFileBlockContent({ filePath: data.filePath, fullContent: data.fullContent });
        }
        break;

      // Model download events
      case 'download-started':
        s.updateModelDownload(data.id, { ...data, status: 'downloading', percent: 0 });
        break;
      case 'download-progress':
        s.updateModelDownload(data.id, { ...data, status: 'downloading' });
        break;
      case 'download-complete':
        s.updateModelDownload(data.id, { ...data, status: 'complete' });
        s.addNotification({ type: 'info', message: `Downloaded: ${data.fileName}` });
        break;
      case 'download-error':
        s.updateModelDownload(data.id, { ...data, status: 'error' });
        s.addNotification({ type: 'error', message: `Download failed: ${data.error}` });
        break;
      case 'download-cancelled':
        s.removeModelDownload(data.id);
        break;

      // Debug events
      case 'debug-event':
        s.handleDebugEvent(data);
        break;

      default:
        break;
    }
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) {
      // Fallback: legacy WebSocket mode (dev server without Electron)
      import('./api/websocket').then(({ connect }) => {
        connect(handleEvent, (connected) => useAppStore.getState().setConnected(connected));
      });
      return;
    }

    // Mark as connected immediately in Electron IPC mode
    useAppStore.getState().setConnected(true);

    // Fire connection-ready to load initial state
    handleEvent('connection-ready', null);

    // Register IPC event listeners — each returns a cleanup function
    const cleanups = [
      api.onLlmToken?.((d) => handleEvent('llm-token', d)),
      api.onLlmThinkingToken?.((d) => handleEvent('llm-thinking-token', d)),
      api.onLlmToolGenerating?.((d) => handleEvent('llm-tool-generating', d)),
      api.onLlmIterationBegin?.((d) => handleEvent('llm-iteration-begin', d)),
      api.onLlmReplaceLast?.((d) => handleEvent('llm-replace-last', d)),
      api.onLlmStatus?.((d) => handleEvent('llm-status', d)),
      api.onLlmFileAccUpdate?.((d) => handleEvent('llm-file-acc-update', d)),
      api.onFileContentStart?.((d) => handleEvent('file-content-start', d)),
      api.onFileContentToken?.((d) => handleEvent('file-content-token', d)),
      api.onFileContentEnd?.((d) => handleEvent('file-content-end', d)),
      api.onContextUsage?.((d) => handleEvent('context-usage', d)),
      api.onAgenticProgress?.((d) => handleEvent('agentic-progress', d)),
      api.onTokenStats?.((d) => handleEvent('token-stats', d)),
      api.onToolExecuting?.((d) => handleEvent('tool-executing', d)),
      api.onMcpToolResults?.((d) => handleEvent('mcp-tool-results', d)),
      api.onToolCheckpoint?.((d) => handleEvent('tool-checkpoint', d)),
      api.onFilesChanged?.((d) => handleEvent('files-changed', d)),
      api.onOpenFile?.((d) => handleEvent('open-file', d)),
      api.onAgentFileModified?.((d) => handleEvent('agent-file-modified', d)),
      api.onModelLoaded?.((d) => handleEvent('model-loaded', d)),
      api.onModelLoading?.((d) => handleEvent('model-loading', d)),
      api.onModelError?.((d) => handleEvent('model-error', d)),
      api.onModelsUpdated?.((d) => handleEvent('models-updated', d)),
      api.onProjectOpened?.((d) => handleEvent('project-opened', d)),
      api.onTodoUpdate?.((d) => handleEvent('todo-update', d)),
      api.onAgentPaused?.((d) => handleEvent('agent-paused', d)),
      api.onDownloadStarted?.((d) => handleEvent('download-started', d)),
      api.onDownloadProgress?.((d) => handleEvent('download-progress', d)),
      api.onDownloadComplete?.((d) => handleEvent('download-complete', d)),
      api.onDownloadError?.((d) => handleEvent('download-error', d)),
      api.onDownloadCancelled?.((d) => handleEvent('download-cancelled', d)),
      api.onDebugEvent?.((d) => handleEvent('debug-event', d)),
    ].filter(Boolean);

    return () => cleanups.forEach(fn => fn());
  }, [handleEvent]);

  // Listen for native Electron menu actions (sent via IPC from appMenu.js)
  useEffect(() => {
    if (!window.electronAPI?.onMenuAction) return;
    window.electronAPI.onMenuAction((action) => {
      const s = useAppStore.getState();
      switch (action) {
        case 'newFile': {
          const name = prompt('New file name:');
          if (!name) return;
          const base = s.projectPath;
          if (!base) { s.addNotification({ type: 'error', message: 'Open a folder first' }); return; }
          fetch('/api/files/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: `${base}/${name}`, content: '' }),
          }).then(r => r.json()).then(d => {
            if (d.error) s.addNotification({ type: 'error', message: d.error });
            else s.openFile({ path: d.path, name, extension: name.split('.').pop(), content: '' });
          }).catch(e => s.addNotification({ type: 'error', message: e.message }));
          return;
        }
        case 'newWindow': {
          if (window.electronAPI?.newWindow) window.electronAPI.newWindow();
          return;
        }
        case 'openFolder': {
          if (window.electronAPI?.openFolderDialog) {
            window.electronAPI.openFolderDialog().then(folderPath => {
              if (folderPath) {
                fetch('/api/project/open', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ projectPath: folderPath }),
                }).then(r => r.json()).then(d => {
                  if (!d.error) s.setProjectPath(folderPath);
                }).catch(() => {});
              }
            });
          }
          return;
        }
        case 'save': {
          const tab = s.openTabs.find(t => t.id === s.activeTabId);
          if (tab && tab.modified) {
            fetch('/api/files/write', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filePath: tab.path, content: tab.content }),
            }).then(r => r.json()).then(res => {
              if (res.success) s.markTabSaved(tab.id);
            }).catch(() => {});
          }
          return;
        }
        case 'saveAll':
          s.addNotification({ type: 'info', message: 'All files saved' });
          return;
        case 'closeTab':
          if (s.activeTabId) s.closeTab(s.activeTabId);
          return;
        case 'closeAllTabs':
          s.openTabs.forEach(t => s.closeTab(t.id));
          return;
        case 'find':
        case 'replace':
          // Let Monaco handle these via keyboard events
          return;
        case 'findInFiles':
          s.setActiveActivity('search');
          return;
        case 'commandPalette':
          s.toggleCommandPalette();
          return;
        case 'showExplorer':
          s.setActiveActivity('explorer');
          return;
        case 'showSearch':
          s.setActiveActivity('search');
          return;
        case 'showGit':
          s.setActiveActivity('git');
          return;
        case 'showChat':
          s.toggleChatPanel();
          return;
        case 'toggleSidebar':
          s.toggleSidebar();
          return;
        case 'togglePanel':
          s.togglePanel();
          return;
        case 'toggleChat':
          s.toggleChatPanel();
          return;
        case 'toggleMinimap':
          s.updateSetting('minimapEnabled', !s.settings.minimapEnabled);
          return;
        case 'toggleWordWrap':
          s.updateSetting('wordWrap', s.settings.wordWrap === 'on' ? 'off' : 'on');
          return;
        case 'goToFile':
          s.toggleCommandPalette();
          return;
        case 'newTerminal':
          s.setActivePanelTab('terminal');
          if (!s.panelVisible) s.togglePanel();
          return;
        case 'showWelcome':
          s.openFile({ path: 'welcome', name: 'Welcome', extension: 'welcome', content: '' });
          return;
        case 'showShortcuts':
          s.setActiveActivity('settings');
          return;
        case 'about':
          s.addNotification({ type: 'info', message: 'guIDE 2.3.15 — Local-first AI IDE. Built for offline inference.', duration: 8000 });
          return;
        default:
          return;
      }
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e) => {
      const s = useAppStore.getState();
      // Ctrl+Shift+P — Command Palette
      if (e.ctrlKey && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        s.toggleCommandPalette();
      }
      // Ctrl+B — Toggle Sidebar
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        s.toggleSidebar();
      }
      // Ctrl+J — Toggle Panel
      if (e.ctrlKey && e.key === 'j') {
        e.preventDefault();
        s.togglePanel();
      }
      // Ctrl+S — Save current file
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        const tab = s.openTabs.find(t => t.id === s.activeTabId);
        if (tab && tab.modified) {
          fetch('/api/files/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: tab.path, content: tab.content }),
          }).then(r => r.json()).then(res => {
            if (res.success) s.markTabSaved(tab.id);
          }).catch(() => {});
        }
      }
      // Ctrl+L — Toggle AI Chat
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        s.toggleChatPanel();
      }
      // Ctrl+N — New Project
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        s.setShowNewProjectDialog(true);
      }
      // Ctrl+= / Ctrl++ — Zoom In
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        s.zoomIn();
      }
      // Ctrl+- — Zoom Out
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        s.zoomOut();
      }
      // Ctrl+0 — Reset Zoom
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        s.zoomReset();
      }
      // Shift+Alt+F — Format Document
      if (e.shiftKey && e.altKey && e.key === 'F') {
        e.preventDefault();
        const tab = s.openTabs.find(t => t.id === s.activeTabId);
        if (tab && tab.content) {
          const ext = tab.path.split('.').pop().toLowerCase();
          fetch('/api/format', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: tab.content, language: ext, filePath: tab.path })
          }).then(r => r.json()).then(data => {
            if (data.formatted) s.updateTabContent(tab.id, data.formatted);
          }).catch(() => {});
        }
      }
      // Escape — Close command palette
      if (e.key === 'Escape') {
        if (s.commandPaletteOpen) s.closeCommandPalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <Layout />
        <WelcomeScreen />
        <WelcomeGuide />
        <NewProjectDialog />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
