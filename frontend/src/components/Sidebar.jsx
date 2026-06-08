/**
 * Sidebar — Renders the active sidebar panel based on ActivityBar selection.
 * Panels: Explorer (file tree), Search, Git, Settings
 */
import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react';
import useAppStore from '../stores/appStore';
import { useTheme, themeList } from './ThemeProvider';
import AccountPanel from './AccountPanel';
import BrowserPanel from './BrowserPanel';
import SlideDown from './SlideDown';
import FileIcon from './FileIcon';
import {
  ChevronRight, ChevronDown, FileCode,
  RefreshCw, Plus, FolderPlus,
  Palette, Pencil, Trash2, Copy, GitBranch, Search as SearchIcon,
  Keyboard, Wrench, ToggleLeft, ToggleRight, Server, Power,
  Check, Minus, Undo2, History, GitMerge,
  Save, RotateCcw, Zap, Scale, Brain, Cpu, Monitor, Type,
  FolderOpen, ExternalLink, Play,
  Package, Star, Download, Upload,
  Pause, SkipForward, ArrowDownRight, ArrowUpRight, Square, Bug, AlertTriangle, Eye, Shield, Mic
} from 'lucide-react';
import { openFileFromReadResponse } from '../utils/openFileFromRead';
import isPocket from '../lib/isPocket';
import { pathString, fileBaseName } from '../lib/pathString';
import { installUpdateNow, updateVersionLabel } from '../lib/updateStatus';
import { uploadFilesToPath, downloadFileUrl, downloadFolderZipUrl, triggerDownload } from '../lib/pocketFiles';
import { importFilesToPath, extractDropPaths } from '../lib/localFiles';

export default function Sidebar() {
  const activeActivity = useAppStore(s => s.activeActivity);

  let panel;
  switch (activeActivity) {
    case 'explorer': panel = <FileExplorer />; break;
    case 'search': panel = <SearchPanel />; break;
    case 'git': panel = <GitPanel />; break;
    case 'settings': panel = <SettingsPanel />; break;
    case 'debug': panel = <DebugPanel />; break;
    case 'extensions': panel = <ExtensionsPanel />; break;
    case 'browser': panel = <BrowserPanel />; break;
    case 'account': panel = <AccountPanel />; break;
    default: panel = <FileExplorer />; break;
  }

  return (
    <div className="animate-slide-right flex flex-col h-full min-h-0">
      {panel}
    </div>
  );
}

