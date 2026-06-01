/**
 * EditorArea — Tab bar + Monaco Editor, mimicking VS Code's editor group.
 * Shows a welcome screen when no files are open.
 */
import { useRef, useCallback, useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import useAppStore from '../stores/appStore';
import DiffViewer from './DiffViewer';
import InlineChat from './InlineChat';
import BrowserPanel from './BrowserPanel';
import {
  initLspBridge,
  pathToUri,
  uriToPath,
  requestCompletion,
  requestHover,
  requestDefinition,
  requestDocumentSymbols,
  notifyDidOpen,
  notifyDidChange,
  symbolPathAtLine,
  computeTodoDecorations,
  refreshLspDiagnosticsMode,
} from '../lib/lspBridge';
import {
  isPreviewable, getPreviewType,
  HtmlPreview, MarkdownPreview, JsonPreview, CsvPreview, SvgPreview, ImagePreview, PdfPreview
} from './EditorPreviews';
import FileIcon from './FileIcon';
import GuideLogo from './GuideLogo';
import {
  X, Circle, FolderOpen, MessageSquare, Settings,
  FileText, Copy, RefreshCw,
  Eye, Code2, Play, ExternalLink, Globe, Wand2,
  ChevronUp, ChevronDown, Check, Undo2, Columns, MoreHorizontal
} from 'lucide-react';

// ── Dirty diff helper — compute line-level changes ──
function computeDirtyDiff(original, current) {
  const origLines = (original || '').split('\n');
  const currLines = (current || '').split('\n');
  const decorations = [];
  const maxLen = Math.max(origLines.length, currLines.length);
  for (let i = 0; i < currLines.length; i++) {
    if (i >= origLines.length) {
      decorations.push({
        range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: 1 },
        options: { isWholeLine: true, linesDecorationsClassName: 'dirty-diff-added', className: 'dirty-diff-added-line' },
      });
    } else if (origLines[i] !== currLines[i]) {
      decorations.push({
        range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: 1 },
        options: { isWholeLine: true, linesDecorationsClassName: 'dirty-diff-modified', className: 'dirty-diff-modified-line' },
      });
    }
  }
  // Deleted lines at end — mark the last current line
  if (origLines.length > currLines.length && currLines.length > 0) {
    decorations.push({
      range: { startLineNumber: currLines.length, startColumn: 1, endLineNumber: currLines.length, endColumn: 1 },
      options: { isWholeLine: true, linesDecorationsClassName: 'dirty-diff-deleted', className: 'dirty-diff-deleted-line' },
    });
  }
  return decorations;
}

