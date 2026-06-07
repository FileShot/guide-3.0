/**
 * Layout — Main VS Code-like application layout.
 *
 * Structure:
 *   ┌─────────────────────────────────────────────────┐
 *   │                   Title Bar                      │
 *   ├────┬──────────┬────────────────────┬─────────────┤
 *   │    │          │                    │             │
 *   │ A  │ Sidebar  │     Editor Area    │  Chat Panel │
 *   │ c  │          │                    │             │
 *   │ t  │          ├────────────────────┤             │
 *   │ .  │          │   Bottom Panel     │             │
 *   │ B  │          │   (Terminal)       │             │
 *   │ a  │          │                    │             │
 *   │ r  │          │                    │             │
 *   ├────┴──────────┴────────────────────┴─────────────┤
 *   │                  Status Bar                      │
 *   └─────────────────────────────────────────────────┘
 */
import useAppStore from '../stores/appStore';
import isPocket from '../lib/isPocket';
import useMobileViewport from '../lib/useMobileViewport';
import { normalizeUpdateStatus, updateVersionLabel } from '../lib/updateStatus';
import PocketMobileLayout from './PocketMobileLayout';
import TitleBar from './TitleBar';
import ActivityBar from './ActivityBar';
import Sidebar from './Sidebar';
import EditorArea from './EditorArea';
import StatusBar from './StatusBar';
import Notifications from './Notifications';
import ComposerPanel from './ComposerPanel';
import { lazy, Suspense, useEffect, useRef } from 'react';

// Lazy-load heavy components that aren't needed on initial render
const BottomPanel = lazy(() => import('./BottomPanel'));
const ChatPanel = lazy(() => import('./ChatPanel'));
const CommandPalette = lazy(() => import('./CommandPalette'));

const LazyFallback = () => (
  <div className="flex items-center justify-center h-full text-vsc-text-dim text-vsc-sm">
    <div className="spinner mr-2" />Loading...
  </div>
);

export default function Layout() {
  const pocket = isPocket();
  const isMobile = useMobileViewport();
  if (pocket && isMobile) {
    return <PocketMobileLayout />;
  }
  return <DesktopLayout />;
}

function DesktopLayout() {
  const sidebarVisible = useAppStore(s => s.sidebarVisible);
  const sidebarWidth = useAppStore(s => s.sidebarWidth);
  const panelVisible = useAppStore(s => s.panelVisible);
  const panelHeight = useAppStore(s => s.panelHeight);
  const chatPanelVisible = useAppStore(s => s.chatPanelVisible);
  const chatPanelWidth = useAppStore(s => s.chatPanelWidth);
  const commandPaletteOpen = useAppStore(s => s.commandPaletteOpen);
  const zoomLevel = useAppStore(s => s.zoomLevel);
  const setUpdateStatus = useAppStore(s => s.setUpdateStatus);
  const addNotification = useAppStore(s => s.addNotification);
  const prevUpdateStatusRef = useRef(null);

  useEffect(() => {
    const hydrate = async () => {
      try {
        const status = window.electronAPI?.updater?.getStatus
          ? await window.electronAPI.updater.getStatus()
          : await fetch('/api/updater/status').then(r => r.json());
        if (status) setUpdateStatus(status);
      } catch {
        // Updater unavailable in dev/web mode
      }
    };
    hydrate();

    if (!window.electronAPI?.updater?.onStatus) return undefined;

    return window.electronAPI.updater.onStatus((payload) => {
      const normalized = normalizeUpdateStatus(payload);
      const prev = prevUpdateStatusRef.current;
      setUpdateStatus(payload);
      if (normalized?.status === 'available' && prev?.status !== 'available') {
        addNotification({
          type: 'info',
          title: 'Update available',
          message: `v${updateVersionLabel(normalized)} — downloading in background`,
          duration: 5000,
        });
      }
      prevUpdateStatusRef.current = normalized;
    });
  }, [setUpdateStatus, addNotification]);

  return (
    <div
      className="flex flex-col overflow-hidden bg-vsc-bg w-full h-full rounded-xl isolation-isolate"
      style={{
        boxShadow: '0 0 0 1px rgba(0,0,0,0.3), 0 4px 24px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.2)',
        ...(zoomLevel !== 1 ? {
          transform: `scale(${zoomLevel})`,
          transformOrigin: 'top left',
          width: `${100 / zoomLevel}%`,
          height: `${100 / zoomLevel}%`,
        } : {}),
      }}
    >
      {/* Title Bar */}
      <TitleBar />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Activity Bar */}
        <ActivityBar />

        {/* Sidebar */}
        {sidebarVisible && (
          <>
            <div style={{ width: sidebarWidth, minWidth: 180 }} className="flex flex-col h-full min-h-0 bg-vsc-sidebar overflow-hidden">
              <Sidebar />
            </div>
            <div
              className="splitter-v"
              onMouseDown={(e) => _startResize(e, 'sidebar')}
              onDoubleClick={() => useAppStore.getState().toggleSidebar()}
            />
          </>
        )}

        {/* Editor + Bottom Panel */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
          {/* Editor Area */}
          <div className="flex-1 overflow-hidden min-h-0">
            <EditorArea />
          </div>
          <ComposerPanel />

          {/* Bottom Panel (Terminal, Output, Problems) */}
          {panelVisible && (
            <>
              <div
                className="splitter-h"
                onMouseDown={(e) => _startResize(e, 'panel')}
                onDoubleClick={() => useAppStore.getState().togglePanel()}
              />
              <div style={{ height: panelHeight }} className="flex-shrink-0 overflow-hidden border-t border-vsc-panel-border">
                <Suspense fallback={<LazyFallback />}><BottomPanel /></Suspense>
              </div>
            </>
          )}
        </div>

        {/* Chat Panel */}
        {chatPanelVisible && (
          <>
            <div
              className="splitter-v"
              onMouseDown={(e) => _startResize(e, 'chat')}
              onDoubleClick={() => useAppStore.getState().toggleChatPanel()}
            />
            <div style={{ width: chatPanelWidth, minWidth: 280 }} className="bg-vsc-sidebar overflow-hidden border-l border-vsc-panel-border">
              <Suspense fallback={<LazyFallback />}><ChatPanel /></Suspense>
            </div>
          </>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Overlays */}
      {commandPaletteOpen && <Suspense fallback={null}><CommandPalette /></Suspense>}
      <Notifications />
    </div>
  );
}

function _startResize(e, target) {
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const store = useAppStore.getState();
  const startWidth = target === 'sidebar' ? store.sidebarWidth : store.chatPanelWidth;
  const startHeight = store.panelHeight;

  const onMouseMove = (ev) => {
    if (target === 'sidebar') {
      const delta = ev.clientX - startX;
      store.setSidebarWidth(startWidth + delta);
    } else if (target === 'chat') {
      const delta = startX - ev.clientX;
      store.setChatPanelWidth(startWidth + delta);
    } else if (target === 'panel') {
      const delta = startY - ev.clientY;
      store.setPanelHeight(startHeight + delta);
    }
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Remove resize overlay
    const overlay = document.getElementById('resize-overlay');
    if (overlay) overlay.remove();
  };

  document.body.style.cursor = target === 'panel' ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
  // Add transparent overlay to prevent iframes/embeds from capturing pointer
  const overlay = document.createElement('div');
  overlay.id = 'resize-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:' + (target === 'panel' ? 'row-resize' : 'col-resize');
  document.body.appendChild(overlay);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}