function FileExplorer() {
  const projectPath = useAppStore(s => s.projectPath);
  const fileTree = useAppStore(s => s.fileTree);
  const workspaceRoots = useAppStore(s => s.workspaceRoots);
  const workspaceRootTrees = useAppStore(s => s.workspaceRootTrees);
  const setWorkspaceRoots = useAppStore(s => s.setWorkspaceRoots);
  const setWorkspaceRootTree = useAppStore(s => s.setWorkspaceRootTree);
  const setProjectPath = useAppStore(s => s.setProjectPath);
  const setFileTree = useAppStore(s => s.setFileTree);
  const setFileTreeLoading = useAppStore(s => s.setFileTreeLoading);
  const addNotification = useAppStore(s => s.addNotification);
  const setGitBranch = useAppStore(s => s.setGitBranch);
  const setGitFileStatuses = useAppStore(s => s.setGitFileStatuses);
  const taskScripts = useAppStore(s => s.taskScripts);
  const loadTaskScripts = useAppStore(s => s.loadTaskScripts);
  const runTaskScript = useAppStore(s => s.runTaskScript);
  const symbolOutline = useAppStore(s => s.symbolOutline);
  const [tasksExpanded, setTasksExpanded] = useState(true);
  const [outlineExpanded, setOutlineExpanded] = useState(true);
  const pocket = isPocket();
  const uploadInputRef = useRef(null);
  const [dropActive, setDropActive] = useState(false);

  // Load npm scripts when project opens
  useEffect(() => {
    if (projectPath) loadTaskScripts();
  }, [projectPath, loadTaskScripts]);

  const fetchGitStatus = useCallback(() => {
    if (!projectPath) return;
    fetch(`/api/git/status?path=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(d => {
        if (d.branch) setGitBranch(d.branch);
        // Build file status map
        const statuses = {};
        for (const f of (d.staged || [])) statuses[f.file] = 'A';
        for (const f of (d.modified || [])) statuses[f.file] = 'M';
        for (const f of (d.untracked || [])) statuses[f.file] = '?';
        setGitFileStatuses(statuses);
      })
      .catch(() => {});
  }, [projectPath, setGitBranch, setGitFileStatuses]);

  const refreshTree = useCallback(() => {
    if (!projectPath) return;
    setFileTreeLoading(true);
    fetch(`/api/files/tree?path=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(d => setFileTree(d.items || []))
      .catch(e => addNotification({ type: 'error', message: `Tree refresh failed: ${e.message}` }))
      .finally(() => setFileTreeLoading(false));
    fetch('/api/workspace/roots')
      .then(r => r.json())
      .then(d => {
        const roots = (d.roots || []).map((r) => pathString(r)).filter(Boolean);
        setWorkspaceRoots(roots);
        const active = pathString(projectPath);
        for (const root of roots) {
          if (root === active) continue;
          fetch(`/api/files/tree?path=${encodeURIComponent(root)}`)
            .then(r => r.json())
            .then(t => setWorkspaceRootTree(root, t.items || []))
            .catch(() => {});
        }
      })
      .catch(() => {});
    fetchGitStatus();
  }, [projectPath, setFileTree, setFileTreeLoading, addNotification, fetchGitStatus, setWorkspaceRoots, setWorkspaceRootTree]);

  useEffect(() => {
    if (projectPath) refreshTree();
  }, [projectPath, refreshTree]);

  const openFolder = useCallback(async () => {
    // Use native Electron folder picker if available, fallback to prompt for browser dev
    let path = null;
    if (window.electronAPI?.openFolderDialog) {
      path = await window.electronAPI.openFolderDialog();
    } else {
      addNotification({ type: 'warning', message: 'Open Folder requires the desktop app.' });
    }
    if (!path) return;
    fetch('/api/project/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: path }),
    }).then(r => r.json()).then(d => {
      if (d.success) {
        setProjectPath(d.path);
        fetch(`/api/files/tree?path=${encodeURIComponent(d.path)}`)
          .then(r => r.json())
          .then(t => setFileTree(t.items || []))
          .catch(() => {});
      } else {
        addNotification({ type: 'error', message: d.error || 'Failed to open folder' });
      }
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  }, [setProjectPath, setFileTree, addNotification]);

  const handleNewFile = useCallback(async () => {
    if (!projectPath) {
      addNotification({ type: 'error', message: 'Open a folder first' });
      return;
    }
    let filePath = null;
    if (window.electronAPI?.dialogNewFile) {
      filePath = await window.electronAPI.dialogNewFile({ defaultDir: projectPath, defaultName: 'untitled.txt' });
    } else {
      addNotification({ type: 'warning', message: 'New File requires the desktop app.' });
    }
    if (!filePath) return;
    fetch('/api/files/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: '' }),
    }).then(r => r.json()).then(d => {
      if (d.success) {
        const name = filePath.split(/[/\\]/).pop();
        addNotification({ type: 'info', message: `Created ${name}` });
        refreshTree();
      } else {
        addNotification({ type: 'error', message: d.error || 'Failed' });
      }
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  }, [projectPath, addNotification, refreshTree]);

  const handleNewFolder = useCallback(async () => {
    if (!projectPath) {
      addNotification({ type: 'error', message: 'Open a folder first' });
      return;
    }
    let folderPath = null;
    if (window.electronAPI?.dialogNewFolder) {
      folderPath = await window.electronAPI.dialogNewFolder({ defaultDir: projectPath });
    } else {
      addNotification({ type: 'warning', message: 'New Folder requires the desktop app.' });
    }
    if (!folderPath) return;
    fetch('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
    }).then(r => r.json()).then(d => {
      if (d.success) {
        const name = folderPath.split(/[/\\]/).pop();
        addNotification({ type: 'info', message: `Created ${name}/` });
        refreshTree();
      } else {
        addNotification({ type: 'error', message: d.error || 'Failed' });
      }
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  }, [projectPath, addNotification, refreshTree]);

  const handleUploadClick = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadChange = useCallback(async (e) => {
    const files = e.target.files;
    if (!files?.length || !projectPath) return;
    try {
      await uploadFilesToPath(Array.from(files), projectPath);
      addNotification({ type: 'info', message: `Uploaded ${files.length} file(s)` });
      refreshTree();
    } catch (err) {
      addNotification({ type: 'error', message: err.message });
    }
    e.target.value = '';
  }, [projectPath, addNotification, refreshTree]);

  const handleDownloadProject = useCallback(() => {
    if (!projectPath) return;
    triggerDownload(downloadFolderZipUrl(projectPath));
  }, [projectPath]);

  const handleExplorerDragOver = useCallback((e) => {
    if (!projectPath) return;
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    }
  }, [pocket, projectPath]);

  const handleExplorerDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false);
  }, []);

  const handleExplorerDrop = useCallback(async (e) => {
    if (!projectPath) return;
    e.preventDefault();
    setDropActive(false);
    const files = e.dataTransfer.files;
    if (!files?.length) return;
    try {
      if (pocket) {
        await uploadFilesToPath(Array.from(files), projectPath);
      } else {
        const sources = extractDropPaths(e.dataTransfer);
        if (!sources.length) throw new Error('Could not read dropped file paths');
        await importFilesToPath(sources, projectPath);
      }
      addNotification({ type: 'info', message: `Imported ${files.length} file(s)` });
      refreshTree();
    } catch (err) {
      addNotification({ type: 'error', message: err.message });
    }
  }, [pocket, projectPath, addNotification, refreshTree]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-vsc-sidebar/85 backdrop-blur-sm">
      <div className="sidebar-header justify-between">
        <span>Explorer</span>
        <div className="flex items-center gap-1">
          <button className="p-1 hover:bg-vsc-list-hover rounded" title="New File" onClick={handleNewFile}>
            <Plus size={14} />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded" title="New Folder" onClick={handleNewFolder}>
            <FolderPlus size={14} />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded" title="Refresh" onClick={refreshTree}>
            <RefreshCw size={14} />
          </button>
          {pocket && projectPath && (
            <>
              <button className="p-1 hover:bg-vsc-list-hover rounded" title="Upload files" onClick={handleUploadClick}>
                <Upload size={14} />
              </button>
              <button className="p-1 hover:bg-vsc-list-hover rounded" title="Download project as ZIP" onClick={handleDownloadProject}>
                <Download size={14} />
              </button>
              <input ref={uploadInputRef} type="file" multiple className="hidden" onChange={handleUploadChange} />
            </>
          )}
        </div>
      </div>

      {!projectPath ? (
        <div className="flex flex-col items-center justify-center flex-1 p-4 text-vsc-text-dim text-vsc-sm">
          <p className="mb-3 text-center">No folder opened</p>
          <button
            className="btn btn-primary"
            onClick={openFolder}
          >
            Open Folder
          </button>
        </div>
      ) : (
        <div
          className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin relative ${dropActive ? 'ring-2 ring-inset ring-vsc-accent/40' : ''}`}
          onDragOver={handleExplorerDragOver}
          onDragLeave={handleExplorerDragLeave}
          onDrop={handleExplorerDrop}
        >
          {dropActive && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-vsc-accent/10 pointer-events-none text-vsc-sm text-vsc-accent">
              Drop files to import
            </div>
          )}
          <div className="sidebar-section-header shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]">
            <ChevronDown size={12} className="mr-1 flex-shrink-0" />
            <span className="truncate">{fileBaseName(projectPath) || 'Project'}</span>
          </div>
          {fileTree.map((item, idx) => (
            <FileTreeItem key={item.path || idx} item={item} depth={0} />
          ))}
          {workspaceRoots.filter(r => pathString(r) !== pathString(projectPath)).map((root) => {
            const rootPath = pathString(root);
            return (
            <div key={rootPath} className="mt-1">
              <div className="sidebar-section-header shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]">
                <ChevronDown size={12} className="mr-1 flex-shrink-0" />
                <span className="truncate">{fileBaseName(rootPath) || rootPath}</span>
              </div>
              {(workspaceRootTrees[rootPath] || workspaceRootTrees[root] || []).map((item, idx) => (
                <FileTreeItem key={`${rootPath}-${item.path || idx}`} item={item} depth={0} />
              ))}
            </div>
            );
          })}
          {taskScripts.length > 0 && (
            <div className="mt-1">
              <div
                className="sidebar-section-header cursor-pointer shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]"
                onClick={() => setTasksExpanded(!tasksExpanded)}
              >
                {tasksExpanded ? <ChevronDown size={12} className="mr-1 flex-shrink-0" /> : <ChevronRight size={12} className="mr-1 flex-shrink-0" />}
                <Package size={12} className="mr-1 flex-shrink-0 text-vsc-text-dim" />
                <span className="truncate">NPM Scripts</span>
              </div>
              {tasksExpanded && taskScripts.map(script => (
                <div
                  key={script.name}
                  className="flex items-center gap-1 px-2 py-0.5 hover:bg-vsc-list-hover cursor-pointer group text-vsc-sm"
                  style={{ paddingLeft: '28px' }}
                  onClick={() => runTaskScript(script.name)}
                  title={script.command}
                >
                  <Play size={11} className="flex-shrink-0 text-vsc-text-dim group-hover:text-green-400" />
                  <span className="truncate text-vsc-text-dim group-hover:text-vsc-text">{script.name}</span>
                </div>
              ))}
            </div>
          )}
          {/* Symbol Outline */}
          {symbolOutline.length > 0 && (
            <div className="mt-1">
              <div
                className="sidebar-section-header cursor-pointer shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]"
                onClick={() => setOutlineExpanded(!outlineExpanded)}
              >
                {outlineExpanded ? <ChevronDown size={12} className="mr-1 flex-shrink-0" /> : <ChevronRight size={12} className="mr-1 flex-shrink-0" />}
                <Type size={12} className="mr-1 flex-shrink-0 text-vsc-text-dim" />
                <span className="truncate">Outline</span>
                <span className="ml-auto text-[10px] text-vsc-text-dim">{symbolOutline.length}</span>
              </div>
              {outlineExpanded && symbolOutline.map((sym, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1 px-2 py-0.5 hover:bg-vsc-list-hover cursor-pointer group text-vsc-sm"
                  style={{ paddingLeft: `${28 + Math.min(sym.indent, 24)}px` }}
                  onClick={() => {
                    // Dispatch a custom event that EditorArea listens for to jump to line
                    window.dispatchEvent(new CustomEvent('guide-goto-line', { detail: { line: sym.line } }));
                  }}
                  title={`${sym.kind} — line ${sym.line}`}
                >
                  <span className={`flex-shrink-0 text-[10px] ${
                    sym.kind === 'class' ? 'text-yellow-400' :
                    sym.kind === 'function' ? 'text-blue-400' :
                    sym.kind === 'method' ? 'text-purple-400' :
                    'text-vsc-text-dim'
                  }`}>
                    {sym.kind === 'class' ? 'C' : sym.kind === 'function' ? 'F' : sym.kind === 'method' ? 'M' : 'V'}
                  </span>
                  <span className="truncate text-vsc-text-dim group-hover:text-vsc-text">{sym.name}</span>
                  <span className="ml-auto text-[9px] text-vsc-text-dim/50">{sym.line}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FileTreeItem({ item, depth }) {
  const [expanded, setExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const activeTabId = useAppStore(s => s.activeTabId);
  const openTabs = useAppStore(s => s.openTabs);
  const addNotification = useAppStore(s => s.addNotification);
  const gitFileStatuses = useAppStore(s => s.gitFileStatuses);

  const isActive = openTabs.some(t => t.path === item.path && t.id === activeTabId);
  const indent = 12 + depth * 16;

  // Get relative path for git status lookup
  const projectPath = useAppStore(s => s.projectPath);
  const relativePath = projectPath && item.path
    ? item.path.replace(projectPath, '').replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : '';
  const gitStatus = gitFileStatuses[relativePath];

  const handleClick = () => {
    if (item.type === 'directory') {
      setExpanded(!expanded);
    } else {
      fetch(`/api/files/read?path=${encodeURIComponent(item.path)}`)
        .then(r => r.json())
        .then(openFileFromReadResponse)
        .catch(() => {});
    }
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleNewFile = async () => {
    const dir = item.type === 'directory' ? item.path : item.path.replace(/[\\/][^\\/]+$/, '');
    let filePath = null;
    if (window.electronAPI?.dialogNewFile) {
      filePath = await window.electronAPI.dialogNewFile({ defaultDir: dir, defaultName: 'untitled.txt' });
    } else {
      addNotification({ type: 'warning', message: 'New File requires the desktop app.' });
      closeContextMenu();
      return;
    }
    if (!filePath) { closeContextMenu(); return; }
    fetch('/api/files/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: '' }),
    }).then(r => r.json()).then(d => {
      const name = filePath.split(/[/\\]/).pop();
      if (d.success) addNotification({ type: 'info', message: `Created ${name}` });
      else addNotification({ type: 'error', message: d.error || 'Failed' });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
    closeContextMenu();
  };

  const handleNewFolder = async () => {
    const dir = item.type === 'directory' ? item.path : item.path.replace(/[\\/][^\\/]+$/, '');
    let folderPath = null;
    if (window.electronAPI?.dialogNewFolder) {
      folderPath = await window.electronAPI.dialogNewFolder({ defaultDir: dir });
    } else {
      addNotification({ type: 'warning', message: 'New Folder requires the desktop app.' });
      closeContextMenu();
      return;
    }
    if (!folderPath) { closeContextMenu(); return; }
    fetch('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
    }).then(r => r.json()).then(d => {
      const name = folderPath.split(/[/\\]/).pop();
      if (d.success) addNotification({ type: 'info', message: `Created ${name}/` });
      else addNotification({ type: 'error', message: d.error || 'Failed' });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
    closeContextMenu();
  };

  const handleRename = async () => {
    const oldName = item.name;
    let newPath = null;
    if (window.electronAPI?.dialogRename) {
      newPath = await window.electronAPI.dialogRename({ currentPath: item.path });
    } else {
      addNotification({ type: 'warning', message: 'Rename requires the desktop app.' });
      closeContextMenu();
      return;
    }
    if (!newPath || newPath === item.path) { closeContextMenu(); return; }
    fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath: item.path, newPath }),
    }).then(r => r.json()).then(d => {
      const newName = newPath.split(/[/\\]/).pop();
      if (d.success) addNotification({ type: 'info', message: `Renamed to ${newName}` });
      else addNotification({ type: 'error', message: d.error || 'Failed' });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
    closeContextMenu();
  };

  const handleDelete = () => {
    if (!confirm(`Delete ${item.name}?`)) return;
    fetch('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: item.path }),
    }).then(r => r.json()).then(d => {
      if (d.success) addNotification({ type: 'info', message: `Deleted ${item.name}` });
      else addNotification({ type: 'error', message: d.error || 'Failed' });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
    closeContextMenu();
  };

  const handleCopyPath = () => {
    navigator.clipboard.writeText(item.path).catch(() => {});
    addNotification({ type: 'info', message: 'Path copied', duration: 2000 });
    closeContextMenu();
  };

  const handleCopyRelativePath = () => {
    const rel = projectPath && item.path
      ? item.path.replace(projectPath, '').replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : item.name;
    navigator.clipboard.writeText(rel).catch(() => {});
    addNotification({ type: 'info', message: 'Relative path copied', duration: 2000 });
    closeContextMenu();
  };

  const handleRevealInExplorer = () => {
    if (window.electronAPI?.showItemInFolder) {
      window.electronAPI.showItemInFolder(item.path);
    }
    closeContextMenu();
  };

  const handleDownload = () => {
    triggerDownload(downloadFileUrl(item.path));
    closeContextMenu();
  };

  const handleDownloadZip = () => {
    triggerDownload(downloadFolderZipUrl(item.path));
    closeContextMenu();
  };

  const icon = <FileIcon
    extension={item.extension}
    name={item.name}
    isDirectory={item.type === 'directory'}
    isOpen={expanded}
  />;

  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/plain', item.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (item.type === 'directory') {
      if (e.dataTransfer.files?.length > 0) {
        e.dataTransfer.dropEffect = 'copy';
      } else {
        e.dataTransfer.dropEffect = 'move';
      }
      setDragOver(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    if (e.dataTransfer.files?.length > 0) {
      const destDir = item.type === 'directory' ? item.path : projectPath;
      if (!destDir) return;
      if (isPocket()) {
        uploadFilesToPath(Array.from(e.dataTransfer.files), destDir)
          .then((d) => {
            const n = d.uploaded?.length || e.dataTransfer.files.length;
            addNotification({ type: 'info', message: `Uploaded ${n} file(s)` });
          })
          .catch(err => addNotification({ type: 'error', message: err.message }));
      } else {
        const sources = extractDropPaths(e.dataTransfer);
        if (!sources.length) {
          addNotification({ type: 'error', message: 'Could not read dropped file paths' });
          return;
        }
        importFilesToPath(sources, destDir)
          .then((d) => {
            const n = d.copied?.length || sources.length;
            addNotification({ type: 'info', message: `Imported ${n} file(s)` });
          })
          .catch(err => addNotification({ type: 'error', message: err.message }));
      }
      return;
    }

    const sourcePath = e.dataTransfer.getData('text/plain');
    if (!sourcePath || sourcePath === item.path) return;
    if (item.type !== 'directory') return;
    const fileName = sourcePath.split(/[\\/]/).pop();
    const newPath = `${item.path}/${fileName}`;
    fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath: sourcePath, newPath }),
    }).then(r => r.json()).then(d => {
      if (d.success) addNotification({ type: 'info', message: `Moved ${fileName}` });
      else addNotification({ type: 'error', message: d.error || 'Move failed' });
    }).catch(err => addNotification({ type: 'error', message: err.message }));
  };

  return (
    <>
      <div
        className={`file-tree-item group ${isActive ? 'active' : ''} ${dragOver ? 'ring-1 ring-vsc-accent/40 bg-vsc-accent/5' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={handleClick}
        onDoubleClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {item.type === 'directory' && (
          <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-100 ${expanded ? 'rotate-90' : ''}`} />
        )}
        {item.type === 'file' && <span className="w-3 flex-shrink-0" />}
        {icon}
        <span className={`truncate text-vsc-sm ${gitStatus === 'M' ? 'text-yellow-400' : gitStatus === '?' ? 'text-green-400' : gitStatus === 'A' ? 'text-green-400' : ''}`}>{item.name}</span>
        {/* Play button for HTML files */}
        {item.type === 'file' && (item.extension === 'html' || item.extension === 'htm') && (
          <button
            className="ml-auto p-0.5 hover:bg-vsc-list-hover rounded text-vsc-success opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              const store = useAppStore.getState();
              const existingTab = store.openTabs.find(t => t.path === item.path);
              if (existingTab) {
                // File already open — just toggle preview mode
                store.setActiveTab(existingTab.id);
                store.togglePreviewMode(existingTab.id);
              } else {
                // Open file and show preview
                fetch(`/api/files/read?path=${encodeURIComponent(item.path)}`)
                  .then(r => r.json())
                  .then(openFileFromReadResponse)
                  .catch(() => {});
              }
            }}
            title="Preview in viewport"
          >
            <Play size={12} />
          </button>
        )}
        {gitStatus && (
          <span className={`ml-auto mr-1 text-[10px] font-bold flex-shrink-0 ${
            gitStatus === 'M' ? 'text-yellow-400' : gitStatus === 'A' ? 'text-green-400' : 'text-gray-400'
          }`}>
            {gitStatus}
          </span>
        )}
      </div>
      <SlideDown isOpen={expanded && !!item.children}>
        <div className="relative">
          <div
            className="absolute top-0 bottom-0 w-px bg-vsc-panel-border/60 pointer-events-none"
            style={{ left: Math.max(indent + 6, 0) }}
          />
          {item.children && item.children.map((child, idx) => (
            <FileTreeItem key={child.path || idx} item={child} depth={depth + 1} />
          ))}
        </div>
      </SlideDown>

      {/* Context Menu */}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isDirectory={item.type === 'directory'}
          onClose={closeContextMenu}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onRename={handleRename}
          onDelete={handleDelete}
          onCopyPath={handleCopyPath}
          onCopyRelativePath={handleCopyRelativePath}
          onRevealInExplorer={handleRevealInExplorer}
          showDownload={isPocket()}
          onDownload={handleDownload}
          onDownloadZip={item.type === 'directory' ? handleDownloadZip : undefined}
        />
      )}
    </>
  );
}

function FileContextMenu({ x, y, isDirectory, onClose, onNewFile, onNewFolder, onRename, onDelete, onCopyPath, onCopyRelativePath, onRevealInExplorer, showDownload, onDownload, onDownloadZip }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Clamp position so menu doesn't overflow viewport
  const style = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 200),
    zIndex: 9999,
  };

  return (
    <div ref={menuRef} className="context-menu" style={style}>
      {isDirectory && (
        <>
          <button className="context-menu-item" onClick={onNewFile}>
            <Plus size={14} className="mr-2 text-vsc-text-dim" /> New File
          </button>
          <button className="context-menu-item" onClick={onNewFolder}>
            <FolderPlus size={14} className="mr-2 text-vsc-text-dim" /> New Folder
          </button>
          <div className="context-menu-separator" />
        </>
      )}
      <button className="context-menu-item" onClick={onRename}>
        <Pencil size={14} className="mr-2 text-vsc-text-dim" /> Rename
      </button>
      <button className="context-menu-item" onClick={onCopyPath}>
        <Copy size={14} className="mr-2 text-vsc-text-dim" /> Copy Path
      </button>
      <button className="context-menu-item" onClick={onCopyRelativePath}>
        <Copy size={14} className="mr-2 text-vsc-text-dim" /> Copy Relative Path
      </button>
      {showDownload && !isDirectory && onDownload && (
        <button className="context-menu-item" onClick={onDownload}>
          <Download size={14} className="mr-2 text-vsc-text-dim" /> Download
        </button>
      )}
      {showDownload && isDirectory && onDownloadZip && (
        <button className="context-menu-item" onClick={onDownloadZip}>
          <Download size={14} className="mr-2 text-vsc-text-dim" /> Download as ZIP
        </button>
      )}
      {window.electronAPI?.showItemInFolder && (
        <button className="context-menu-item" onClick={onRevealInExplorer}>
          <ExternalLink size={14} className="mr-2 text-vsc-text-dim" /> Reveal in File Explorer
        </button>
      )}
      <div className="context-menu-separator" />
      <button className="context-menu-item text-vsc-error" onClick={onDelete}>
        <Trash2 size={14} className="mr-2" /> Delete
      </button>
    </div>
  );
}

function SearchPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [replace, setReplace] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [semantic, setSemantic] = useState(true);
  const [replacing, setReplacing] = useState(false);
  const projectPath = useAppStore(s => s.projectPath);
  const openFile = useAppStore(s => s.openFile);
  const addNotification = useAppStore(s => s.addNotification);
  const timerRef = useRef(null);

  const doSearch = useCallback((q) => {
    if (!q || !projectPath) { setResults([]); return; }
    setLoading(true);
    const semanticParam = semantic ? '&semantic=true' : '';
    fetch(`/api/files/search?path=${encodeURIComponent(projectPath)}&query=${encodeURIComponent(q)}${semanticParam}`)
      .then(r => r.json())
      .then(d => setResults(d.results || []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, [projectPath, semantic]);

  const handleChange = (e) => {
    const q = e.target.value;
    setQuery(q);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(q), 300);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { clearTimeout(timerRef.current); doSearch(query); }
  };

  const doReplaceAll = () => {
    if (!query || !projectPath) return;
    setReplacing(true);
    fetch('/api/files/replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, query, replace }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      else addNotification({ type: 'info', message: `Replaced in ${d.count ?? 0} file(s)` });
      doSearch(query);
    }).catch(e => addNotification({ type: 'error', message: e.message }))
      .finally(() => setReplacing(false));
  };

  // Group results by file
  const grouped = results.reduce((acc, r) => {
    if (!acc[r.file]) acc[r.file] = [];
    acc[r.file].push(r);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full">
      <div className="sidebar-header flex items-center justify-between">
        <span>Search</span>
        <button
          className="p-0.5 rounded hover:bg-vsc-list-hover text-vsc-text-dim"
          onClick={() => setShowReplace(!showReplace)}
          title="Toggle Replace"
        >
          <ChevronRight size={14} className={showReplace ? 'rotate-90 transition-transform' : 'transition-transform'} />
        </button>
      </div>
      <div className="px-2 pb-2 space-y-1">
        <div className="flex gap-1">
          <input
            type="text"
            className="flex-1 h-[26px] px-2 bg-vsc-input border border-vsc-input-border rounded-sm text-vsc-sm"
            placeholder="Search..."
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
          <button
            className={`p-1 rounded transition-colors ${semantic ? 'text-vsc-accent bg-vsc-accent/10' : 'text-vsc-text-dim hover:bg-vsc-list-hover'}`}
            onClick={() => setSemantic(!semantic)}
            title={semantic ? 'Semantic search ON (ranks by relevance)' : 'Semantic search OFF (plain text match)'}
          >
            <Brain size={14} />
          </button>
        </div>
        {showReplace && (
          <>
            <input
              type="text"
              className="w-full h-[26px] px-2 bg-vsc-input border border-vsc-input-border rounded-sm text-vsc-sm"
              placeholder="Replace..."
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
            />
            <button
              className="w-full btn btn-primary text-vsc-xs py-1 disabled:opacity-50"
              onClick={doReplaceAll}
              disabled={!query || replacing}
            >
              {replacing ? 'Replacing...' : 'Replace All'}
            </button>
          </>
        )}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin text-vsc-sm">
        {loading && <p className="px-3 py-2 text-vsc-text-dim">Searching...</p>}
        {!loading && !query && <p className="px-3 py-2 text-vsc-text-dim">Type to search across files</p>}
        {!loading && query && results.length === 0 && <p className="px-3 py-2 text-vsc-text-dim">No results found</p>}
        {Object.entries(grouped).map(([file, matches]) => (
          <SearchFileGroup key={file} file={file} matches={matches} openFile={openFile} projectPath={projectPath} />
        ))}
      </div>
    </div>
  );
}

function SearchFileGroup({ file, matches, openFile, projectPath }) {
  const [expanded, setExpanded] = useState(true);
  const fileName = file.split(/[\\/]/).pop();
  const relPath = file.replace(projectPath, '').replace(/^[\\/]/, '');

  const handleOpen = (match) => {
    fetch(`/api/files/read?path=${encodeURIComponent(file)}`)
      .then(r => r.json())
      .then(d => openFileFromReadResponse({
        ...d,
        path: d.path || file,
        name: d.name || fileName,
        extension: d.extension || fileName.split('.').pop(),
      }))
      .catch(() => {});
  };

  return (
    <div>
      <button
        className="flex items-center gap-1 px-2 py-0.5 w-full text-left hover:bg-vsc-list-hover text-vsc-text"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FileCode size={14} className="text-vsc-text-dim flex-shrink-0" />
        <span className="truncate flex-1">{relPath || fileName}</span>
        <span className="text-vsc-text-dim text-[10px] ml-1">{matches.length}</span>
      </button>
      {expanded && matches.map((m, i) => (
        <button
          key={i}
          className="flex items-center gap-1 pl-7 pr-2 py-0.5 w-full text-left hover:bg-vsc-list-hover text-vsc-text-dim"
          onClick={() => handleOpen(m)}
        >
          <span className="text-[10px] text-vsc-text-dim w-6 text-right flex-shrink-0">{m.line}</span>
          <span className="truncate text-vsc-text">{m.text}</span>
        </button>
      ))}
    </div>
  );
}

function GitPanel() {
  const projectPath = useAppStore(s => s.projectPath);
  const openFile = useAppStore(s => s.openFile);
  const addNotification = useAppStore(s => s.addNotification);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [branch, setBranch] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [branches, setBranches] = useState([]);
  const [showBranches, setShowBranches] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [logEntries, setLogEntries] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);

  const refresh = useCallback(() => {
    if (!projectPath) return;
    setLoading(true);
    fetch(`/api/git/status?path=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(d => {
        if (d.branch) setBranch(d.branch);
        setStatus(d);
      })
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, [projectPath]);

  useEffect(() => { refresh(); }, [refresh]);

  const stageFiles = (files, all) => {
    fetch('/api/git/stage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { path: projectPath, all: true } : { path: projectPath, files }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const unstageFiles = (files, all) => {
    fetch('/api/git/unstage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { path: projectPath, all: true } : { path: projectPath, files }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const discardFiles = (files) => {
    if (!confirm(`Discard changes to ${files.length} file(s)? This cannot be undone.`)) return;
    fetch('/api/git/discard', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath, files }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      else addNotification({ type: 'info', message: `Discarded changes to ${files.length} file(s)` });
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const commit = () => {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    fetch('/api/git/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath, message: commitMsg }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      else { addNotification({ type: 'info', message: 'Committed successfully' }); setCommitMsg(''); }
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }))
      .finally(() => setCommitting(false));
  };

  const push = () => {
    setPushing(true);
    fetch('/api/git/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      else addNotification({ type: 'info', message: d.output?.trim() || 'Pushed successfully' });
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }))
      .finally(() => setPushing(false));
  };

  const pull = () => {
    setPulling(true);
    fetch('/api/git/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      else addNotification({ type: 'info', message: d.output?.trim() || 'Pulled successfully' });
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }))
      .finally(() => setPulling(false));
  };

  const showDiff = (file, staged) => {
    const qs = `path=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(file)}${staged ? '&staged=true' : ''}`;
    fetch(`/api/git/diff?${qs}`)
      .then(r => r.json())
      .then(d => {
        if (d.diff) {
          openFile({ path: `diff://${file}`, name: `${file.split(/[\\/]/).pop()} (diff)`, extension: 'diff', content: d.diff });
        } else {
          addNotification({ type: 'info', message: 'No diff available' });
        }
      }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const loadBranches = () => {
    fetch(`/api/git/branches?path=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(d => { if (d.branches) setBranches(d.branches); })
      .catch(() => {});
  };

  const switchBranch = (name) => {
    fetch('/api/git/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath, branch: name }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      else { addNotification({ type: 'info', message: `Switched to ${name}` }); setShowBranches(false); }
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const createBranch = () => {
    if (!newBranch.trim()) return;
    fetch('/api/git/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath, branch: newBranch.trim(), create: true }),
    }).then(r => r.json()).then(d => {
      if (d.error) addNotification({ type: 'error', message: d.error });
      else { addNotification({ type: 'info', message: `Created branch ${newBranch.trim()}` }); setNewBranch(''); setShowBranches(false); }
      refresh();
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const loadLog = () => {
    fetch(`/api/git/log?path=${encodeURIComponent(projectPath)}&count=20`)
      .then(r => r.json())
      .then(d => { if (d.entries) setLogEntries(d.entries); })
      .catch(() => {});
  };

  if (!projectPath) {
    return (
      <div className="flex flex-col h-full">
        <div className="sidebar-header">Source Control</div>
        <div className="flex-1 flex items-center justify-center text-vsc-text-dim text-vsc-sm p-4 text-center">
          <p>Open a folder to see source control information</p>
        </div>
      </div>
    );
  }

  const staged = status?.staged || [];
  const modified = status?.modified || [];
  const untracked = status?.untracked || [];
  const totalChanges = staged.length + modified.length + untracked.length;

  return (
    <div className="flex flex-col h-full">
      <div className="sidebar-header flex items-center justify-between">
        <span>Source Control</span>
        <div className="flex items-center gap-0.5">
          <button className="p-0.5 rounded hover:bg-vsc-list-hover text-vsc-text-dim" onClick={() => { setShowLog(!showLog); if (!showLog) loadLog(); }} title="Commit History">
            <History size={14} />
          </button>
          <button className="p-0.5 rounded hover:bg-vsc-list-hover text-vsc-text-dim" onClick={() => { setShowBranches(!showBranches); if (!showBranches) loadBranches(); }} title="Branches">
            <GitMerge size={14} />
          </button>
          <button className="p-0.5 rounded hover:bg-vsc-list-hover text-vsc-text-dim" onClick={refresh} title="Refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Branch bar */}
      <div className="px-3 py-1 text-vsc-xs text-vsc-text-dim border-b border-vsc-panel-border/25 flex items-center gap-1">
        <GitBranch size={12} />
        <span>{branch || '(no branch)'}</span>
        {totalChanges > 0 && <span className="ml-auto text-[10px] bg-vsc-accent/20 text-vsc-accent px-1.5 rounded-full">{totalChanges}</span>}
      </div>

      {/* Branch picker */}
      {showBranches && (
        <div className="border-b border-vsc-panel-border/25 bg-vsc-sidebar-bg">
          <div className="px-2 py-1 flex gap-1">
            <input
              className="flex-1 bg-vsc-input-bg border border-vsc-input-border rounded px-2 py-0.5 text-vsc-sm text-vsc-text focus:outline-none focus:border-vsc-accent"
              placeholder="New branch name..."
              value={newBranch}
              onChange={e => setNewBranch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createBranch()}
            />
            <button className="btn btn-primary text-[10px] px-2 py-0.5" onClick={createBranch}>Create</button>
          </div>
          <div className="max-h-32 overflow-y-auto scrollbar-thin">
            {branches.map(b => (
              <button
                key={b.name}
                className={`flex items-center gap-1 px-3 py-0.5 w-full text-left text-vsc-sm hover:bg-vsc-list-hover ${b.current ? 'text-vsc-accent' : 'text-vsc-text'}`}
                onClick={() => !b.current && switchBranch(b.name)}
              >
                {b.current && <Check size={12} />}
                <span className={b.current ? '' : 'pl-4'}>{b.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Commit message + button */}
      <div className="px-2 py-1.5 border-b border-vsc-panel-border/25">
        <textarea
          className="w-full bg-vsc-input-bg border border-vsc-input-border rounded px-2 py-1 text-vsc-sm text-vsc-text resize-none focus:outline-none focus:border-vsc-accent"
          rows={2}
          placeholder="Commit message (Ctrl+Enter to commit)"
          value={commitMsg}
          onChange={e => setCommitMsg(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } }}
        />
        <div className="flex gap-1 mt-1">
          <button
            className="btn btn-primary flex-1 flex items-center justify-center gap-1 disabled:opacity-50"
            onClick={commit}
            disabled={!commitMsg.trim() || committing}
          >
            <Check size={12} />
            {committing ? 'Committing...' : 'Commit'}
          </button>
          {(modified.length > 0 || untracked.length > 0) && (
            <button
              className="btn flex items-center justify-center gap-1 px-2 py-1"
              onClick={() => stageFiles(null, true)}
              title="Stage All"
            >
              <Plus size={12} />
            </button>
          )}
        </div>
        <div className="flex gap-1 mt-1">
          <button
            className="btn flex-1 flex items-center justify-center gap-1 disabled:opacity-50"
            onClick={pull}
            disabled={pulling}
            title="Pull from remote"
          >
            <Download size={12} />
            {pulling ? 'Pulling...' : 'Pull'}
          </button>
          <button
            className="btn flex-1 flex items-center justify-center gap-1 disabled:opacity-50"
            onClick={push}
            disabled={pushing}
            title="Push to remote"
          >
            <Upload size={12} />
            {pushing ? 'Pushing...' : 'Push'}
          </button>
        </div>
      </div>

      {/* Commit history */}
      {showLog && (
        <div className="border-b border-vsc-panel-border/25 max-h-48 overflow-y-auto scrollbar-thin">
          <div className="px-2 py-1 text-vsc-xs font-medium text-vsc-text tracking-wider">Recent Commits</div>
          {logEntries.length === 0 && <p className="px-3 py-1 text-vsc-text-dim text-vsc-xs">No commits</p>}
          {logEntries.map((e, i) => (
            <div key={i} className="px-3 py-0.5 hover:bg-vsc-list-hover text-vsc-xs">
              <div className="flex items-center gap-1">
                <span className="text-vsc-accent font-mono">{e.hash}</span>
                <span className="truncate text-vsc-text flex-1">{e.message}</span>
              </div>
              <div className="text-vsc-text-dim text-[10px]">{e.author} - {e.date}</div>
            </div>
          ))}
        </div>
      )}

      {/* File changes */}
      <div className="flex-1 overflow-y-auto scrollbar-thin text-vsc-sm">
        {loading && <p className="px-3 py-2 text-vsc-text-dim">Loading...</p>}

        {!loading && totalChanges === 0 && (
          <p className="px-3 py-2 text-vsc-text-dim">No changes detected</p>
        )}

        {staged.length > 0 && (
          <GitFileSection
            title="Staged Changes" files={staged} badge="S" badgeColor="text-green-400"
            onUnstage={(f) => unstageFiles([f])} onUnstageAll={() => unstageFiles(null, true)}
            onDiff={(f) => showDiff(f, true)}
          />
        )}
        {modified.length > 0 && (
          <GitFileSection
            title="Changes" files={modified} badge="M" badgeColor="text-yellow-400"
            onStage={(f) => stageFiles([f])} onStageAll={() => stageFiles(modified, false)}
            onDiscard={(f) => discardFiles([f])}
            onDiff={(f) => showDiff(f, false)}
          />
        )}
        {untracked.length > 0 && (
          <GitFileSection
            title="Untracked" files={untracked} badge="U" badgeColor="text-vsc-text-dim"
            onStage={(f) => stageFiles([f])} onStageAll={() => stageFiles(untracked, false)}
          />
        )}
      </div>
    </div>
  );
}

function GitFileSection({ title, files, badge, badgeColor, onStage, onStageAll, onUnstage, onUnstageAll, onDiscard, onDiff }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div>
      <div className="flex items-center px-2 py-1 hover:bg-vsc-list-hover text-vsc-text font-medium text-vsc-xs tracking-wider">
        <button className="flex items-center gap-1 flex-1 text-left" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{title}</span>
        </button>
        <span className="text-vsc-text-dim mr-1">{files.length}</span>
        {onStageAll && <button className="p-0.5 rounded hover:bg-vsc-accent/20 text-vsc-text-dim" onClick={onStageAll} title="Stage All"><Plus size={12} /></button>}
        {onUnstageAll && <button className="p-0.5 rounded hover:bg-vsc-accent/20 text-vsc-text-dim" onClick={onUnstageAll} title="Unstage All"><Minus size={12} /></button>}
      </div>
      {expanded && files.map((f, i) => {
        const fileName = typeof f === 'string' ? f : f.file || f;
        const displayName = fileName.split(/[\\/]/).pop();
        return (
          <div key={i} className="group flex items-center gap-1 pl-6 pr-2 py-0.5 hover:bg-vsc-list-hover text-vsc-sm">
            <span
              className="truncate flex-1 text-vsc-text cursor-pointer hover:underline"
              onClick={() => onDiff && onDiff(fileName)}
              title={fileName}
            >
              {displayName}
            </span>
            <div className="hidden group-hover:flex items-center gap-0.5">
              {onDiscard && <button className="p-0.5 rounded hover:bg-red-500/20 text-vsc-text-dim" onClick={() => onDiscard(fileName)} title="Discard Changes"><Undo2 size={12} /></button>}
              {onStage && <button className="p-0.5 rounded hover:bg-vsc-accent/20 text-vsc-text-dim" onClick={() => onStage(fileName)} title="Stage"><Plus size={12} /></button>}
              {onUnstage && <button className="p-0.5 rounded hover:bg-vsc-accent/20 text-vsc-text-dim" onClick={() => onUnstage(fileName)} title="Unstage"><Minus size={12} /></button>}
            </div>
            <span className={`text-[10px] font-mono ${badgeColor} group-hover:hidden`}>{badge}</span>
          </div>
        );
      })}
    </div>
  );
}

function CloudProviderSettings() {
  const addNotification = useAppStore(s => s.addNotification);
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('none');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [status, setStatus] = useState(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  // Load providers + status on mount
  useEffect(() => {
    fetch('/api/cloud/providers').then(r => r.json()).then(d => {
      setProviders(d.all || []);
    }).catch(() => {});
    fetch('/api/cloud/status').then(r => r.json()).then(d => {
      setStatus(d);
      if (d.activeProvider && d.activeProvider !== 'none') {
        setSelectedProvider(d.activeProvider);
        setSelectedModel(d.activeModel || '');
      }
    }).catch(() => {});
  }, []);

  // Load models when provider changes
  useEffect(() => {
    if (selectedProvider === 'none') { setModels([]); return; }
    setLoadingModels(true);
    fetch(`/api/cloud/models/${encodeURIComponent(selectedProvider)}`)
      .then(r => r.json())
      .then(d => { setModels(d.models || []); setLoadingModels(false); })
      .catch(() => setLoadingModels(false));
  }, [selectedProvider]);

  const saveApiKey = () => {
    fetch('/api/cloud/apikey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: selectedProvider, key: apiKey }),
    }).then(r => r.json()).then(d => {
      if (d.success) addNotification({ type: 'info', message: `API key ${d.hasKey ? 'saved' : 'cleared'} for ${selectedProvider}` });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const setActive = () => {
    fetch('/api/cloud/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: selectedProvider, model: selectedModel }),
    }).then(r => r.json()).then(d => {
      if (d.success) {
        setStatus({ activeProvider: d.activeProvider, activeModel: d.activeModel });
        addNotification({ type: 'info', message: `Cloud provider set to ${d.activeProvider}` });
      }
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const deactivate = () => {
    fetch('/api/cloud/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'none' }),
    }).then(r => r.json()).then(d => {
      if (d.success) {
        setStatus({ activeProvider: 'none', activeModel: '' });
        setSelectedProvider('none');
        setSelectedModel('');
        addNotification({ type: 'info', message: 'Switched to local model' });
      }
    }).catch(() => {});
  };

  const currentProvider = providers.find(p => p.provider === selectedProvider);
  const isFree = currentProvider?.isFree;

  return (
    <div className="px-3 py-2 border-b border-vsc-panel-border/25">
      <button
        className="flex items-center gap-1.5 w-full text-left mb-1"
        onClick={() => setCollapsed(c => !c)}
      >
        {collapsed ? <ChevronRight size={14} className="text-vsc-text-dim" /> : <ChevronDown size={14} className="text-vsc-text-dim" />}
        <h3 className="text-vsc-sm font-semibold text-vsc-text flex items-center gap-1.5">
          Cloud AI Provider
        </h3>
        {status?.activeProvider && status.activeProvider !== 'none' && (
          <span className="ml-auto text-[10px] text-green-400 font-medium">Active</span>
        )}
      </button>

      {!collapsed && (
        <div className="space-y-2 mt-1">
          {/* Active status */}
          {status?.activeProvider && status.activeProvider !== 'none' && (
            <div className="bg-green-500/10 border border-green-500/30 rounded p-2 text-vsc-xs">
              <div className="text-green-400 font-medium">
                {providers.find(p => p.provider === status.activeProvider)?.label || status.activeProvider}
              </div>
              <div className="text-vsc-text-dim mt-0.5">Model: {status.activeModel || 'default'}</div>
              <button
                className="text-[10px] text-red-400 hover:text-red-300 mt-1 underline"
                onClick={deactivate}
              >
                Switch to local model
              </button>
            </div>
          )}

          {/* Provider dropdown */}
          <div>
            <label className="text-[11px] text-vsc-text-dim block mb-0.5">Provider</label>
            <select
              className="w-full h-6 px-1.5 text-vsc-xs bg-vsc-input border border-vsc-input-border rounded-sm text-vsc-text"
              value={selectedProvider}
              onChange={(e) => { setSelectedProvider(e.target.value); setSelectedModel(''); setApiKey(''); }}
            >
              <option value="none">Local Model (default)</option>
              {providers.map(p => (
                <option key={p.provider} value={p.provider}>
                  {p.label}{p.isFree ? ' (Free)' : ''}
                </option>
              ))}
            </select>
          </div>

          {selectedProvider !== 'none' && (
            <>
              {/* Free tier badge */}
              {isFree && (
                <div className="text-[10px] text-green-400 bg-green-500/10 px-2 py-1 rounded">
                  Free tier — no API key needed. Bundled keys rotate automatically.
                </div>
              )}

              {/* API Key */}
              {!isFree && (
                <div>
                  <label className="text-[11px] text-vsc-text-dim block mb-0.5">API Key</label>
                  <div className="flex gap-1">
                    <input
                      type="password"
                      className="flex-1 h-6 px-1.5 text-vsc-xs bg-vsc-input border border-vsc-input-border rounded-sm text-vsc-text"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                    />
                    <button
                      className="btn btn-primary text-[10px] px-2 h-6 rounded-sm"
                      onClick={saveApiKey}
                    >
                      Save
                    </button>
                  </div>
                  <div className="text-[10px] text-vsc-text-dim mt-0.5">Stored locally, never sent except to the provider.</div>
                </div>
              )}

              {/* Model picker */}
              <div>
                <label className="text-[11px] text-vsc-text-dim block mb-0.5">Model</label>
                {loadingModels ? (
                  <div className="text-[10px] text-vsc-text-dim">Loading models...</div>
                ) : models.length > 0 ? (
                  <select
                    className="w-full h-6 px-1.5 text-vsc-xs bg-vsc-input border border-vsc-input-border rounded-sm text-vsc-text"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                  >
                    <option value="">Select a model...</option>
                    {models.map(m => (
                      <option key={m.id} value={m.id}>{m.name || m.id}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="w-full h-6 px-1.5 text-vsc-xs bg-vsc-input border border-vsc-input-border rounded-sm text-vsc-text"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    placeholder="Enter model ID..."
                  />
                )}
              </div>

              {/* Set Active button */}
              <button
                className="btn btn-primary w-full"
                onClick={setActive}
                disabled={!selectedModel && models.length > 0}
              >
                Set as Active Provider
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Auto-update settings — uses global updateStatus from Layout subscription.
function UpdatesSettings({ settings, updateSetting }) {
  const addNotification = useAppStore(s => s.addNotification);
  const updateStatus = useAppStore(s => s.updateStatus);
  const setUpdateStatus = useAppStore(s => s.setUpdateStatus);
  const [busy, setBusy] = useState(false);
  const cadence = Number(settings.autoUpdateCheckHours ?? 24);

  const refreshStatus = useCallback(() => {
    const p = window.electronAPI?.updater?.getStatus
      ? window.electronAPI.updater.getStatus()
      : fetch('/api/updater/status').then(r => r.json());
    Promise.resolve(p).then(s => { if (s) setUpdateStatus(s); }).catch(() => {});
  }, [setUpdateStatus]);

  useEffect(() => {
    if (!updateStatus) refreshStatus();
    const id = setInterval(refreshStatus, 60000);
    return () => clearInterval(id);
  }, [refreshStatus, updateStatus]);

  const checkNow = () => {
    setBusy(true);
    const p = window.electronAPI?.updater?.check
      ? window.electronAPI.updater.check()
      : fetch('/api/updater/check', { method: 'POST' }).then(r => r.json());
    Promise.resolve(p)
      .then(() => { addNotification({ type: 'info', message: 'Checking for updates…', duration: 2000 }); setTimeout(refreshStatus, 1500); })
      .catch(e => addNotification({ type: 'error', message: e.message }))
      .finally(() => setBusy(false));
  };

  const installNow = () => {
    Promise.resolve(installUpdateNow())
      .catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const status = updateStatus;
  const statusLabel =
    status?.available === false ? 'Updater unavailable (dev/web mode)'
      : status?.status === 'checking' ? 'Checking…'
        : status?.status === 'available' ? `Update available: v${updateVersionLabel(status)} — downloading…`
          : status?.status === 'downloading' ? `Downloading… ${Math.round(status?.progress?.percent || 0)}%`
            : status?.status === 'downloaded' ? `Downloaded v${updateVersionLabel(status)} — restart to install`
              : status?.status === 'error' ? `Error: ${status?.error || 'unknown'}`
                : 'Up to date';

  return (
    <SettingsSection title="Updates" icon={<Download size={13} />} keywords="updates auto update download release restart install">
      <div className="text-[11px] text-vsc-text-dim mb-2">{statusLabel}</div>
      {status?.installVariant && (
        <div className="text-[10px] text-vsc-text-dim mb-2">
          Install variant: {status.installVariant}{status.channel ? ` (${status.channel} channel)` : ''}
        </div>
      )}

      <div className="mb-3">
        <label className="text-[11px] text-vsc-text-dim block mb-1">Automatic check cadence</label>
        <select
          value={String(cadence)}
          onChange={e => updateSetting('autoUpdateCheckHours', Number(e.target.value))}
          className="w-full text-[11px] px-2 py-1 rounded bg-vsc-input border border-vsc-input-border text-vsc-text"
        >
          <option value="0">Off (manual only)</option>
          <option value="1">Every hour</option>
          <option value="6">Every 6 hours</option>
          <option value="24">Every day</option>
          <option value="168">Every week</option>
        </select>
        <div className="text-[10px] text-vsc-text-dim mt-0.5">
          Checks daily by default while the app is open. The check is a small HTTP request to the release feed; no data leaves your machine other than your version.
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        <button
          className="btn btn-primary disabled:opacity-50"
          onClick={checkNow}
          disabled={busy || status?.available === false}
        >
          Check now
        </button>
        {status?.status === 'downloaded' && (
          <button
            className="btn btn-primary px-2.5 py-1"
            onClick={installNow}
          >
            Restart & install
          </button>
        )}
      </div>
    </SettingsSection>
  );
}

function SettingsPanel() {
  const modelInfo = useAppStore(s => s.modelInfo);
  const availableModels = useAppStore(s => s.availableModels);
  const modelLoading = useAppStore(s => s.modelLoading);
  const addNotification = useAppStore(s => s.addNotification);
  const settings = useAppStore(s => s.settings);
  const settingsSyncStatus = useAppStore(s => s.settingsSyncStatus);
  const settingsSyncError = useAppStore(s => s.settingsSyncError);
  const settingsLastSyncedAt = useAppStore(s => s.settingsLastSyncedAt);
  const updateSetting = useAppStore(s => s.updateSetting);
  const resetSettings = useAppStore(s => s.resetSettings);
  const { themeId, setTheme } = useTheme();
  const reloadTimerRef = useRef(null);
  const reloadInFlightRef = useRef(false);
  const chatStreaming = useAppStore(s => s.chatStreaming);

  const syncLabel = settingsSyncStatus === 'saving'
    ? 'Saving...'
    : settingsSyncStatus === 'saved'
      ? 'Saved'
      : settingsSyncStatus === 'error'
        ? 'Save failed'
        : 'Not synced';

  const loadModel = (modelPath) => {
    fetch('/api/models/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath }),
    }).then(r => r.json()).then(d => {
      if (!d.success) addNotification({ type: 'error', message: d.error });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };

  const triggerModelReload = useCallback((reasonLabel) => {
    window.electronAPI?.uiLog?.(`triggerModelReload called reason=${reasonLabel} path=${modelInfo?.path ?? 'none'} modelLoading=${modelLoading} chatStreaming=${chatStreaming}`);
    if (!modelInfo?.path || modelLoading || reloadInFlightRef.current) return;
    if (chatStreaming) {
      window.electronAPI?.uiLog?.(`triggerModelReload BLOCKED chatStreaming`);
      addNotification({ type: 'warning', message: 'Stop or wait for generation to finish before reloading the model.', duration: 4000 });
      return;
    }
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      if (!modelInfo?.path || reloadInFlightRef.current) return;
      reloadInFlightRef.current = true;
      window.electronAPI?.uiLog?.(`triggerModelReload FETCH /api/models/load reason=${reasonLabel}`);
      fetch('/api/models/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelPath: modelInfo.path }),
      }).then(r => r.json()).then(d => {
        window.electronAPI?.uiLog?.(`triggerModelReload response success=${!!d?.success} reason=${reasonLabel}`);
        if (!d.success) {
          addNotification({ type: 'error', message: d.error || 'Model reload failed' });
        } else {
          addNotification({ type: 'info', message: `Model reloaded (${reasonLabel})`, duration: 1800 });
        }
      }).catch(e => {
        window.electronAPI?.uiLog?.(`triggerModelReload ERROR ${e.message} reason=${reasonLabel}`);
        addNotification({ type: 'error', message: e.message || 'Model reload failed' });
      }).finally(() => {
        reloadInFlightRef.current = false;
      });
    }, 250);
  }, [modelInfo, modelLoading, chatStreaming, addNotification]);

  const updateSettingWithReload = useCallback((key, value) => {
    window.electronAPI?.uiLog?.(`updateSettingWithReload key=${key} value=${JSON.stringify(value)}`);
    updateSetting(key, value);
    const requiresReload = key === 'contextSize' || key === 'gpuLayers' || key === 'gpuPreference' || key === 'requireMinContextForGpu' || key === 'kvCacheType' || key === 'enableThinking' || key === 'gpuConstrainedContext' || key === 'vramBalance';
    if (requiresReload) triggerModelReload(key);
  }, [updateSetting, triggerModelReload]);

  const applyThinkingMode = useCallback(async (mode) => {
    window.electronAPI?.uiLog?.(`applyThinkingMode START mode=${mode} current=${settings.thinkingMode}`);
    if (chatStreaming) {
      window.electronAPI?.uiLog?.(`applyThinkingMode BLOCKED chatStreaming`);
      addNotification({ type: 'warning', message: 'Stop or wait for generation to finish before changing thinking mode.', duration: 4000 });
      return;
    }
    try {
      await updateSetting('thinkingMode', mode);
      window.electronAPI?.uiLog?.(`applyThinkingMode after updateSetting OK`);
      addNotification({ type: 'info', message: `Thinking mode → ${mode} — reloading model…`, duration: 2500 });
      triggerModelReload('thinkingMode');
    } catch (e) {
      addNotification({ type: 'error', message: e.message || 'Failed to save thinking mode' });
    }
  }, [settings, updateSetting, triggerModelReload, chatStreaming, addNotification]);

  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    };
  }, []);

  const [settingsSearch, setSettingsSearch] = useState('');

  return (
    <SettingsSearchContext.Provider value={settingsSearch}>
    <div className="flex flex-col h-full overflow-y-auto scrollbar-thin">
      {/* Header with Reset */}
      <div className="sidebar-header justify-between">
        <div className="flex items-center gap-2">
          <span>Settings</span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded border ${
              settingsSyncStatus === 'saved'
                ? 'text-green-300 border-green-400/40 bg-green-500/10'
                : settingsSyncStatus === 'saving'
                  ? 'text-vsc-accent border-vsc-accent/40 bg-vsc-accent/10'
                  : settingsSyncStatus === 'error'
                    ? 'text-vsc-error border-vsc-error/40 bg-vsc-error/10'
                    : 'text-vsc-text-dim border-vsc-panel-border bg-vsc-bg'
            }`}
            title={
              settingsSyncStatus === 'saved' && settingsLastSyncedAt
                ? `Last synced: ${new Date(settingsLastSyncedAt).toLocaleTimeString()}`
                : settingsSyncError || 'Settings sync status'
            }
          >
            {syncLabel}
          </span>
        </div>
        <button
          onClick={() => { resetSettings(); addNotification({ type: 'info', message: 'Settings reset to defaults', duration: 2000 }); }}
          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover"
          title="Reset all settings to defaults"
        >
          <RotateCcw size={11} /> Reset
        </button>
      </div>

      <div className="px-3 pt-2 pb-1 text-[10px] text-vsc-text-dim border-b border-vsc-panel-border/20">
        <div>Most settings apply on the next request immediately.</div>
        <div className="text-yellow-300/80">Model context/GPU settings require model reload.</div>
        {settingsSyncStatus === 'error' && settingsSyncError && (
          <div className="text-vsc-error mt-1">{settingsSyncError}</div>
        )}
      </div>

      <div className="px-3 py-2 border-b border-vsc-panel-border/25 sticky top-0 z-10 bg-vsc-sidebar/95 backdrop-blur-sm">
        <div className="relative">
          <SearchIcon size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-vsc-text-dim pointer-events-none" />
          <input
            type="search"
            value={settingsSearch}
            onChange={(e) => setSettingsSearch(e.target.value)}
            placeholder="Search settings…"
            className="w-full pl-7 pr-2 py-1.5 text-[11px] rounded bg-vsc-input border border-vsc-input-border text-vsc-text placeholder:text-vsc-text-dim focus:outline-none focus:border-vsc-accent/50"
          />
        </div>
        {settingsSearch.trim() && (
          <div className="text-[10px] text-vsc-text-dim mt-1">Matching sections expand automatically</div>
        )}
      </div>

      {/* Theme */}
      <SettingsSection title="Theme" icon={<Palette size={13} />} keywords="theme color appearance dark light">
        <div className="space-y-0.5">
          {themeList.map(t => (
            <button
              key={t.id}
              className={`w-full text-left px-2 py-1.5 rounded-md text-vsc-xs transition-colors flex items-center gap-2 ${
                themeId === t.id
                  ? 'bg-vsc-accent/15 text-vsc-accent font-medium'
                  : 'text-vsc-text hover:bg-vsc-list-hover'
              }`}
              onClick={() => setTheme(t.id)}
            >
              <span className="flex items-center gap-0.5 flex-shrink-0">
                {(t.swatches || []).map((rgb, i) => (
                  <span
                    key={i}
                    className="w-3 h-3 rounded-sm border border-vsc-panel-border/40"
                    style={{ backgroundColor: `rgb(${rgb})` }}
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1">
                <span>{t.name}</span>
                <span className="ml-1 text-vsc-text-dim">({t.type})</span>
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>

      {/* LLM / Inference */}
      <SettingsSection title="LLM / Inference" icon={<Cpu size={13} />} defaultOpen keywords="llm inference temperature context size max response tokens top p k repeat penalty seed">
        <SettingSlider label="Temperature" value={settings.temperature} min={0} max={2} step={0.05}
          onChange={v => updateSetting('temperature', v)} tooltip="Lower = more focused, higher = more creative" />
        <SettingNumberField label="Max Response Tokens" value={settings.maxResponseTokens}
          min={0} max={8192} step={256} onChange={v => updateSetting('maxResponseTokens', v)}
          hint="0 = auto — use all available context space for generation" />
        <div>
          <SettingNumberField label="Context Size" value={settings.contextSize}
            min={0} max={131072} step={1024} onChange={v => updateSettingWithReload('contextSize', v)}
            hint="0 = auto — use the largest context the model allows and VRAM can fit (recommended). Otherwise set an explicit token budget." />
          <div className="text-[10px] text-yellow-400/80 mt-0.5">Requires model reload to apply</div>
        </div>
        <SettingSlider label="Top P" value={settings.topP} min={0} max={1} step={0.05}
          onChange={v => updateSetting('topP', v)} />
        <SettingNumberField label="Top K" value={settings.topK}
          min={1} max={200} step={1} onChange={v => updateSetting('topK', v)} />
        <SettingSlider label="Repeat Penalty" value={settings.repeatPenalty} min={1} max={2} step={0.05}
          onChange={v => updateSetting('repeatPenalty', v)} />
        <SettingNumberField label="Seed" value={settings.seed}
          min={-1} max={99999} step={1} onChange={v => updateSetting('seed', v)}
          hint="-1 for random" />
      </SettingsSection>

      {/* Thinking & Reasoning */}
      <SettingsSection title="Thinking & Reasoning" icon={<Brain size={13} />} keywords="thinking reasoning effort budget mode wrapper">
        <div className="mb-3">
          <label className="text-[11px] text-vsc-text-dim block mb-1.5">Reasoning Effort</label>
          <div className="flex gap-1">
            {['low', 'medium', 'high'].map(level => (
              <button key={level}
                className={`flex-1 px-2 py-1 text-[10px] rounded border transition-colors flex items-center justify-center gap-1
                  ${settings.reasoningEffort === level
                    ? 'bg-vsc-accent border-vsc-accent text-white'
                    : 'bg-vsc-bg border-vsc-panel-border text-vsc-text-dim hover:border-vsc-accent/50'}`}
                onClick={() => updateSetting('reasoningEffort', level)}
              >
                {level === 'low' ? <Zap size={10} /> : level === 'medium' ? <Scale size={10} /> : <Brain size={10} />}
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-vsc-text-dim mt-1">Low = fast, High = thorough</div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] text-vsc-text-dim">
              Thinking Budget:{' '}
              <span className="text-vsc-text font-medium">
                {(settings.thinkingBudget ?? 0) === 0 ? 'Auto' : settings.thinkingBudget === -1 ? 'Unlimited' : `${(settings.thinkingBudget ?? 0).toLocaleString()} tokens`}
              </span>
            </label>
            <div className="flex items-center gap-1">
              <input type="number" value={settings.thinkingBudget === -1 ? '' : settings.thinkingBudget}
                min={0} max={32768} step={128}
                placeholder={settings.thinkingBudget === -1 ? 'unlim' : '0=auto'}
                onChange={e => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v)) updateSetting('thinkingBudget', Math.max(0, Math.min(32768, v)));
                }}
                className="w-16 text-right text-[11px] px-1 py-0.5 rounded bg-vsc-input border border-vsc-input-border text-vsc-text"
              />
              <button
                className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                  settings.thinkingBudget === -1
                    ? 'bg-vsc-accent border-vsc-accent text-white'
                    : 'bg-vsc-bg border-vsc-panel-border text-vsc-text-dim'}`}
                onClick={() => updateSetting('thinkingBudget', settings.thinkingBudget === -1 ? 0 : -1)}
                title="Unlimited (no cap)"
              >inf</button>
            </div>
          </div>
          <input type="range" min={0} max={32768} step={128}
            value={settings.thinkingBudget === -1 ? 32768 : settings.thinkingBudget}
            onChange={e => updateSetting('thinkingBudget', parseInt(e.target.value))}
            className="w-full h-1 appearance-none bg-vsc-panel-border rounded-full cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-vsc-accent [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-vsc-text-dim mt-0.5">
            <span>0 = Auto</span><span>8K</span><span>16K</span><span>32K</span>
          </div>
        </div>
      </SettingsSection>

      {/* Agentic Behavior */}
      <SettingsSection title="Agentic Behavior" icon={<Zap size={13} />} keywords="agent iterations timeout thinking tools native function calling grammar debug stream summarizer lint sub-agents browser tor onion geckodriver marionette">
        <SettingSlider label="Max Iterations" value={settings.maxIterations} min={1} max={100} step={1}
          onChange={v => updateSetting('maxIterations', v)}
          tooltip="Maximum tool-call iterations per task"
          format={v => String(Math.round(v))} />
        <SettingSlider label="Generation Timeout (sec, 0=disabled)" value={settings.generationTimeoutSec} min={0} max={600} step={10}
          onChange={v => updateSetting('generationTimeoutSec', v)}
          tooltip="Abort generation after this many seconds (0 = no limit)"
          format={v => v === 0 ? 'disabled' : String(Math.round(v))} />
        <SettingToggle label="Enable Thinking (Chat Template)" value={settings.enableThinking !== false}
          onChange={v => updateSettingWithReload('enableThinking', v)}
          hint="Pass enable_thinking to chat template. Required for Qwen 3.5 small models to think." />
        <div className="mb-2">
          <label className="text-[11px] text-vsc-text-dim block mb-1">
            Thinking Wrapper Mode
            <span className="ml-1 text-vsc-text-muted">(reloads model — shows loading spinner)</span>
          </label>
          <select
            className="w-full bg-vsc-input border border-vsc-border rounded text-[11px] text-vsc-text px-2 py-1 focus:outline-none focus:border-vsc-focus"
            value={settings.thinkingMode || 'C'}
            onChange={e => {
              window.electronAPI?.uiLog?.(`thinkingMode dropdown change -> ${e.target.value}`);
              applyThinkingMode(e.target.value);
            }}
          >
            <option value="C">C — ThinkingOpen (inject &lt;think&gt; prefix)</option>
            <option value="B">B — Jinja, no prefix (raw enable_thinking=true)</option>
            <option value="auto">auto — node-llama-cpp auto resolver</option>
            <option value="off">off — Jinja, thinking disabled</option>
          </select>
          <p className="text-[10px] text-vsc-text-muted mt-1">
            Resets on model load: GLM-4.6V → off; others → auto. C/B = Jinja paths. auto = Qwen/GPT/Phi. off = template thinking disabled.
          </p>
        </div>
        <SettingToggle label="Filter Thinking Tokens" value={settings.enableThinkingFilter}
          onChange={v => updateSetting('enableThinkingFilter', v)}
          hint="Strip thinking tags from output" />
        <SettingToggle label="Tools Enabled" value={settings.toolsEnabled !== false}
          onChange={v => updateSetting('toolsEnabled', v)}
          hint="When off, no tool definitions are passed to the model. Useful for testing thinking display in isolation." />
        <SettingToggle label="Native Function Calling (GBNF)" value={settings.enableNativeFC !== false}
          onChange={v => updateSetting('enableNativeFC', v)}
          hint="Use node-llama-cpp GBNF grammar to constrain FC generation. Disable if the model hangs for minutes generating tool call JSON — falling back to prose tool call parsing (toolParser.js)." />
        <SettingToggle label="Grammar-Constrained Tool Calls" value={settings.enableGrammar}
          onChange={v => updateSetting('enableGrammar', v)}
          hint="Forces JSON schema grammar on raw output. Mutually exclusive with Native FC — enabling this disables native FC. May cause hangs on small models." />
        <SettingToggle label="Debug stream diagnostics" value={!!settings.debugStreamDiag}
          onChange={v => updateSetting('debugStreamDiag', v)}
          hint="Logs verbose [StreamDiag] token traces to guide-main.log. Does not change model output." />
        <SettingToggle label="Context Summarizer" value={settings.enableContextSummarizer !== false}
          onChange={v => updateSetting('enableContextSummarizer', v)}
          hint="On context shift, generate a progress summary from dropped turns so the model can continue the task without losing track." />
        <SettingToggle label="Auto Lint Fix" value={settings.autoLintFix !== false}
          onChange={v => updateSetting('autoLintFix', v)}
          hint="Auto-inject lint correction into model context after file writes detect errors." />
        <SettingToggle label="Sub-Agents" value={!!settings.enableSubAgents}
          onChange={v => updateSetting('enableSubAgents', v)}
          hint="Allow model to spawn focused sub-agents using a fresh context window. Off by default — uses extra VRAM." />
        <div>
          <label className="text-[11px] text-vsc-text-dim block mb-1">Agent browser engine</label>
          <select
            className="w-full text-[11px] bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50"
            value={settings.browserEngine || 'chromium'}
            onChange={e => updateSetting('browserEngine', e.target.value)}
          >
            <option value="chromium">Chromium (Playwright)</option>
            <option value="tor">Tor Browser</option>
          </select>
          <p className="text-[10px] text-vsc-text-dim mt-1">Which browser engine agent browser_* tools use. .onion sites require Tor Browser. No path setup needed — Tor is auto-detected or downloaded on first use.</p>
        </div>
        {(settings.browserEngine || 'chromium') === 'tor' && (
          <TorBrowserSettings settings={settings} updateSetting={updateSetting} />
        )}
        <div>
          <label className="text-[11px] text-vsc-text-dim block mb-1">Browser control</label>
          <select
            className="w-full text-[11px] bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50"
            value={settings.browserControl || 'auto'}
            onChange={e => updateSetting('browserControl', e.target.value)}
          >
            <option value="auto">Auto (local iframe, external screencast)</option>
            <option value="screencast">Viewport screencast</option>
            <option value="playwright">Playwright only (no live canvas)</option>
          </select>
          <p className="text-[10px] text-vsc-text-dim mt-1">How the viewport shows agent browser sessions.</p>
        </div>
      </SettingsSection>

      {/* Command Execution Policy */}
      <SettingsSection title="Command Execution" icon={<Shield size={13} />} keywords="command execution shell powershell cmd policy allow deny list turbo auto">
        <div>
          <label className="text-[11px] text-vsc-text-dim block mb-1">Default Shell (Windows)</label>
          <select
            className="w-full text-[11px] bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50"
            value={settings.commandShell || 'powershell'}
            onChange={e => updateSetting('commandShell', e.target.value)}
          >
            <option value="powershell">PowerShell (default)</option>
            <option value="cmd">CMD</option>
          </select>
          <p className="text-[10px] text-vsc-text-muted mt-1">
            Controls which shell `run_command` uses by default on Windows. Individual tool calls can still override via the `shell` parameter.
          </p>
        </div>
        <div>
          <label className="text-[11px] text-vsc-text-dim block mb-1">Execution Policy</label>
          <select
            className="w-full text-[11px] bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50"
            value={settings.executionPolicy || 'auto'}
            onChange={e => updateSetting('executionPolicy', e.target.value)}
          >
            <option value="disabled">Disabled — All commands require approval</option>
            <option value="allowlist">Allowlist — Only safe commands auto-execute</option>
            <option value="auto">Auto — Agent judges safety (recommended)</option>
            <option value="turbo">Turbo — All commands auto-execute (except denylisted)</option>
          </select>
          <p className="text-[10px] text-vsc-text-muted mt-1">
            Controls how the agent executes shell commands. "Auto" lets the agent decide based on safety heuristics. "Turbo" auto-executes everything except explicitly denylisted commands. "Allowlist" only auto-executes commands in the allow list. "Disabled" requires approval for every command.
          </p>
        </div>
        <div>
          <label className="text-[11px] text-vsc-text-dim block mb-1">Allow List (one per line)</label>
          <textarea
            className="w-full text-[10px] font-mono bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50 resize-y min-h-[60px] max-h-[120px]"
            value={(settings.commandAllowList || []).join('\n')}
            onChange={e => updateSetting('commandAllowList', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
            placeholder="git status&#10;git log&#10;npm test"
          />
          <p className="text-[10px] text-vsc-text-muted mt-1">Commands that auto-execute in "Allowlist" mode.</p>
        </div>
        <div>
          <label className="text-[11px] text-vsc-text-dim block mb-1">Deny List (one per line)</label>
          <textarea
            className="w-full text-[10px] font-mono bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50 resize-y min-h-[60px] max-h-[120px]"
            value={(settings.commandDenyList || []).join('\n')}
            onChange={e => updateSetting('commandDenyList', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
            placeholder="rm -rf /&#10;format C:&#10;shutdown"
          />
          <p className="text-[10px] text-vsc-text-muted mt-1">Commands that are always blocked regardless of policy level.</p>
        </div>
        <SettingToggle label="Require Tool Approval" value={settings.requireToolApproval === true}
          onChange={v => updateSetting('requireToolApproval', v)}
          hint="When on, destructive tools (write_file, delete_file, etc.) and blocked commands show an approval popup. When off (default), all tools auto-execute." />
      </SettingsSection>

      {/* System Prompt */}
      <SettingsSection title="System Prompt" icon={<Type size={13} />} keywords="system prompt custom instructions">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] text-vsc-text-dim">AI Identity & Behavior</label>
            {settings.systemPrompt && (
              <button onClick={() => updateSetting('systemPrompt', '')}
                className="text-[10px] px-1.5 py-0.5 rounded text-vsc-accent border border-vsc-accent/50 hover:bg-vsc-accent/10">
                Clear
              </button>
            )}
          </div>
          <textarea value={settings.systemPrompt}
            onChange={e => updateSetting('systemPrompt', e.target.value)}
            rows={6} placeholder="Override the default system prompt... (leave empty for default)"
            className="w-full text-[12px] px-2 py-1.5 rounded resize-y font-mono bg-vsc-input border border-vsc-input-border text-vsc-text"
            style={{ minHeight: '80px' }} />
          <div className="text-[10px] text-vsc-text-dim mt-0.5">Leave empty to use the built-in system prompt. Tool definitions are appended automatically.</div>
        </div>
        <div className="mt-2">
          <label className="text-[11px] text-vsc-text-dim block mb-1">Custom Instructions (appended to every message)</label>
          <textarea value={settings.customInstructions}
            onChange={e => updateSetting('customInstructions', e.target.value)}
            rows={3} placeholder="Always respond in markdown. Prefer TypeScript..."
            className="w-full text-[12px] px-2 py-1.5 rounded resize-y font-mono bg-vsc-input border border-vsc-input-border text-vsc-text"
            style={{ minHeight: '50px' }} />
          <div className="text-[10px] text-vsc-text-dim mt-0.5">Added to every user message for persistent preferences.</div>
        </div>
      </SettingsSection>

      {/* Guide Instructions */}
      <SettingsSection title="Guide Instructions" icon={<FileCode size={13} />} keywords="guide instructions rules skills">
        <div>
          <label className="text-[11px] text-vsc-text-dim block mb-1">Instruction File Path</label>
          <input value={settings.guideInstructionsPath}
            onChange={e => updateSetting('guideInstructionsPath', e.target.value)}
            placeholder=".guide-instructions.md"
            className="w-full text-[12px] px-2 py-1.5 rounded font-mono bg-vsc-input border border-vsc-input-border text-vsc-text" />
          <div className="text-[10px] text-vsc-text-dim mt-0.5">
            Path to a markdown file (relative to project root or absolute) whose contents are injected into the model's context on every request. Use it to define project-specific rules, coding conventions, or behavioral instructions.
          </div>
          {settings.guideInstructionsPath && (
            <button onClick={() => updateSetting('guideInstructionsPath', '')}
              className="text-[10px] px-1.5 py-0.5 mt-1 rounded text-vsc-accent border border-vsc-accent/50 hover:bg-vsc-accent/10">
              Clear
            </button>
          )}
        </div>
      </SettingsSection>

      {/* Hardware */}
      <SettingsSection title="Hardware" icon={<Monitor size={13} />} keywords="hardware gpu layers vram balance speed balanced context kv cache quantization preference constrained cpu cuda">
        <div className="mb-3">
          <label className="text-[11px] text-vsc-text-dim block mb-1">GPU Mode</label>
          <div className="flex gap-1">
            {[{ v: 'auto', l: 'Auto (GPU + CPU)' }, { v: 'cpu', l: 'CPU Only' }].map(opt => (
              <button key={opt.v}
                className={`flex-1 px-2 py-1 text-[10px] rounded border transition-colors ${
                  settings.gpuPreference === opt.v
                    ? 'bg-vsc-accent border-vsc-accent text-white'
                    : 'bg-vsc-bg border-vsc-panel-border text-vsc-text-dim hover:border-vsc-accent/50'}`}
                onClick={() => updateSettingWithReload('gpuPreference', opt.v)}
              >{opt.l}</button>
            ))}
          </div>
        </div>
        <div>
          <SettingNumberField label="GPU Layers" value={settings.gpuLayers}
            min={-1} max={200} step={1} onChange={v => updateSettingWithReload('gpuLayers', v)}
            hint="-1 = auto (uses VRAM Balance preset). Set to your model's total layer count for max GPU speed; manual value overrides preset layer logic." />
          <div className="text-[10px] text-yellow-400/80 mt-0.5">Requires model reload to apply</div>
        </div>
        <div className="mb-3">
          <label className="text-[11px] text-vsc-text-dim block mb-1">VRAM Balance (auto layers only)</label>
          <div className="flex gap-1">
            {[
              { v: 'balanced', l: 'Balanced' },
              { v: 'speed', l: 'Speed' },
              { v: 'context', l: 'Context' },
            ].map(opt => (
              <button key={opt.v}
                className={`flex-1 px-2 py-1 text-[10px] rounded border transition-colors ${
                  (settings.vramBalance || 'balanced') === opt.v
                    ? 'bg-vsc-accent border-vsc-accent text-white'
                    : 'bg-vsc-bg border-vsc-panel-border text-vsc-text-dim hover:border-vsc-accent/50'}`}
                onClick={() => updateSettingWithReload('vramBalance', opt.v)}
              >{opt.l}</button>
            ))}
          </div>
          <div className="text-[10px] text-vsc-text-dim mt-1">
            Speed: maximizes GPU layers; context is whatever fits in remaining VRAM. Balanced: best layers while meeting context targets. Context: prioritizes longest window; may use fewer GPU layers. KV-on-RAM with max GPU layers is not supported — use CPU mode or lower KV quant (Q4) for more context.
          </div>
        </div>
        <SettingToggle label="Require Min Context for GPU" value={settings.requireMinContextForGpu}
          onChange={v => updateSettingWithReload('requireMinContextForGpu', v)}
          hint="If GPU yields < 4096 ctx, retry on CPU for larger context" />
        <SettingToggle label="GPU-Constrained Context" value={settings.gpuConstrainedContext !== false}
          onChange={v => updateSettingWithReload('gpuConstrainedContext', v)}
          hint="Cap context to VRAM-bounded size when few GPU layers. Improves speed for large models on small GPUs." />
        <div className="mb-3 mt-2">
          <label className="text-[11px] text-vsc-text-dim block mb-1">KV Cache Quantization</label>
          <div className="flex gap-1">
            {[
              { v: 'q3_0', l: 'Q3 (Max Context)' },
              { v: 'q4_0', l: 'Q4 (Most Context)' },
              { v: 'q8_0', l: 'Q8 (Balanced)' },
              { v: 'f16', l: 'F16 (Best Quality)' },
            ].map(opt => (
              <button key={opt.v}
                className={`flex-1 px-2 py-1 text-[10px] rounded border transition-colors ${
                  settings.kvCacheType === opt.v
                    ? 'bg-vsc-accent border-vsc-accent text-white'
                    : 'bg-vsc-bg border-vsc-panel-border text-vsc-text-dim hover:border-vsc-accent/50'}`}
                onClick={() => updateSettingWithReload('kvCacheType', opt.v)}
              >{opt.l}</button>
            ))}
          </div>
          <div className="text-[10px] text-vsc-text-dim mt-1">Lower quantization = more context in same VRAM; Q8 is the recommended default. Affects KV cache only, not model weights.</div>
        </div>
      </SettingsSection>

      {/* Editor */}
      <LspLanguagesSettings addNotification={addNotification} />
      <VoiceSettings addNotification={addNotification} />

      <SettingsSection title="Editor" icon={<FileCode size={13} />} keywords="editor font size family tab word wrap line numbers minimap bracket format">
        <SettingSlider label="Font Size" value={settings.fontSize} min={8} max={32} step={1}
          onChange={v => updateSetting('fontSize', v)} format={v => String(Math.round(v))} />
        <div className="mb-2">
          <label className="text-[11px] text-vsc-text-dim block mb-1">Font Family</label>
          <input type="text" value={settings.fontFamily}
            onChange={e => updateSetting('fontFamily', e.target.value)}
            className="w-full text-[11px] px-2 py-1 rounded bg-vsc-input border border-vsc-input-border text-vsc-text" />
        </div>
        <SettingSlider label="Tab Size" value={settings.tabSize} min={1} max={8} step={1}
          onChange={v => updateSetting('tabSize', v)} format={v => String(Math.round(v))} />
        <div className="mb-2">
          <label className="text-[11px] text-vsc-text-dim block mb-1">Word Wrap</label>
          <select value={settings.wordWrap} onChange={e => updateSetting('wordWrap', e.target.value)}
            className="w-full text-[11px] px-2 py-1 rounded bg-vsc-input border border-vsc-input-border text-vsc-text">
            <option value="on">On</option>
            <option value="off">Off</option>
            <option value="wordWrapColumn">At Column</option>
          </select>
        </div>
        <div className="mb-2">
          <label className="text-[11px] text-vsc-text-dim block mb-1">Line Numbers</label>
          <select value={settings.lineNumbers} onChange={e => updateSetting('lineNumbers', e.target.value)}
            className="w-full text-[11px] px-2 py-1 rounded bg-vsc-input border border-vsc-input-border text-vsc-text">
            <option value="on">On</option>
            <option value="off">Off</option>
            <option value="relative">Relative</option>
          </select>
        </div>
        <SettingToggle label="Minimap" value={settings.minimapEnabled} onChange={v => updateSetting('minimapEnabled', v)} />
        <SettingToggle label="Bracket Pair Colorization" value={settings.bracketPairColorization}
          onChange={v => updateSetting('bracketPairColorization', v)} />
        <SettingToggle label="Format on Paste" value={settings.formatOnPaste}
          onChange={v => updateSetting('formatOnPaste', v)} />
        <SettingToggle label="Format on Type" value={settings.formatOnType}
          onChange={v => updateSetting('formatOnType', v)} />
      </SettingsSection>

      {/* Auto-Update — opt-in, off by default */}
      <UpdatesSettings settings={settings} updateSetting={updateSetting} />

      {/* Cloud AI Provider */}
      <CloudProviderSettings />

      {/* Model Selection */}
      <SettingsSection title="AI Model" icon={<Cpu size={13} />} keywords="ai model gguf load scan local">
        {modelInfo ? (
          <div className="bg-vsc-bg rounded p-2 text-vsc-xs">
            <div className="text-vsc-text-bright font-medium truncate">{modelInfo.name}</div>
            <div className="text-vsc-text-dim mt-1">
              Context: {modelInfo.contextSize?.toLocaleString()} tokens
              {modelInfo.contextSizeRequested === 'auto' && modelInfo.contextSizeCap != null && (
                <span> (auto, cap {Number(modelInfo.contextSizeCap).toLocaleString()})</span>
              )}
              {modelInfo.gpuLayers > 0 && ` | GPU: ${modelInfo.gpuLayers}${modelInfo.totalLayers ? `/${modelInfo.totalLayers}` : ''} layers`}
              {modelInfo.vramBalance === 'speed' && modelInfo.gpuLayers > 0 && (
                <span> — Speed preset: tight VRAM fit</span>
              )}
            </div>
            {modelInfo.vramBalance === 'speed' && modelInfo.gpuLayers > 0 && modelInfo.totalLayers && (
              <div className="text-vsc-text-dim mt-0.5 text-[10px]">
                Speed preset uses {modelInfo.gpuLayers}/{modelInfo.totalLayers} GPU layers and {modelInfo.contextSize?.toLocaleString()} context — maximizes layers; context is whatever fits remaining VRAM on your GPU.
              </div>
            )}
            {modelInfo.contextSizeRequested === 'auto' && (modelInfo.contextHardwareCap != null || modelInfo.contextTrainMax != null) && (
              <div className="text-vsc-text-dim mt-0.5 text-[10px]">
                {modelInfo.contextHardwareCap != null && (
                  <span>HW cap: {Number(modelInfo.contextHardwareCap).toLocaleString()}{modelInfo.kvMemSource ? ` (${modelInfo.kvMemSource})` : ''}</span>
                )}
                {modelInfo.contextHardwareCap != null && modelInfo.contextTrainMax != null && <span> · </span>}
                {modelInfo.contextTrainMax != null && (
                  <span>Train max: {Number(modelInfo.contextTrainMax).toLocaleString()}</span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-vsc-xs text-vsc-text-dim">No model loaded</div>
        )}
        {availableModels.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="text-vsc-xs text-vsc-text-dim mb-1">Available Models:</div>
            {availableModels.filter(m => m.modelType === 'llm').map(m => (
              <button key={m.path}
                className={`w-full text-left px-2 py-1.5 rounded text-vsc-xs hover:bg-vsc-list-hover
                  ${modelInfo?.path === m.path ? 'bg-vsc-list-active text-vsc-text-bright' : 'text-vsc-text'}`}
                onClick={() => loadModel(m.path)} disabled={modelLoading}>
                <div className="truncate font-medium">{m.name}</div>
                <div className="text-vsc-text-dim">{m.sizeFormatted}</div>
              </button>
            ))}
          </div>
        )}
        {modelLoading && (
          <div className="flex items-center gap-2 mt-2 text-vsc-xs text-vsc-accent">
            <div className="spinner" /><span>Loading model...</span>
          </div>
        )}
        <button className="btn btn-primary w-full mt-2"
          onClick={() => {
            fetch('/api/models/scan', { method: 'POST' })
              .then(r => r.json())
              .then(d => { if (d.models) useAppStore.getState().setAvailableModels(d.models); })
              .catch(() => {});
          }}>
          Scan for Models
        </button>
      </SettingsSection>

      {/* Tool Toggles */}
      <SettingsSection title="Tools" icon={<Wrench size={13} />} defaultOpen={false} keywords="tools enable disable read write file browser terminal">
        <ToolToggles />
      </SettingsSection>

      {/* MCP Servers */}
      <SettingsSection title="MCP Servers" icon={<Server size={13} />} defaultOpen={false} keywords="mcp servers model context protocol">
        <MCPConfigPanel />
      </SettingsSection>

      {/* Keyboard Shortcuts */}
      <SettingsSection title="Keyboard Shortcuts" icon={<Keyboard size={13} />} defaultOpen={false} keywords="keyboard shortcuts hotkeys keybindings">
        <KeyboardShortcuts />
      </SettingsSection>
    </div>
    </SettingsSearchContext.Provider>
  );
}

// Collapsible settings section
const SettingsSearchContext = createContext('');

function settingsTextMatches(query, ...parts) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = parts.filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

function SettingSearchWrap({ label, hint, tooltip, children }) {
  const searchQuery = useContext(SettingsSearchContext);
  const q = searchQuery.trim().toLowerCase();
  const match = !q || settingsTextMatches(q, label, hint, tooltip);
  if (!match) return null;
  const highlight = q && settingsTextMatches(q, label, hint, tooltip);
  return (
    <div className={highlight ? 'rounded-md ring-1 ring-vsc-accent/30 bg-vsc-accent/5 -mx-1 px-1' : undefined}>
      {children}
    </div>
  );
}

function SettingsSection({ title, icon, defaultOpen = false, keywords = '', children }) {
  const searchQuery = useContext(SettingsSearchContext);
  const q = searchQuery.trim().toLowerCase();
  const sectionMatch = settingsTextMatches(q, title, keywords);
  const [open, setOpen] = useState(defaultOpen);
  const forceOpen = !!q && sectionMatch;

  if (q && !sectionMatch) return null;

  return (
    <div className="border-b border-vsc-panel-border/25">
      <button
        className="w-full flex items-center gap-2 py-2.5 px-3 text-[11px] font-semibold tracking-wider text-vsc-text-dim hover:bg-vsc-list-hover transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <ChevronRight size={12} className={`transition-transform flex-shrink-0 ${(forceOpen || open) ? 'rotate-90' : ''}`} />
        {icon}
        {title}
      </button>
      <SlideDown isOpen={forceOpen || open}>
        <div className="px-3 pb-3 space-y-3">{children}</div>
      </SlideDown>
    </div>
  );
}

function LspLanguagesSettings({ addNotification }) {
  const [status, setStatus] = useState(null);
  const load = useCallback(() => {
    fetch('/api/lsp/status').then(r => r.json()).then(d => {
      if (d.success) setStatus(d);
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  const install = (lang) => {
    fetch('/api/lsp/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang }),
    }).then(r => r.json()).then(d => {
      load();
      addNotification({ type: d.success ? 'info' : 'error', message: d.success ? `${lang} language server ready` : (d.error || 'Install failed') });
    }).catch(e => addNotification({ type: 'error', message: e.message }));
  };
  const langs = [
    { id: 'typescript', label: 'TypeScript / JavaScript', bundled: true },
    { id: 'python', label: 'Python (Pyright)', bundled: false },
    { id: 'rust', label: 'Rust (rust-analyzer)', bundled: false },
    { id: 'go', label: 'Go (gopls)', bundled: false },
    { id: 'yaml', label: 'YAML', bundled: false },
  ];
  return (
    <SettingsSection title="Languages (LSP)" icon={<FileCode size={13} />}>
      <p className="text-[10px] text-vsc-text-dim mb-2">TS/JS ships with guIDE. Other servers download on demand.</p>
      {langs.map(({ id, label, bundled }) => {
        const st = status?.status?.[id];
        const installed = st?.installed || (status?.running || []).some(s => s.key === id);
        return (
          <div key={id} className="flex items-center justify-between gap-2 py-1">
            <span className="text-[11px] text-vsc-text truncate">{label}</span>
            {installed ? (
              <span className="text-[10px] text-vsc-success shrink-0">{bundled ? 'Bundled' : 'Installed'}</span>
            ) : (
              <button className="text-[10px] text-vsc-accent hover:underline shrink-0" onClick={() => install(id)}>Install</button>
            )}
          </div>
        );
      })}
      <button className="text-[10px] text-vsc-text-dim hover:text-vsc-text mt-1" onClick={load}>Refresh status</button>
    </SettingsSection>
  );
}

function VoiceSettings({ addNotification }) {
  const settings = useAppStore((s) => s.settings);
  const updateSetting = useAppStore((s) => s.updateSetting);
  const [voiceStatus, setVoiceStatus] = useState(null);

  useEffect(() => {
    fetch('/api/voice/status').then((r) => r.json()).then(setVoiceStatus).catch(() => {});
  }, []);

  return (
    <SettingsSection title="Voice input" icon={<Mic size={13} />}>
      <p className="text-[10px] text-vsc-text-dim mb-2">
        Offline-first: bundled Whisper. Cloud fallback uses OpenAI when online and API key is set.
      </p>
      <div className="py-0.5">
        <label className="text-[11px] text-vsc-text-dim block mb-1">Voice provider</label>
        <select
          value={settings.voiceProvider || 'auto'}
          onChange={(e) => updateSetting('voiceProvider', e.target.value)}
          className="w-full bg-vsc-input border border-vsc-panel-border/30 rounded px-2 py-1 text-[11px] text-vsc-text"
        >
          <option value="auto">Auto (cloud when online, else local)</option>
          <option value="local">Local Whisper only</option>
          <option value="cloud">Cloud (OpenAI) only</option>
        </select>
      </div>
      <div className="text-[10px] text-vsc-text-dim mt-1 space-y-0.5">
        <div>Local Whisper: {voiceStatus?.localWhisper ? 'Ready' : 'Will download model on first use'}</div>
        <div>Cloud STT: {voiceStatus?.cloudAvailable ? 'OpenAI key configured' : 'Add OpenAI key in Cloud AI settings'}</div>
      </div>
    </SettingsSection>
  );
}

function TorBrowserSettings({ settings, updateSetting }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!window.electronAPI?.getTorBrowserStatus) return;
    setChecking(true);
    try {
      const result = await window.electronAPI.getTorBrowserStatus();
      setStatus(result);
    } catch {
      setStatus({ ready: false, error: 'Could not validate Tor Browser path' });
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [settings.torBrowserPath, settings.geckodriverPath, refreshStatus]);

  const pickTorPath = useCallback(async () => {
    const picked = await window.electronAPI?.pickTorBrowserExe?.();
    if (picked) {
      updateSetting('torBrowserPath', picked);
    }
  }, [updateSetting]);

  const statusLabel = status?.ready
    ? status.source === 'discovered'
      ? 'Ready (auto-detected)'
      : status.source === 'downloaded'
        ? 'Ready (bundled by guIDE)'
        : 'Ready'
    : status?.willAutoDownload
      ? 'Ready — downloads on first browse'
      : settings.torBrowserPath && status?.pathValid === false
        ? 'Invalid path'
        : status?.geckodriverReady === false
          ? 'geckodriver missing'
          : checking
            ? 'Checking…'
            : 'Not ready';

  return (
    <>
      <div>
        <label className="text-[11px] text-vsc-text-dim block mb-1">Tor Browser path (optional override)</label>
        <div className="flex gap-1">
          <input
            type="text"
            className="flex-1 text-[10px] font-mono bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50"
            value={settings.torBrowserPath || ''}
            onChange={e => updateSetting('torBrowserPath', e.target.value)}
            placeholder="Leave empty — auto-detect or download"
          />
          <button type="button" className="btn btn-secondary text-[10px] px-2 shrink-0" onClick={pickTorPath}>
            Browse…
          </button>
        </div>
        <p className="text-[10px] text-vsc-text-dim mt-1">
          guIDE launches its own Tor Browser when agents browse. Status:{' '}
          <span className={status?.ready || status?.willAutoDownload ? 'text-vsc-success' : 'text-vsc-warning'}>{statusLabel}</span>
          {status?.resolvedPath && !settings.torBrowserPath ? ` (${status.resolvedPath.split(/[/\\]/).slice(-3).join('/')})` : ''}
          {status?.error && !status?.ready && !status?.willAutoDownload ? ` — ${status.error}` : ''}
        </p>
      </div>
      <div>
        <label className="text-[11px] text-vsc-text-dim block mb-1">geckodriver path (optional)</label>
        <input
          type="text"
          className="w-full text-[10px] font-mono bg-vsc-input border border-vsc-panel-border/25 rounded px-2 py-1.5 text-vsc-text focus:outline-none focus:border-vsc-accent/50"
          value={settings.geckodriverPath || ''}
          onChange={e => updateSetting('geckodriverPath', e.target.value)}
          placeholder="Auto-download on first use"
        />
        <p className="text-[10px] text-vsc-text-dim mt-1">Advanced override. Leave empty to auto-download geckodriver 0.36.x.</p>
      </div>
      <SettingToggle label="Debug Tor browser" value={!!settings.debugTorBrowser}
        onChange={v => updateSetting('debugTorBrowser', v)}
        hint="Logs Marionette command traces to guide-main.log ([TorBrowserBackend])." />
    </>
  );
}

// Toggle (boolean) setting
function SettingToggle({ label, value, onChange, hint }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex-1 min-w-0 mr-2">
        <span className="text-[11px] text-vsc-text-dim">{label}</span>
        {hint && <div className="text-[10px] text-vsc-text-dim/60">{hint}</div>}
      </div>
      <button onClick={() => {
        window.electronAPI?.uiLog?.(`SettingToggle click label=${label} ${value} -> ${!value}`);
        onChange(!value);
      }}
        className="w-[34px] h-[17px] rounded-full transition-colors relative flex-shrink-0"
        style={{ backgroundColor: value ? 'rgb(var(--guide-accent))' : 'rgb(var(--guide-panel-border))' }}>
        <div className="w-[13px] h-[13px] rounded-full bg-white absolute top-[2px] transition-all"
          style={{ left: value ? '19px' : '2px' }} />
      </button>
    </div>
  );
}

// Number input field setting
function SettingNumberField({ label, value, min, max, step, onChange, hint }) {
  return (
    <SettingSearchWrap label={label} hint={hint}>
    <div className="mb-2">
      <div className="flex items-center justify-between mb-0.5">
        <label className="text-[11px] text-vsc-text-dim">{label}</label>
        <input type="number" className="w-[72px] h-5 px-1 text-[11px] text-center bg-vsc-input border border-vsc-input-border rounded-sm text-vsc-text"
          value={value} min={min} max={max} step={step}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            onChange(Number.isFinite(v) ? v : min);
          }} />
      </div>
      {hint && <div className="text-[10px] text-vsc-text-dim">{hint}</div>}
    </div>
    </SettingSearchWrap>
  );
}

const TOOL_CATEGORIES = {
  'File Operations': [
    { name: 'read_file', label: 'Read File' },
    { name: 'write_file', label: 'Write File' },
    { name: 'edit_file', label: 'Edit File' },
    { name: 'append_to_file', label: 'Append to File' },
    { name: 'delete_file', label: 'Delete File' },
    { name: 'rename_file', label: 'Rename File' },
    { name: 'copy_file', label: 'Copy File' },
    { name: 'list_directory', label: 'List Directory' },
    { name: 'find_files', label: 'Find Files' },
    { name: 'create_directory', label: 'Create Directory' },
    { name: 'get_project_structure', label: 'Project Structure' },
    { name: 'get_file_info', label: 'File Info' },
    { name: 'open_file_in_editor', label: 'Open in Editor' },
    { name: 'diff_files', label: 'Diff Files' },
  ],
  'Search': [
    { name: 'grep_search', label: 'Grep Search' },
    { name: 'search_in_file', label: 'Search in File' },
    { name: 'search_codebase', label: 'Search Codebase' },
    { name: 'replace_in_files', label: 'Replace in Files' },
  ],
  'Terminal': [
    { name: 'run_command', label: 'Run Command' },
    { name: 'check_port', label: 'Check Port' },
    { name: 'install_packages', label: 'Install Packages' },
  ],
  'Web': [
    { name: 'web_search', label: 'Web Search' },
    { name: 'fetch_webpage', label: 'Fetch Webpage' },
    { name: 'http_request', label: 'HTTP Request' },
  ],
  'Browser': [
    { name: 'browser_navigate', label: 'Navigate' },
    { name: 'browser_snapshot', label: 'Snapshot' },
    { name: 'browser_click', label: 'Click' },
    { name: 'browser_type', label: 'Type' },
    { name: 'browser_fill_form', label: 'Fill Form' },
    { name: 'browser_select_option', label: 'Select Option' },
    { name: 'browser_evaluate', label: 'Evaluate JS' },
    { name: 'browser_scroll', label: 'Scroll' },
    { name: 'browser_back', label: 'Back' },
    { name: 'browser_press_key', label: 'Press Key' },
    { name: 'browser_hover', label: 'Hover' },
    { name: 'browser_drag', label: 'Drag' },
    { name: 'browser_screenshot', label: 'Screenshot' },
    { name: 'browser_get_content', label: 'Get Content' },
    { name: 'browser_get_url', label: 'Get URL' },
    { name: 'browser_get_links', label: 'Get Links' },
    { name: 'browser_tabs', label: 'Tabs' },
    { name: 'browser_handle_dialog', label: 'Handle Dialog' },
    { name: 'browser_console_messages', label: 'Console Messages' },
    { name: 'browser_file_upload', label: 'File Upload' },
    { name: 'browser_resize', label: 'Resize' },
    { name: 'browser_wait', label: 'Wait' },
    { name: 'browser_wait_for', label: 'Wait For' },
    { name: 'browser_close', label: 'Close' },
  ],
  'Git': [
    { name: 'git_status', label: 'Status' },
    { name: 'git_commit', label: 'Commit' },
    { name: 'git_diff', label: 'Diff' },
    { name: 'git_log', label: 'Log' },
    { name: 'git_branch', label: 'Branch' },
    { name: 'git_stash', label: 'Stash' },
    { name: 'git_reset', label: 'Reset' },
  ],
  'Code Analysis': [
    { name: 'analyze_error', label: 'Analyze Error' },
  ],
  'Undo': [
    { name: 'undo_edit', label: 'Undo Edit' },
    { name: 'list_undoable', label: 'List Undoable' },
  ],
  'Memory': [
    { name: 'save_memory', label: 'Save Memory' },
    { name: 'get_memory', label: 'Get Memory' },
    { name: 'list_memories', label: 'List Memories' },
  ],
  'Planning': [
    { name: 'write_todos', label: 'Write Todos' },
    { name: 'update_todo', label: 'Update Todo' },
  ],
  'Scratchpad': [
    { name: 'write_scratchpad', label: 'Write Scratchpad' },
    { name: 'read_scratchpad', label: 'Read Scratchpad' },
  ],
  'Image Generation': [
    { name: 'generate_image', label: 'Generate Image' },
  ],
};

// Tools enabled by default (most critical tools for productive AI assistance)
const DEFAULT_ENABLED_TOOLS = new Set([
  // File Operations
  'read_file', 'write_file', 'edit_file', 'append_to_file', 'create_file',
  'delete_file', 'rename_file', 'list_directory', 'find_files',
  'get_project_structure', 'get_file_info', 'open_file_in_editor', 'diff_files',
  // Search
  'grep_search', 'search_in_file', 'search_codebase', 'replace_in_files',
  // Terminal
  'run_command', 'check_port', 'install_packages',
  // Web
  'web_search', 'fetch_webpage', 'http_request',
  // Browser (ALL tools)
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_evaluate', 'browser_scroll', 'browser_back',
  'browser_screenshot', 'browser_get_content', 'browser_select_option',
  'browser_wait', 'browser_wait_for', 'browser_press_key', 'browser_hover',
  'browser_drag', 'browser_tabs', 'browser_handle_dialog', 'browser_console_messages',
  'browser_file_upload', 'browser_resize', 'browser_get_url', 'browser_get_links',
  'browser_close',
  // Git
  'git_status', 'git_commit', 'git_diff', 'git_log', 'git_branch',
  // Code Analysis
  'analyze_error',
  // Undo
  'undo_edit', 'list_undoable',
  // Memory
  'save_memory', 'get_memory', 'list_memories',
  // Planning
  'write_todos', 'update_todo',
  // Interaction
  'ask_question',
  // Scratchpad
  'write_scratchpad', 'read_scratchpad',
  // Rules
  'save_rule', 'list_rules',
]);

// Total tool count
const TOTAL_TOOLS = Object.values(TOOL_CATEGORIES).reduce((sum, tools) => sum + tools.length, 0);

const KEYBOARD_SHORTCUTS = [
  { keys: 'Ctrl+Shift+P', action: 'Command Palette' },
  { keys: 'Ctrl+B', action: 'Toggle Sidebar' },
  { keys: 'Ctrl+J', action: 'Toggle Panel' },
  { keys: 'Ctrl+`', action: 'Toggle Terminal' },
  { keys: 'Ctrl+S', action: 'Save File' },
  { keys: 'Ctrl+W', action: 'Close Tab' },
  { keys: 'Ctrl+Shift+E', action: 'Explorer' },
  { keys: 'Ctrl+Shift+F', action: 'Search' },
  { keys: 'Ctrl+Shift+G', action: 'Source Control' },
  { keys: 'Ctrl+F', action: 'Find in File' },
  { keys: 'Ctrl+H', action: 'Find and Replace' },
  { keys: 'Ctrl+P', action: 'Quick Open File' },
  { keys: 'Ctrl+Z', action: 'Undo' },
  { keys: 'Ctrl+Shift+Z', action: 'Redo' },
  { keys: 'Ctrl+/', action: 'Toggle Comment' },
];

function ToolToggles() {
  const enabledTools = useAppStore(s => s.enabledTools);
  const toggleTool = useAppStore(s => s.toggleTool);
  const setEnabledTools = useAppStore(s => s.setEnabledTools);

  // Determine if a tool is enabled: check store, fall back to DEFAULT_ENABLED_TOOLS
  const isEnabled = (toolName) => {
    if (toolName in enabledTools) return enabledTools[toolName];
    return DEFAULT_ENABLED_TOOLS.has(toolName);
  };

  const enabledCount = Object.entries(TOOL_CATEGORIES).reduce((sum, [, tools]) =>
    sum + tools.filter(t => isEnabled(t.name)).length, 0
  );

  const toggleCategory = (category, enable) => {
    const tools = TOOL_CATEGORIES[category];
    const updated = { ...enabledTools };
    for (const tool of tools) {
      updated[tool.name] = enable;
    }
    setEnabledTools(updated);
  };

  return (
    <div className="px-3 py-2 border-t border-vsc-panel-border/25">
      <h3 className="text-vsc-sm font-semibold text-vsc-text mb-1 flex items-center gap-1.5">
        <Wrench size={14} className="text-vsc-accent" />
        Tools
        <span className="text-[10px] text-vsc-text-dim font-normal ml-auto">{enabledCount}/{TOTAL_TOOLS}</span>
      </h3>
      <div className="space-y-0.5 max-h-[350px] overflow-y-auto scrollbar-thin">
        {Object.entries(TOOL_CATEGORIES).map(([category, tools]) => {
          const catEnabled = tools.filter(t => isEnabled(t.name)).length;
          const allEnabled = catEnabled === tools.length;

          return (
            <details key={category} className="group">
              <summary className="flex items-center gap-1.5 py-1 cursor-pointer select-none text-[11px] list-none hover:bg-vsc-list-hover rounded px-1 -mx-1">
                <ChevronRight size={10} className="text-vsc-text-dim transition-transform group-open:rotate-90 flex-shrink-0" />
                <span className="flex-1 text-vsc-text">{category}</span>
                <span className="text-[9px] text-vsc-text-dim mr-1">{catEnabled}/{tools.length}</span>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleCategory(category, !allEnabled);
                  }}
                  className="text-[9px] px-1.5 py-0 rounded transition-colors hover:bg-vsc-accent/20"
                  style={{ color: allEnabled ? 'var(--guide-text-dim)' : 'rgb(var(--guide-accent))' }}
                >
                  {allEnabled ? 'Disable all' : 'Enable all'}
                </button>
              </summary>
              <div className="pl-4 pb-1 space-y-0">
                {tools.map(tool => {
                  const enabled = isEnabled(tool.name);
                  return (
                    <button
                      key={tool.name}
                      className="w-full flex items-center gap-1.5 py-[2px] text-[10px] rounded px-1 -mx-1 hover:bg-vsc-list-hover"
                      onClick={() => toggleTool(tool.name)}
                    >
                      <div
                        className="w-[26px] h-[13px] rounded-full relative transition-colors flex-shrink-0"
                        style={{ backgroundColor: enabled ? 'rgb(var(--guide-accent))' : 'rgb(var(--guide-panel-border))' }}
                      >
                        <div
                          className="w-[9px] h-[9px] rounded-full bg-white absolute top-[2px] transition-all"
                          style={{ left: enabled ? '15px' : '2px' }}
                        />
                      </div>
                      <span className={enabled ? 'text-vsc-text' : 'text-vsc-text-dim'}>{tool.label}</span>
                    </button>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function KeyboardShortcuts() {
  return (
    <div className="px-3 py-2 border-t border-vsc-panel-border/25 overflow-x-auto">
      <h3 className="text-vsc-sm font-semibold text-vsc-text mb-2 flex items-center gap-1.5">
        <Keyboard size={14} className="text-vsc-accent" />
        Keyboard Shortcuts
      </h3>
      <div className="space-y-0.5">
        {KEYBOARD_SHORTCUTS.map(s => (
          <div key={s.keys} className="flex items-center justify-between px-1 py-0.5 text-vsc-xs min-w-0">
            <span className="text-vsc-text-dim truncate mr-2">{s.action}</span>
            <kbd className="bg-vsc-badge px-1.5 py-0.5 rounded text-[10px] font-mono text-vsc-text-bright flex-shrink-0">{s.keys}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingSlider({ label, value, min, max, step, onChange, tooltip, format }) {
  const safeValue = value ?? min ?? 0;
  const displayValue = format ? format(safeValue) : safeValue.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0);

  return (
    <div className="mb-2" title={tooltip}>
      <div className="flex items-center justify-between mb-0.5">
        <label className="text-[11px] text-vsc-text-dim">{label}</label>
        <span className="text-[11px] text-vsc-text-bright font-medium">{displayValue}</span>
      </div>
      <input
        type="range"
        className="w-full h-1 appearance-none bg-vsc-panel-border rounded-full cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-vsc-accent
          [&::-webkit-slider-thumb]:hover:bg-vsc-accent-hover [&::-webkit-slider-thumb]:cursor-pointer"
        min={min} max={max} step={step}
        value={safeValue}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

function MCPConfigPanel() {
  const mcpServers = useAppStore(s => s.mcpServers);
  const addMcpServer = useAppStore(s => s.addMcpServer);
  const removeMcpServer = useAppStore(s => s.removeMcpServer);
  const toggleMcpServer = useAppStore(s => s.toggleMcpServer);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');

  const handleAdd = async () => {
    if (!name.trim() || !command.trim()) return;
    const serverConfig = {
      name: name.trim(),
      command: command.trim(),
      args: args.trim() ? args.trim().split(/\s+/) : [],
    };
    // Save to localStorage for persistence
    addMcpServer(serverConfig);
    // Also tell the backend to actually start the MCP server
    if (window.electronAPI?.mcpAddServer) {
      const result = await window.electronAPI.mcpAddServer(serverConfig);
      if (!result?.success) {
        console.error(`[MCPConfigPanel] add-server failed: ${result?.error}`);
      }
    }
    setName(''); setCommand(''); setArgs('');
    setAdding(false);
  };

  return (
    <div className="px-3 py-2 border-t border-vsc-panel-border/25">
      <h3 className="text-vsc-sm font-semibold text-vsc-text mb-2 flex items-center gap-1.5">
        <Server size={14} className="text-vsc-accent" />
        MCP Servers
      </h3>

      {mcpServers.length === 0 && !adding && (
        <p className="text-[11px] text-vsc-text-dim mb-2">No MCP servers configured.</p>
      )}

      <div className="space-y-1 mb-2">
        {mcpServers.map(sv => (
          <div key={sv.id} className="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-vsc-list-hover group">
            <button onClick={async () => { toggleMcpServer(sv.id); if (window.electronAPI?.mcpToggleServer) await window.electronAPI.mcpToggleServer(sv.name); }} title={sv.enabled ? 'Disable' : 'Enable'}>
              <Power size={12} className={sv.enabled ? 'text-green-400' : 'text-vsc-text-dim'} />
            </button>
            <div className="flex-1 min-w-0">
              <div className={`text-vsc-xs truncate ${sv.enabled ? 'text-vsc-text' : 'text-vsc-text-dim line-through'}`}>
                {sv.name}
              </div>
              <div className="text-[10px] text-vsc-text-dim truncate">{sv.command}</div>
            </div>
            <button
              className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-vsc-list-hover rounded"
              onClick={async () => { removeMcpServer(sv.id); if (window.electronAPI?.mcpRemoveServer) await window.electronAPI.mcpRemoveServer(sv.name); }}
              title="Remove"
            >
              <Trash2 size={11} className="text-vsc-text-dim hover:text-red-400" />
            </button>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="space-y-1.5 p-2 bg-vsc-bg rounded border border-vsc-panel-border/15">
          <input
            className="w-full h-6 px-2 text-vsc-xs bg-vsc-input border border-vsc-input-border rounded-sm"
            placeholder="Server name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <input
            className="w-full h-6 px-2 text-vsc-xs bg-vsc-input border border-vsc-input-border rounded-sm"
            placeholder="Command (e.g. npx)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className="w-full h-6 px-2 text-vsc-xs bg-vsc-input border border-vsc-input-border rounded-sm"
            placeholder="Args (space-separated)"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
          <div className="flex gap-1.5">
            <button
              className="btn btn-primary flex-1 disabled:opacity-40"
              onClick={handleAdd}
              disabled={!name.trim() || !command.trim()}
            >
              Add
            </button>
            <button
              className="btn flex-1"
              onClick={() => { setAdding(false); setName(''); setCommand(''); setArgs(''); }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="w-full px-2 py-1 text-vsc-xs text-vsc-accent hover:bg-vsc-list-hover rounded flex items-center gap-1"
          onClick={() => setAdding(true)}
        >
          <Plus size={12} />
          Add Server
        </button>
      )}
    </div>
  );
}

function DebugPanel() {
  const debugSessionId = useAppStore(s => s.debugSessionId);
  const debugSessionState = useAppStore(s => s.debugSessionState);
  const debugStackFrames = useAppStore(s => s.debugStackFrames);
  const debugScopes = useAppStore(s => s.debugScopes);
  const debugVariables = useAppStore(s => s.debugVariables);
  const debugOutput = useAppStore(s => s.debugOutput);
  const debugError = useAppStore(s => s.debugError);
  const setDebugError = useAppStore(s => s.setDebugError);
  const addDebugOutput = useAppStore(s => s.addDebugOutput);
  const clearDebugOutput = useAppStore(s => s.clearDebugOutput);

  const [debugType, setDebugType] = useState('node');
  const [program, setProgram] = useState('');
  const [args, setArgs] = useState('');
  const [evalExpr, setEvalExpr] = useState('');
  const [expandedScopes, setExpandedScopes] = useState({});
  const [expandedFrames, setExpandedFrames] = useState({});
  const [showCallStack, setShowCallStack] = useState(true);
  const [showVariables, setShowVariables] = useState(true);
  const [showConsole, setShowConsole] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const consoleEndRef = useRef(null);

  const isActive = debugSessionState !== 'inactive';
  const isPaused = debugSessionState === 'paused';

  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [debugOutput]);

  const debugAction = useCallback(async (endpoint, method = 'POST', body = null) => {
    try {
      setActionLoading(true);
      setDebugError(null);
      const opts = { method };
      if (body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(`/api/debug/${endpoint}`, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Debug action failed');
      return data;
    } catch (err) {
      setDebugError(err.message);
      return null;
    } finally {
      setActionLoading(false);
    }
  }, [setDebugError]);

  const handleStart = useCallback(async () => {
    if (!program.trim()) {
      setDebugError('Enter a file path to debug');
      return;
    }
    clearDebugOutput();
    const argsList = args.trim() ? args.trim().split(/\s+/) : [];
    await debugAction('start', 'POST', { type: debugType, program: program.trim(), args: argsList });
  }, [program, args, debugType, debugAction, clearDebugOutput, setDebugError]);

  const handleStop = useCallback(() => debugAction('stop', 'POST', { sessionId: debugSessionId }), [debugAction, debugSessionId]);
  const handleContinue = useCallback(() => debugAction('continue', 'POST', { sessionId: debugSessionId }), [debugAction, debugSessionId]);
  const handleStepOver = useCallback(() => debugAction('stepOver', 'POST', { sessionId: debugSessionId }), [debugAction, debugSessionId]);
  const handleStepInto = useCallback(() => debugAction('stepInto', 'POST', { sessionId: debugSessionId }), [debugAction, debugSessionId]);
  const handleStepOut = useCallback(() => debugAction('stepOut', 'POST', { sessionId: debugSessionId }), [debugAction, debugSessionId]);
  const handlePause = useCallback(() => debugAction('pause', 'POST', { sessionId: debugSessionId }), [debugAction, debugSessionId]);

  const handleEvaluate = useCallback(async () => {
    if (!evalExpr.trim() || !debugSessionId) return;
    const result = await debugAction('evaluate', 'POST', {
      sessionId: debugSessionId,
      expression: evalExpr.trim(),
      frameId: debugStackFrames[0]?.id
    });
    if (result && result.result) {
      addDebugOutput(`> ${evalExpr}`);
      addDebugOutput(result.result.description || result.result.value || JSON.stringify(result.result));
    }
    setEvalExpr('');
  }, [evalExpr, debugSessionId, debugStackFrames, debugAction, addDebugOutput]);

  const toggleScope = useCallback(async (scopeRef) => {
    const key = String(scopeRef);
    if (expandedScopes[key]) {
      setExpandedScopes(prev => { const n = { ...prev }; delete n[key]; return n; });
    } else {
      setExpandedScopes(prev => ({ ...prev, [key]: true }));
      if (!debugVariables[key]) {
        await debugAction('variables', 'GET');
      }
    }
  }, [expandedScopes, debugVariables, debugAction]);

  const loadFrameScopes = useCallback(async (frameIndex) => {
    const key = String(frameIndex);
    if (expandedFrames[key]) {
      setExpandedFrames(prev => { const n = { ...prev }; delete n[key]; return n; });
    } else {
      setExpandedFrames(prev => ({ ...prev, [key]: true }));
    }
  }, [expandedFrames]);

  // No active session — show launch config
  if (!isActive) {
    return (
      <div className="flex flex-col h-full">
        <div className="sidebar-header">
          <span className="font-semibold text-vsc-xs tracking-wider">Run and Debug</span>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-vsc p-3 space-y-3">
          {debugError && (
            <div className="flex items-center gap-1.5 p-2 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-vsc-xs">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="truncate">{debugError}</span>
            </div>
          )}

          <div>
            <label className="text-vsc-xs text-vsc-text-dim block mb-1">Type</label>
            <div className="flex gap-1">
              <button
                className={`flex-1 px-2 py-1 rounded text-vsc-xs ${debugType === 'node' ? 'bg-vsc-accent text-white' : 'bg-vsc-bg-light text-vsc-text-dim hover:text-vsc-text'}`}
                onClick={() => setDebugType('node')}
              >Node.js</button>
              <button
                className={`flex-1 px-2 py-1 rounded text-vsc-xs ${debugType === 'python' ? 'bg-vsc-accent text-white' : 'bg-vsc-bg-light text-vsc-text-dim hover:text-vsc-text'}`}
                onClick={() => setDebugType('python')}
              >Python</button>
            </div>
          </div>

          <div>
            <label className="text-vsc-xs text-vsc-text-dim block mb-1">Program</label>
            <input
              className="w-full bg-vsc-input border border-vsc-border rounded px-2 py-1 text-vsc-sm text-vsc-text placeholder-vsc-text-dim focus:outline-none focus:border-vsc-accent"
              placeholder={debugType === 'node' ? 'e.g. index.js' : 'e.g. main.py'}
              value={program}
              onChange={e => setProgram(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleStart()}
            />
          </div>

          <div>
            <label className="text-vsc-xs text-vsc-text-dim block mb-1">Arguments</label>
            <input
              className="w-full bg-vsc-input border border-vsc-border rounded px-2 py-1 text-vsc-sm text-vsc-text placeholder-vsc-text-dim focus:outline-none focus:border-vsc-accent"
              placeholder="Optional arguments"
              value={args}
              onChange={e => setArgs(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleStart()}
            />
          </div>

          <button
            className="btn btn-primary w-full flex items-center justify-center gap-1.5 disabled:opacity-50"
            onClick={handleStart}
            disabled={actionLoading || !program.trim()}
          >
            <Play size={14} />
            Start Debugging
          </button>

          <div className="border-t border-vsc-border pt-3 mt-2">
            <p className="text-vsc-xs text-vsc-text-dim">
              {debugType === 'node'
                ? 'Launches Node.js with --inspect-brk. Connects via Chrome DevTools Protocol.'
                : 'Launches Python with debugpy. Requires: pip install debugpy'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Active session — show debugger controls
  return (
    <div className="flex flex-col h-full">
      <div className="sidebar-header justify-between">
        <span className="font-semibold text-vsc-xs tracking-wider">
          <Bug size={12} className="inline mr-1" />
          Debugging
        </span>
        <span className={`text-vsc-xs px-1.5 py-0.5 rounded ${isPaused ? 'bg-yellow-500/20 text-yellow-400' : 'bg-green-500/20 text-green-400'}`}>
          {debugSessionState}
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-vsc-border bg-vsc-bg-darker">
        <button onClick={handleContinue} disabled={!isPaused || actionLoading} title="Continue (F5)"
          className="p-1 rounded hover:bg-vsc-bg-light text-green-400 disabled:opacity-30 disabled:hover:bg-transparent">
          <Play size={14} />
        </button>
        <button onClick={handleStepOver} disabled={!isPaused || actionLoading} title="Step Over (F10)"
          className="p-1 rounded hover:bg-vsc-bg-light text-vsc-accent disabled:opacity-30 disabled:hover:bg-transparent">
          <SkipForward size={14} />
        </button>
        <button onClick={handleStepInto} disabled={!isPaused || actionLoading} title="Step Into (F11)"
          className="p-1 rounded hover:bg-vsc-bg-light text-vsc-accent disabled:opacity-30 disabled:hover:bg-transparent">
          <ArrowDownRight size={14} />
        </button>
        <button onClick={handleStepOut} disabled={!isPaused || actionLoading} title="Step Out (Shift+F11)"
          className="p-1 rounded hover:bg-vsc-bg-light text-vsc-accent disabled:opacity-30 disabled:hover:bg-transparent">
          <ArrowUpRight size={14} />
        </button>
        <button onClick={handlePause} disabled={isPaused || actionLoading} title="Pause (F6)"
          className="p-1 rounded hover:bg-vsc-bg-light text-yellow-400 disabled:opacity-30 disabled:hover:bg-transparent">
          <Pause size={14} />
        </button>
        <div className="flex-1" />
        <button onClick={handleStop} disabled={actionLoading} title="Stop (Shift+F5)"
          className="p-1 rounded hover:bg-vsc-bg-light text-red-400 disabled:opacity-30 disabled:hover:bg-transparent">
          <Square size={14} />
        </button>
      </div>

      {debugError && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border-b border-red-500/30 text-red-400 text-vsc-xs">
          <AlertTriangle size={12} className="shrink-0" />
          <span className="truncate">{debugError}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-vsc">
        {/* Call Stack */}
        <div className="border-b border-vsc-border">
          <button
            className="w-full flex items-center gap-1 px-3 py-1.5 text-vsc-xs font-semibold tracking-wider text-vsc-text-dim hover:text-vsc-text"
            onClick={() => setShowCallStack(v => !v)}
          >
            {showCallStack ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Call Stack
          </button>
          {showCallStack && (
            <div className="px-1 pb-2">
              {debugStackFrames.length === 0 ? (
                <p className="px-3 text-vsc-xs text-vsc-text-dim italic">
                  {isPaused ? 'No frames available' : 'Running...'}
                </p>
              ) : (
                debugStackFrames.map((frame, i) => (
                  <button
                    key={frame.id || i}
                    className={`w-full text-left px-3 py-0.5 text-vsc-xs hover:bg-vsc-bg-light rounded truncate ${i === 0 ? 'text-yellow-300' : 'text-vsc-text-dim'}`}
                    onClick={() => loadFrameScopes(i)}
                    title={`${frame.name} — ${frame.source || 'unknown'}:${frame.line || '?'}`}
                  >
                    <span className="text-vsc-text">{frame.name || '<anonymous>'}</span>
                    {frame.source && (
                      <span className="ml-1 text-vsc-text-dim">
                        {frame.source.split(/[/\\]/).pop()}:{frame.line}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Variables */}
        <div className="border-b border-vsc-border">
          <button
            className="w-full flex items-center gap-1 px-3 py-1.5 text-vsc-xs font-semibold tracking-wider text-vsc-text-dim hover:text-vsc-text"
            onClick={() => setShowVariables(v => !v)}
          >
            {showVariables ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Variables
          </button>
          {showVariables && (
            <div className="px-1 pb-2">
              {debugScopes.length === 0 ? (
                <p className="px-3 text-vsc-xs text-vsc-text-dim italic">
                  {isPaused ? 'No scopes available' : 'Not paused'}
                </p>
              ) : (
                debugScopes.map((scope, si) => (
                  <div key={scope.name || si}>
                    <button
                      className="w-full flex items-center gap-1 px-3 py-0.5 text-vsc-xs text-vsc-text hover:bg-vsc-bg-light rounded"
                      onClick={() => toggleScope(scope.object?.objectId || si)}
                    >
                      {expandedScopes[String(scope.object?.objectId || si)]
                        ? <ChevronDown size={10} />
                        : <ChevronRight size={10} />}
                      <Eye size={10} className="text-vsc-accent" />
                      <span>{scope.name || scope.type || 'Scope'}</span>
                    </button>
                    {expandedScopes[String(scope.object?.objectId || si)] && (
                      <div className="ml-4">
                        {(debugVariables[String(scope.object?.objectId || si)] || []).map((v, vi) => (
                          <div key={v.name || vi} className="flex items-baseline gap-1.5 px-3 py-0.5 text-vsc-xs truncate">
                            <span className="text-blue-300">{v.name}</span>
                            <span className="text-vsc-text-dim">=</span>
                            <span className={`truncate ${v.type === 'string' ? 'text-orange-300' : v.type === 'number' ? 'text-green-300' : 'text-vsc-text'}`}>
                              {v.value !== undefined ? String(v.value) : v.description || 'undefined'}
                            </span>
                          </div>
                        ))}
                        {(!debugVariables[String(scope.object?.objectId || si)] ||
                          debugVariables[String(scope.object?.objectId || si)].length === 0) && (
                          <p className="px-3 text-vsc-xs text-vsc-text-dim italic">No variables</p>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Debug Console */}
        <div>
          <button
            className="w-full flex items-center gap-1 px-3 py-1.5 text-vsc-xs font-semibold tracking-wider text-vsc-text-dim hover:text-vsc-text"
            onClick={() => setShowConsole(v => !v)}
          >
            {showConsole ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Debug Console
          </button>
          {showConsole && (
            <div className="px-1 pb-2">
              <div className="max-h-48 overflow-y-auto scrollbar-vsc bg-vsc-bg-darker rounded mx-2 mb-2">
                {debugOutput.length === 0 ? (
                  <p className="px-2 py-1 text-vsc-xs text-vsc-text-dim italic">No output</p>
                ) : (
                  debugOutput.map((line, i) => (
                    <div key={i} className="px-2 py-0.5 text-vsc-xs font-mono text-vsc-text whitespace-pre-wrap break-all">
                      {line}
                    </div>
                  ))
                )}
                <div ref={consoleEndRef} />
              </div>
              {isPaused && (
                <div className="flex gap-1 mx-2">
                  <input
                    className="flex-1 bg-vsc-input border border-vsc-border rounded px-2 py-1 text-vsc-xs text-vsc-text placeholder-vsc-text-dim font-mono focus:outline-none focus:border-vsc-accent"
                    placeholder="Evaluate expression..."
                    value={evalExpr}
                    onChange={e => setEvalExpr(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleEvaluate()}
                  />
                  <button
                    className="btn btn-primary px-2 py-1 disabled:opacity-50"
                    onClick={handleEvaluate}
                    disabled={!evalExpr.trim()}
                  >
                    Run
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExtensionsPanel() {
  const extensions = useAppStore(s => s.extensions);
  const extensionCategories = useAppStore(s => s.extensionCategories);
  const extensionsLoading = useAppStore(s => s.extensionsLoading);
  const setExtensions = useAppStore(s => s.setExtensions);
  const setExtensionCategories = useAppStore(s => s.setExtensionCategories);
  const setExtensionsLoading = useAppStore(s => s.setExtensionsLoading);
  const addNotification = useAppStore(s => s.addNotification);

  const [tab, setTab] = useState('installed');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [actionLoading, setActionLoading] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogSource, setCatalogSource] = useState('');
  const fileInputRef = useRef(null);

  const loadExtensions = useCallback(async () => {
    setExtensionsLoading(true);
    try {
      const res = await fetch('/api/extensions');
      const data = await res.json();
      if (data.extensions) setExtensions(data.extensions);
      if (data.categories) setExtensionCategories(data.categories);
    } catch (err) {
      console.error('Failed to load extensions:', err);
    }
    setExtensionsLoading(false);
  }, [setExtensions, setExtensionCategories, setExtensionsLoading]);

  useEffect(() => {
    loadExtensions();
  }, [loadExtensions]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const res = await fetch('/api/extensions/catalog');
      const data = await res.json();
      setCatalog(data.extensions || []);
      setCatalogSource(data.source || '');
    } catch (err) {
      console.error('Failed to load marketplace catalog:', err);
      addNotification({ type: 'error', message: 'Failed to load marketplace catalog' });
    }
    setCatalogLoading(false);
  }, [addNotification]);

  useEffect(() => {
    if (tab === 'marketplace') loadCatalog();
  }, [tab, loadCatalog]);

  const handleMarketplaceInstall = async (ext) => {
    if (!ext.downloadUrl) {
      addNotification({ type: 'info', message: `${ext.name} is not available for one-click install yet` });
      return;
    }
    setActionLoading(ext.id);
    try {
      const res = await fetch('/api/extensions/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadUrl: ext.downloadUrl, id: ext.id }),
      });
      const data = await res.json();
      if (data.success) {
        addNotification({ type: 'info', message: `Installed ${ext.name}` });
        await loadExtensions();
      } else {
        addNotification({ type: 'error', message: data.error || 'Install failed' });
      }
    } catch (err) {
      addNotification({ type: 'error', message: err.message });
    }
    setActionLoading(null);
  };

  const handleInstallFile = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setActionLoading('installing');
    try {
      for (const file of files) {
        let data;
        if (window.electronAPI?.installExtensionFile) {
          const buf = await file.arrayBuffer();
          data = await window.electronAPI.installExtensionFile(buf, file.name);
        } else {
          const buf = await file.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buf));
          const res = await fetch('/api/extensions/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ _fileBuffer: bytes, _fileName: file.name }),
          });
          data = await res.json();
        }
        if (!data.success) {
          addNotification({ type: 'error', message: data.error || `Install failed: ${file.name}` });
        } else {
          addNotification({ type: 'info', message: `Installed ${file.name}` });
        }
      }
      await loadExtensions();
    } catch (err) {
      addNotification({ type: 'error', message: err.message || 'Install error' });
    }
    setActionLoading(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUninstall = async (id) => {
    setActionLoading(id);
    try {
      await fetch('/api/extensions/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await loadExtensions();
    } catch (err) {
      console.error('Uninstall error:', err);
    }
    setActionLoading(null);
  };

  const handleToggle = async (id, enabled) => {
    try {
      await fetch(`/api/extensions/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await loadExtensions();
    } catch (err) {
      console.error('Toggle error:', err);
    }
  };

  const categoryColors = {
    theme: '#9b59b6',
    snippets: '#3498db',
    formatter: '#2ecc71',
    linter: '#e67e22',
    language: '#1abc9c',
    tools: '#e74c3c',
    git: '#f39c12',
    ai: '#8b5cf6',
    other: '#6b7280',
  };

  const renderStars = (rating) => {
    const full = Math.floor(rating || 0);
    return (
      <span className="flex items-center gap-0.5">
        {Array.from({ length: 5 }, (_, i) => (
          <Star key={i} size={10} fill={i < full ? '#fbbf24' : 'none'} stroke={i < full ? '#fbbf24' : '#666'} />
        ))}
        {rating > 0 && <span className="text-[10px] ml-0.5 text-vsc-text-dim">{rating}</span>}
      </span>
    );
  };

  const filtered = extensions.filter(ext => {
    if (category !== 'all' && ext.category !== category) return false;
    if (search && !ext.name.toLowerCase().includes(search.toLowerCase()) &&
        !ext.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full text-[12px]">
      {/* Tabs */}
      <div className="flex border-b border-vsc-border">
        <button onClick={() => setTab('installed')}
          className={`flex-1 px-2 py-1.5 text-[11px] transition-colors border-b-2 ${
            tab === 'installed' ? 'text-vsc-accent border-vsc-accent' : 'text-vsc-text-dim border-transparent'
          }`}>
          Installed ({extensions.length})
        </button>
        <button onClick={() => setTab('marketplace')}
          className={`flex-1 px-2 py-1.5 text-[11px] transition-colors border-b-2 ${
            tab === 'marketplace' ? 'text-vsc-accent border-vsc-accent' : 'text-vsc-text-dim border-transparent'
          }`}>
          Marketplace
        </button>
      </div>

      {/* Search + Filter */}
      <div className="px-3 pt-2 space-y-1.5">
        <div className="flex items-center gap-1 px-2 py-1.5 rounded bg-vsc-input border border-vsc-border">
          <SearchIcon size={13} className="text-vsc-text-dim" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search extensions..."
            className="flex-1 bg-transparent outline-none text-[12px] text-vsc-text"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {extensionCategories.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)}
              className={`px-2 py-0.5 rounded-full text-[10px] capitalize transition-colors ${
                category === cat ? 'bg-vsc-accent text-white' : 'bg-vsc-sidebar-bg text-vsc-text-dim'
              }`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Install Button */}
      {tab === 'installed' && (
        <div className="px-3 pt-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.guide-ext"
            className="hidden"
            onChange={handleInstallFile}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={actionLoading === 'installing'}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium bg-vsc-accent text-white hover:opacity-90 disabled:opacity-50"
          >
            <Upload size={13} />
            {actionLoading === 'installing' ? 'Installing...' : 'Install from File'}
          </button>
        </div>
      )}

      {/* Extension List */}
      <div className="flex-1 overflow-auto px-3 py-2 space-y-2">
        {tab === 'installed' && (
          extensionsLoading ? (
            <div className="text-center py-8 text-vsc-text-dim">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8">
              <Package size={32} className="mx-auto mb-2 opacity-30 text-vsc-text-dim" />
              <p className="text-vsc-text-dim text-[12px]">No extensions installed</p>
              <p className="text-[10px] text-vsc-text-dim mt-1">
                Install extensions from .zip or .guide-ext files,<br />
                or browse the marketplace for community extensions.
              </p>
            </div>
          ) : (
            filtered.map(ext => (
              <div key={ext.id} className="p-2.5 rounded bg-vsc-sidebar-bg border border-vsc-border">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Package size={14} style={{ color: categoryColors[ext.category] || categoryColors.other }} />
                      <span className="font-medium text-[12px] text-vsc-text">{ext.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full capitalize bg-vsc-selection text-vsc-text-dim">
                        {ext.category}
                      </span>
                    </div>
                    <p className="text-[11px] mt-0.5 leading-tight text-vsc-text-dim">{ext.description}</p>
                    <div className="flex items-center gap-3 mt-1">
                      {ext.rating && renderStars(ext.rating)}
                      <span className="text-[10px] text-vsc-text-dim">v{ext.version}</span>
                      {ext.author && <span className="text-[10px] text-vsc-text-dim">{ext.author}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                    <button onClick={() => handleToggle(ext.id, !ext.enabled)}
                      className="p-1 rounded hover:opacity-80"
                      title={ext.enabled ? 'Disable' : 'Enable'}>
                      {ext.enabled
                        ? <ToggleRight size={18} className="text-green-400" />
                        : <ToggleLeft size={18} className="text-vsc-text-dim" />}
                    </button>
                    {!ext.builtin && (
                      <button onClick={() => handleUninstall(ext.id)}
                        disabled={actionLoading === ext.id}
                        className="p-1 rounded hover:opacity-80 text-vsc-text-dim disabled:opacity-50"
                        title="Uninstall">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )
        )}

        {tab === 'marketplace' && (
          catalogLoading ? (
            <div className="text-center py-8 text-vsc-text-dim">Loading marketplace...</div>
          ) : catalog.length === 0 ? (
            <div className="text-center py-8">
              <Package size={32} className="mx-auto mb-2 opacity-30 text-vsc-text-dim" />
              <p className="text-vsc-text-dim text-[12px] font-medium">Community Marketplace</p>
              <p className="text-[10px] text-vsc-text-dim mt-1 mb-3">
                No extensions available from catalog.
              </p>
              <button
                onClick={loadCatalog}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[11px] font-medium bg-vsc-accent text-white hover:opacity-90"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            </div>
          ) : (
            catalog
              .filter(ext => {
                if (category !== 'all' && ext.category !== category) return false;
                if (search && !ext.name.toLowerCase().includes(search.toLowerCase()) &&
                    !(ext.description || '').toLowerCase().includes(search.toLowerCase())) return false;
                return true;
              })
              .map(ext => {
                const installed = extensions.some(e => e.id === ext.id);
                return (
                  <div key={ext.id} className="p-2.5 rounded bg-vsc-sidebar-bg border border-vsc-border">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Package size={14} style={{ color: categoryColors[ext.category] || categoryColors.other }} />
                          <span className="font-medium text-[12px] text-vsc-text">{ext.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full capitalize bg-vsc-selection text-vsc-text-dim">
                            {ext.category || 'other'}
                          </span>
                        </div>
                        <p className="text-[11px] mt-0.5 leading-tight text-vsc-text-dim">{ext.description}</p>
                        <div className="flex items-center gap-3 mt-1">
                          {ext.rating && renderStars(ext.rating)}
                          <span className="text-[10px] text-vsc-text-dim">v{ext.version}</span>
                          {ext.author && <span className="text-[10px] text-vsc-text-dim">{ext.author}</span>}
                        </div>
                      </div>
                      <div className="ml-2 flex-shrink-0">
                        {installed ? (
                          <span className="text-[10px] text-green-400">Installed</span>
                        ) : (
                          <button
                            onClick={() => handleMarketplaceInstall(ext)}
                            disabled={actionLoading === ext.id}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-vsc-accent text-white hover:opacity-90 disabled:opacity-50"
                          >
                            <Download size={12} />
                            {actionLoading === ext.id ? 'Installing...' : 'Install'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
          )
        )}
        {tab === 'marketplace' && catalogSource && (
          <p className="text-[10px] text-vsc-text-dim text-center pt-2">Catalog source: {catalogSource}</p>
        )}
      </div>
    </div>
  );
}
