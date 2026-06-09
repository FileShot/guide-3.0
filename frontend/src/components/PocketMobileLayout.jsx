/**
 * PocketMobileLayout — Mobile-only shell for pocket.graysoft.dev.
 * Editor on top, chat on bottom (draggable split). Terminal optional via toolbar.
 */
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import useAppStore from '../stores/appStore';
import Sidebar from './Sidebar';
import EditorArea from './EditorArea';
import Notifications from './Notifications';
import ComposerPanel from './ComposerPanel';
import { Files, MessageSquare, Terminal, Settings, Globe, X, ChevronLeft } from 'lucide-react';

const BottomPanel = lazy(() => import('./BottomPanel'));
const ChatPanel = lazy(() => import('./ChatPanel'));
const BrowserPanel = lazy(() => import('./BrowserPanel'));
const CommandPalette = lazy(() => import('./CommandPalette'));

const LazyFallback = () => (
  <div className="flex items-center justify-center h-full text-vsc-text-dim text-vsc-sm">
    <div className="spinner mr-2" />Loading...
  </div>
);

// splitRatio = editor share from top; 0.50 => 50/50 default (draggable, persisted)
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;
const DEFAULT_SPLIT = 0.5;
const SPLIT_STORAGE_KEY = 'pocket-mobile-split';

function readStoredSplit() {
  try {
    const v = parseFloat(localStorage.getItem(SPLIT_STORAGE_KEY));
    if (!Number.isNaN(v) && v >= MIN_SPLIT && v <= MAX_SPLIT) return v;
  } catch (_) {}
  return DEFAULT_SPLIT;
}

function useSplitDrag(setRatio, containerRef) {
  const dragging = useRef(false);
  const onMove = useCallback((clientY) => {
    const el = containerRef.current;
    if (!el || !dragging.current) return;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top;
    setRatio(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, y / rect.height)));
  }, [containerRef, setRatio]);
  const end = useCallback(() => {
    dragging.current = false;
    document.body.style.userSelect = '';
    document.body.style.touchAction = '';
  }, []);
  const start = useCallback((clientY) => {
    dragging.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.touchAction = 'none';
    onMove(clientY);
  }, [onMove]);
  useEffect(() => {
    const onMouseMove = (e) => onMove(e.clientY);
    const onMouseUp = () => end();
    const onTouchMove = (e) => {
      if (dragging.current && e.touches[0]) { e.preventDefault(); onMove(e.touches[0].clientY); }
    };
    const onTouchEnd = () => end();
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [onMove, end]);
  return { start };
}

function SplitHandle({ onStart }) {
  return (
    <div
      className="pocket-mobile-split-handle flex-shrink-0 touch-none"
      onMouseDown={(e) => { e.preventDefault(); onStart(e.clientY); }}
      onTouchStart={(e) => { e.preventDefault(); onStart(e.touches[0].clientY); }}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor and chat"
    >
      <div className="pocket-mobile-split-pill" />
    </div>
  );
}

function MobileToolbar({ onFiles, onSettings, mobileMode, onModeChange }) {
  const sidebarOpen = useAppStore(s => s.sidebarVisible);
  const activeActivity = useAppStore(s => s.activeActivity);
  const settingsActive = sidebarOpen && activeActivity === 'settings';
  const modeBtn = (mode, label, Icon) => (
    <button
      type="button"
      className={`pocket-mobile-toolbar-btn ${mobileMode === mode ? 'active' : ''}`}
      onClick={() => onModeChange(mode)}
      aria-pressed={mobileMode === mode}
    >
      <Icon size={16} strokeWidth={1.5} />
      <span>{label}</span>
    </button>
  );
  return (
    <div className="pocket-mobile-toolbar flex-shrink-0" aria-label="Mobile tools">
      <button
        type="button"
        className={`pocket-mobile-toolbar-btn ${sidebarOpen ? 'active' : ''}`}
        onClick={onFiles}
        aria-pressed={sidebarOpen}
      >
        <Files size={16} strokeWidth={1.5} />
        <span>Files</span>
      </button>
      {modeBtn('chat', 'Chat', MessageSquare)}
      {modeBtn('terminal', 'Terminal', Terminal)}
      {modeBtn('browser', 'Browser', Globe)}
      <button
        type="button"
        className={`pocket-mobile-toolbar-btn ${settingsActive ? 'active' : ''}`}
        onClick={onSettings}
        aria-pressed={settingsActive}
      >
        <Settings size={16} strokeWidth={1.5} />
        <span>Settings</span>
      </button>
    </div>
  );
}

