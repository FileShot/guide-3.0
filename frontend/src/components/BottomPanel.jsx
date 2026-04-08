/**
 * BottomPanel — Terminal, Output, Problems, Debug Console, and Ports tabs.
 * VS Code-style: tabs left, terminal instance list right, badge on Problems.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import useAppStore from '../stores/appStore';
import { Terminal as TerminalIcon, FileOutput, AlertTriangle, X, Plus, Trash2, Globe, Bug, ChevronDown, MoreHorizontal, CheckSquare, RefreshCw } from 'lucide-react';

const panelTabs = [
  { id: 'problems', label: 'PROBLEMS', icon: AlertTriangle },
  { id: 'output', label: 'OUTPUT', icon: FileOutput },
  { id: 'todo', label: 'TODO', icon: CheckSquare },
  { id: 'debug', label: 'DEBUG CONSOLE', icon: Bug },
  { id: 'terminal', label: 'TERMINAL', icon: TerminalIcon },
  { id: 'ports', label: 'PORTS', icon: Globe },
];

export default function BottomPanel() {
  const activePanelTab = useAppStore(s => s.activePanelTab);
  const setActivePanelTab = useAppStore(s => s.setActivePanelTab);
  const togglePanel = useAppStore(s => s.togglePanel);
  const terminalTabs = useAppStore(s => s.terminalTabs);
  const activeTerminalTab = useAppStore(s => s.activeTerminalTab);
  const setActiveTerminalTab = useAppStore(s => s.setActiveTerminalTab);
  const addTerminalTab = useAppStore(s => s.addTerminalTab);
  const closeTerminalTab = useAppStore(s => s.closeTerminalTab);

  // Problems count — reads from store (set to 0 by default, wired to Monaco diagnostics later)
  const problemsCount = useAppStore(s => s.problemsCount ?? 0);

  return (
    <div className="flex flex-col h-full bg-vsc-panel">
      {/* Tab bar */}
      <div className="flex items-center h-[35px] border-b border-vsc-panel-border no-select flex-shrink-0">
        {/* Left: panel type tabs */}
        <div className="flex items-center flex-1 min-w-0 overflow-hidden">
          {panelTabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`panel-tab flex-shrink-0 ${activePanelTab === id ? 'active' : ''}`}
              onClick={() => setActivePanelTab(id)}
            >
              <Icon size={14} className="mr-1.5" />
              {label}
              {id === 'problems' && problemsCount > 0 && (
                <span className="ml-1.5 px-1 py-px text-[10px] rounded bg-vsc-error/20 text-vsc-error font-medium leading-none">
                  {problemsCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Right: terminal instance tabs (always visible, not just when terminal active) */}
        <div className="flex items-center gap-0.5 pl-2 border-l border-vsc-panel-border/30 flex-shrink-0">
          {activePanelTab === 'terminal' && terminalTabs.map(tab => (
            <div
              key={tab.id}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] cursor-pointer transition-colors flex-shrink-0 ${
                activeTerminalTab === tab.id
                  ? 'bg-vsc-list-active text-vsc-text-bright'
                  : 'text-vsc-text-dim hover:bg-vsc-list-hover hover:text-vsc-text'
              }`}
              onClick={() => setActiveTerminalTab(tab.id)}
            >
              <TerminalIcon size={11} />
              <span className="max-w-[80px] truncate">{tab.name}</span>
              {terminalTabs.length > 1 && (
                <button
                  className="hover:text-vsc-error ml-0.5 flex-shrink-0"
                  onClick={(e) => { e.stopPropagation(); closeTerminalTab(tab.id); }}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
          <button
            className="p-1 hover:bg-vsc-list-hover rounded text-vsc-text-dim hover:text-vsc-text flex-shrink-0"
            title="New Terminal"
            onClick={addTerminalTab}
          >
            <Plus size={13} />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded text-vsc-text-dim hover:text-vsc-text flex-shrink-0" title="More terminal options">
            <ChevronDown size={13} />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded text-vsc-text-dim hover:text-vsc-text flex-shrink-0" title="More actions">
            <MoreHorizontal size={13} />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded flex-shrink-0" title="Clear" onClick={() => {}}>
            <Trash2 size={13} className="text-vsc-text-dim" />
          </button>
          <button className="p-1 hover:bg-vsc-list-hover rounded flex-shrink-0" title="Close Panel" onClick={togglePanel}>
            <X size={13} className="text-vsc-text-dim" />
          </button>
        </div>
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {activePanelTab === 'terminal' && <XTermPanel />}
        {activePanelTab === 'output' && <OutputPanel />}
        {activePanelTab === 'problems' && <ProblemsPanel />}
        {activePanelTab === 'todo' && <TodoPanel />}
        {activePanelTab === 'debug' && <PlaceholderPanel label="Debug Console" />}
        {activePanelTab === 'ports' && <PlaceholderPanel label="Ports" />}
      </div>
    </div>
  );
}

function PlaceholderPanel({ label }) {
  return (
    <div className="flex items-center justify-center h-full text-vsc-text-dim/40 text-[12px]">
      {label}
    </div>
  );
}

function XTermPanel() {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const termIdRef = useRef(null);
  const modeRef = useRef(null); // 'pty' | 'exec' | null
  const [loaded, setLoaded] = useState(false);
  const activeTerminalTab = useAppStore(s => s.activeTerminalTab);

  // Initialize xterm.js + IPC PTY
  useEffect(() => {
    let term = null;
    let fitAddon = null;
    let disposed = false;
    let cleanupData = null;
    let cleanupExit = null;

    async function initXterm() {
      try {
        const { Terminal } = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        const { WebLinksAddon } = await import('@xterm/addon-web-links');

        if (disposed) return;

        // Get theme colors from CSS variables
        const style = getComputedStyle(document.documentElement);
        const getColor = (name) => {
          const val = style.getPropertyValue(`--guide-${name}`).trim();
          if (!val) return undefined;
          const parts = val.split(' ').map(Number);
          if (parts.length === 3) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
          return undefined;
        };

        term = new Terminal({
          fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
          fontSize: 13,
          lineHeight: 1.4,
          cursorBlink: true,
          cursorStyle: 'bar',
          scrollback: 5000,
          theme: {
            background: getColor('terminal-bg') || '#0a0a0a',
            foreground: getColor('terminal-fg') || '#b4b4b4',
            cursor: getColor('terminal-cursor') || '#ff6b00',
            selectionBackground: getColor('selection') || 'rgba(60, 40, 10, 0.5)',
            black: '#000000',
            red: '#cd3131',
            green: '#0dbc79',
            yellow: '#e5e510',
            blue: '#2472c8',
            magenta: '#bc3fbc',
            cyan: '#11a8cd',
            white: '#e5e5e5',
            brightBlack: '#666666',
            brightRed: '#f14c4c',
            brightGreen: '#23d18b',
            brightYellow: '#f5f543',
            brightBlue: '#3b8eea',
            brightMagenta: '#d670d6',
            brightCyan: '#29b8db',
            brightWhite: '#e5e5e5',
          },
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());

        if (!termRef.current || disposed) return;

        term.open(termRef.current);
        fitAddon.fit();
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;
        setLoaded(true);

        const api = window.electronAPI;

        // Try IPC PTY first (Electron mode)
        if (api?.terminal) {
          const termId = activeTerminalTab || `pty-${Date.now()}`;
          termIdRef.current = termId;

          // Listen for data from this terminal
          cleanupData = api.terminal.onData((msg) => {
            if (msg.terminalId === termId && msg.data) {
              term.write(msg.data);
            }
          });

          cleanupExit = api.terminal.onExit((msg) => {
            if (msg.terminalId === termId) {
              term.writeln(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m`);
            }
          });

          // Create the PTY process
          const result = await api.terminal.create({
            terminalId: termId,
            cols: term.cols,
            rows: term.rows,
          });

          if (result?.success) {
            modeRef.current = 'pty';
            // Forward input to PTY via IPC
            term.onData((data) => {
              if (modeRef.current === 'pty') {
                api.terminal.write(termId, data);
              }
            });
          } else {
            // PTY not available — exec fallback
            modeRef.current = 'exec';
            term.writeln('Terminal');
            term.writeln('\x1b[90mnode-pty not available \u2014 using command execution fallback\x1b[0m');
            term.writeln('');
            term.write('> ');
            _setupExecMode(term);
          }
        } else {
          // No Electron API — try legacy WebSocket
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
          const ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'create', terminalId: activeTerminalTab, cols: term.cols, rows: term.rows }));
          };
          ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_) { return; }
            if (msg.type === 'output') term.write(msg.data);
            else if (msg.type === 'ready') modeRef.current = 'pty';
            else if (msg.type === 'no-pty') {
              modeRef.current = 'exec';
              term.writeln('Terminal');
              term.writeln('\x1b[90mnode-pty not available \u2014 using command execution fallback\x1b[0m');
              term.writeln('');
              term.write('> ');
              _setupExecMode(term);
            } else if (msg.type === 'exit') {
              term.writeln(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m`);
            }
          };
          ws.onerror = () => {
            if (!modeRef.current) {
              modeRef.current = 'exec';
              term.writeln('Terminal');
              term.writeln('\x1b[90mUsing command execution mode\x1b[0m');
              term.writeln('');
              term.write('> ');
              _setupExecMode(term);
            }
          };

          term.onData((data) => {
            if (ws.readyState === WebSocket.OPEN && modeRef.current === 'pty') {
              ws.send(JSON.stringify({ type: 'input', data }));
            }
          });

          // Store ws ref for cleanup and resize
          termIdRef.current = null;
          cleanupData = () => { if (ws.readyState === WebSocket.OPEN) ws.close(); };
        }

      } catch (err) {
        console.error('Failed to initialize xterm:', err);
      }
    }

    initXterm();

    return () => {
      disposed = true;
      if (cleanupData) cleanupData();
      if (cleanupExit) cleanupExit();
      if (termIdRef.current && window.electronAPI?.terminal) {
        window.electronAPI.terminal.destroy(termIdRef.current);
      }
      if (term) {
        term.dispose();
        xtermRef.current = null;
        fitAddonRef.current = null;
        termIdRef.current = null;
      }
    };
  }, [activeTerminalTab]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit();
          // Notify PTY of new size
          if (termIdRef.current && window.electronAPI?.terminal && xtermRef.current) {
            window.electronAPI.terminal.resize(termIdRef.current, xtermRef.current.cols, xtermRef.current.rows);
          }
        } catch {}
      }
    };
    const observer = new ResizeObserver(handleResize);
    if (termRef.current) observer.observe(termRef.current);
    window.addEventListener('resize', handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [loaded]);

  // R39-A3: Sync xterm theme when app theme changes (class attribute on <html>)
  useEffect(() => {
    if (!xtermRef.current) return;
    const observer = new MutationObserver(() => {
      if (!xtermRef.current) return;
      const style = getComputedStyle(document.documentElement);
      const getColor = (name) => {
        const val = style.getPropertyValue(`--guide-${name}`).trim();
        if (!val) return undefined;
        const parts = val.split(' ').map(Number);
        if (parts.length === 3) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
        return undefined;
      };
      xtermRef.current.options.theme = {
        background: getColor('terminal-bg') || '#0a0a0a',
        foreground: getColor('terminal-fg') || '#b4b4b4',
        cursor: getColor('terminal-cursor') || '#ff6b00',
        selectionBackground: getColor('selection') || 'rgba(60, 40, 10, 0.5)',
      };
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [loaded]);

  return (
    <div className="h-full w-full relative">
      <div
        ref={termRef}
        className="h-full w-full xterm-container"
        style={{ padding: '4px 0 0 8px' }}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center text-vsc-text-dim text-vsc-sm">
          <div className="spinner mr-2" />
          Loading terminal...
        </div>
      )}
    </div>
  );
}

/** Exec fallback: line-by-line command execution when PTY is not available */
function _setupExecMode(term) {
  let currentLine = '';
  term.onData((data) => {
    if (data === '\r') {
      term.writeln('');
      if (currentLine.trim()) {
        fetch('/api/terminal/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: currentLine }),
        }).then(r => r.json()).then(d => {
          if (d.output) term.writeln(d.output);
          if (!d.success && d.output) term.writeln(`\x1b[31m${d.output}\x1b[0m`);
          term.write('\x1b[38;2;255;107;0m>\x1b[0m ');
        }).catch(err => {
          term.writeln(`\x1b[31mError: ${err.message}\x1b[0m`);
          term.write('\x1b[38;2;255;107;0m>\x1b[0m ');
        });
      } else {
        term.write('\x1b[38;2;255;107;0m>\x1b[0m ');
      }
      currentLine = '';
    } else if (data === '\x7f') {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        term.write('\b \b');
      }
    } else if (data >= ' ') {
      currentLine += data;
      term.write(data);
    }
  });
}

function OutputPanel() {
  return (
    <div className="h-full p-2 overflow-y-auto scrollbar-thin font-vsc-code text-vsc-sm text-vsc-text-dim">
      <div className="text-vsc-xs">Output channel - AI generation logs will appear here</div>
    </div>
  );
}

function ProblemsPanel() {
  return (
    <div className="h-full p-2 overflow-y-auto scrollbar-thin text-vsc-sm">
      <div className="flex items-center gap-2 text-vsc-text-dim text-vsc-xs">
        <AlertTriangle size={14} />
        <span>No problems detected in workspace</span>
      </div>
    </div>
  );
}

function TodoPanel() {
  const todoItems = useAppStore(s => s.todoItems);
  const todoLoading = useAppStore(s => s.todoLoading);
  const scanTodos = useAppStore(s => s.scanTodos);
  const setActiveTab = useAppStore(s => s.setActiveTab);
  const openTabs = useAppStore(s => s.openTabs);

  const TYPE_COLORS = {
    TODO: 'text-blue-400',
    FIXME: 'text-red-400',
    HACK: 'text-yellow-400',
    NOTE: 'text-green-400',
    XXX: 'text-orange-400',
    BUG: 'text-red-500',
    OPTIMIZE: 'text-purple-400'
  };

  // Group by file
  const grouped = {};
  todoItems.forEach(item => {
    if (!grouped[item.file]) grouped[item.file] = [];
    grouped[item.file].push(item);
  });

  const handleClick = async (item) => {
    // Open file and navigate to line
    try {
      const r = await fetch(`/api/files/read?path=${encodeURIComponent(item.file)}`);
      const data = await r.json();
      if (data.content !== undefined) {
        const tabId = `file-${item.file}`;
        const existing = openTabs.find(t => t.path === item.file);
        if (existing) {
          setActiveTab(existing.id);
        } else {
          useAppStore.getState().openTab({
            id: tabId,
            name: item.file.split('/').pop(),
            path: item.file,
            content: data.content,
            language: item.file.split('.').pop()
          });
        }
      }
    } catch (_) {}
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-vsc-panel-border/30 flex-shrink-0">
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover transition-colors"
          onClick={scanTodos}
          disabled={todoLoading}
        >
          <RefreshCw size={12} className={todoLoading ? 'animate-spin' : ''} />
          {todoLoading ? 'Scanning...' : 'Scan'}
        </button>
        <span className="text-vsc-xs text-vsc-text-dim">
          {todoItems.length > 0 ? `${todoItems.length} items` : ''}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-1">
        {todoItems.length === 0 && !todoLoading && (
          <div className="flex items-center gap-2 p-2 text-vsc-text-dim text-vsc-xs">
            <CheckSquare size={14} />
            <span>Click Scan to find TODO, FIXME, HACK, NOTE, BUG comments in your project</span>
          </div>
        )}
        {Object.entries(grouped).map(([file, items]) => (
          <div key={file} className="mb-1">
            <div className="px-2 py-0.5 text-vsc-xs text-vsc-text-dim font-medium truncate" title={file}>
              {file}
            </div>
            {items.map((item, i) => (
              <button
                key={`${file}-${item.line}-${i}`}
                className="w-full text-left flex items-baseline gap-2 px-4 py-0.5 text-vsc-xs hover:bg-vsc-list-hover rounded cursor-pointer"
                onClick={() => handleClick(item)}
              >
                <span className={`font-bold flex-shrink-0 ${TYPE_COLORS[item.type] || 'text-vsc-text'}`}>
                  {item.type}
                </span>
                <span className="text-vsc-text-dim flex-shrink-0">:{item.line}</span>
                <span className="text-vsc-text truncate">{item.text}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
