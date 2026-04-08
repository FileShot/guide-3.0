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
import TitleBar from './TitleBar';
import ActivityBar from './ActivityBar';
import Sidebar from './Sidebar';
import EditorArea from './EditorArea';
import BottomPanel from './BottomPanel';
import ChatPanel from './ChatPanel';
import StatusBar from './StatusBar';
import CommandPalette from './CommandPalette';
import Notifications from './Notifications';

export default function Layout() {
  const sidebarVisible = useAppStore(s => s.sidebarVisible);
  const sidebarWidth = useAppStore(s => s.sidebarWidth);
  const panelVisible = useAppStore(s => s.panelVisible);
  const panelHeight = useAppStore(s => s.panelHeight);
  const chatPanelVisible = useAppStore(s => s.chatPanelVisible);
  const chatPanelWidth = useAppStore(s => s.chatPanelWidth);
  const commandPaletteOpen = useAppStore(s => s.commandPaletteOpen);
  const zoomLevel = useAppStore(s => s.zoomLevel);

  return (
    <div
      className="flex flex-col overflow-hidden bg-vsc-bg w-full h-full"
      style={zoomLevel !== 1 ? {
        transform: `scale(${zoomLevel})`,
        transformOrigin: 'top left',
        width: `${100 / zoomLevel}%`,
        height: `${100 / zoomLevel}%`,
      } : undefined}
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
            <div style={{ width: sidebarWidth, minWidth: 180 }} className="bg-vsc-sidebar overflow-hidden">
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
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Editor Area */}
          <div className="flex-1 overflow-hidden min-h-0">
            <EditorArea />
          </div>

          {/* Bottom Panel (Terminal, Output, Problems) */}
          {panelVisible && (
            <>
              <div
                className="splitter-h"
                onMouseDown={(e) => _startResize(e, 'panel')}
                onDoubleClick={() => useAppStore.getState().togglePanel()}
              />
              <div style={{ height: panelHeight }} className="flex-shrink-0 overflow-hidden border-t border-vsc-panel-border">
                <BottomPanel />
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
              <ChatPanel />
            </div>
          </>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* Overlays */}
      {commandPaletteOpen && <CommandPalette />}
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
