/**
 * Notifications — Toast notification system mimicking VS Code's.
 * Displays info, warning, and error notifications in the bottom-right corner.
 */
import useAppStore from '../stores/appStore';
import { X, Info, AlertTriangle, AlertCircle, CheckCircle } from 'lucide-react';

export default function Notifications() {
  const notifications = useAppStore(s => s.notifications);
  const dismissNotification = useAppStore(s => s.dismissNotification);

  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-8 right-4 z-50 flex flex-col gap-2 max-w-[450px]">
      {notifications.map(notif => {
        const Icon = notif.type === 'error' ? AlertCircle
          : notif.type === 'warning' ? AlertTriangle
          : notif.type === 'success' ? CheckCircle
          : Info;

        const borderColor = notif.type === 'error' ? 'border-vsc-error/40'
          : notif.type === 'warning' ? 'border-vsc-warning/40'
          : notif.type === 'success' ? 'border-vsc-success/40'
          : 'border-vsc-accent/40';

        const iconColor = notif.type === 'error' ? 'text-vsc-error'
          : notif.type === 'warning' ? 'text-vsc-warning'
          : notif.type === 'success' ? 'text-vsc-success'
          : 'text-vsc-info';

        return (
          <div
            key={notif.id}
            className={`notification-toast border ${borderColor}`}
          >
            <div className="flex items-start gap-2">
              <Icon size={16} className={`${iconColor} flex-shrink-0 mt-0.5`} />
              <div className="flex-1 min-w-0">
                {notif.title && (
                  <div className="text-vsc-sm font-medium text-vsc-text-bright mb-0.5">
                    {notif.title}
                  </div>
                )}
                <div className="text-vsc-sm text-vsc-text break-words">
                  {notif.message}
                </div>
                {notif.actions && notif.actions.length > 0 && (
                  <div className="flex gap-2 mt-2">
                    {notif.actions.map((action, idx) => (
                      <button
                        key={idx}
                        className="px-2 py-1 text-vsc-xs bg-vsc-button hover:bg-vsc-button-hover text-white rounded"
                        onClick={() => {
                          action.onClick?.();
                          dismissNotification(notif.id);
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="p-0.5 hover:bg-vsc-list-hover rounded flex-shrink-0"
                onClick={() => dismissNotification(notif.id)}
              >
                <X size={14} className="text-vsc-text-dim" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
