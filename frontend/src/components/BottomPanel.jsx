/**
 * BottomPanel — Terminal, Output, Problems, Debug Console, and Ports tabs.
 * VS Code-style: tabs left, terminal instance list right, badge on Problems.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import useAppStore from '../stores/appStore';
import { openFileFromReadResponse } from '../utils/openFileFromRead';
import { Terminal as TerminalIcon, FileOutput, AlertTriangle, X, Plus, Trash2, Globe, Bug, ChevronDown, MoreHorizontal, CheckSquare, RefreshCw } from 'lucide-react';

const mainTabs = [
  { id: 'problems', label: 'Problems', icon: AlertTriangle },
  { id: 'output', label: 'Output', icon: FileOutput },
  { id: 'todo', label: 'Todo', icon: CheckSquare },
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
];

const moreTabs = [
  { id: 'debug', label: 'Debug Console', icon: Bug },
  { id: 'ports', label: 'Ports', icon: Globe },
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
  const clearActiveTerminal = useAppStore(s => s.clearActiveTerminal);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [termDropdown, setTermDropdown] = useState(null);

  // Problems count — reads from store (set to 0 by default, wired to Monaco diagnostics later)
  const problemsCount = useAppStore(s => s.problemsCount ?? 0);

  return (
    <div className="flex flex-col h-full bg-vsc-panel">
      {/* Tab bar */}
      <div className="flex items-center h-[28px] border-b border-vsc-panel-border no-select flex-shrink-0">
        {/* Left: panel type tabs */}
        <div className="flex items-center flex-1 min-w-0 overflow-hidden">
          {mainTabs.map(({ id, label, icon: Icon }, idx) => (
            <div key={id} className="flex items-center flex-shrink-0">
              {idx > 0 && (
                <span className="text-vsc-text-dim/25 text-[11px] mx-0.5 select-none">/</span>
              )}
              <button
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
            </div>
          ))}
          {/* More dropdown for Debug Console & Ports */}
          <div className="relative flex-shrink-0">
            <button
              className={`panel-tab flex items-center gap-1 ${moreTabs.some(t => t.id === activePanelTab) ? 'active' : ''}`}
              onClick={() => setMoreMenuOpen(v => !v)}
            >
              <MoreHorizontal size={14} />
            </button>
            {moreMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreMenuOpen(false)} />
                <div className="absolute top-full left-0 mt-0.5 z-50 bg-vsc-sidebar border border-vsc-panel-border rounded-md shadow-lg py-1 min-w-[140px]">
                  {moreTabs.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      className={`flex items-center gap-2 w-full px-3 py-1.5 text-vsc-xs hover:bg-vsc-list-hover ${activePanelTab === id ? 'text-vsc-text-bright' : 'text-vsc-text-dim'}`}
                      onClick={() => { setActivePanelTab(id); setMoreMenuOpen(false); }}
                    >
                      <Icon size={12} />
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right: terminal instance tabs (always visible, not just when terminal active) */}
        <div className="flex items-center gap-0.5 pl-2 border-l border-vsc-panel-border/15 flex-shrink-0">
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
          <button className="p-1 hover:bg-vsc-list-hover rounded flex-shrink-0" title="Clear" onClick={clearActiveTerminal}>
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
        {activePanelTab === 'debug' && <DebugConsolePanel />}
        {activePanelTab === 'ports' && <PortsPanel />}
      </div>
    </div>
  );
}

function OutputPanel() {
  const outputLogLines = useAppStore(s => s.outputLogLines);
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [outputLogLines.length]);

  if (outputLogLines.length === 0) {
    return (
      <div className="h-full p-2 overflow-y-auto scrollbar-thin font-vsc-code text-vsc-sm text-vsc-text-dim">
        <div className="text-vsc-xs">Output channel — logs will appear here</div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full p-2 overflow-y-auto scrollbar-thin font-vsc-code text-vsc-xs">
      {outputLogLines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap text-vsc-text-dim leading-relaxed">
          <span className="text-vsc-text-dim/50 mr-2">{new Date(line.time).toLocaleTimeString()}</span>
          <span className="text-vsc-accent/70 mr-2">[{line.channel}]</span>
          {line.text}
        </div>
      ))}
    </div>
  );
}

