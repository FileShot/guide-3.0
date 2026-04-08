/**
 * TitleBar — Custom title bar with guIDE branding (Audiowide font).
 * Shows hamburger menu, centered search bar, and window controls.
 * Requires frame:false in BrowserWindow + preload.js windowControls IPC.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useAppStore from '../stores/appStore';
import { Search, Menu, ChevronRight, X, PanelLeft, PanelBottom, PanelRight, LayoutTemplate } from 'lucide-react';

const wc = () => window.electronAPI?.windowControls;

export default function TitleBar() {
  const projectPath = useAppStore(s => s.projectPath);
  const connected = useAppStore(s => s.connected);
  const fileTree = useAppStore(s => s.fileTree);
  const openFile = useAppStore(s => s.openFile);
  const sidebarVisible = useAppStore(s => s.sidebarVisible);
  const panelVisible = useAppStore(s => s.panelVisible);
  const chatPanelVisible = useAppStore(s => s.chatPanelVisible);
  const toggleSidebar = useAppStore(s => s.toggleSidebar);
  const togglePanel = useAppStore(s => s.togglePanel);
  const toggleChatPanel = useAppStore(s => s.toggleChatPanel);
  const [maximized, setMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState(null);    // hamburger panel
  const [expandedCat, setExpandedCat] = useState(null); // expanded category in hamburger
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const layoutMenuRef = useRef(null);
  const searchInputRef = useRef(null);

  const projectName = projectPath ? projectPath.split(/[\\/]/).pop() : '';
  const title = projectName ? `${projectName}` : '';

  useEffect(() => {
    const check = async () => {
      const m = await wc()?.isMaximized?.();
      setMaximized(!!m);
    };
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, []);

  // Close hamburger / search on Escape or click outside
  useEffect(() => {
    if (!openMenu && !searchActive && !layoutMenuOpen) return;
    const handleClick = (e) => {
      if (openMenu && !e.target.closest('.hamburger-panel') && !e.target.closest('.hamburger-trigger')) {
        setOpenMenu(null);
        setExpandedCat(null);
      }
      if (searchActive && !e.target.closest('.search-bar-container')) {
        setSearchActive(false);
        setSearchQuery('');
      }
      if (layoutMenuOpen && layoutMenuRef.current && !layoutMenuRef.current.contains(e.target)) {
        setLayoutMenuOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        setExpandedCat(null);
        setSearchActive(false);
        setSearchQuery('');
        setLayoutMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openMenu, searchActive, layoutMenuOpen]);

  // Ctrl+P to activate search bar
  useEffect(() => {
    const handleGlobalKey = (e) => {
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        setSearchActive(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);

  // Focus search input when activated
  useEffect(() => {
    if (searchActive) searchInputRef.current?.focus();
  }, [searchActive]);

  // Flatten file tree for search
  const flatFiles = useMemo(() => {
    const result = [];
    const walk = (items, parentPath = '') => {
      for (const item of items || []) {
        const fullPath = parentPath ? `${parentPath}/${item.name}` : item.name;
        if (item.type === 'file') {
          result.push({ name: item.name, path: fullPath, fullPath: item.path || fullPath });
        }
        if (item.children) walk(item.children, fullPath);
      }
    };
    walk(fileTree);
    return result;
  }, [fileTree]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return flatFiles
      .filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 12);
  }, [searchQuery, flatFiles]);

  const handleSearchSelect = (file) => {
    openFile({
      path: file.fullPath,
      name: file.name,
      extension: file.name.split('.').pop() || '',
      content: '',
    });
    setSearchActive(false);
    setSearchQuery('');
  };

  return (
    <div className="h-titlebar bg-vsc-titlebar flex items-center no-select text-vsc-sm border-b border-vsc-panel-border/50"
         style={{ WebkitAppRegion: 'drag' }}>
      {/* Brand + Hamburger */}
      <div className="flex items-center pl-2 pr-2 gap-1" style={{ WebkitAppRegion: 'no-drag' }}>
        {/* Hamburger button */}
        <button
          className={`hamburger-trigger p-1.5 rounded transition-colors duration-150
            ${openMenu ? 'bg-vsc-list-hover text-vsc-text' : 'text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover/60'}`}
          onClick={() => { setOpenMenu(openMenu ? null : 'main'); setExpandedCat(null); }}
        >
          {openMenu ? <X size={14} /> : <Menu size={14} />}
        </button>

        <div
          className="w-4 h-4 flex-shrink-0 bg-vsc-accent"
          style={{ mask: 'url(/icon.png) center/contain no-repeat', WebkitMask: 'url(/icon.png) center/contain no-repeat' }}
          title="guIDE"
        />
      </div>

      {/* Hamburger Panel */}
      {openMenu && (
        <div className="hamburger-panel absolute top-titlebar left-2 bg-vsc-dropdown/95 backdrop-blur-xl border border-vsc-dropdown-border rounded-lg shadow-2xl z-[9999] w-[280px] py-1.5 max-h-[80vh] overflow-y-auto">
          {MENUS.map(menu => (
            <div key={menu.label}>
              <button
                className="flex items-center w-full px-3 py-1.5 text-[12px] font-medium text-vsc-text hover:bg-vsc-list-hover transition-colors duration-100"
                onClick={() => setExpandedCat(expandedCat === menu.label ? null : menu.label)}
              >
                <ChevronRight size={12} className={`mr-1.5 text-vsc-text-dim transition-transform duration-150 ${expandedCat === menu.label ? 'rotate-90' : ''}`} />
                <span>{menu.label}</span>
              </button>
              {expandedCat === menu.label && (
                <div className="pl-3 pb-1">
                  {menu.items.map((item, i) => {
                    if (item.type === 'separator') {
                      return <div key={i} className="border-t border-vsc-panel-border/30 my-1 mx-2" />;
                    }
                    return (
                      <button
                        key={i}
                        className="flex items-center w-full px-3 py-1 text-vsc-xs text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover/60 transition-colors duration-100 rounded"
                        onClick={() => { executeMenuAction(item.action); setOpenMenu(null); setExpandedCat(null); }}
                      >
                        <span className="flex-1 text-left">{item.label}</span>
                        {item.shortcut && <span className="text-vsc-text-dim/60 ml-3 text-[10px]">{item.shortcut}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Center — Search Bar */}
      <div className="flex-1 flex justify-center px-4" style={{ WebkitAppRegion: 'no-drag' }}>
        <div className="search-bar-container relative w-full max-w-[480px]">
          {searchActive ? (
            <>
              <div className="flex items-center bg-vsc-input border border-vsc-input-border rounded-md px-2.5 py-0.5 gap-1.5 shadow-lg">
                <Search size={12} className="text-vsc-text-dim flex-shrink-0" />
                <input
                  ref={searchInputRef}
                  className="flex-1 bg-transparent border-none outline-none text-vsc-xs text-vsc-text placeholder:text-vsc-text-dim/50"
                  placeholder="Search files by name (Ctrl+P)"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && searchResults.length > 0) {
                      handleSearchSelect(searchResults[0]);
                    }
                    if (e.key === 'Escape') {
                      setSearchActive(false);
                      setSearchQuery('');
                    }
                  }}
                />
                <button
                  className="p-0.5 text-vsc-text-dim hover:text-vsc-text"
                  onClick={() => { setSearchActive(false); setSearchQuery(''); }}
                >
                  <X size={11} />
                </button>
              </div>
              {/* Search Results Dropdown */}
              {searchQuery && searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-vsc-dropdown/95 backdrop-blur-xl border border-vsc-dropdown-border rounded-lg shadow-2xl z-[9999] max-h-[300px] overflow-y-auto py-1">
                  {searchResults.map((file, i) => (
                    <button
                      key={file.fullPath}
                      className={`flex items-center w-full px-3 py-1.5 text-vsc-xs hover:bg-vsc-list-hover transition-colors ${i === 0 ? 'bg-vsc-list-hover/40' : ''}`}
                      onClick={() => handleSearchSelect(file)}
                    >
                      <span className="text-vsc-text font-medium truncate">{file.name}</span>
                      <span className="ml-2 text-[10px] text-vsc-text-dim/60 truncate">{file.path}</span>
                    </button>
                  ))}
                </div>
              )}
              {searchQuery && searchResults.length === 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-vsc-dropdown/95 backdrop-blur-xl border border-vsc-dropdown-border rounded-lg shadow-2xl z-[9999] py-3 px-4">
                  <span className="text-vsc-xs text-vsc-text-dim">No matching files</span>
                </div>
              )}
            </>
          ) : (
            <button
              className="flex items-center justify-center gap-1.5 w-full px-3 py-0.5 rounded-md text-vsc-xs text-vsc-text-dim/70 hover:text-vsc-text-dim hover:bg-vsc-list-hover/40 transition-colors duration-150 border border-transparent hover:border-vsc-panel-border/30"
              onClick={() => setSearchActive(true)}
            >
              <Search size={11} />
              <span className="truncate">{title || 'Search files (Ctrl+P)'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Right — Layout toggles + status */}
      <div className="flex items-center gap-0.5 pr-1" style={{ WebkitAppRegion: 'no-drag' }}>
        {/* Layout toggle buttons — VS Code title bar style */}
        <button
          className={`p-1 rounded transition-colors duration-150 ${sidebarVisible ? 'text-vsc-text hover:bg-vsc-list-hover/60' : 'text-vsc-text-dim/50 hover:bg-vsc-list-hover/40 hover:text-vsc-text-dim'}`}
          title="Toggle Primary Sidebar"
          onClick={toggleSidebar}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className={`p-1 rounded transition-colors duration-150 ${panelVisible ? 'text-vsc-text hover:bg-vsc-list-hover/60' : 'text-vsc-text-dim/50 hover:bg-vsc-list-hover/40 hover:text-vsc-text-dim'}`}
          title="Toggle Bottom Panel"
          onClick={togglePanel}
        >
          <PanelBottom size={14} />
        </button>
        <button
          className={`p-1 rounded transition-colors duration-150 ${chatPanelVisible ? 'text-vsc-text hover:bg-vsc-list-hover/60' : 'text-vsc-text-dim/50 hover:bg-vsc-list-hover/40 hover:text-vsc-text-dim'}`}
          title="Toggle Chat Panel"
          onClick={toggleChatPanel}
        >
          <PanelRight size={14} />
        </button>

        {/* Customize Layout dropdown */}
        <div className="relative" ref={layoutMenuRef}>
          <button
            className={`p-1 rounded transition-colors duration-150 ${layoutMenuOpen ? 'text-vsc-text bg-vsc-list-hover/60' : 'text-vsc-text-dim hover:bg-vsc-list-hover/60 hover:text-vsc-text'}`}
            title="Customize Layout"
            onClick={() => setLayoutMenuOpen(!layoutMenuOpen)}
          >
            <LayoutTemplate size={14} />
          </button>
          {layoutMenuOpen && (
            <div className="absolute top-full right-0 mt-1 bg-vsc-dropdown/95 backdrop-blur-xl border border-vsc-dropdown-border rounded-lg shadow-2xl z-[9999] w-[180px] py-1 text-[12px]">
              <button
                className="flex items-center w-full px-3 py-1.5 text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover/60 transition-colors"
                onClick={() => {
                  useAppStore.setState({ sidebarVisible: true, panelVisible: false, chatPanelVisible: true });
                  setLayoutMenuOpen(false);
                }}
              >
                Default layout
              </button>
              <button
                className="flex items-center w-full px-3 py-1.5 text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover/60 transition-colors"
                onClick={() => {
                  useAppStore.setState({ sidebarVisible: false, panelVisible: false, chatPanelVisible: false });
                  setLayoutMenuOpen(false);
                }}
              >
                Focus Mode (editor only)
              </button>
              <button
                className="flex items-center w-full px-3 py-1.5 text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover/60 transition-colors"
                onClick={() => {
                  useAppStore.setState({ sidebarVisible: true, panelVisible: true, chatPanelVisible: true });
                  setLayoutMenuOpen(false);
                }}
              >
                Show all panels
              </button>
            </div>
          )}
        </div>

        {/* Connection status dot */}
        <div className={`w-1.5 h-1.5 rounded-full ml-1 ${connected ? 'bg-vsc-success' : 'bg-vsc-error'}`}
             title={connected ? 'Connected' : 'Disconnected'} />
      </div>

      {/* Window Controls */}
      <div className="flex items-stretch h-full ml-1" style={{ WebkitAppRegion: 'no-drag' }}>
        <WinBtn title="Minimize" onClick={() => wc()?.minimize()}>
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </WinBtn>
        <WinBtn title={maximized ? 'Restore' : 'Maximize'} onClick={() => wc()?.maximize()}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="2" y="0" width="8" height="8" rx="0.5" stroke="currentColor" strokeWidth="1"/>
              <rect x="0" y="2" width="8" height="8" rx="0.5" fill="var(--vsc-titlebar,#1e1e2e)" stroke="currentColor" strokeWidth="1"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1"/>
            </svg>
          )}
        </WinBtn>
        <WinBtn title="Close" onClick={() => wc()?.close()} isClose>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/>
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
        </WinBtn>
      </div>
    </div>
  );
}

// ─── Menu definitions ────────────────────────────────────

const MENUS = [
  {
    label: 'File',
    items: [
      { label: 'New File', shortcut: 'Ctrl+N', action: 'newFile' },
      { label: 'Open Folder...', shortcut: 'Ctrl+K Ctrl+O', action: 'openFolder' },
      { type: 'separator' },
      { label: 'Save', shortcut: 'Ctrl+S', action: 'save' },
      { label: 'Save All', shortcut: 'Ctrl+K S', action: 'saveAll' },
      { type: 'separator' },
      { label: 'Close Editor', shortcut: 'Ctrl+W', action: 'closeTab' },
      { label: 'Close All Editors', action: 'closeAllTabs' },
      { type: 'separator' },
      { label: 'Exit', shortcut: 'Alt+F4', action: 'exit' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', action: 'undo' },
      { label: 'Redo', shortcut: 'Ctrl+Y', action: 'redo' },
      { type: 'separator' },
      { label: 'Cut', shortcut: 'Ctrl+X', action: 'cut' },
      { label: 'Copy', shortcut: 'Ctrl+C', action: 'copy' },
      { label: 'Paste', shortcut: 'Ctrl+V', action: 'paste' },
      { type: 'separator' },
      { label: 'Find', shortcut: 'Ctrl+F', action: 'find' },
      { label: 'Replace', shortcut: 'Ctrl+H', action: 'replace' },
      { label: 'Find in Files', shortcut: 'Ctrl+Shift+F', action: 'findInFiles' },
    ],
  },
  {
    label: 'Selection',
    items: [
      { label: 'Select All', shortcut: 'Ctrl+A', action: 'selectAll' },
      { label: 'Expand Selection', shortcut: 'Shift+Alt+Right', action: 'expandSelection' },
      { label: 'Shrink Selection', shortcut: 'Shift+Alt+Left', action: 'shrinkSelection' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Command Palette...', shortcut: 'Ctrl+Shift+P', action: 'commandPalette' },
      { type: 'separator' },
      { label: 'Explorer', shortcut: 'Ctrl+Shift+E', action: 'showExplorer' },
      { label: 'Search', shortcut: 'Ctrl+Shift+F', action: 'showSearch' },
      { label: 'Source Control', shortcut: 'Ctrl+Shift+G', action: 'showGit' },
      { label: 'AI Chat', shortcut: 'Ctrl+Shift+A', action: 'showChat' },
      { type: 'separator' },
      { label: 'Toggle Sidebar', shortcut: 'Ctrl+B', action: 'toggleSidebar' },
      { label: 'Toggle Panel', shortcut: 'Ctrl+J', action: 'togglePanel' },
      { label: 'Toggle Chat Panel', action: 'toggleChat' },
      { type: 'separator' },
      { label: 'Toggle Minimap', action: 'toggleMinimap' },
      { label: 'Toggle Word Wrap', action: 'toggleWordWrap' },
      { type: 'separator' },
      { label: 'Zoom In', shortcut: 'Ctrl+=', action: 'zoomIn' },
      { label: 'Zoom Out', shortcut: 'Ctrl+-', action: 'zoomOut' },
      { label: 'Reset Zoom', shortcut: 'Ctrl+0', action: 'zoomReset' },
    ],
  },
  {
    label: 'Go',
    items: [
      { label: 'Go to File...', shortcut: 'Ctrl+P', action: 'goToFile' },
      { label: 'Go to Line...', shortcut: 'Ctrl+G', action: 'goToLine' },
    ],
  },
  {
    label: 'Terminal',
    items: [
      { label: 'New Terminal', shortcut: 'Ctrl+`', action: 'newTerminal' },
      { label: 'Toggle Terminal', shortcut: 'Ctrl+J', action: 'togglePanel' },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Welcome', action: 'showWelcome' },
      { label: 'Keyboard Shortcuts', shortcut: 'Ctrl+K Ctrl+S', action: 'showShortcuts' },
      { type: 'separator' },
      { label: 'About guIDE', action: 'about' },
    ],
  },
];

// ─── Action handler ──────────────────────────────────────

function executeMenuAction(action) {
  const store = useAppStore.getState();
  switch (action) {
    // File
    case 'newFile': {
      const name = prompt('New file name:');
      if (!name) return;
      const base = store.projectPath;
      if (!base) { store.addNotification({ type: 'error', message: 'Open a folder first' }); return; }
      fetch('/api/files/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${base}/${name}`, content: '' }),
      }).then(r => r.json()).then(d => {
        if (d.error) store.addNotification({ type: 'error', message: d.error });
        else store.openFile({ path: d.path, name, extension: name.split('.').pop(), content: '' });
      }).catch(e => store.addNotification({ type: 'error', message: e.message }));
      return;
    }
    case 'openFolder': {
      const path = prompt('Enter folder path to open:');
      if (path) {
        fetch(`/api/files/tree?path=${encodeURIComponent(path)}`)
          .then(r => r.json())
          .then(d => {
            if (d.error) store.addNotification({ type: 'error', message: d.error });
            else { store.setProjectPath(path); store.setFileTree(d.tree || []); }
          }).catch(() => {});
      }
      return;
    }
    case 'save':
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
      return;
    case 'saveAll':
      store.addNotification({ type: 'info', message: 'All files saved' });
      return;
    case 'closeTab':
      if (store.activeTabId) store.closeTab(store.activeTabId);
      return;
    case 'closeAllTabs':
      store.openTabs.forEach(t => store.closeTab(t.id));
      return;
    case 'exit':
      wc()?.close();
      return;

    // Edit — these dispatch native browser commands, Monaco handles them
    case 'undo': document.execCommand('undo'); return;
    case 'redo': document.execCommand('redo'); return;
    case 'cut': document.execCommand('cut'); return;
    case 'copy': document.execCommand('copy'); return;
    case 'paste': navigator.clipboard?.readText().then(t => document.execCommand('insertText', false, t)).catch(() => {}); return;
    case 'find': document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true })); return;
    case 'replace': document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true })); return;
    case 'findInFiles': store.setActiveActivity('search'); return;
    case 'selectAll': document.execCommand('selectAll'); return;
    case 'expandSelection': return;
    case 'shrinkSelection': return;

    // View
    case 'commandPalette': store.toggleCommandPalette(); return;
    case 'showExplorer': store.setActiveActivity('explorer'); return;
    case 'showSearch': store.setActiveActivity('search'); return;
    case 'showGit': store.setActiveActivity('git'); return;
    case 'showChat': store.toggleChatPanel(); return;
    case 'toggleSidebar': store.toggleSidebar(); return;
    case 'togglePanel': store.togglePanel(); return;
    case 'toggleChat': store.toggleChatPanel(); return;
    case 'toggleMinimap': store.updateSetting('minimapEnabled', !store.settings.minimapEnabled); return;
    case 'toggleWordWrap': store.updateSetting('wordWrap', store.settings.wordWrap === 'on' ? 'off' : 'on'); return;
    case 'zoomIn': store.zoomIn(); return;
    case 'zoomOut': store.zoomOut(); return;
    case 'zoomReset': store.zoomReset(); return;

    // Go
    case 'goToFile': store.toggleCommandPalette(); return;
    case 'goToLine': document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true })); return;

    // Terminal
    case 'newTerminal': store.setActivePanelTab('terminal'); if (!store.panelVisible) store.togglePanel(); return;

    // Help
    case 'showWelcome': store.openFile({ path: 'welcome', name: 'Welcome', extension: 'welcome', content: '' }); return;
    case 'showShortcuts': store.setActiveActivity('settings'); return;
    case 'about':
      store.addNotification({ type: 'info', message: 'guIDE 2.0 — Local-first AI IDE. Built for offline inference.', duration: 8000 });
      return;

    default: return;
  }
}

// ─── Win button component ────────────────────────────

function WinBtn({ children, onClick, title, isClose }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex items-center justify-center w-[46px] h-full text-vsc-text-dim transition-colors duration-75
        ${isClose ? 'hover:bg-red-600 hover:text-white' : 'hover:bg-vsc-list-hover hover:text-vsc-text'}`}
    >
      {children}
    </button>
  );
}
