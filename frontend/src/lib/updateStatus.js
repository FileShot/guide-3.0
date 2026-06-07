/** Normalize updater payloads from IPC push vs getStatus API. */
export function normalizeUpdateStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const updateInfo = payload.updateInfo || payload.info || null;
  let status = payload.status;
  if (status === 'up-to-date') status = 'idle';
  return {
    ...payload,
    status,
    updateInfo,
    progress: payload.progress || null,
    error: payload.error || null,
    available: payload.available !== false,
  };
}

export function installUpdateNow() {
  if (window.electronAPI?.updater?.install) {
    return window.electronAPI.updater.install();
  }
  return fetch('/api/updater/install', { method: 'POST' });
}

export function updateVersionLabel(status) {
  return status?.updateInfo?.version || status?.info?.version || '?';
}