export default function EditorArea() {
  const openTabs = useAppStore(s => s.openTabs);
  const activeTabId = useAppStore(s => s.activeTabId);
  const setActiveTab = useAppStore(s => s.setActiveTab);
  const closeTab = useAppStore(s => s.closeTab);
  const updateTabContent = useAppStore(s => s.updateTabContent);
  const addNotification = useAppStore(s => s.addNotification);
  const setEditorCursorPosition = useAppStore(s => s.setEditorCursorPosition);
  const setEditorDiagnostics = useAppStore(s => s.setEditorDiagnostics);
  const setWorkspaceProblems = useAppStore(s => s.setWorkspaceProblems);
  const setEditorSelection = useAppStore(s => s.setEditorSelection);
  const setSymbolOutline = useAppStore(s => s.setSymbolOutline);
  const minimapEnabled = useAppStore(s => s.settings.minimapEnabled);
  const editorIndentSize = useAppStore(s => s.editorIndentSize);
  const editorIndentType = useAppStore(s => s.editorIndentType);
  const diffState = useAppStore(s => s.diffState);
  const chatFilesChanged = useAppStore(s => s.chatFilesChanged);
  const autoSaveTimersRef = useRef(new Map()); // per-tab timers

  // Auto-save: debounced write to disk after content changes (1s delay)
  const autoSaveTab = useCallback((tabId, content, filePath) => {
    const timers = autoSaveTimersRef.current;
    if (timers.has(tabId)) clearTimeout(timers.get(tabId));
    timers.set(tabId, setTimeout(() => {
      timers.delete(tabId);
      const api = window.electronAPI;
      if (api?.apiFetch && filePath) {
        api.apiFetch('/api/files/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, content, formatOnSave: true }),
        }).then((res) => {
          const store = useAppStore.getState();
          store.markTabSaved(tabId);
          if (res?.formatted && res?.content && res.content !== content) {
            store.updateTabContent(tabId, res.content);
          }
          if (res?.problems?.length) {
            const existing = store.workspaceProblems.filter(p => p.file !== filePath);
            store.setWorkspaceProblems([...existing, ...res.problems]);
          }
        }).catch(err => {
          console.error(`[AutoSave] Failed to save ${filePath}:`, err);
        });
      }
    }, 1000));
  }, [setWorkspaceProblems]);
  const setChatFilesChanged = useAppStore(s => s.setChatFilesChanged);
  const openDiff = useAppStore(s => s.openDiff);
  const closeDiff = useAppStore(s => s.closeDiff);
  const [tabContextMenu, setTabContextMenu] = useState(null);
  const [inlineChat, setInlineChat] = useState(null);
  const previewMode = useAppStore(s => s.previewMode);
  const setPreviewMode = useAppStore(s => s.setPreviewMode);
  const togglePreviewMode = useAppStore(s => s.togglePreviewMode);
  const editorRef = useRef(null);
  const dirtyDecorationsRef = useRef(null);
  const todoDecorationsRef = useRef(null);
  const breakpointDecorationsRef = useRef(null);
  const errorLensRef = useRef(null);
  const lspDisposablesRef = useRef([]);
  const lspVersionRef = useRef(new Map());
  const documentSymbolsRef = useRef([]);
  const fileBreakpointsRef = useRef(new Map()); // filePath -> Set<line>
  const previewRequested = useAppStore(s => s.previewRequested);
  const editorSplit = useAppStore(s => s.editorSplit);
  const toggleEditorSplit = useAppStore(s => s.toggleEditorSplit);
  const moveTabToEditorGroup = useAppStore(s => s.moveTabToEditorGroup);
  const setActiveEditorGroup = useAppStore(s => s.setActiveEditorGroup);
  const activeEditorGroup = useAppStore(s => s.activeEditorGroup);
  const secondaryEditorRef = useRef(null);
  const [dragTabId, setDragTabId] = useState(null);
  const projectPath = useAppStore(s => s.projectPath);
  const debugSessionId = useAppStore(s => s.debugSessionId);
  const [symbolBreadcrumbs, setSymbolBreadcrumbs] = useState([]);
  const [cursorLine, setCursorLine] = useState(1);

  const activeTab = openTabs.find(t => t.id === activeTabId);

  // Sync breakpoints to debug session when session becomes active
  useEffect(() => {
    if (!debugSessionId || !activeTab?.path) return;
    const lines = fileBreakpointsRef.current.get(activeTab.path);
    if (!lines?.size) return;
    const api = window.electronAPI;
    const payload = {
      sessionId: debugSessionId,
      filePath: activeTab.path,
      breakpoints: [...lines].map((line) => ({ line })),
    };
    const req = api?.apiFetch
      ? api.apiFetch('/api/debug/setBreakpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      : fetch('/api/debug/setBreakpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    req.catch(() => {});
  }, [debugSessionId, activeTab?.path]);

  // LSP didOpen / didChange when active tab content changes
  useEffect(() => {
    if (!activeTab?.path || activeTab.isBinary) return;
    const uri = pathToUri(activeTab.path);
    const lang = activeTab.language || 'plaintext';
    const prev = lspVersionRef.current.get(activeTab.path) || 0;
    const ver = prev + 1;
    lspVersionRef.current.set(activeTab.path, ver);
    if (prev === 0) {
      notifyDidOpen({ uri, language: lang, text: activeTab.content || '', version: ver }).catch(() => {});
    } else {
      notifyDidChange({ uri, text: activeTab.content || '', version: ver }).catch(() => {});
    }
  }, [activeTab?.path, activeTab?.content, activeTab?.language, activeTab?.isBinary]);

  // Fetch LSP document symbols for breadcrumbs + outline
  useEffect(() => {
    if (!activeTab?.path || activeTab.isBinary) {
      documentSymbolsRef.current = [];
      setSymbolBreadcrumbs([]);
      return;
    }
    let cancelled = false;
    const uri = pathToUri(activeTab.path);
    requestDocumentSymbols({ uri, language: activeTab.language, cwd: projectPath })
      .then((symbols) => {
        if (cancelled) return;
        const syms = Array.isArray(symbols) ? symbols : [];
        documentSymbolsRef.current = syms;
        setSymbolOutline(syms.map((s) => ({
          name: s.name,
          kind: s.kind,
          line: (s.range?.start?.line ?? 0) + 1,
          indent: 0,
        })));
        setSymbolBreadcrumbs(symbolPathAtLine(syms, cursorLine));
      })
      .catch(() => {
        if (cancelled) return;
        documentSymbolsRef.current = [];
        // Fallback: regex-based outline when LSP unavailable
        if (!activeTab?.content) { setSymbolOutline([]); return; }
        const lines = activeTab.content.split('\n');
        const symbols = [];
        const patterns = [
          { regex: /^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/, kind: 'function' },
          { regex: /^(export\s+)?(default\s+)?class\s+(\w+)/, kind: 'class' },
          { regex: /^(async\s+)?def\s+(\w+)/, kind: 'function' },
          { regex: /^class\s+(\w+)/, kind: 'class' },
          { regex: /^(pub\s+)?(async\s+)?fn\s+(\w+)/, kind: 'function' },
          { regex: /^func\s+(\w+)/, kind: 'function' },
        ];
        for (let i = 0; i < lines.length && symbols.length < 100; i++) {
          for (const { regex, kind } of patterns) {
            const m = lines[i].match(regex);
            if (m) {
              const name = m[m.length - 1];
              if (name && /^[A-Za-z_]\w*$/.test(name)) {
                symbols.push({ name, kind, line: i + 1, indent: 0 });
              }
              break;
            }
          }
        }
        setSymbolOutline(symbols);
      });
    return () => { cancelled = true; };
  }, [activeTab?.path, activeTab?.content, activeTab?.language, activeTab?.isBinary, projectPath, setSymbolOutline]);

  // Update symbol breadcrumbs when cursor moves
  useEffect(() => {
    if (documentSymbolsRef.current.length) {
      setSymbolBreadcrumbs(symbolPathAtLine(documentSymbolsRef.current, cursorLine));
    }
  }, [cursorLine]);

  // TODO/FIXME squiggle decorations
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTab?.content) return;
    const decos = computeTodoDecorations(activeTab.content);
    if (todoDecorationsRef.current) {
      todoDecorationsRef.current.set(decos);
    } else {
      todoDecorationsRef.current = editor.createDecorationsCollection(decos);
    }
  }, [activeTab?.content]);

  const refreshBreakpointDecorations = useCallback((editor, filePath) => {
    if (!editor || !filePath) return;
    const lines = fileBreakpointsRef.current.get(filePath) || new Set();
    const decos = [...lines].map((line) => ({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: {
        isWholeLine: false,
        glyphMarginClassName: 'editor-breakpoint-glyph',
        glyphMarginHoverMessage: { value: 'Breakpoint' },
      },
    }));
    if (breakpointDecorationsRef.current) {
      breakpointDecorationsRef.current.set(decos);
    } else {
      breakpointDecorationsRef.current = editor.createDecorationsCollection(decos);
    }
  }, []);

  useEffect(() => {
    refreshBreakpointDecorations(editorRef.current, activeTab?.path);
  }, [activeTab?.path, refreshBreakpointDecorations]);

  const syncBreakpointsToBackend = useCallback((filePath) => {
    if (!debugSessionId) return;
    const lines = fileBreakpointsRef.current.get(filePath);
    const payload = {
      sessionId: debugSessionId,
      filePath,
      breakpoints: [...(lines || [])].map((line) => ({ line })),
    };
    const api = window.electronAPI;
    const req = api?.apiFetch
      ? api.apiFetch('/api/debug/setBreakpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      : fetch('/api/debug/setBreakpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    req.catch(() => {});
  }, [debugSessionId]);

  const toggleBreakpoint = useCallback((line, filePath) => {
    if (!filePath) return;
    let lines = fileBreakpointsRef.current.get(filePath);
    if (!lines) {
      lines = new Set();
      fileBreakpointsRef.current.set(filePath, lines);
    }
    if (lines.has(line)) lines.delete(line);
    else lines.add(line);
    refreshBreakpointDecorations(editorRef.current, filePath);
    syncBreakpointsToBackend(filePath);
  }, [refreshBreakpointDecorations, syncBreakpointsToBackend]);

  const gotoLine = useCallback((line) => {
    const editor = editorRef.current;
    if (!editor || !line) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }, []);

  // R46-B: When Sidebar play button opens a file and sets previewRequested,
  // activate preview mode on the active tab
  useEffect(() => {
    if (previewRequested && activeTabId) {
      closeDiff();
      setPreviewMode(activeTabId, true);
      useAppStore.getState().setPreviewRequested(false);
    }
  }, [previewRequested, activeTabId, closeDiff]);

  // Auto-open diff when AI has edited the active file (avoid side effect during render)
  useEffect(() => {
    if (!activeTab || diffState) return;
    const fileChange = chatFilesChanged.find(f => f.path === activeTab.path);
    if (!fileChange) return;
    const totalEdits = (fileChange.linesAdded || 0) + (fileChange.linesRemoved || 0);
    if (totalEdits > 0 && activeTab.originalContent != null) {
      openDiff(activeTab.originalContent, activeTab.content, activeTab.name);
    }
  }, [activeTab, chatFilesChanged, diffState, openDiff]);

  const addChatMessage = useAppStore(s => s.addChatMessage);

  // Ctrl+I — open inline chat at cursor
  useEffect(() => {
    const handleKey = (e) => {
      if (e.ctrlKey && e.key === 'i' && editorRef.current) {
        e.preventDefault();
        const editor = editorRef.current;
        const pos = editor.getPosition();
        if (!pos) return;
        const coords = editor.getScrolledVisiblePosition(pos);
        const domNode = editor.getDomNode();
        const rect = domNode?.getBoundingClientRect();
        if (!coords || !rect) return;
        const sel = editor.getSelection();
        const model = editor.getModel();
        const selectedText = sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';
        setInlineChat({
          top: coords.top + rect.top + coords.height,
          left: coords.left + rect.left,
          selectedText,
        });
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Listen for goto-line events from symbol outline sidebar
  useEffect(() => {
    const handler = (e) => {
      gotoLine(e.detail?.line);
    };
    window.addEventListener('guide-goto-line', handler);
    return () => window.removeEventListener('guide-goto-line', handler);
  }, [gotoLine]);

  // Dirty diff — update gutter decorations when content changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTab) return;
    if (activeTab.modified) {
      const decos = computeDirtyDiff(activeTab.originalContent, activeTab.content);
      if (dirtyDecorationsRef.current) {
        dirtyDecorationsRef.current.set(decos);
      } else {
        dirtyDecorationsRef.current = editor.createDecorationsCollection(decos);
      }
    } else {
      // File not modified — clear decorations
      if (dirtyDecorationsRef.current) {
        dirtyDecorationsRef.current.clear();
        dirtyDecorationsRef.current = null;
      }
    }
  }, [activeTab?.content, activeTab?.originalContent, activeTab?.modified]);

  const handleTabContextMenu = (e, tabId) => {
    e.preventDefault();
    e.stopPropagation();
    setTabContextMenu({ x: e.clientX, y: e.clientY, tabId });
  };

  const handleCloseTab = useCallback((tabId) => {
    const tab = openTabs.find(t => t.id === tabId);
    // Auto-save: flush any pending save timer and write to disk immediately
    if (tab?.modified && tab.path) {
      const timers = autoSaveTimersRef.current;
      if (timers.has(tabId)) {
        clearTimeout(timers.get(tabId));
        timers.delete(tabId);
      }
      const api = window.electronAPI;
      if (api?.apiFetch) {
        api.apiFetch('/api/files/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: tab.path, content: tab.content }),
        }).then(() => {
          useAppStore.getState().markTabSaved(tabId);
        }).catch(err => {
          console.error(`[AutoSave] Failed to save ${tab.path} on close:`, err);
        });
      }
    }
    closeTab(tabId);
  }, [openTabs, closeTab]);

  const handleCloseOtherTabs = useCallback((tabId) => {
    openTabs.forEach(t => {
      if (t.id !== tabId) {
        if (t.modified && t.path) {
          const api = window.electronAPI;
          if (api?.apiFetch) {
            api.apiFetch('/api/files/write', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: t.path, content: t.content }),
            }).then(() => {
              useAppStore.getState().markTabSaved(t.id);
            }).catch(() => {});
          }
        }
        closeTab(t.id);
      }
    });
    setTabContextMenu(null);
  }, [openTabs, closeTab]);

  const handleCloseAllTabs = useCallback(() => {
    openTabs.forEach(t => {
      if (t.modified && t.path) {
        const api = window.electronAPI;
        if (api?.apiFetch) {
          api.apiFetch('/api/files/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: t.path, content: t.content }),
          }).then(() => {
            useAppStore.getState().markTabSaved(t.id);
          }).catch(() => {});
        }
      }
      closeTab(t.id);
    });
    setTabContextMenu(null);
  }, [openTabs, closeTab]);

  const handleCloseSavedTabs = useCallback((scopeTabIds) => {
    const scope = scopeTabIds ? new Set(scopeTabIds) : null;
    openTabs.forEach(t => {
      if (t.modified) return;
      if (scope && !scope.has(t.id)) return;
      closeTab(t.id);
    });
    setTabContextMenu(null);
  }, [openTabs, closeTab]);

  const handleCopyPath = useCallback((tabId) => {
    const tab = openTabs.find(t => t.id === tabId);
    if (tab) {
      navigator.clipboard.writeText(tab.path).catch(() => {});
      addNotification({ type: 'info', message: 'Path copied', duration: 2000 });
    }
    setTabContextMenu(null);
  }, [openTabs, addNotification]);

  const requestBrowserReload = useAppStore(s => s.requestBrowserReload);

  const handleReloadBrowserTab = useCallback(() => {
    requestBrowserReload();
    setTabContextMenu(null);
  }, [requestBrowserReload]);

  if (openTabs.length === 0) {
    return <WelcomeScreen />;
  }

  const renderTabBar = (tabs, groupNum) => (
    <div
      className="flex h-tabbar bg-vsc-tab-border overflow-x-auto scrollbar-none no-select flex-shrink-0"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDrop={(e) => {
        e.preventDefault();
        const tabId = e.dataTransfer.getData('text/tab-id') || dragTabId;
        if (tabId) moveTabToEditorGroup(tabId, groupNum);
        setDragTabId(null);
      }}
    >
      {tabs.map(tab => {
        const isHtml = tab.extension === 'html' || tab.extension === 'htm';
        const isBrowserTab = tab.type === 'browser';
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            draggable
            className={`editor-tab ${isActive ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab.id); setActiveEditorGroup(groupNum); }}
            onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/tab-id', tab.id);
              setDragTabId(tab.id);
            }}
            onDragEnd={() => setDragTabId(null)}
          >
            {isBrowserTab ? <Globe size={14} className="text-vsc-accent flex-shrink-0" /> : <FileIcon extension={tab.extension} size={14} />}
            <span className="truncate text-vsc-sm">{tab.name}</span>
            {tab.modified && <Circle size={8} className="text-vsc-text-bright fill-current flex-shrink-0" />}
            {isHtml && (
              <button
                className="p-0.5 hover:bg-vsc-list-hover rounded text-vsc-success opacity-60 hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); closeDiff(); togglePreviewMode(tab.id); }}
                title={previewMode[tab.id] ? 'Show code' : 'Preview in viewport'}
              >
                <Play size={12} />
              </button>
            )}
            <button className="close-btn" onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id); }}>
              <X size={14} />
            </button>
          </div>
        );
      })}
      {tabs.length > 0 && (
        <button
          type="button"
          className="flex items-center justify-center w-7 h-full text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover flex-shrink-0 border-l border-vsc-panel-border/30"
          title="Tab actions"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const tabId = tabs.some(t => t.id === activeTabId) ? activeTabId : tabs[0].id;
            setTabContextMenu({ x: Math.max(8, rect.right - 200), y: rect.bottom + 2, tabId });
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      {groupNum === 1 && (
        <button
          className="flex items-center px-2 text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover flex-shrink-0"
          title={editorSplit ? 'Close split editor' : 'Split editor right'}
          onClick={toggleEditorSplit}
        >
          <Columns size={14} />
        </button>
      )}
    </div>
  );

  const primaryTabs = editorSplit ? openTabs.filter(t => (t.editorGroup || 1) !== 2) : openTabs;
  const secondaryTabs = editorSplit ? openTabs.filter(t => t.editorGroup === 2) : [];

  const renderEditorContent = (paneActiveTab, paneEditorRef, isSecondary) => {
    if (!paneActiveTab) {
      return (
        <div className="flex-1 flex items-center justify-center text-vsc-text-dim text-vsc-xs">
          {isSecondary ? 'Drag a tab here or open a file' : 'No file open'}
        </div>
      );
    }
    if (diffState && !previewMode[paneActiveTab.id] && !isSecondary && paneActiveTab.id === activeTabId) {
      return <DiffViewer />;
    }
    if (paneActiveTab.type === 'browser') return <BrowserPanel />;
    if (previewMode[paneActiveTab.id] && getPreviewType(paneActiveTab.path)) {
      const type = getPreviewType(paneActiveTab.path);
      const toggle = () => setPreviewMode(paneActiveTab.id, false);
      switch (type) {
        case 'html': return <HtmlPreview content={paneActiveTab.content} filePath={paneActiveTab.path} onToggleCode={toggle} />;
        case 'markdown': return <MarkdownPreview content={paneActiveTab.content} filePath={paneActiveTab.path} onToggleCode={toggle} />;
        case 'json': return <JsonPreview content={paneActiveTab.content} filePath={paneActiveTab.path} onToggleCode={toggle} />;
        case 'csv': return <CsvPreview content={paneActiveTab.content} filePath={paneActiveTab.path} onToggleCode={toggle} />;
        case 'svg': return <SvgPreview content={paneActiveTab.content} filePath={paneActiveTab.path} onToggleCode={toggle} />;
        case 'image': return <ImagePreview filePath={paneActiveTab.path} dataUrl={paneActiveTab.dataUrl} onToggleCode={toggle} />;
        case 'pdf': return <PdfPreview filePath={paneActiveTab.path} dataUrl={paneActiveTab.dataUrl} onToggleCode={toggle} />;
        default: return null;
      }
    }
    if (paneActiveTab.isBinary) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-vsc-text-dim">
          <p className="text-sm mb-2">This file is binary and cannot be shown as text.</p>
          {isPreviewable(paneActiveTab.path) && (
            <button type="button" className="px-3 py-1.5 text-[12px] rounded bg-vsc-accent/20 text-vsc-accent hover:bg-vsc-accent/30" onClick={() => setPreviewMode(paneActiveTab.id, true)}>
              Show preview
            </button>
          )}
        </div>
      );
    }
    const refToUse = isSecondary ? secondaryEditorRef : editorRef;
    return (
      <Editor
        key={paneActiveTab.id}
        defaultLanguage={paneActiveTab.language}
        language={paneActiveTab.language}
        value={paneActiveTab.content}
        theme="vs-dark"
        onChange={(value) => {
          if (value !== undefined) {
            updateTabContent(paneActiveTab.id, value);
            autoSaveTab(paneActiveTab.id, value, paneActiveTab.path);
          }
        }}
        onMount={(editor, monaco) => {
          refToUse.current = editor;
          if (!isSecondary) {
            editor.onDidChangeCursorPosition((e) => {
              const pos = { line: e.position.lineNumber, column: e.position.column };
              setEditorCursorPosition(pos);
              if (paneActiveTab?.path && window.electronAPI?.sendEditorContext) {
                window.electronAPI.sendEditorContext({ activeFilePath: paneActiveTab.path, cursorLine: pos.line, cursorCol: pos.column });
              }
            });
            const pos = editor.getPosition();
            if (pos) setEditorCursorPosition({ line: pos.lineNumber, column: pos.column });
            editor.onDidChangeCursorSelection((e) => {
              const sel = e.selection;
              if (sel.isEmpty()) setEditorSelection(null);
              else {
                const model = editor.getModel();
                const text = model.getValueInRange(sel);
                setEditorSelection({ chars: text.length, lines: sel.endLineNumber - sel.startLineNumber + 1 });
              }
            });
          }
          if (monaco.languages?.typescript && !isSecondary) {
            const tsOpts = { target: monaco.languages.typescript.ScriptTarget.ESNext, allowNonTsExtensions: true, moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs, module: monaco.languages.typescript.ModuleKind.ESNext, noEmit: true, esModuleInterop: true, jsx: monaco.languages.typescript.JsxEmit.React, allowJs: true, strict: false };
            monaco.languages.typescript.typescriptDefaults.setCompilerOptions(tsOpts);
            monaco.languages.typescript.javascriptDefaults.setCompilerOptions(tsOpts);
          }
        }}
        options={{
          fontSize: 14,
          fontFamily: 'Consolas, "Courier New", monospace',
          minimap: { enabled: minimapEnabled, scale: 1 },
          scrollBeyondLastLine: true,
          smoothScrolling: true,
          automaticLayout: true,
          tabSize: editorIndentSize,
          insertSpaces: editorIndentType === 'spaces',
        }}
        loading={<div className="flex items-center justify-center h-full text-vsc-text-dim"><div className="spinner mr-2" />Loading editor...</div>}
      />
    );
  };

  const secondaryActiveTab = secondaryTabs.find(t => t.id === activeTabId) || secondaryTabs[secondaryTabs.length - 1] || null;
  const primaryActiveTab = primaryTabs.find(t => t.id === activeTabId) || primaryTabs[primaryTabs.length - 1] || activeTab;

  if (editorSplit) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col flex-1 min-w-0 border-r border-vsc-panel-border/20" onMouseDown={() => setActiveEditorGroup(1)}>
            {renderTabBar(primaryTabs, 1)}
            <div className="flex-1 min-h-0">{renderEditorContent(primaryActiveTab, editorRef, false)}</div>
          </div>
          <div className="flex flex-col flex-1 min-w-0" onMouseDown={() => setActiveEditorGroup(2)}>
            {renderTabBar(secondaryTabs, 2)}
            <div className="flex-1 min-h-0">{renderEditorContent(secondaryActiveTab, secondaryEditorRef, true)}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab Bar */}
      <div className="flex h-tabbar bg-vsc-tab-border overflow-x-auto scrollbar-none no-select">
        {openTabs.map(tab => {
          const isHtml = tab.extension === 'html' || tab.extension === 'htm';
          const isBrowserTab = tab.type === 'browser';
          return (
            <div
              key={tab.id}
              className={`editor-tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
            >
              {isBrowserTab ? <Globe size={14} className="text-vsc-accent flex-shrink-0" /> : <FileIcon extension={tab.extension} size={14} />}
              <span className="truncate text-vsc-sm">{tab.name}</span>
              {tab.modified && <Circle size={8} className="text-vsc-text-bright fill-current flex-shrink-0" />}
              {/* Play button for HTML files */}
              {isHtml && (
                <button
                  className="p-0.5 hover:bg-vsc-list-hover rounded text-vsc-success opacity-60 hover:opacity-100"
                  onClick={(e) => { 
                    e.stopPropagation(); 
                    closeDiff();
                    togglePreviewMode(tab.id);
                  }}
                  title={previewMode[tab.id] ? 'Show code' : 'Preview in viewport'}
                >
                  <Play size={12} />
                </button>
              )}
              <button
                className="close-btn"
                onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id); }}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
        <button
          className="flex items-center px-2 text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover flex-shrink-0"
          title="Split editor right"
          onClick={toggleEditorSplit}
        >
          <Columns size={14} />
        </button>
      </div>

      {/* Tab Context Menu */}
      {tabContextMenu && (
        <TabContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          tabId={tabContextMenu.tabId}
          isBrowserTab={openTabs.find(t => t.id === tabContextMenu.tabId)?.type === 'browser'}
          editorSplit={editorSplit}
          onClose={() => setTabContextMenu(null)}
          onCloseTab={handleCloseTab}
          onCloseOthers={handleCloseOtherTabs}
          onCloseAll={handleCloseAllTabs}
          onCloseSaved={handleCloseSavedTabs}
          onCopyPath={handleCopyPath}
          onReload={handleReloadBrowserTab}
          onToggleSplit={toggleEditorSplit}
        />
      )}

      {/* Breadcrumb */}
      {activeTab && (
        <div className="h-breadcrumb flex items-center px-3 bg-vsc-bg text-vsc-xs text-vsc-breadcrumb border-b border-vsc-panel-border no-select overflow-hidden min-w-0">
          <div className="flex items-center min-w-0 overflow-hidden flex-1">
          {activeTab.path.split(/[\\/]/).map((part, i, arr) => (
            <span key={`path-${i}`} className="shrink-0 last:shrink">
              {i > 0 && <span className="mx-1 text-vsc-text-dim">/</span>}
              <span className={`${i === arr.length - 1 && !symbolBreadcrumbs.length ? 'text-vsc-text truncate' : 'hover:text-vsc-text cursor-pointer'}`}>
                {part}
              </span>
            </span>
          ))}
          {symbolBreadcrumbs.map((sym, i) => (
            <span key={`sym-${i}-${sym.line}`} className="shrink-0">
              <span className="mx-1 text-vsc-text-dim">›</span>
              <button
                type="button"
                className={`hover:text-vsc-text ${i === symbolBreadcrumbs.length - 1 ? 'text-vsc-text' : 'text-vsc-breadcrumb'}`}
                onClick={() => gotoLine(sym.line)}
                title={`Go to ${sym.name}`}
              >
                {sym.name}
              </button>
            </span>
          ))}
          </div>
          {/* Previous/Next change navigation */}
          {activeTab.modified && (
            <div className="flex items-center gap-px ml-1">
              <button
                className="p-0.5 rounded text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover transition-colors"
                title="Previous Change"
                onClick={() => {
                  const editor = editorRef.current;
                  const decos = dirtyDecorationsRef.current;
                  if (!editor || !decos) return;
                  const ranges = decos.getRanges();
                  if (!ranges.length) return;
                  const curLine = editor.getPosition()?.lineNumber || 1;
                  // Find the last decoration line before cursor
                  let target = null;
                  for (let i = ranges.length - 1; i >= 0; i--) {
                    if (ranges[i].startLineNumber < curLine) { target = ranges[i]; break; }
                  }
                  if (!target) target = ranges[ranges.length - 1]; // wrap around
                  editor.revealLineInCenter(target.startLineNumber);
                  editor.setPosition({ lineNumber: target.startLineNumber, column: 1 });
                  editor.focus();
                }}
              >
                <ChevronUp size={12} />
              </button>
              <button
                className="p-0.5 rounded text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover transition-colors"
                title="Next Change"
                onClick={() => {
                  const editor = editorRef.current;
                  const decos = dirtyDecorationsRef.current;
                  if (!editor || !decos) return;
                  const ranges = decos.getRanges();
                  if (!ranges.length) return;
                  const curLine = editor.getPosition()?.lineNumber || 1;
                  let target = null;
                  for (let i = 0; i < ranges.length; i++) {
                    if (ranges[i].startLineNumber > curLine) { target = ranges[i]; break; }
                  }
                  if (!target) target = ranges[0]; // wrap around
                  editor.revealLineInCenter(target.startLineNumber);
                  editor.setPosition({ lineNumber: target.startLineNumber, column: 1 });
                  editor.focus();
                }}
              >
                <ChevronDown size={12} />
              </button>
            </div>
          )}
          {/* Preview toggle button */}
          {isPreviewable(activeTab.path) && (
            <button
              className={`ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
                previewMode[activeTab.id]
                  ? 'text-vsc-accent bg-vsc-accent/10'
                  : 'text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover'
              }`}
              onClick={() => {
                closeDiff();
                togglePreviewMode(activeTab.id);
              }}
              title={previewMode[activeTab.id] ? 'Show code' : 'Show preview'}
            >
              {previewMode[activeTab.id] ? <Code2 size={12} /> : <Eye size={12} />}
              {previewMode[activeTab.id] ? 'Code' : 'Preview'}
            </button>
          )}
          <button
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover transition-colors"
            onClick={async () => {
              if (!activeTab) return;
              const ext = activeTab.path.split('.').pop().toLowerCase();
              try {
                const r = await fetch('/api/format', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: activeTab.content, language: ext, filePath: activeTab.path })
                });
                const data = await r.json();
                if (r.ok && data.formatted) {
                  useAppStore.getState().updateTabContent(activeTab.id, data.formatted);
                }
              } catch (_) {}
            }}
            title="Format Document (Shift+Alt+F)"
          >
            <Wand2 size={12} />
            Format
          </button>
        </div>
      )}

      {/* AI Edit Bar — shown when AI has changed the currently open file, auto-opens diff */}
      {activeTab && (() => {
        const fileChange = chatFilesChanged.find(f => f.path === activeTab.path);
        if (!fileChange) return null;
        const totalEdits = (fileChange.linesAdded || 0) + (fileChange.linesRemoved || 0);
        return (
          <div className="flex items-center gap-2 px-3 py-1 bg-vsc-accent/5 border-b border-vsc-accent/20 no-select">
            <span className="text-[11px] text-vsc-text font-medium">
              {totalEdits} edit{totalEdits !== 1 ? 's' : ''}
            </span>
            {fileChange.linesAdded > 0 && <span className="text-[11px] text-vsc-success font-medium">+{fileChange.linesAdded}</span>}
            {fileChange.linesRemoved > 0 && <span className="text-[11px] text-vsc-error font-medium">-{fileChange.linesRemoved}</span>}
            <div className="flex-1" />
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover transition-colors"
              title="View diff of changes"
              onClick={() => {
                if (activeTab?.originalContent != null) {
                  openDiff(activeTab.originalContent, activeTab.content, activeTab.name);
                }
              }}
            >
              <Columns size={11} />
              View Diff
            </button>
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-success hover:bg-vsc-success/10 transition-colors"
              title="Keep all edits"
              onClick={() => {
                useAppStore.getState().markTabSaved(activeTab.id);
                setChatFilesChanged(chatFilesChanged.filter(f => f.path !== activeTab.path));
              }}
            >
              <Check size={11} />
              Keep
            </button>
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-text-dim hover:text-vsc-error hover:bg-vsc-error/10 transition-colors"
              title="Undo all edits to this file"
              onClick={() => {
                if (activeTab?.originalContent != null) {
                  useAppStore.getState().updateTabContent(activeTab.id, activeTab.originalContent);
                  const api = window.electronAPI;
                  if (api?.apiFetch) {
                    api.apiFetch('/api/files/write', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: activeTab.path, content: activeTab.originalContent }),
                    });
                  }
                }
                setChatFilesChanged(chatFilesChanged.filter(f => f.path !== activeTab.path));
              }}
            >
              <Undo2 size={11} />
              Undo
            </button>
          </div>
        );
      })()}

      {/* Monaco Editor, Diff Viewer, Preview, or Browser */}
      <div className="flex-1 min-h-0">
        {diffState && !(activeTab && previewMode[activeTab.id]) ? (
          <DiffViewer />
        ) : activeTab && activeTab.type === 'browser' ? (
          <BrowserPanel />
        ) : activeTab && previewMode[activeTab.id] && getPreviewType(activeTab.path) ? (
          (() => {
            const type = getPreviewType(activeTab.path);
            const toggle = () => setPreviewMode(activeTab.id, false);
            switch (type) {
              case 'html': return <HtmlPreview content={activeTab.content} filePath={activeTab.path} onToggleCode={toggle} />;
              case 'markdown': return <MarkdownPreview content={activeTab.content} filePath={activeTab.path} onToggleCode={toggle} />;
              case 'json': return <JsonPreview content={activeTab.content} filePath={activeTab.path} onToggleCode={toggle} />;
              case 'csv': return <CsvPreview content={activeTab.content} filePath={activeTab.path} onToggleCode={toggle} />;
              case 'svg': return <SvgPreview content={activeTab.content} filePath={activeTab.path} onToggleCode={toggle} />;
              case 'image': return <ImagePreview filePath={activeTab.path} dataUrl={activeTab.dataUrl} onToggleCode={toggle} />;
              case 'pdf': return <PdfPreview filePath={activeTab.path} dataUrl={activeTab.dataUrl} onToggleCode={toggle} />;
              default: return null;
            }
          })()
        ) : activeTab?.isBinary ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-vsc-text-dim">
            <p className="text-sm mb-2">This file is binary and cannot be shown as text.</p>
            <p className="text-[12px] mb-4">Use Preview to view the image or media content.</p>
            {isPreviewable(activeTab.path) && (
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded bg-vsc-accent/20 text-vsc-accent hover:bg-vsc-accent/30"
                onClick={() => setPreviewMode(activeTab.id, true)}
              >
                Show preview
              </button>
            )}
          </div>
        ) : activeTab ? (
          <Editor
            key={activeTab.id}
            defaultLanguage={activeTab.language}
            language={activeTab.language}
            value={activeTab.content}
            theme="vs-dark"
            onChange={(value) => {
              if (value !== undefined) {
                updateTabContent(activeTab.id, value);
                autoSaveTab(activeTab.id, value, activeTab.path);
              }
            }}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              errorLensRef.current = editor.createDecorationsCollection([]);
              initLspBridge(monaco);
              refreshLspDiagnosticsMode(monaco);

              const tabPath = activeTab?.path;
              const tabLang = activeTab?.language;
              const tabUri = tabPath ? pathToUri(tabPath) : '';

              const openDefinitionLocation = (loc) => {
                if (!loc?.uri) return;
                const targetPath = uriToPath(loc.uri);
                const line = (loc.range?.start?.line ?? 0) + 1;
                const col = (loc.range?.start?.character ?? 0) + 1;
                if (targetPath === tabPath) {
                  editor.revealLineInCenter(line);
                  editor.setPosition({ lineNumber: line, column: col });
                  editor.focus();
                  return;
                }
                const api = window.electronAPI;
                const readReq = api?.apiFetch
                  ? api.apiFetch(`/api/files/read?path=${encodeURIComponent(targetPath)}`)
                  : fetch(`/api/files/read?path=${encodeURIComponent(targetPath)}`).then((r) => r.json());
                readReq.then((d) => {
                  if (d?.content != null) {
                    useAppStore.getState().openFile({
                      path: targetPath,
                      name: targetPath.split(/[\\/]/).pop(),
                      extension: targetPath.split('.').pop(),
                      content: d.content,
                    });
                    setTimeout(() => {
                      const ed = editorRef.current;
                      if (ed) {
                        ed.revealLineInCenter(line);
                        ed.setPosition({ lineNumber: line, column: col });
                        ed.focus();
                      }
                    }, 100);
                  }
                }).catch(() => {});
              };

              // Track cursor position + send editor context to backend for AI awareness
              editor.onDidChangeCursorPosition((e) => {
                const pos = { line: e.position.lineNumber, column: e.position.column };
                setEditorCursorPosition(pos);
                setCursorLine(e.position.lineNumber);
                if (tabPath && window.electronAPI?.sendEditorContext) {
                  window.electronAPI.sendEditorContext({
                    activeFilePath: tabPath,
                    cursorLine: pos.line,
                    cursorCol: pos.column,
                  });
                }
              });
              const pos = editor.getPosition();
              if (pos) {
                setEditorCursorPosition({ line: pos.lineNumber, column: pos.column });
                setCursorLine(pos.lineNumber);
              }

              // Breakpoint glyph margin + Ctrl+click go-to-definition
              editor.onMouseDown((e) => {
                const target = e.target;
                if (target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
                  toggleBreakpoint(e.target.position.lineNumber, tabPath);
                  return;
                }
                if (e.event.ctrlKey && e.target.position && tabPath) {
                  const p = e.target.position;
                  requestDefinition({
                    uri: tabUri,
                    line: p.lineNumber - 1,
                    character: p.column - 1,
                    language: tabLang,
                    cwd: projectPath,
                  }).then((result) => {
                    const loc = Array.isArray(result) ? result[0] : result;
                    if (loc) openDefinitionLocation(loc);
                  }).catch(() => {});
                }
              });

              refreshBreakpointDecorations(editor, tabPath);
              // Track text selection
              editor.onDidChangeCursorSelection((e) => {
                const sel = e.selection;
                if (sel.isEmpty()) {
                  setEditorSelection(null);
                } else {
                  const model = editor.getModel();
                  const text = model.getValueInRange(sel);
                  const lines = sel.endLineNumber - sel.startLineNumber + 1;
                  setEditorSelection({ chars: text.length, lines });
                }
              });
              // Track diagnostics (errors/warnings) + push to backend for AI feedback loop
              const syncWorkspaceProblems = () => {
                const allMarkers = monaco.editor.getModelMarkers({});
                let errors = 0, warnings = 0;
                const problems = [];
                for (const m of allMarkers) {
                  if (m.severity === monaco.MarkerSeverity.Error) errors++;
                  else if (m.severity === monaco.MarkerSeverity.Warning) warnings++;
                  const model = monaco.editor.getModel(m.resource);
                  const filePath = model?.uri?.fsPath || model?.uri?.path?.replace(/^\//, '') || '';
                  problems.push({
                    file: filePath,
                    line: m.startLineNumber,
                    column: m.startColumn,
                    message: m.message,
                    severity: m.severity === monaco.MarkerSeverity.Error ? 'error'
                      : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
                    source: m.source || 'editor',
                  });
                }
                setEditorDiagnostics({ errors, warnings });
                setWorkspaceProblems(problems);

                // Error Lens — inline diagnostic hints on active file
                const activeModel = editor.getModel();
                if (activeModel && errorLensRef.current) {
                  const fileMarkers = monaco.editor.getModelMarkers({ resource: activeModel.uri });
                  const decos = fileMarkers
                    .filter((m) => m.severity === monaco.MarkerSeverity.Error || m.severity === monaco.MarkerSeverity.Warning)
                    .slice(0, 40)
                    .map((m) => ({
                      range: new monaco.Range(
                        m.startLineNumber,
                        activeModel.getLineMaxColumn(m.startLineNumber),
                        m.startLineNumber,
                        activeModel.getLineMaxColumn(m.startLineNumber),
                      ),
                      options: {
                        after: {
                          content: `  ${(m.message || '').slice(0, 100)}`,
                          inlineClassName: m.severity === monaco.MarkerSeverity.Error
                            ? 'guide-error-lens-error'
                            : 'guide-error-lens-warn',
                        },
                      },
                    }));
                  errorLensRef.current.set(decos);
                }
              };

              // TypeScript/JavaScript IntelliSense defaults (Monaco built-in TS worker)
              if (monaco.languages?.typescript) {
                const tsOpts = {
                  target: monaco.languages.typescript.ScriptTarget.ESNext,
                  allowNonTsExtensions: true,
                  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
                  module: monaco.languages.typescript.ModuleKind.ESNext,
                  noEmit: true,
                  esModuleInterop: true,
                  jsx: monaco.languages.typescript.JsxEmit.React,
                  allowJs: true,
                  strict: false,
                };
                monaco.languages.typescript.typescriptDefaults.setCompilerOptions(tsOpts);
                monaco.languages.typescript.javascriptDefaults.setCompilerOptions(tsOpts);
                monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
                monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
              }

              // LSP completion provider
              const langId = tabLang || 'plaintext';
              const lspCompletionDisposable = monaco.languages.registerCompletionItemProvider(
                langId,
                {
                  triggerCharacters: ['.', ':', '<', '"', '/', '@', '#'],
                  provideCompletionItems: async (model, position) => {
                    const fp = model.uri?.fsPath || tabPath;
                    if (!fp) return { suggestions: [] };
                    const uri = pathToUri(fp);
                    try {
                      const result = await requestCompletion({
                        uri,
                        line: position.lineNumber - 1,
                        character: position.column - 1,
                        language: model.getLanguageId(),
                        cwd: projectPath,
                      });
                      const items = Array.isArray(result) ? result : result?.items || [];
                      const word = model.getWordUntilPosition(position);
                      const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: word.endColumn,
                      };
                      return {
                        suggestions: items.map((item) => ({
                          label: typeof item.label === 'string' ? item.label : item.label?.label || String(item.label),
                          kind: item.kind ?? monaco.languages.CompletionItemKind.Text,
                          insertText: item.insertText ?? (typeof item.label === 'string' ? item.label : item.label?.label),
                          range,
                          detail: item.detail,
                          documentation: item.documentation,
                          sortText: item.sortText,
                        })),
                      };
                    } catch {
                      return { suggestions: [] };
                    }
                  },
                },
              );

              // LSP hover provider
              const lspHoverDisposable = monaco.languages.registerHoverProvider(
                langId,
                {
                  provideHover: async (model, position) => {
                    const fp = model.uri?.fsPath || tabPath;
                    if (!fp) return null;
                    try {
                      const result = await requestHover({
                        uri: pathToUri(fp),
                        line: position.lineNumber - 1,
                        character: position.column - 1,
                        language: model.getLanguageId(),
                        cwd: projectPath,
                      });
                      if (!result) return null;
                      const value = typeof result.contents === 'string'
                        ? result.contents
                        : Array.isArray(result.contents)
                          ? result.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n')
                          : result.contents?.value || '';
                      if (!value) return null;
                      return { range: new monaco.Range(position.lineNumber, 1, position.lineNumber, 1), contents: [{ value }] };
                    } catch {
                      return null;
                    }
                  },
                },
              );

              // GitLens-lite — blame on hover
              let blameCache = null;
              let blameCachePath = null;
              const gitBlameHoverDisposable = monaco.languages.registerHoverProvider('*', {
                provideHover: async (model, position) => {
                  const fp = model.uri?.fsPath;
                  if (!fp || !projectPath) return null;
                  const rel = fp.startsWith(projectPath)
                    ? fp.slice(projectPath.length).replace(/^[/\\]+/, '').replace(/\\/g, '/')
                    : fp.split(/[/\\]/).pop();
                  if (blameCachePath !== fp) {
                    try {
                      const r = await fetch(`/api/git/blame?file=${encodeURIComponent(rel)}&path=${encodeURIComponent(projectPath)}`);
                      const d = await r.json();
                      blameCache = d.lines || [];
                      blameCachePath = fp;
                    } catch {
                      return null;
                    }
                  }
                  const line = blameCache?.[position.lineNumber - 1];
                  if (!line) return null;
                  return {
                    contents: [{
                      value: `**${line.author}** · ${line.date} \`${line.hash}\`${line.summary ? `\n\n${line.summary}` : ''}`,
                    }],
                  };
                },
              });

              // LSP go-to-definition provider (F12 / Ctrl+click via Monaco)
              const lspDefinitionDisposable = monaco.languages.registerDefinitionProvider(
                langId,
                {
                  provideDefinition: async (model, position) => {
                    const fp = model.uri?.fsPath || tabPath;
                    if (!fp) return null;
                    try {
                      const result = await requestDefinition({
                        uri: pathToUri(fp),
                        line: position.lineNumber - 1,
                        character: position.column - 1,
                        language: model.getLanguageId(),
                        cwd: projectPath,
                      });
                      const locs = Array.isArray(result) ? result : result ? [result] : [];
                      return locs.map((loc) => ({
                        uri: monaco.Uri.parse(loc.uri),
                        range: new monaco.Range(
                          (loc.range?.start?.line ?? 0) + 1,
                          (loc.range?.start?.character ?? 0) + 1,
                          (loc.range?.end?.line ?? 0) + 1,
                          (loc.range?.end?.character ?? 0) + 1,
                        ),
                      }));
                    } catch {
                      return null;
                    }
                  },
                },
              );

              // AI inline completion (secondary to LSP suggest)
              const completionDisposable = monaco.languages.registerInlineCompletionsProvider('*', {
                provideInlineCompletions: async (model, position) => {
                  const offset = model.getOffsetAt(position);
                  const full = model.getValue();
                  const prefix = full.slice(0, offset);
                  const suffix = full.slice(offset);
                  try {
                    const r = await fetch('/api/complete', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        filePath: activeTab?.path,
                        language: model.getLanguageId(),
                        prefix,
                        suffix,
                        line: position.lineNumber,
                        column: position.column,
                      }),
                    });
                    const d = await r.json();
                    if (!d?.text) return { items: [] };
                    return {
                      items: [{
                        insertText: d.text,
                        range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                      }],
                    };
                  } catch {
                    return { items: [] };
                  }
                },
                disposeInlineCompletions: () => {},
              });

              const disposables = [completionDisposable, lspCompletionDisposable, lspHoverDisposable, lspDefinitionDisposable, gitBlameHoverDisposable];
              lspDisposablesRef.current = disposables;
              editor.onDidDispose(() => disposables.forEach((d) => d.dispose()));

              monaco.editor.onDidChangeMarkers(() => syncWorkspaceProblems());
              syncWorkspaceProblems();
              monaco.editor.onDidChangeMarkers(([resource]) => {
                const markers = monaco.editor.getModelMarkers({ resource });
                let fileErrors = 0, fileWarnings = 0;
                const details = [];
                for (const m of markers) {
                  if (m.severity === monaco.MarkerSeverity.Error) fileErrors++;
                  else if (m.severity === monaco.MarkerSeverity.Warning) fileWarnings++;
                  if (details.length < 20) {
                    details.push({
                      line: m.startLineNumber,
                      message: m.message,
                      severity: m.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning',
                    });
                  }
                }
                // Push per-file diagnostics to main process for AI tool feedback
                const model = monaco.editor.getModel(resource);
                const filePath = model?.uri?.fsPath || activeTab?.path || '';
                if (filePath && window.electronAPI?.sendDiagnostics) {
                  window.electronAPI.sendDiagnostics({ filePath, errors: fileErrors, warnings: fileWarnings, details });
                }
              });
            }}
            options={{
              fontSize: 14,
              fontFamily: 'Consolas, "Courier New", monospace',
              minimap: { enabled: minimapEnabled, scale: 1 },
              scrollBeyondLastLine: true,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              wordWrap: 'off',
              tabSize: editorIndentSize,
              insertSpaces: editorIndentType === 'spaces',
              automaticLayout: true,
              padding: { top: 8 },
              lineNumbers: 'on',
              glyphMargin: true,
              folding: true,
              renderLineHighlight: 'all',
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
                useShadows: false,
                verticalHasArrows: false,
                horizontalHasArrows: false,
                arrowSize: 0,
              },
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              parameterHints: { enabled: true },
              formatOnPaste: false,
              formatOnType: false,
            }}
            loading={
              <div className="flex items-center justify-center h-full text-vsc-text-dim">
                <div className="spinner mr-2" />
                Loading editor...
              </div>
            }
          />
        ) : null}
      </div>

      {/* Inline Chat Widget */}
      {inlineChat && (
        <InlineChat
          position={{ top: inlineChat.top, left: inlineChat.left }}
          selectedText={inlineChat.selectedText}
          onApplyEdit={(newCode) => {
            // Replace the selected text (or insert at cursor) with the accepted edit
            const editor = editorRef.current;
            if (!editor) return;
            const sel = editor.getSelection();
            const model = editor.getModel();
            if (sel && !sel.isEmpty()) {
              // Replace selection
              editor.executeEdits('inline-chat-accept', [{
                range: sel,
                text: newCode,
              }]);
            } else {
              // Insert at cursor position
              const pos = editor.getPosition();
              if (pos) {
                editor.executeEdits('inline-chat-accept', [{
                  range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column },
                  text: newCode,
                }]);
              }
            }
          }}
          onClose={() => setInlineChat(null)}
        />
      )}
    </div>
  );
}

