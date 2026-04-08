/**
 * StatusBar — Bottom bar with context usage ring, model info, and editor status.
 * Uses theme CSS variables for full theme support.
 */
import useAppStore from '../stores/appStore';
import { GitBranch, AlertTriangle, AlertCircle, Cpu, Zap, HardDrive, Radio } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';

export default function StatusBar() {
  const modelInfo = useAppStore(s => s.modelInfo);
  const modelLoaded = useAppStore(s => s.modelLoaded);
  const modelLoading = useAppStore(s => s.modelLoading);
  const modelLoadProgress = useAppStore(s => s.modelLoadProgress);
  const chatContextUsage = useAppStore(s => s.chatContextUsage);
  const activeTabId = useAppStore(s => s.activeTabId);
  const openTabs = useAppStore(s => s.openTabs);
  const projectPath = useAppStore(s => s.projectPath);
  const togglePanel = useAppStore(s => s.togglePanel);
  const toggleChatPanel = useAppStore(s => s.toggleChatPanel);
  const setActiveActivity = useAppStore(s => s.setActiveActivity);
  const cursorPos = useAppStore(s => s.editorCursorPosition);
  const diagnostics = useAppStore(s => s.editorDiagnostics);
  const gitBranch = useAppStore(s => s.gitBranch);
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

  // Tokens per second tracking
  const [tokensPerSec, setTokensPerSec] = useState(0);
  const prevTextLenRef = useRef(0);
  const lastTickRef = useRef(Date.now());

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

  // Poll GPU memory every 10s when model is loaded
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
    const id = setInterval(poll, 10000);
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

  return (
    <div className={`h-statusbar flex items-center no-select text-[11px] ${
      modelLoading ? 'bg-vsc-statusbar-debug' : 'bg-vsc-statusbar'
    } text-vsc-text-bright`}>
      {/* Left section */}
      <div className="flex items-center flex-1 min-w-0">
        {/* Branch */}
        {projectPath && (
          <button className="statusbar-item" onClick={() => setActiveActivity('git')}>
            <GitBranch size={12} className="mr-1" />
            <span>{gitBranch}</span>
          </button>
        )}

        {/* Errors / Warnings */}
        <button className="statusbar-item" onClick={togglePanel}>
          <AlertCircle size={12} className={`mr-1 ${diagnostics.errors > 0 ? 'text-vsc-error' : ''}`} />
          <span className={diagnostics.errors > 0 ? 'text-vsc-error' : ''}>{diagnostics.errors}</span>
          <AlertTriangle size={12} className={`ml-2 mr-1 ${diagnostics.warnings > 0 ? 'text-vsc-warning' : ''}`} />
          <span className={diagnostics.warnings > 0 ? 'text-vsc-warning' : ''}>{diagnostics.warnings}</span>
        </button>
      </div>

      {/* Right section */}
      <div className="flex items-center">
        {/* Line / Column + Selection */}
        {activeTab && (
          <button className="statusbar-item" title="Go to Line">
            <span>Ln {cursorPos.line}, Col {cursorPos.column}</span>
            {editorSelection && (
              <span className="ml-1.5 text-vsc-accent">({editorSelection.chars} selected)</span>
            )}
          </button>
        )}

        {/* Spaces / Tabs */}
        {activeTab && (
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
        {activeTab && (
          <button className="statusbar-item" onClick={() => {
            setEditorEncoding(editorEncoding === 'UTF-8' ? 'UTF-16LE' : 'UTF-8');
          }} title="Click to change encoding">
            <span>{editorEncoding}</span>
          </button>
        )}

        {/* EOL */}
        {activeTab && (
          <button className="statusbar-item" onClick={() => {
            setEditorEol(editorEol === 'LF' ? 'CRLF' : 'LF');
          }} title="Click to change line endings">
            <span>{editorEol}</span>
          </button>
        )}

        {/* Language */}
        {activeTab && (
          <button className="statusbar-item" onClick={openCommandPalette} title="Click to change language">
            <span>{_formatLanguage(activeTab.language)}</span>
          </button>
        )}

        {/* Tokens per second (during generation) */}
        {tokensPerSec > 0 && (
          <div className="statusbar-item" title="Generation speed">
            <Zap size={12} className="mr-1 text-yellow-300" />
            <span>{tokensPerSec} tok/s</span>
          </div>
        )}

        {/* Token stats */}
        {tokenStats && tokenStats.sessionTokens > 0 && (
          <div className="statusbar-item" title={`Session: ${tokenStats.sessionTokens.toLocaleString()} tokens, ${tokenStats.requestCount} requests`}>
            <Zap size={12} className="mr-1 text-yellow-300" />
            <span>{_formatTokens(tokenStats.sessionTokens)}</span>
          </div>
        )}

        {/* GPU memory */}
        {gpuMemory && gpuMemory.memoryUsed !== undefined && (
          <div className="statusbar-item" title={`GPU: ${gpuMemory.memoryUsed}MB / ${gpuMemory.memoryTotal}MB used${gpuMemory.name ? ` (${gpuMemory.name})` : ''}${gpuMemory.gpuLayers ? ` | ${gpuMemory.gpuLayers}${modelInfo?.totalLayers ? '/' + modelInfo.totalLayers : ''} layers` : ''}`}>
            <HardDrive size={12} className="mr-1" />
            <span>{gpuMemory.memoryUsed}MB</span>
            {gpuMemory.gpuLayers > 0 && (
              <span className="ml-1 text-vsc-text-dim/70">{gpuMemory.gpuLayers}{modelInfo?.totalLayers ? '/' + modelInfo.totalLayers : ''} layers</span>
            )}
          </div>
        )}

        {/* CPU/RAM */}
        {gpuMemory && gpuMemory.ramUsedGB !== undefined && (
          <div className="statusbar-item" title={`RAM: ${gpuMemory.ramUsedGB}GB / ${gpuMemory.ramTotalGB}GB | CPU: ${gpuMemory.cpuUsage}%`}>
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
            <span className={contextPct > 85 ? 'text-yellow-200' : ''}>
              {contextPct}%
            </span>
          </button>
        )}

        {/* Go Live button */}
        <button
          className={`statusbar-item ${liveServerRunning ? 'text-green-400' : ''}`}
          onClick={toggleLiveServer}
          title={liveServerRunning ? `Live Server running on ${liveServerUrl} - Click to stop` : 'Click to start Live Server'}
        >
          <Radio size={12} className={`mr-1 ${liveServerRunning ? 'animate-pulse' : ''}`} />
          <span>{liveServerRunning ? 'Go Live' : 'Go Live'}</span>
        </button>

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
          <button className="statusbar-item" onClick={() => setActiveActivity('settings')} title={modelInfo ? `${modelInfo.name} (${modelInfo.contextSize} ctx)` : 'No model'}>
            <Cpu size={12} className="mr-1" />
            {modelLoaded && modelInfo ? (
              <span className="truncate max-w-[120px]">{modelInfo.family || modelInfo.name}</span>
            ) : (
              <span className="opacity-70">No Model</span>
            )}
          </button>
        )}
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
