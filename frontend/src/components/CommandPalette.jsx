/**
 * CommandPalette — Ctrl+Shift+P overlay mimicking VS Code's command palette.
 * Provides quick access to all IDE commands.
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';
import useAppStore from '../stores/appStore';
import {
  Files, Search, GitBranch, MessageSquare, Settings, Terminal,
  FolderOpen, Trash2, Layout, PanelBottom, Cpu, RefreshCw,
  Save, X, Palette, Plus, FileCode, AlertCircle, Package,
} from 'lucide-react';

// Theme commands are generated dynamically from themeList
import { themeList } from './ThemeProvider';

async function pickFolderPath() {
  if (window.electronAPI?.openFolderDialog) {
    return await window.electronAPI.openFolderDialog();
  }
  useAppStore.getState().addNotification({ type: 'warning', message: 'Open Folder requires the desktop app.' });
  return null;
}

async function pickNewFileName() {
  const store = useAppStore.getState();
  if (window.electronAPI?.dialogNewFile && store.projectPath) {
    return await window.electronAPI.dialogNewFile({ defaultDir: store.projectPath, defaultName: 'untitled.txt' });
  }
  store.addNotification({ type: 'warning', message: 'New File requires the desktop app with an open folder.' });
  return null;
}

const staticCommands = [
  { id: 'file.open', label: 'Open Folder...', category: 'File', icon: FolderOpen, action: async (s) => {
    const path = await pickFolderPath();
    if (path) {
      fetch('/api/project/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: path }),
      }).then(r => r.json()).then(d => {
        if (d.success) {
          s.setProjectPath(d.path);
          fetch(`/api/files/tree?path=${encodeURIComponent(d.path)}`)
            .then(r => r.json())
            .then(t => s.setFileTree(t.items || []))
            .catch(() => {});
        }
      }).catch(() => {});
    }
  }},
  { id: 'file.save', label: 'Save', category: 'File', icon: Save, shortcut: 'Ctrl+S', action: (s) => {
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
  }},
  { id: 'file.newFile', label: 'New File', category: 'File', icon: FileCode, action: async () => {
    const filePath = await pickNewFileName();
    if (filePath) {
      const store = useAppStore.getState();
      fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: '' }),
      }).then(r => r.json()).then(d => {
        if (d.success) {
          const name = filePath.split(/[/\\]/).pop();
          store.addNotification({ type: 'info', message: `Created ${name}` });
          store.openFile({ path: d.path || filePath, name, content: '', modified: false });
        }
      }).catch(() => {});
    }
  }},
  { id: 'view.sidebar', label: 'Toggle Sidebar', category: 'View', icon: Layout, shortcut: 'Ctrl+B', action: (s) => s.toggleSidebar() },
  { id: 'view.panel', label: 'Toggle Panel', category: 'View', icon: PanelBottom, shortcut: 'Ctrl+J', action: (s) => s.togglePanel() },
  { id: 'view.chat', label: 'Toggle AI Chat', category: 'View', icon: MessageSquare, action: (s) => s.toggleChatPanel() },
  { id: 'view.explorer', label: 'Show Explorer', category: 'View', icon: Files, shortcut: 'Ctrl+Shift+E', action: (s) => s.setActiveActivity('explorer') },
  { id: 'view.search', label: 'Show Search', category: 'View', icon: Search, shortcut: 'Ctrl+Shift+F', action: (s) => s.setActiveActivity('search') },
  { id: 'view.git', label: 'Show Source Control', category: 'View', icon: GitBranch, shortcut: 'Ctrl+Shift+G', action: (s) => s.setActiveActivity('git') },
  { id: 'view.settings', label: 'Open Settings', category: 'Preferences', icon: Settings, action: (s) => s.setActiveActivity('settings') },
  { id: 'view.terminal', label: 'Toggle Terminal', category: 'View', icon: Terminal, shortcut: 'Ctrl+`', action: (s) => { s.setActivePanelTab('terminal'); if (!useAppStore.getState().panelVisible) s.togglePanel(); } },
  { id: 'terminal.new', label: 'New Terminal', category: 'Terminal', icon: Plus, action: (s) => {
    s.addTerminalTab();
    s.setActivePanelTab('terminal');
    if (!useAppStore.getState().panelVisible) s.togglePanel();
  }},
  { id: 'model.load', label: 'Load AI Model...', category: 'AI', icon: Cpu, action: (s) => s.setActiveActivity('settings') },
  { id: 'model.scan', label: 'Scan for Models', category: 'AI', icon: RefreshCw, action: () => {
    fetch('/api/models/scan', { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (d.models) useAppStore.getState().setAvailableModels(d.models); })
      .catch(() => {});
  }},
  { id: 'chat.clear', label: 'Clear Chat History', category: 'AI', icon: Trash2, action: (s) => {
    s.clearChat();
    fetch('/api/session/clear', { method: 'POST' }).catch(() => {});
  }},
  { id: 'editor.closeTab', label: 'Close Active Tab', category: 'Editor', icon: X, shortcut: 'Ctrl+W', action: (s) => {
    if (s.activeTabId) s.closeTab(s.activeTabId);
  }},
  { id: 'editor.closeAll', label: 'Close All Tabs', category: 'Editor', icon: X, action: (s) => {
    s.openTabs.forEach(t => s.closeTab(t.id));
  }},
  { id: 'view.problems', label: 'Show Problems', category: 'View', icon: AlertCircle, action: (s) => {
    s.setActivePanelTab('problems');
    if (!useAppStore.getState().panelVisible) s.togglePanel();
  }},
  { id: 'view.output', label: 'Show Output', category: 'View', icon: Terminal, action: (s) => {
    s.setActivePanelTab('output');
    if (!useAppStore.getState().panelVisible) s.togglePanel();
  }},
  { id: 'view.debugConsole', label: 'Show Debug Console', category: 'View', icon: Terminal, action: (s) => {
    s.setActivePanelTab('debug');
    if (!useAppStore.getState().panelVisible) s.togglePanel();
  }},
  { id: 'git.push', label: 'Git: Push', category: 'Git', icon: GitBranch, action: () => {
    const store = useAppStore.getState();
    if (!store.projectPath) return;
    fetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: store.projectPath }),
    }).then(r => r.json()).then(d => {
      store.addNotification({ type: d.success ? 'info' : 'error', message: d.success ? 'Pushed to remote' : (d.error || 'Push failed') });
    }).catch(() => {});
  }},
  { id: 'git.pull', label: 'Git: Pull', category: 'Git', icon: GitBranch, action: () => {
    const store = useAppStore.getState();
    if (!store.projectPath) return;
    fetch('/api/git/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: store.projectPath }),
    }).then(r => r.json()).then(d => {
      store.addNotification({ type: d.success ? 'info' : 'error', message: d.success ? 'Pulled from remote' : (d.error || 'Pull failed') });
    }).catch(() => {});
  }},
  { id: 'output.clear', label: 'Clear Output', category: 'View', icon: Trash2, action: (s) => s.clearOutputLog() },
  { id: 'problems.clear', label: 'Clear Problems', category: 'View', icon: Trash2, action: (s) => s.setWorkspaceProblems([]) },
];

// Generate theme commands dynamically
const themeCommands = themeList.map(t => ({
  id: `theme.${t.id}`,
  label: `Color Theme: ${t.name}`,
  category: 'Preferences',
  icon: Palette,
  action: () => {
    // Use ThemeProvider's setTheme via DOM event
    document.dispatchEvent(new CustomEvent('guide-set-theme', { detail: t.id }));
  },
}));

const commands = [...staticCommands, ...themeCommands];

function useExtensionCommands() {
  const [extCommands, setExtCommands] = useState([]);

  useEffect(() => {
    fetch('/api/extensions/commands')
      .then(r => r.json())
      .then(d => {
        const list = (d.commands || []).map(cmd => ({
          id: cmd.id || cmd,
          label: typeof cmd === 'string' ? cmd : (cmd.label || cmd.id),
          category: 'Extensions',
          icon: Package,
          action: () => {
            fetch('/api/extensions/runCommand', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ commandId: cmd.id || cmd }),
            }).then(r => r.json()).then(res => {
              if (!res.success) {
                useAppStore.getState().addNotification({ type: 'error', message: res.error || 'Command failed' });
              }
            }).catch(() => {});
          },
        }));
        setExtCommands(list);
      })
      .catch(() => {});
  }, []);

  return extCommands;
}

export default function CommandPalette() {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);
  const closeCommandPalette = useAppStore(s => s.closeCommandPalette);
  const extensionCommands = useExtensionCommands();
  const allCommands = useMemo(() => [...commands, ...extensionCommands], [extensionCommands]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    if (!query) return allCommands;
    const lower = query.toLowerCase();
    return allCommands.filter(cmd =>
      cmd.label.toLowerCase().includes(lower) ||
      cmd.category.toLowerCase().includes(lower) ||
      cmd.id.toLowerCase().includes(lower)
    );
  }, [query, allCommands]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  const executeCommand = (cmd) => {
    closeCommandPalette();
    const store = useAppStore.getState();
    cmd.action(store);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeCommandPalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIdx]) executeCommand(filtered[selectedIdx]);
    }
  };

  return (
    <div className="command-palette-overlay" onClick={closeCommandPalette}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="flex-1 overflow-y-auto scrollbar-thin max-h-[300px]">
          {filtered.map((cmd, idx) => {
            const Icon = cmd.icon;
            const prevCategory = idx > 0 ? filtered[idx - 1].category : null;
            const showSeparator = cmd.category !== prevCategory;
            return (
              <React.Fragment key={cmd.id}>
                {showSeparator && (
                  <div className="px-3 pt-2 pb-1 text-[10px] tracking-wider text-vsc-text-dim font-semibold">
                    {cmd.category}
                  </div>
                )}
                <div
                  className={`command-palette-item ${idx === selectedIdx ? 'active' : ''}`}
                  onClick={() => executeCommand(cmd)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                >
                  <Icon size={14} className="mr-2 text-vsc-text-dim flex-shrink-0" />
                  <span className="flex-1 truncate">{cmd.label}</span>
                  {cmd.shortcut && (
                    <span className="text-vsc-xs text-vsc-text-dim ml-3 bg-vsc-badge px-1.5 py-0.5 rounded">
                      {cmd.shortcut}
                    </span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-vsc-sm text-vsc-text-dim text-center">
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
