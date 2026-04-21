/**
 * NewProjectDialog — Modal for creating a new project from a template.
 */
import { useState, useRef, useEffect } from 'react';
import useAppStore from '../stores/appStore';
import {
  FolderPlus, X, Folder, FileCode, Server, Monitor, Wrench, Bot, Cpu,
  Globe, Chrome, Terminal, Package, Boxes, Layout, Code2,
} from 'lucide-react';

const ICON_MAP = {
  folder: Folder, react: Code2, nextjs: Globe, nodejs: Server, python: FileCode,
  electron: Monitor, html: Layout, chrome: Chrome, bot: Bot, terminal: Terminal,
  vue: Code2, svelte: Code2, flask: Server, docker: Boxes, ai: Cpu, mcp: Package,
  tauri: Monitor, rust: Wrench,
};

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend' },
  { id: 'desktop', label: 'Desktop' },
  { id: 'tools', label: 'Tools' },
  { id: 'ai', label: 'AI' },
  { id: 'general', label: 'General' },
];

export default function NewProjectDialog() {
  const show = useAppStore(s => s.showNewProjectDialog);
  const setShow = useAppStore(s => s.setShowNewProjectDialog);
  const setProjectPath = useAppStore(s => s.setProjectPath);
  const setFileTree = useAppStore(s => s.setFileTree);
  const addNotification = useAppStore(s => s.addNotification);

  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [category, setCategory] = useState('all');
  const [parentDir, setParentDir] = useState('');
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);
  const nameRef = useRef(null);

  // Fetch templates when dialog opens
  useEffect(() => {
    if (!show) return;
    fetch('/api/templates')
      .then(r => r.json())
      .then(data => {
        setTemplates(data);
        if (data.length && !selectedTemplate) setSelectedTemplate(data[0].id);
      })
      .catch(() => {});
  }, [show]);

  // Pre-populate parent directory with user's home directory
  useEffect(() => {
    if (!show) return;
    fetch('/api/system/homedir')
      .then(r => r.json())
      .then(data => { if (data.homedir && !parentDir) setParentDir(data.homedir); })
      .catch(() => {});
  }, [show]);

  useEffect(() => {
    if (show && nameRef.current) nameRef.current.focus();
  }, [show, selectedTemplate]);

  if (!show) return null;

  const filtered = category === 'all'
    ? templates
    : templates.filter(t => t.category === category);

  const handleBrowse = async () => {
    if (window.electronAPI?.openFolderDialog) {
      const dir = await window.electronAPI.openFolderDialog();
      if (dir) setParentDir(dir);
    } else {
      const dir = prompt('Enter parent directory path:');
      if (dir) setParentDir(dir);
    }
  };

  const handleCreate = async () => {
    if (!parentDir.trim() || !projectName.trim() || !selectedTemplate) return;
    setCreating(true);
    try {
      const res = await fetch('/api/templates/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: selectedTemplate,
          projectName: projectName.trim(),
          parentDir: parentDir.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        const openedPath = data.path || data.projectDir;
        setProjectPath(openedPath);
        await fetch('/api/project/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: openedPath }),
        });
        const treeRes = await fetch(`/api/files/tree?path=${encodeURIComponent(openedPath)}`);
        const treeData = await treeRes.json();
        setFileTree(treeData.items || []);
        addNotification({ type: 'info', message: `Project "${projectName}" created (${data.filesCreated.length} files)`, duration: 3000 });
        setShow(false);
        setSelectedTemplate(null);
        setCategory('all');
        setParentDir('');
        setProjectName('');
      } else {
        addNotification({ type: 'error', message: data.error || 'Failed to create project', duration: 4000 });
      }
    } catch {
      addNotification({ type: 'error', message: 'Failed to create project', duration: 4000 });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50" onClick={() => setShow(false)}>
      <div
        className="w-[720px] max-h-[85vh] bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-vsc-panel-border flex-shrink-0">
          <div className="flex items-center gap-2 text-vsc-text-bright text-vsc-base font-medium">
            <FolderPlus size={16} className="text-vsc-accent" />
            New Project
          </div>
          <button className="text-vsc-text-dim hover:text-vsc-text" onClick={() => setShow(false)}>
            <X size={16} />
          </button>
        </div>

        {/* Category tabs */}
        <div className="flex gap-1 px-4 pt-3 pb-2 border-b border-vsc-panel-border flex-shrink-0 flex-wrap">
          {CATEGORIES.map(c => (
            <button
              key={c.id}
              className={`px-2.5 py-1 text-vsc-xs rounded transition-colors ${
                category === c.id
                  ? 'bg-vsc-accent text-white'
                  : 'text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover'
              }`}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Template grid */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-3 gap-2">
            {filtered.map(t => {
              const Icon = ICON_MAP[t.icon] || Folder;
              const isSelected = selectedTemplate === t.id;
              return (
                <button
                  key={t.id}
                  className={`flex flex-col items-start p-3 rounded-lg border text-left transition-colors ${
                    isSelected
                      ? 'border-vsc-accent bg-vsc-accent/10'
                      : 'border-vsc-panel-border hover:border-vsc-text-dim hover:bg-vsc-list-hover'
                  }`}
                  onClick={() => setSelectedTemplate(t.id)}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <Icon size={16} className={isSelected ? 'text-vsc-accent' : 'text-vsc-text-dim'} />
                    <span className={`text-vsc-sm font-medium ${isSelected ? 'text-vsc-text-bright' : 'text-vsc-text'}`}>
                      {t.name}
                    </span>
                  </div>
                  <p className="text-[10px] text-vsc-text-dim leading-tight line-clamp-2">{t.description}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Project config */}
        <div className="px-4 py-3 border-t border-vsc-panel-border flex-shrink-0 flex flex-col gap-2.5">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-vsc-xs text-vsc-text-dim mb-1">Parent Directory</label>
              <div className="flex gap-1">
                <input
                  type="text"
                  className="flex-1 bg-vsc-input border border-vsc-panel-border rounded px-2 py-1.5 text-vsc-sm text-vsc-text outline-none focus:border-vsc-accent"
                  placeholder="Select a directory..."
                  value={parentDir}
                  onChange={e => setParentDir(e.target.value)}
                />
                <button
                  className="px-2 bg-vsc-input border border-vsc-panel-border rounded text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover"
                  onClick={handleBrowse}
                  title="Browse..."
                >
                  <Folder size={14} />
                </button>
              </div>
            </div>
            <div className="w-[200px]">
              <label className="block text-vsc-xs text-vsc-text-dim mb-1">Project Name</label>
              <input
                ref={nameRef}
                type="text"
                className="w-full bg-vsc-input border border-vsc-panel-border rounded px-2 py-1.5 text-vsc-sm text-vsc-text outline-none focus:border-vsc-accent"
                placeholder="my-project"
                value={projectName}
                onChange={e => setProjectName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              />
            </div>
          </div>
          {parentDir && projectName && (
            <p className="text-[10px] text-vsc-text-dim truncate">
              {parentDir.replace(/[\\/]$/, '')}/{projectName.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '-').toLowerCase()}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-vsc-panel-border flex-shrink-0">
          <button
            className="px-3 py-1.5 text-vsc-sm text-vsc-text rounded hover:bg-vsc-list-hover"
            onClick={() => setShow(false)}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-vsc-sm bg-vsc-accent text-white rounded hover:opacity-90 disabled:opacity-50"
            disabled={!parentDir.trim() || !projectName.trim() || !selectedTemplate || creating}
            onClick={handleCreate}
          >
            {creating ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
