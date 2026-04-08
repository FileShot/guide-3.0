/**
 * ActivityBar — Left icon strip with activity icons.
 * Theme-aware — all colors from CSS variables.
 */
import useAppStore from '../stores/appStore';
import { Files, Search, GitBranch, MessageSquare, Blocks, Settings, Bug, UserCircle, Globe } from 'lucide-react';

const activities = [
  { id: 'explorer', icon: Files, label: 'Explorer (Ctrl+Shift+E)' },
  { id: 'search', icon: Search, label: 'Search (Ctrl+Shift+F)' },
  { id: 'git', icon: GitBranch, label: 'Source Control (Ctrl+Shift+G)' },
  { id: 'debug', icon: Bug, label: 'Run and Debug (Ctrl+Shift+D)' },
  { id: 'extensions', icon: Blocks, label: 'Extensions (Ctrl+Shift+X)' },
  { id: 'browser', icon: Globe, label: 'Browser Preview' },
];

export default function ActivityBar() {
  const activeActivity = useAppStore(s => s.activeActivity);
  const setActiveActivity = useAppStore(s => s.setActiveActivity);
  const chatPanelVisible = useAppStore(s => s.chatPanelVisible);
  const toggleChatPanel = useAppStore(s => s.toggleChatPanel);

  return (
    <div className="w-activitybar bg-vsc-activitybar flex flex-col items-center no-select border-r border-vsc-panel-border/30">
      {/* Top activities */}
      <div className="flex flex-col">
        {activities.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            className={`activity-bar-icon ${activeActivity === id ? 'active' : ''}`}
            title={label}
            onClick={() => {
              // R46-C: Browser opens as editor tab, not sidebar panel
              if (id === 'browser') {
                useAppStore.getState().openBrowserTab();
              } else {
                setActiveActivity(id);
              }
            }}
          >
            <Icon size={24} strokeWidth={1.5} />
          </button>
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom activities */}
      <div className="flex flex-col pb-1">
        <button
          className={`activity-bar-icon ${chatPanelVisible ? 'active' : ''}`}
          title="AI Chat"
          onClick={toggleChatPanel}
        >
          <MessageSquare size={24} strokeWidth={1.5} />
        </button>
        <button
          className={`activity-bar-icon ${activeActivity === 'account' ? 'active' : ''}`}
          title="Account"
          onClick={() => setActiveActivity('account')}
        >
          <UserCircle size={24} strokeWidth={1.5} />
        </button>
        <button
          className={`activity-bar-icon ${activeActivity === 'settings' ? 'active' : ''}`}
          title="Settings"
          onClick={() => setActiveActivity('settings')}
        >
          <Settings size={24} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
