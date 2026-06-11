/**
 * StatusBar — Bottom bar with context usage ring, model info, and editor status.
 * Uses theme CSS variables for full theme support.
 */
import useAppStore from '../stores/appStore';
import { installUpdateNow, updateVersionLabel } from '../lib/updateStatus';
import { GitBranch, AlertTriangle, AlertCircle, Cpu, Zap, HardDrive, Radio, Download, Loader2, ImageIcon } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';

export default function StatusBar() {
  const modelInfo = useAppStore(s => s.modelInfo);
  const modelLoaded = useAppStore(s => s.modelLoaded);
  const modelLoading = useAppStore(s => s.modelLoading);
  const modelLoadProgress = useAppStore(s => s.modelLoadProgress);
  const chatContextUsage = useAppStore(s => s.chatContextUsage);
  const activeTabId = useAppStore(s => s.activeTabId);
  const [appVersion, setAppVersion] = useState('...');
  const openTabs = useAppStore(s => s.openTabs);
  const projectPath = useAppStore(s => s.projectPath);
  const togglePanel = useAppStore(s => s.togglePanel);
  const toggleChatPanel = useAppStore(s => s.toggleChatPanel);
  const setActiveActivity = useAppStore(s => s.setActiveActivity);
  const cursorPos = useAppStore(s => s.editorCursorPosition);
  const diagnostics = useAppStore(s => s.editorDiagnostics);
  const gitBranch = useAppStore(s => s.gitBranch);
  const setGitBranch = useAppStore(s => s.setGitBranch);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchList, setBranchList] = useState([]);
  const branchMenuRef = useRef(null);
  const editorEol = useAppStore(s => s.editorEol);
  const setEditorEol = useAppStore(s => s.setEditorEol);
  const editorEncoding = useAppStore(s => s.editorEncoding);
  const setEditorEncoding = useAppStore(s => s.setEditorEncoding);
  const editorIndentSize = useAppStore(s => s.editorIndentSize);
  const setEditorIndentSize = useAppStore(s => s.setEditorIndentSize);
  const editorIndentType = useAppStore(s => s.editorIndentType);
  const setEditorIndentType = useAppStore(s => s.setEditorIndentType);
  const openCommandPalette = useAppStore(s => s.openCommandPalette);
  const editorSelection = useAppStore(s => s.editorSelection);
  const tokenStats = useAppStore(s => s.tokenStats);
  const gpuMemory = useAppStore(s => s.gpuMemory);
  const setGpuMemory = useAppStore(s => s.setGpuMemory);
  const chatStreaming = useAppStore(s => s.chatStreaming);
  const chatStreamingText = useAppStore(s => s.chatStreamingText);
  const liveServerRunning = useAppStore(s => s.liveServerRunning);
  const liveServerUrl = useAppStore(s => s.liveServerUrl);
  const setLiveServerStatus = useAppStore(s => s.setLiveServerStatus);
  const addNotification = useAppStore(s => s.addNotification);
  const vramWarning = useAppStore(s => s.vramWarning);
  const clearVramWarning = useAppStore(s => s.clearVramWarning);
  const updateStatus = useAppStore(s => s.updateStatus);
  const mediaStatus = useAppStore(s => s.mediaStatus);
  const setActiveActivity = useAppStore(s => s.setActiveActivity);

  // Tokens per second tracking
  const [tokensPerSec, setTokensPerSec] = useState(0);
  const prevTextLenRef = useRef(0);
  const lastTickRef = useRef(Date.now());
  const statusBarRef = useRef(null);
  // Higher tier = more hidden. Left/editor first, GPU/model/context last.
  const [barTier, setBarTier] = useState(0);

  useEffect(() => {
    const el = statusBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 1200;
      if (w >= 1100) setBarTier(0);
      else if (w >= 900) setBarTier(1);
      else if (w >= 750) setBarTier(2);
      else if (w >= 600) setBarTier(3);
      else if (w >= 480) setBarTier(4);
      else setBarTier(5);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!branchMenuOpen) return;
    const onDocClick = (e) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target)) {
        setBranchMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [branchMenuOpen]);

  const toggleBranchMenu = async () => {
    if (!projectPath) {
      setActiveActivity('git');
      return;
    }
    if (branchMenuOpen) {
      setBranchMenuOpen(false);
      return;
    }
    try {
      const r = await fetch(`/api/git/branches?path=${encodeURIComponent(projectPath)}`);
      const d = await r.json();
      if (d.success && d.branches) setBranchList(d.branches);
    } catch (_) {}
    setBranchMenuOpen(true);
  };

  const checkoutBranch = async (name) => {
    if (!projectPath || !name) return;
    try {
      const r = await fetch('/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath, branch: name }),
      });
      const d = await r.json();
      if (d.success) {
        setGitBranch(name);
        setBranchMenuOpen(false);
        addNotification({ type: 'info', message: `Switched to branch ${name}` });
      } else {
        addNotification({ type: 'error', message: d.error || 'Checkout failed' });
      }
    } catch (e) {
      addNotification({ type: 'error', message: e.message });
    }
  };

  const hideEditorChips = barTier >= 1;
  const hideLeftGit = barTier >= 2;
  const hideTokStats = barTier >= 3;
  const hideRam = barTier >= 3;
  const hideGpuDetails = barTier >= 4;
  const hideGoLive = barTier >= 4;
  const hideContextPct = barTier >= 5;
  const hideModelName = barTier >= 5;

  useEffect(() => {
    if (!chatStreaming) {
      setTokensPerSec(0);
      prevTextLenRef.current = 0;
      lastTickRef.current = Date.now();
      return;
    }
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - lastTickRef.current) / 1000;
      const state = useAppStore.getState();
      // R37-Step5: Measure BOTH chatStreamingText AND streamingFileBlocks content.
      // File content goes through a separate channel (file-content-token → streamingFileBlocks)
      // not chatStreamingText, so the old measurement missed all file-writing tokens.
      let currentLen = state.chatStreamingText.length;
      if (state.streamingFileBlocks && state.streamingFileBlocks.length > 0) {
        for (const block of state.streamingFileBlocks) {
          currentLen += (block.content || '').length;
        }
      }
      const charsDelta = currentLen - prevTextLenRef.current;
      // Approximate: ~4 chars per token
      const tokensDelta = Math.max(0, Math.round(charsDelta / 4));
      if (elapsed > 0 && tokensDelta > 0) {
        setTokensPerSec(Math.round(tokensDelta / elapsed));
      } else if (elapsed > 2) {
        setTokensPerSec(0);
      }
      prevTextLenRef.current = currentLen;
      lastTickRef.current = now;
    }, 1000);
    return () => clearInterval(interval);
  }, [chatStreaming]);

  // Fetch app version from package.json on mount
  useEffect(() => {
    (async () => {
      try {
        const v = window.electronAPI?.getAppVersion
          ? await window.electronAPI.getAppVersion()
          : (await (await import('../api/websocket')).invoke('get-app-version'));
        if (v) setAppVersion(v);
      } catch {}
    })();
  }, []);

  // Poll GPU memory every 60s when model is loaded
  useEffect(() => {
    if (!modelLoaded) return;
    const poll = () => {
      fetch('/api/gpu').then(r => r.json()).then(info => {
        if (info && info.memoryUsed !== undefined) {
          setGpuMemory(info);
        }
      }).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 60000);
    return () => clearInterval(id);
  }, [modelLoaded, setGpuMemory]);

  // Toggle live server
  const toggleLiveServer = async () => {
    if (liveServerRunning) {
      // Stop
      try {
        const res = await fetch('/api/live-server/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          setLiveServerStatus({ running: false, port: null, url: null });
          addNotification({ type: 'info', title: 'Live Server Stopped' });
        }
      } catch (e) {
        addNotification({ type: 'error', title: 'Failed to stop server', message: e.message });
      }
    } else {
      // Start
      if (!projectPath) {
        addNotification({ type: 'warning', title: 'No project open', message: 'Open a folder first' });
        return;
      }
      try {
        const res = await fetch('/api/live-server/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectPath }),
        });
        const data = await res.json();
        if (data.success) {
          setLiveServerStatus({ running: true, port: data.port, url: data.url });
          addNotification({ type: 'success', title: 'Live Server Started', message: data.url });
          // Open in browser
          window.open(data.url, '_blank');
        } else {
          addNotification({ type: 'error', title: 'Failed to start server', message: data.error });
        }
      } catch (e) {
        addNotification({ type: 'error', title: 'Failed to start server', message: e.message });
      }
    }
  };

  const activeTab = openTabs.find(t => t.id === activeTabId);
  const contextPct = chatContextUsage
    ? Math.round((chatContextUsage.used / chatContextUsage.total) * 100)
    : null;

  const gpuLayerOffload =
    typeof gpuMemory?.gpuLayers === 'number'
      ? gpuMemory.gpuLayers
      : modelLoaded && modelInfo && typeof modelInfo.gpuLayers === 'number'
        ? modelInfo.gpuLayers
        : undefined;
  const gpuTotalLayers = typeof gpuMemory?.totalLayers === 'number' ? gpuMemory.totalLayers : modelInfo?.totalLayers;

  return (
    <div
      ref={statusBarRef}
      className={`h-statusbar flex items-center no-select text-[11px] ${
      modelLoading ? 'bg-vsc-statusbar-debug' : 'bg-vsc-statusbar'
    } text-vsc-text-bright`}
    >
      {/* Left section — git/errors hidden before right-side GPU/context */}
      <div className="flex items-center flex-1 min-w-0 overflow-hidden">
        {updateStatus?.status === 'downloaded' && (
          <button
            type="button"
            className="statusbar-item shrink-0 text-vsc-accent font-medium hover:underline"
            onClick={() => installUpdateNow()}
            title="Restart guIDE to apply the update"
          >
            <Download size={12} className="mr-1" />
            Restart to update (v{updateVersionLabel(updateStatus)})
          </button>
        )}
        {updateStatus?.status === 'downloading' && (
          <div className="statusbar-item shrink-0 text-vsc-text-dim" title="Downloading update in background">
            Updating… {Math.round(updateStatus.progress?.percent || 0)}%
          </div>
        )}

        {mediaStatus?.message && (
          <button
            type="button"
            className={`statusbar-item shrink-0 max-w-[280px] truncate flex items-center gap-1.5 ${
              mediaStatus.phase === 'error' ? 'text-vsc-error' : 'text-vsc-info'
            }`}
            title={mediaStatus.message}
            onClick={() => setActiveActivity('settings')}
          >
            {(mediaStatus.phase === 'generating' || mediaStatus.phase === 'download') && (
              <Loader2 size={11} className="animate-spin shrink-0" />
            )}
            {mediaStatus.phase === 'done' && <ImageIcon size={11} className="shrink-0" />}
            {mediaStatus.phase === 'error' && <AlertCircle size={11} className="shrink-0" />}
            <span className="truncate">{mediaStatus.message}</span>
          </button>
        )}

        {projectPath && !hideLeftGit && (
          <div className="relative shrink-0" ref={branchMenuRef}>
            <button className="statusbar-item" onClick={toggleBranchMenu} title="Switch branch">
              <GitBranch size={12} className="mr-1" />
              <span className="truncate max-w-[140px]">{gitBranch}</span>
            </button>
            {branchMenuOpen && branchList.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 min-w-[180px] max-h-[240px] overflow-y-auto bg-vsc-sidebar border border-vsc-panel-border rounded shadow-lg z-50 py-1">
                {branchList.map(b => (
                  <button
                    key={b.name}
                    className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-vsc-list-hover ${b.current ? 'text-vsc-accent font-medium' : 'text-vsc-text'}`}
                    onClick={() => checkoutBranch(b.name)}
                  >
                    {b.current ? '● ' : '  '}{b.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button className="statusbar-item shrink-0" onClick={togglePanel} title={`${diagnostics.errors} errors, ${diagnostics.warnings} warnings`}>
          <AlertCircle size={12} className={`mr-1 ${diagnostics.errors > 0 ? 'text-vsc-error' : ''}`} />
          {!hideLeftGit && (
            <span className={diagnostics.errors > 0 ? 'text-vsc-error' : ''}>{diagnostics.errors}</span>
          )}
          <AlertTriangle size={12} className={`${hideLeftGit ? '' : 'ml-2'} mr-1 ${diagnostics.warnings > 0 ? 'text-vsc-warning' : ''}`} />
          {!hideLeftGit && (
            <span className={diagnostics.warnings > 0 ? 'text-vsc-warning' : ''}>{diagnostics.warnings}</span>
          )}
        </button>
      </div>

      {/* Right section — editor chips hide first; system stats hide last */}
      <div className="flex items-center min-w-0 overflow-hidden shrink">
        {/* Line / Column + Selection */}
        {activeTab && (
          <button className="statusbar-item" title="Go to Line">
            <span>Ln {cursorPos.line}, Col {cursorPos.column}</span>
            {editorSelection && (
              <span className="ml-1.5 text-vsc-accent">({editorSelection.chars} selected)</span>
            )}
          </button>
        )}

        {/* Spaces / Tabs — hidden on narrow status bars */}
        {activeTab && !hideEditorChips && (
          <button className="statusbar-item" onClick={() => {
            if (editorIndentType === 'spaces' && editorIndentSize === 2) {
              setEditorIndentSize(4);
            } else if (editorIndentType === 'spaces' && editorIndentSize === 4) {
              setEditorIndentType('tabs');
              setEditorIndentSize(4);
            } else {
              setEditorIndentType('spaces');
              setEditorIndentSize(2);
            }
          }} title="Click to change indentation">
            <span>{editorIndentType === 'tabs' ? 'Tabs' : `Spaces: ${editorIndentSize}`}</span>
          </button>
        )}

        {/* Encoding */}
        {activeTab && !hideEditorChips && (
          <button className="statusbar-item" onClick={() => {
            setEditorEncoding(editorEncoding === 'UTF-8' ? 'UTF-16LE' : 'UTF-8');
          }} title="Click to change encoding">
            <span>{editorEncoding}</span>
          </button>
        )}

        {/* EOL */}
        {activeTab && !hideEditorChips && (
          <button className="statusbar-item" onClick={() => {
            setEditorEol(editorEol === 'LF' ? 'CRLF' : 'LF');
          }} title="Click to change line endings">
            <span>{editorEol}</span>
          </button>
        )}

        {/* Language */}
        {activeTab && !hideEditorChips && (
          <button className="statusbar-item" onClick={openCommandPalette} title="Click to change language">
            <span>{_formatLanguage(activeTab.language)}</span>
          </button>
        )}

        {/* Tokens per second (during generation) */}
        {tokensPerSec > 0 && !hideTokStats && (
          <div className="statusbar-item shrink-0" title="Generation speed">
            <Zap size={12} className="mr-1 text-yellow-300" />
            <span>{tokensPerSec} tok/s</span>
          </div>
        )}

        {/* Token stats */}
        {tokenStats && tokenStats.sessionTokens > 0 && !hideTokStats && (
          <div className="statusbar-item shrink-0" title={`Session: ${tokenStats.sessionTokens.toLocaleString()} tokens, ${tokenStats.requestCount} requests`}>
            <Zap size={12} className="mr-1 text-yellow-300" />
            <span>{_formatTokens(tokenStats.sessionTokens)}</span>
          </div>
        )}

        {/* GPU memory + layers offloaded (nvidia-smi + modelInfo merged in /api/gpu; modelInfo fallback until first poll) */}
        {gpuMemory && gpuMemory.memoryUsed !== undefined && (
          <div
            className={`statusbar-item ${vramWarning ? 'text-yellow-400' : ''}`}
            title={`GPU: ${gpuMemory.memoryUsed}MB / ${gpuMemory.memoryTotal}MB used${gpuMemory.name ? ` (${gpuMemory.name})` : ''}${
              gpuLayerOffload !== undefined
                ? ` | ${gpuLayerOffload}${gpuTotalLayers != null ? `/${gpuTotalLayers}` : ''} layer(s) on GPU`
                : ''
            }${modelInfo?.vramFreeAfterLoadGB != null ? ` | ${modelInfo.vramFreeAfterLoadGB}GB free after model load` : ''}${
              modelInfo?.contextPctOfCap != null ? ` | ctx ${modelInfo.contextPctOfCap}% of cap` : ''
            }${gpuMemory.temperature > 0 ? ` | ${Math.round(gpuMemory.temperature)}°C` : ''}${vramWarning ? ` | ${vramWarning}` : ''}`}
            onClick={() => vramWarning && clearVramWarning()}
          >
            {vramWarning && <AlertTriangle size={12} className="mr-1 text-yellow-400" />}
            {!vramWarning && <HardDrive size={12} className="mr-1" />}
            <span>{gpuMemory.memoryUsed}MB</span>
            {gpuLayerOffload !== undefined && !hideGpuDetails && (
              <span className="ml-1 text-vsc-text-dim/70">
                {gpuLayerOffload}{gpuTotalLayers != null ? `/${gpuTotalLayers}` : ''} layers
                {modelInfo?.vramFreeAfterLoadGB != null ? ` · ${modelInfo.vramFreeAfterLoadGB}GB free` : ''}
              </span>
            )}
            {gpuMemory.temperature > 0 && !hideGpuDetails && (
              <span className={`ml-1 ${
                gpuMemory.temperature > 85 ? 'text-red-400' :
                gpuMemory.temperature > 75 ? 'text-yellow-400' :
                'text-vsc-text-dim/70'
              }`}>
                {Math.round(gpuMemory.temperature)}°C
              </span>
            )}
          </div>
        )}

        {/* CPU/RAM */}
        {gpuMemory && gpuMemory.ramUsedGB !== undefined && !hideRam && (
          <div className="statusbar-item shrink-0" title={`RAM: ${gpuMemory.ramUsedGB}GB / ${gpuMemory.ramTotalGB}GB | CPU: ${gpuMemory.cpuUsage}%`}>
            <Cpu size={12} className="mr-1" />
            <span>{gpuMemory.ramUsedGB}GB</span>
          </div>
        )}

        {/* Context usage ring */}
        {contextPct !== null && (
          <button
            className="statusbar-item gap-1.5"
            onClick={toggleChatPanel}
            title={`Context: ${chatContextUsage.used}/${chatContextUsage.total} tokens (${contextPct}%)`}
          >
            <ContextRing percent={contextPct} size={14} />
            {!hideContextPct && (
              <span className={contextPct > 85 ? 'text-yellow-200' : ''}>
                {contextPct}%
              </span>
            )}
          </button>
        )}

        {!hideGoLive && (
        <button
          className={`statusbar-item shrink-0 ${liveServerRunning ? 'text-green-400' : ''}`}
          onClick={toggleLiveServer}
          title={liveServerRunning ? `Live Server running on ${liveServerUrl} - Click to stop` : 'Click to start Live Server'}
        >
          <Radio size={12} className={`mr-1 ${liveServerRunning ? 'animate-pulse' : ''}`} />
          <span>{liveServerRunning ? 'Go Live' : 'Go Live'}</span>
        </button>
        )}

        {/* Model info / Loading progress */}
        {modelLoading ? (
          <div className="statusbar-item gap-2" title={`Loading model... ${modelLoadProgress}%`}>
            <Cpu size={12} className="animate-pulse" />
            <div className="flex items-center gap-1.5">
              <div className="w-24 h-1.5 bg-vsc-panel-border rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${modelLoadProgress}%`,
                    background: 'linear-gradient(90deg, rgb(var(--guide-accent)), rgb(var(--guide-accent-hover)))',
                  }}
                />
              </div>
              <span className="text-[10px] tabular-nums">{Math.round(modelLoadProgress)}%</span>
            </div>
          </div>
        ) : (
          <button className="statusbar-item" onClick={() => setActiveActivity('settings')} title={modelInfo ? `${modelInfo.name} (${modelInfo.contextSize?.toLocaleString?.() ?? modelInfo.contextSize} ctx${modelInfo.contextSizeRequested === 'auto' && modelInfo.contextTrainMax ? `, train max ${modelInfo.contextTrainMax.toLocaleString()}` : ''})` : 'No model'}>
            <Cpu size={12} className="mr-1" />
            {modelLoaded && modelInfo ? (
              !hideModelName && (
                <span className="truncate max-w-[120px]">{modelInfo.name || modelInfo.family}</span>
              )
            ) : (
              <span className="opacity-70">No Model</span>
            )}
          </button>
        )}

        <span className="statusbar-item shrink-0 text-vsc-text-dim/50 text-[10px] select-none" title={`guIDE ${appVersion}`}>v{appVersion}</span>
      </div>
    </div>
  );
}

/**
 * ContextRing — SVG circular progress indicator for context usage.
 */
function ContextRing({ percent, size = 14 }) {
  const radius = (size - 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (percent / 100) * circumference;
  const strokeColor = percent > 85 ? 'rgb(250, 200, 60)' : percent > 60 ? 'rgb(var(--guide-accent))' : 'rgb(var(--guide-success))';

  return (
    <svg width={size} height={size} className="flex-shrink-0">
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth={1.5}
      />
      {/* Progress arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeDasharray={`${filled} ${circumference - filled}`}
        strokeDashoffset={circumference / 4}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.3s ease' }}
      />
    </svg>
  );
}

function _formatLanguage(lang) {
  const map = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    typescriptreact: 'TypeScript React',
    python: 'Python',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    json: 'JSON',
    markdown: 'Markdown',
    yaml: 'YAML',
    rust: 'Rust',
    go: 'Go',
    java: 'Java',
    csharp: 'C#',
    cpp: 'C++',
    c: 'C',
    ruby: 'Ruby',
    php: 'PHP',
    shell: 'Shell Script',
    powershell: 'PowerShell',
    sql: 'SQL',
    plaintext: 'Plain Text',
  };
  return map[lang] || lang || 'Plain Text';
}

function _formatTokens(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}