export default function PocketMobileLayout() {
  const sidebarVisible = useAppStore(s => s.sidebarVisible);
  const activeActivity = useAppStore(s => s.activeActivity);
  const commandPaletteOpen = useAppStore(s => s.commandPaletteOpen);

  const [splitRatio, setSplitRatio] = useState(readStoredSplit);
  const [mobileMode, setMobileMode] = useState('chat');
  const mainRef = useRef(null);
  const { start: startSplitDrag } = useSplitDrag(setSplitRatio, mainRef);

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, String(splitRatio));
    } catch (_) {}
  }, [splitRatio]);

  useEffect(() => {
    document.documentElement.classList.add('pocket-mobile-active');
    useAppStore.setState({
      sidebarVisible: false,
      panelVisible: false,
      chatPanelVisible: true,
    });
    return () => document.documentElement.classList.remove('pocket-mobile-active');
  }, []);

  const openExplorer = () => {
    const s = useAppStore.getState();
    if (s.sidebarVisible && s.activeActivity === 'explorer') {
      useAppStore.setState({ sidebarVisible: false });
    } else {
      s.setActiveActivity('explorer');
      useAppStore.setState({ sidebarVisible: true });
    }
  };

  const openSettings = () => {
    const s = useAppStore.getState();
    if (s.sidebarVisible && s.activeActivity === 'settings') {
      useAppStore.setState({ sidebarVisible: false });
    } else {
      s.setActiveActivity('settings');
      useAppStore.setState({ sidebarVisible: true });
    }
  };

  const closeDrawer = () => useAppStore.setState({ sidebarVisible: false });
  const drawerTitle = activeActivity === 'settings' ? 'Settings' : 'Explorer';

  const handleModeChange = (mode) => {
    setMobileMode(mode);
    if (mode === 'browser') {
      closeDrawer();
      useAppStore.getState().openBrowserTab();
    }
  };

  const editorFlex = splitRatio;
  const bottomFlex = 1 - splitRatio;

  return (
    <div className="pocket-mobile-root flex flex-col overflow-hidden bg-vsc-bg w-full h-full">
      <MobileToolbar
        onFiles={openExplorer}
        onSettings={openSettings}
        mobileMode={mobileMode}
        onModeChange={handleModeChange}
      />
      <div ref={mainRef} className="flex-1 flex flex-col min-h-0 relative overflow-hidden">
        <div className="min-h-0 overflow-hidden flex flex-col" style={{ flex: `${editorFlex} 1 0%` }}>
          <EditorArea />
          <ComposerPanel />
        </div>
        <SplitHandle onStart={startSplitDrag} />
        <div className="min-h-0 overflow-hidden flex flex-col border-t border-vsc-panel-border/40" style={{ flex: `${bottomFlex} 1 0%` }}>
          <Suspense fallback={<LazyFallback />}>
            {mobileMode === 'terminal' ? (
              <BottomPanel />
            ) : mobileMode === 'browser' ? (
              <BrowserPanel />
            ) : (
              <ChatPanel />
            )}
          </Suspense>
        </div>
        <div className={`pocket-mobile-drawer ${sidebarVisible ? 'pocket-mobile-drawer-open' : ''}`} aria-hidden={!sidebarVisible}>
          <div className="pocket-mobile-drawer-header">
            <button type="button" className="pocket-mobile-drawer-back" onClick={closeDrawer} aria-label="Close panel"><ChevronLeft size={18} /></button>
            <span className="text-[13px] font-medium text-vsc-text">{drawerTitle}</span>
            <button type="button" className="pocket-mobile-drawer-back ml-auto" onClick={closeDrawer} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden"><Sidebar /></div>
        </div>
        {sidebarVisible && <button type="button" className="pocket-mobile-backdrop" onClick={closeDrawer} aria-label="Close panel overlay" />}
      </div>
      {commandPaletteOpen && <Suspense fallback={null}><CommandPalette /></Suspense>}
      <Notifications />
    </div>
  );
}