function WelcomeScreen() {
  const setActiveActivity = useAppStore(s => s.setActiveActivity);
  const toggleChatPanel = useAppStore(s => s.toggleChatPanel);
  const openCommandPalette = useAppStore(s => s.openCommandPalette);

  const openFolder = () => {
    const doOpen = (path) => {
      if (!path) return;
      fetch('/api/project/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: path }),
      }).then(r => r.json()).then(d => {
        if (d.success) {
          useAppStore.getState().setProjectPath(d.path);
          fetch(`/api/files/tree?path=${encodeURIComponent(d.path)}`)
            .then(r => r.json())
            .then(t => useAppStore.getState().setFileTree(t.items || []))
            .catch(() => {});
        }
      }).catch(() => {});
    };

    if (window.electronAPI?.openFolderDialog) {
      window.electronAPI.openFolderDialog().then(result => {
        if (result) doOpen(result);
      });
    } else {
      const path = prompt('Enter folder path to open:');
      if (path) doOpen(path);
    }
  };

  return (
    <div className="welcome-tab relative overflow-hidden">
      {/* Animated wavy lines — thin dashed strokes, theme-reactive */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <svg className="absolute bottom-0 left-0 w-full h-full" viewBox="0 0 1200 400" preserveAspectRatio="none">
          <path fill="none" stroke="currentColor" className="text-vsc-accent" strokeWidth="0.8" strokeDasharray="10 8" opacity="0.10"
            d="M-100,300 C50,260 200,340 400,280 C600,220 800,320 1000,270 C1200,220 1350,300 1500,260">
            <animateTransform attributeName="transform" type="translate" values="0,0;-30,0;0,0" dur="25s" repeatCount="indefinite" />
          </path>
          <path fill="none" stroke="currentColor" className="text-vsc-accent" strokeWidth="0.6" strokeDasharray="6 12" opacity="0.06"
            d="M-50,365 C100,330 250,385 450,340 C650,295 850,370 1050,325 C1250,280 1400,355 1550,315">
            <animateTransform attributeName="transform" type="translate" values="0,0;20,0;0,0" dur="35s" repeatCount="indefinite" />
          </path>
        </svg>
        {/* Radial glow behind content */}
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[300px] h-[200px] rounded-full bg-vsc-accent/[0.03]" style={{ filter: 'blur(80px)' }} />
      </div>

      <GuideLogo size={48} className="relative z-10 mb-3 mx-auto" />
      <h1 className="font-brand text-vsc-accent relative z-10">guIDE</h1>
      <p className="relative z-10">Local-first AI-powered IDE. Zero cloud dependency.</p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4 w-full max-w-xl mx-auto text-left relative z-10">
        {/* Start */}
        <div>
          <h3 className="text-vsc-xs font-semibold text-vsc-text-dim tracking-wider mb-2">Start</h3>
          <div className="flex flex-col gap-1">
            <button className="welcome-action" onClick={openFolder}>
              <FolderOpen size={16} />
              Open Folder...
            </button>
            <button className="welcome-action" onClick={toggleChatPanel}>
              <MessageSquare size={16} />
              Open AI Chat
            </button>
            <button className="welcome-action" onClick={() => setActiveActivity('settings')}>
              <Settings size={16} />
              Configure Model
            </button>
            <button className="welcome-action" onClick={openCommandPalette}>
              <FileText size={16} />
              Command Palette
            </button>
          </div>
        </div>

        {/* Shortcuts */}
        <div>
          <h3 className="text-vsc-xs font-semibold text-vsc-text-dim tracking-wider mb-2">Keyboard Shortcuts</h3>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-vsc-xs">
            <kbd className="kbd">Ctrl+Shift+P</kbd><span className="text-vsc-text">Command Palette</span>
            <kbd className="kbd">Ctrl+B</kbd><span className="text-vsc-text">Toggle Sidebar</span>
            <kbd className="kbd">Ctrl+J</kbd><span className="text-vsc-text">Toggle Panel</span>
            <kbd className="kbd">Ctrl+S</kbd><span className="text-vsc-text">Save File</span>
            <kbd className="kbd">Ctrl+L</kbd><span className="text-vsc-text">Toggle AI Chat</span>
            <kbd className="kbd">Ctrl+P</kbd><span className="text-vsc-text">Quick Open</span>
            <kbd className="kbd">Ctrl+/</kbd><span className="text-vsc-text">Toggle Comment</span>
            <kbd className="kbd">Ctrl+`</kbd><span className="text-vsc-text">Toggle Terminal</span>
          </div>
        </div>
      </div>

      <p className="mt-8 text-[10px] text-vsc-text-dim/50 relative z-10">guIDE — Built for local AI inference</p>
    </div>
  );
}



function TabContextMenu({
  x, y, tabId, isBrowserTab, editorSplit, onClose, onCloseTab, onCloseOthers, onCloseAll, onCloseSaved, onCopyPath, onReload, onToggleSplit,
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const style = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 180),
    zIndex: 9999,
  };

  return (
    <div ref={menuRef} className="context-menu" style={style}>
      {isBrowserTab && onReload && (
        <button className="context-menu-item" onClick={() => onReload()}>
          <RefreshCw size={14} className="mr-2 text-vsc-text-dim" /> Reload
        </button>
      )}
      {isBrowserTab && onReload && <div className="context-menu-separator" />}
      <button className="context-menu-item" onClick={() => { onCloseTab(tabId); onClose(); }}>
        <X size={14} className="mr-2 text-vsc-text-dim" /> Close
      </button>
      <button className="context-menu-item" onClick={() => onCloseOthers(tabId)}>
        <X size={14} className="mr-2 text-vsc-text-dim" /> Close Others
      </button>
      <button className="context-menu-item" onClick={() => onCloseAll()}>
        <X size={14} className="mr-2 text-vsc-text-dim" /> Close All
      </button>
      <button className="context-menu-item" onClick={() => { onCloseSaved(); onClose(); }}>
        <X size={14} className="mr-2 text-vsc-text-dim" /> Close Saved
      </button>
      <div className="context-menu-separator" />
      <button className="context-menu-item" onClick={() => onCopyPath(tabId)}>
        <Copy size={14} className="mr-2 text-vsc-text-dim" /> Copy Path
      </button>
      {onToggleSplit && (
        <>
          <div className="context-menu-separator" />
          <button className="context-menu-item" onClick={() => { onToggleSplit(); onClose(); }}>
            <Columns size={14} className="mr-2 text-vsc-text-dim" /> {editorSplit ? 'Close Split Editor' : 'Split Editor Right'}
          </button>
        </>
      )}
    </div>
  );
}