function ProblemsPanel() {
  const workspaceProblems = useAppStore(s => s.workspaceProblems);
  const setActiveTab = useAppStore(s => s.setActiveTab);
  const openTabs = useAppStore(s => s.openTabs);

  const grouped = {};
  workspaceProblems.forEach(p => {
    const file = p.file || 'unknown';
    if (!grouped[file]) grouped[file] = [];
    grouped[file].push(p);
  });

  const SEVERITY_COLORS = {
    error: 'text-vsc-error',
    warning: 'text-vsc-warning',
    info: 'text-vsc-accent',
    hint: 'text-vsc-text-dim',
  };

  const handleClick = async (problem) => {
    const file = problem.file;
    if (!file || file === 'unknown') return;
    try {
      const existing = openTabs.find(t => t.path === file);
      if (existing) {
        setActiveTab(existing.id);
      } else {
        const r = await fetch(`/api/files/read?path=${encodeURIComponent(file)}`);
        const data = await r.json();
        openFileFromReadResponse(data);
      }
      window.dispatchEvent(new CustomEvent('guide-goto-line', {
        detail: { line: problem.line || 1, column: problem.column || 1 },
      }));
    } catch (_) {}
  };

  if (workspaceProblems.length === 0) {
    return (
      <div className="h-full p-2 overflow-y-auto scrollbar-thin text-vsc-sm">
        <div className="flex items-center gap-2 text-vsc-text-dim text-vsc-xs">
          <AlertTriangle size={14} />
          <span>No problems detected in workspace</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-1">
      {Object.entries(grouped).map(([file, problems]) => (
        <div key={file} className="mb-1">
          <div className="px-2 py-0.5 text-vsc-xs text-vsc-text-dim font-medium truncate" title={file}>
            {file}
          </div>
          {problems.map((p, i) => (
            <button
              key={`${file}-${p.line}-${p.column}-${i}`}
              className="w-full text-left flex items-baseline gap-2 px-4 py-0.5 text-vsc-xs hover:bg-vsc-list-hover rounded cursor-pointer"
              onClick={() => handleClick(p)}
            >
              <span className={`flex-shrink-0 font-medium ${SEVERITY_COLORS[p.severity] || 'text-vsc-text'}`}>
                {p.severity || 'error'}
              </span>
              <span className="text-vsc-text-dim flex-shrink-0">
                [{p.line || 1},{p.column || 1}]
              </span>
              <span className="text-vsc-text truncate">{p.message}</span>
              {p.source && <span className="text-vsc-text-dim/60 flex-shrink-0 ml-auto">{p.source}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function DebugConsolePanel() {
  const debugConsoleLines = useAppStore(s => s.debugConsoleLines);
  const clearDebugConsole = useAppStore(s => s.clearDebugConsole);
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [debugConsoleLines.length]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-vsc-panel-border/15 flex-shrink-0">
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover transition-colors"
          onClick={clearDebugConsole}
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin p-2 font-vsc-code text-vsc-xs">
        {debugConsoleLines.length === 0 ? (
          <div className="text-vsc-text-dim/40 text-[12px]">Debug console output will appear here</div>
        ) : (
          debugConsoleLines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap text-vsc-text-dim leading-relaxed">
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PortsPanel() {
  const portsList = useAppStore(s => s.portsList);
  const setPortsList = useAppStore(s => s.setPortsList);
  const outputLogLines = useAppStore(s => s.outputLogLines);
  const openBrowserTab = useAppStore(s => s.openBrowserTab);
  const setViewportNavigateUrl = useAppStore(s => s.setViewportNavigateUrl);

  const scanOutputForPorts = useCallback((lines) => {
    const found = new Map();
    const re = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{2,5})/gi;
    for (const line of lines) {
      const text = typeof line === 'string' ? line : line?.text || '';
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const port = parseInt(m[1], 10);
        if (port > 0 && port < 65536) {
          found.set(port, { port, label: `localhost:${port}`, url: `http://localhost:${port}` });
        }
      }
    }
    return Array.from(found.values());
  }, []);

  const refreshPorts = useCallback(async () => {
    try {
      const r = await fetch('/api/ports/list');
      const data = await r.json();
      if (Array.isArray(data.ports) && data.ports.length) {
        setPortsList(data.ports);
        return;
      }
    } catch (_) {}
    const fromOutput = scanOutputForPorts(outputLogLines);
    if (fromOutput.length) setPortsList(fromOutput);
  }, [outputLogLines, scanOutputForPorts, setPortsList]);

  useEffect(() => {
    refreshPorts();
    const t = setInterval(refreshPorts, 8000);
    return () => clearInterval(t);
  }, [refreshPorts]);

  useEffect(() => {
    const fromOutput = scanOutputForPorts(outputLogLines.slice(-50));
    if (fromOutput.length) {
      const prev = useAppStore.getState().portsList || [];
      const merged = new Map(prev.map((p) => [p.port, p]));
      for (const p of fromOutput) merged.set(p.port, p);
      setPortsList(Array.from(merged.values()).sort((a, b) => a.port - b.port));
    }
  }, [outputLogLines.length, scanOutputForPorts, setPortsList]);

  const handleOpenPort = (entry) => {
    if (!entry?.url) return;
    setViewportNavigateUrl(entry.url);
    openBrowserTab();
  };

  if (!portsList.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-vsc-text-dim/40 text-[12px]">
        <span>No forwarded ports detected</span>
        <button className="text-vsc-accent hover:underline text-[11px]" onClick={refreshPorts}>Scan now</button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-2 text-vsc-xs">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-vsc-text-dim">{portsList.length} port{portsList.length !== 1 ? 's' : ''}</span>
        <button className="text-vsc-accent hover:underline text-[10px]" onClick={refreshPorts}>Refresh</button>
      </div>
      {portsList.map((entry, i) => (
        <div key={`${entry.port}-${i}`} className="flex items-center gap-3 py-1 px-2 hover:bg-vsc-list-hover rounded">
          <Globe size={12} className="text-vsc-text-dim flex-shrink-0" />
          <span className="text-vsc-text font-medium">{entry.port}</span>
          {entry.label && <span className="text-vsc-text-dim">{entry.label}</span>}
          {entry.url && (
            <button
              type="button"
              className="text-vsc-accent truncate ml-auto hover:underline text-left"
              onClick={() => handleOpenPort(entry)}
            >
              {entry.url}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function XTermPanel() {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const termIdRef = useRef(null);
  const modeRef = useRef(null); // 'pty' | 'exec' | null
  const ptyCwdRef = useRef(null); // cwd the PTY was spawned with (avoid redundant visible cd)
  const ptySpawnAtRef = useRef(0);
  const ptyStartupRetryRef = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const activeTerminalTab = useAppStore(s => s.activeTerminalTab);
  const activePanelTab = useAppStore(s => s.activePanelTab);
  const terminalClearTick = useAppStore(s => s.terminalClearTick);

  const projectPath = useAppStore(s => s.projectPath);

  useEffect(() => {
    if (terminalClearTick > 0 && xtermRef.current) {
      xtermRef.current.clear();
    }
  }, [terminalClearTick]);

  useEffect(() => {
    const t = setTimeout(() => setLoadTimedOut(true), 12000);
    return () => clearTimeout(t);
  }, [activeTerminalTab]);

  useEffect(() => {
    if (!loaded || !xtermRef.current) return;
    const t = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        xtermRef.current?.focus();
      } catch (_) {}
    }, 50);
    return () => clearTimeout(t);
  }, [loaded, activeTerminalTab, activePanelTab]);

  // Initialize xterm.js + IPC PTY (tab change only — cwd updates handled separately)
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

        const waitForTerminalSize = async (el, maxMs = 2500) => {
          const start = Date.now();
          while (Date.now() - start < maxMs) {
            if (disposed || !el) return;
            const { width, height } = el.getBoundingClientRect();
            if (width >= 40 && height >= 40) return;
            await new Promise((r) => requestAnimationFrame(r));
          }
        };

        await waitForTerminalSize(termRef.current);
        if (disposed) return;

        fitAddon.fit();
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;
        setLoaded(true);

        const api = window.electronAPI;

        const spawnPty = async () => {
          const cols = Math.max(term.cols || 0, 10);
          const rows = Math.max(term.rows || 0, 3);
          const projectPath = useAppStore.getState().projectPath;
          ptySpawnAtRef.current = Date.now();
          return api.terminal.create({
            terminalId: termIdRef.current,
            cols,
            rows,
            cwd: projectPath || undefined,
          });
        };

        // Try IPC PTY first (Electron mode)
        if (api?.terminal) {
          const termId = activeTerminalTab || `pty-${Date.now()}`;
          termIdRef.current = termId;

          // Listen for data from this terminal
          cleanupData = api.terminal.onData((msg) => {
            if (msg.terminalId === termId && msg.data) {
              term.write(msg.data);
              const re = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{2,5})/gi;
              const found = new Map();
              let m;
              re.lastIndex = 0;
              while ((m = re.exec(msg.data)) !== null) {
                const port = parseInt(m[1], 10);
                if (port > 0 && port < 65536) {
                  found.set(port, { port, label: `localhost:${port}`, url: `http://localhost:${port}` });
                }
              }
              if (found.size > 0) {
                const prev = useAppStore.getState().portsList || [];
                const merged = new Map(prev.map((p) => [p.port, p]));
                for (const p of found.values()) merged.set(p.port, p);
                useAppStore.getState().setPortsList(Array.from(merged.values()).sort((a, b) => a.port - b.port));
              }
            }
          });

          cleanupExit = api.terminal.onExit(async (msg) => {
            if (msg.terminalId !== termId) return;
            const elapsed = Date.now() - ptySpawnAtRef.current;
            const spuriousStartupExit = elapsed < 4000
              && ptyStartupRetryRef.current < 1
              && (msg.exitCode === -1073741510 || msg.exitCode === 0);
            if (spuriousStartupExit && !disposed) {
              ptyStartupRetryRef.current += 1;
              term.writeln('\r\n\x1b[90m[Terminal restarting…]\x1b[0m');
              try {
                fitAddon?.fit();
                const retry = await spawnPty();
                if (retry?.success) {
                  modeRef.current = 'pty';
                  return;
                }
              } catch (_) {}
            }
            term.writeln(`\r\n\x1b[90m[Process exited with code ${msg.exitCode}]\x1b[0m`);
          });

          const result = await spawnPty();

          if (result?.success) {
            modeRef.current = 'pty';
            ptyCwdRef.current = useAppStore.getState().projectPath || null;
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
            ws.send(JSON.stringify({ type: 'create', terminalId: activeTerminalTab, cols: term.cols, rows: term.rows, cwd: useAppStore.getState().projectPath || undefined }));
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

  // Sync shell cwd when project opens/changes — keep xterm alive, refresh PowerShell prompt
  useEffect(() => {
    if (!projectPath || !termIdRef.current || modeRef.current !== 'pty') return;
    const norm = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
    if (norm(ptyCwdRef.current) === norm(projectPath)) return;

    const api = window.electronAPI;
    if (!api?.terminal) return;

    const termId = termIdRef.current;
    const cols = xtermRef.current?.cols || 80;
    const rows = xtermRef.current?.rows || 24;

    (async () => {
      try {
        if (api.terminal.recreate) {
          const result = await api.terminal.recreate({
            terminalId: termId,
            cwd: projectPath,
            cols,
            rows,
          });
          if (result?.success) {
            ptyCwdRef.current = projectPath;
            return;
          }
        }
      } catch (_) {}

      // Fallback: silent Set-Location (no visible cd line in scrollback)
      const escaped = projectPath.replace(/'/g, "''");
      api.terminal.write(termId, `Set-Location -LiteralPath '${escaped}'\r`);
      ptyCwdRef.current = projectPath;
    })();
  }, [projectPath]);

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
      {!loaded && !loadTimedOut && (
        <div className="absolute inset-0 flex items-center justify-center text-vsc-text-dim text-vsc-sm pointer-events-none">
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
      <div className="flex items-center gap-2 px-2 py-1 border-b border-vsc-panel-border/15 flex-shrink-0">
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
