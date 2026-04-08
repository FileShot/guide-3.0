/**
 * WelcomeScreen — Full-page overlay shown on app startup.
 * Premium Windsurf/Cursor-inspired design with animated wavy background,
 * glassmorphism cards, recommended model downloads, and smooth animations.
 */
import { useState, useEffect, useCallback } from 'react';
import useAppStore from '../stores/appStore';
import ModelDownloadPanel from './ModelDownloadPanel';
import {
  FolderOpen, Plus, Clock, ChevronRight, Package, Cloud,
  Star, Loader2, Zap, Code2, Brain, Keyboard, ArrowRight, Download,
  Cpu, Sparkles, Globe,
} from 'lucide-react';

// Recommended models — curated for first-time users
const RECOMMENDED_MODELS = [
  {
    name: 'Qwen 3.5 4B',
    desc: 'Fast, great for quick tasks. Runs on any modern GPU.',
    size: '~2.6 GB',
    hfRepo: 'unsloth/Qwen3.5-4B-GGUF',
    hfFile: 'Qwen3.5-4B-Q4_K_M.gguf',
    tier: 'starter',
  },
  {
    name: 'Qwen 3.5 9B',
    desc: 'Balanced quality and speed. Best all-rounder.',
    size: '~5.5 GB',
    hfRepo: 'unsloth/Qwen3.5-9B-GGUF',
    hfFile: 'Qwen3.5-9B-Q4_K_M.gguf',
    tier: 'recommended',
  },
  {
    name: 'Qwen 3.5 27B',
    desc: 'Maximum quality. Needs 20GB+ VRAM.',
    size: '~16.7 GB',
    hfRepo: 'unsloth/Qwen3.5-27B-GGUF',
    hfFile: 'Qwen3.5-27B-Q4_K_M.gguf',
    tier: 'advanced',
  },
];

export default function WelcomeScreen() {
  const showWelcomeScreen = useAppStore(s => s.showWelcomeScreen);
  const setShowWelcomeScreen = useAppStore(s => s.setShowWelcomeScreen);
  const recentFolders = useAppStore(s => s.recentFolders);
  const setProjectPath = useAppStore(s => s.setProjectPath);
  const setFileTree = useAppStore(s => s.setFileTree);
  const setShowNewProjectDialog = useAppStore(s => s.setShowNewProjectDialog);
  const addNotification = useAppStore(s => s.addNotification);
  const availableModels = useAppStore(s => s.availableModels);
  const modelInfo = useAppStore(s => s.modelInfo);
  const modelLoading = useAppStore(s => s.modelLoading);
  const defaultModelPath = useAppStore(s => s.defaultModelPath);
  const setDefaultModelPath = useAppStore(s => s.setDefaultModelPath);

  const [loadingModel, setLoadingModel] = useState(null);
  const [showDownloadPanel, setShowDownloadPanel] = useState(false);
  const [downloadingRec, setDownloadingRec] = useState(null);
  const [mounted, setMounted] = useState(false);

  // Trigger entrance animations
  useEffect(() => {
    if (showWelcomeScreen) {
      const t = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(t);
    }
    setMounted(false);
  }, [showWelcomeScreen]);

  if (!showWelcomeScreen) return null;

  if (showDownloadPanel) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-vsc-bg/80 backdrop-blur-sm">
        <div className="w-full max-w-[500px] h-[80vh] bg-vsc-sidebar rounded-2xl border border-vsc-panel-border/50 shadow-2xl overflow-hidden">
          <ModelDownloadPanel onBack={() => setShowDownloadPanel(false)} />
        </div>
      </div>
    );
  }

  const openFolder = () => {
    if (window.electronAPI?.showOpenDialog) {
      window.electronAPI.showOpenDialog().then(result => {
        if (result) openProjectPath(result);
      });
    } else {
      const path = prompt('Enter folder path to open:');
      if (path) openProjectPath(path);
    }
  };

  const openProjectPath = (path) => {
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
  };

  const openRecent = (path) => openProjectPath(path);
  const newProject = () => setShowNewProjectDialog(true);

  const loadModel = async (modelPath) => {
    setLoadingModel(modelPath);
    try {
      const r = await fetch('/api/models/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelPath }),
      });
      const d = await r.json();
      if (!d.success) addNotification({ type: 'error', message: d.error });
    } catch (e) {
      addNotification({ type: 'error', message: e.message });
    }
    setLoadingModel(null);
  };

  const toggleDefault = (modelPath) => {
    setDefaultModelPath(defaultModelPath === modelPath ? null : modelPath);
  };

  const useCloudAI = () => {
    localStorage.setItem('guide-cloud-provider', 'groq');
    localStorage.setItem('guide-cloud-model', 'llama-3.3-70b-versatile');
    if (recentFolders.length > 0) openRecent(recentFolders[0]);
    else setShowWelcomeScreen(false);
  };

  const downloadRecommended = async (rec) => {
    setDownloadingRec(rec.hfFile);
    try {
      const url = `https://huggingface.co/${rec.hfRepo}/resolve/main/${rec.hfFile}`;
      const r = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, fileName: rec.hfFile }),
      });
      const d = await r.json();
      if (d.error) addNotification({ type: 'error', message: d.error });
      else addNotification({ type: 'info', message: `Download started: ${rec.name}` });
    } catch (e) {
      addNotification({ type: 'error', message: e.message });
    }
    setDownloadingRec(null);
  };

  const formatPath = (fullPath) => {
    const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return {
      name: parts[parts.length - 1] || fullPath,
      parent: parts.slice(0, -1).join('/') || '/',
    };
  };

  const llmModels = (availableModels || []).filter(m =>
    m.modelType === 'llm' && !/mmproj/i.test(m.name || m.path || '')
  );

  const anim = (delay) => ({
    opacity: mounted ? 1 : 0,
    transform: mounted ? 'translateY(0)' : 'translateY(16px)',
    transition: `opacity 0.5s ease ${delay}s, transform 0.5s ease ${delay}s`,
  });

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center overflow-auto bg-vsc-bg">
      {/* Animated wavy background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <svg className="absolute bottom-0 left-0 w-full" viewBox="0 0 1440 320" preserveAspectRatio="none" style={{ height: '25%', opacity: 0.03 }}>
          <path fill="rgb(var(--guide-accent))" d="M0,224L48,213.3C96,203,192,181,288,186.7C384,192,480,224,576,234.7C672,245,768,235,864,208C960,181,1056,139,1152,138.7C1248,139,1344,181,1392,202.7L1440,224L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z">
            <animateTransform attributeName="transform" type="translate" values="0,0;15,3;0,0" dur="8s" repeatCount="indefinite" />
          </path>
        </svg>
        <svg className="absolute bottom-0 left-0 w-full" viewBox="0 0 1440 320" preserveAspectRatio="none" style={{ height: '20%', opacity: 0.02 }}>
          <path fill="rgb(var(--guide-accent))" d="M0,288L48,272C96,256,192,224,288,213.3C384,203,480,213,576,229.3C672,245,768,267,864,261.3C960,256,1056,224,1152,208C1248,192,1344,192,1392,192L1440,192L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z">
            <animateTransform attributeName="transform" type="translate" values="0,0;-10,4;0,0" dur="10s" repeatCount="indefinite" />
          </path>
        </svg>
        {/* Radial glow behind logo */}
        <div className="absolute top-[8%] left-1/2 -translate-x-1/2 w-[500px] h-[300px] rounded-full"
          style={{ background: 'radial-gradient(ellipse, rgb(var(--guide-accent) / 0.08) 0%, transparent 70%)' }} />
      </div>

      {/* Skip button */}
      <button
        onClick={() => setShowWelcomeScreen(false)}
        className="absolute top-4 right-4 text-vsc-xs text-vsc-text-dim/50 hover:text-vsc-text transition-colors px-3 py-1 rounded-lg hover:bg-white/5"
        style={anim(0)}
      >
        Skip
      </button>

      {/* Logo + Brand */}
      <div className="flex flex-col items-center mt-14 mb-6 select-none relative z-10" style={anim(0.1)}>
        <div className="relative">
          <div
            className="w-20 h-20 mb-4 bg-vsc-accent"
            style={{
              mask: 'url(/icon.png) center/contain no-repeat',
              WebkitMask: 'url(/icon.png) center/contain no-repeat',
              filter: 'drop-shadow(0 0 30px rgb(var(--guide-accent) / 0.5))',
            }}
          />
          <div className="absolute inset-0 w-20 h-20 rounded-full animate-pulse"
               style={{ background: 'radial-gradient(circle, rgb(var(--guide-accent) / 0.15) 0%, transparent 70%)' }} />
        </div>
        <h1 className="text-[36px] font-brand text-vsc-accent tracking-tight" style={{ textShadow: '0 0 40px rgb(var(--guide-accent) / 0.3)' }}>
          guIDE
        </h1>
        <p className="text-[13px] text-vsc-text-dim/70 mt-1 font-light">
          Local AI — No cloud required
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 mb-8 relative z-10" style={anim(0.2)}>
        <button
          onClick={openFolder}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-[13px] font-medium
            bg-vsc-accent text-vsc-bg hover:brightness-110 transition-all duration-200
            hover:-translate-y-0.5 hover:shadow-lg hover:shadow-vsc-accent/20 active:translate-y-0"
        >
          <FolderOpen size={16} />
          Open Folder
        </button>
        <button
          onClick={newProject}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-[13px] font-medium
            bg-white/5 text-vsc-text border border-white/10 backdrop-blur-sm
            hover:bg-white/10 hover:border-white/20 transition-all duration-200
            hover:-translate-y-0.5 hover:shadow-lg active:translate-y-0"
        >
          <Plus size={16} />
          New Project
        </button>
      </div>

      {/* Main content grid */}
      <div className="w-full max-w-[920px] px-6 flex gap-6 min-h-0 pb-12 relative z-10">

        {/* Left Column — Recent + Shortcuts */}
        <div className="flex-1 min-w-0" style={anim(0.3)}>
          {recentFolders.length > 0 ? (
            <div className="glass-card rounded-2xl p-4 mb-5">
              <div className="flex items-center gap-2 mb-3 text-[11px] font-semibold uppercase tracking-wider text-vsc-text-dim/80">
                <Clock size={12} />
                Recent Projects
              </div>
              <div className="flex flex-col gap-0.5">
                {recentFolders.slice(0, 4).map(path => {
                  const { name, parent } = formatPath(path);
                  return (
                    <button
                      key={path}
                      onClick={() => openRecent(path)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-left
                        transition-all duration-150 group
                        hover:bg-white/5 hover:shadow-sm"
                    >
                      <FolderOpen size={16} className="text-vsc-accent flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-vsc-text truncate">{name}</div>
                        <div className="text-[11px] text-vsc-text-dim/60 truncate">{parent}</div>
                      </div>
                      <ChevronRight size={14} className="text-vsc-text-dim/30 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  );
                })}
                {recentFolders.length > 4 && (
                  <button
                    onClick={() => {}}
                    className="text-[11px] text-vsc-accent hover:text-vsc-accent-hover px-3 py-1.5 transition-colors"
                  >
                    Show all ({recentFolders.length})
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="glass-card rounded-2xl p-8 mb-5 text-center">
              <FolderOpen size={40} className="text-vsc-text-dim/20 mx-auto mb-3" />
              <p className="text-vsc-sm text-vsc-text-dim/70">No recent projects</p>
              <p className="text-vsc-xs text-vsc-text-dim/40 mt-1">Open a folder to get started</p>
            </div>
          )}

          {/* Keyboard Shortcuts */}
          <div className="glass-card rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3 text-[11px] font-semibold uppercase tracking-wider text-vsc-text-dim/80">
              <Keyboard size={12} />
              Shortcuts
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-vsc-xs">
              {[
                ['Ctrl+Shift+P', 'Command Palette'],
                ['Ctrl+B', 'Toggle Sidebar'],
                ['Ctrl+L', 'Toggle AI Chat'],
                ['Ctrl+J', 'Toggle Terminal'],
                ['Ctrl+S', 'Save File'],
                ['Ctrl+P', 'Quick Open'],
              ].map(([key, action]) => (
                <div key={key} className="contents">
                  <kbd className="bg-white/5 border border-white/10 px-2 py-0.5 rounded-md text-[10px] font-mono text-vsc-text-bright text-center">{key}</kbd>
                  <span className="text-vsc-text/80">{action}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column — Models */}
        <div className={recentFolders.length > 0 ? 'w-[340px] flex-shrink-0' : 'flex-1 min-w-0'} style={anim(0.4)}>
          {/* Cloud AI Card */}
          <div className="glass-card rounded-2xl p-4 mb-5">
            <div className="flex items-center gap-2 mb-3 text-[11px] font-semibold uppercase tracking-wider text-vsc-text-dim/80">
              <Cloud size={12} />
              Cloud AI
            </div>
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/3 border border-white/5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-vsc-accent/20 to-vsc-accent/5 flex items-center justify-center">
                <Globe size={16} className="text-vsc-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-vsc-text">guIDE Cloud AI</div>
                <div className="text-[10px] text-vsc-text-dim/60">20 free messages/day</div>
              </div>
              <button
                onClick={useCloudAI}
                className="flex-shrink-0 text-[11px] px-3 py-1.5 rounded-lg font-medium
                  bg-vsc-accent text-vsc-bg hover:brightness-110 transition-all duration-150"
              >
                Use
              </button>
            </div>
          </div>

          {/* Recommended Models */}
          <div className="glass-card rounded-2xl p-4 mb-5">
            <div className="flex items-center gap-2 mb-3 text-[11px] font-semibold uppercase tracking-wider text-vsc-text-dim/80">
              <Sparkles size={12} />
              Recommended Models
            </div>
            <div className="flex flex-col gap-2">
              {RECOMMENDED_MODELS.map(rec => {
                const isDownloading = downloadingRec === rec.hfFile;
                const alreadyInstalled = llmModels.some(m => (m.name || '').includes(rec.hfFile.replace('.gguf', '')));
                return (
                  <div key={rec.hfFile}
                    className={`relative flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all duration-150 ${
                      rec.tier === 'recommended'
                        ? 'bg-vsc-accent/5 border-vsc-accent/20'
                        : 'bg-white/2 border-white/5'
                    }`}
                  >
                    {rec.tier === 'recommended' && (
                      <div className="absolute -top-2 right-3 text-[9px] font-semibold px-2 py-0.5 rounded-full bg-vsc-accent text-vsc-bg uppercase tracking-wider">
                        Best
                      </div>
                    )}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      rec.tier === 'starter' ? 'bg-green-500/10' :
                      rec.tier === 'recommended' ? 'bg-vsc-accent/10' : 'bg-purple-500/10'
                    }`}>
                      <Cpu size={14} className={
                        rec.tier === 'starter' ? 'text-green-400' :
                        rec.tier === 'recommended' ? 'text-vsc-accent' : 'text-purple-400'
                      } />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-vsc-text">{rec.name}</div>
                      <div className="text-[10px] text-vsc-text-dim/60">{rec.desc}</div>
                      <div className="text-[10px] text-vsc-text-dim/40 mt-0.5">{rec.size}</div>
                    </div>
                    <button
                      onClick={() => !alreadyInstalled && downloadRecommended(rec)}
                      disabled={isDownloading || alreadyInstalled}
                      className={`flex-shrink-0 text-[10px] px-2.5 py-1 rounded-lg font-medium flex items-center gap-1 transition-all duration-150 ${
                        alreadyInstalled
                          ? 'bg-green-500/10 text-green-400 cursor-default'
                          : 'bg-white/5 text-vsc-text hover:bg-white/10 border border-white/10'
                      }`}
                    >
                      {isDownloading ? <Loader2 size={10} className="animate-spin" /> :
                       alreadyInstalled ? 'Installed' :
                       <><Download size={10} /> Get</>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Installed Models */}
          {llmModels.length > 0 && (
            <div className="glass-card rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3 text-[11px] font-semibold uppercase tracking-wider text-vsc-text-dim/80">
                <Package size={12} />
                Installed Models
                <button
                  onClick={() => setShowDownloadPanel(true)}
                  className="ml-auto flex items-center gap-1 text-[10px] text-vsc-accent hover:text-vsc-accent-hover transition-colors normal-case tracking-normal font-normal"
                >
                  <Download size={10} /> More
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {llmModels.map(model => {
                  const label = (model.name || '').replace(/\.gguf$/i, '');
                  const mp = model.path || model.name;
                  const isActive = modelInfo?.path === mp;
                  const isDefault = defaultModelPath === mp;
                  const isLoading = loadingModel === mp || (modelLoading && loadingModel === mp);

                  return (
                    <div
                      key={mp}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border transition-all duration-150 ${
                        isActive
                          ? 'bg-vsc-accent/8 border-vsc-accent/30'
                          : 'bg-white/2 border-white/5 hover:bg-white/4'
                      }`}
                    >
                      <button
                        onClick={() => toggleDefault(mp)}
                        className="flex-shrink-0 transition-colors"
                        title={isDefault ? 'Default model' : 'Set as default'}
                      >
                        <Star
                          size={13}
                          className={isDefault ? 'text-vsc-accent' : 'text-vsc-text-dim/30 hover:text-vsc-text-dim'}
                          fill={isDefault ? 'currentColor' : 'none'}
                        />
                      </button>
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] text-vsc-text truncate block" title={label}>
                          {label}
                        </span>
                        {model.sizeFormatted && (
                          <span className="text-[10px] text-vsc-text-dim/50">{model.sizeFormatted}</span>
                        )}
                      </div>
                      <button
                        onClick={() => !isActive && loadModel(mp)}
                        disabled={isLoading || isActive}
                        className={`flex-shrink-0 text-[11px] px-2.5 py-1 rounded-lg font-medium flex items-center gap-1 transition-all duration-150 ${
                          isActive
                            ? 'bg-green-500/10 text-green-400 cursor-default'
                            : 'bg-vsc-accent text-vsc-bg hover:brightness-110 cursor-pointer'
                        }`}
                        style={{ minWidth: 50, opacity: isLoading ? 0.7 : 1 }}
                      >
                        {isLoading ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : isActive ? (
                          'Active'
                        ) : (
                          'Use'
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* No models */}
          {llmModels.length === 0 && (
            <div className="glass-card rounded-2xl p-8 text-center">
              <Package size={36} className="text-vsc-text-dim/15 mx-auto mb-3" />
              <p className="text-vsc-sm text-vsc-text-dim/60">No models installed</p>
              <p className="text-vsc-xs text-vsc-text-dim/35 mt-1">
                Download a recommended model above
              </p>
              <button
                onClick={() => setShowDownloadPanel(true)}
                className="mt-3 flex items-center gap-1.5 mx-auto px-4 py-2 text-[11px] font-medium rounded-xl bg-vsc-accent text-vsc-bg hover:brightness-110 transition-all"
              >
                <Download size={12} /> Browse HuggingFace
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="pb-6 text-[10px] text-vsc-text-dim/30 select-none relative z-10" style={anim(0.5)}>
        guIDE 2.0 — Built for local AI inference
      </div>
    </div>
  );
}
