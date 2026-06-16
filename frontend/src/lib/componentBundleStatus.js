/** Normalize optional-component bundle payloads from IPC push vs getStatus API. */
export function normalizeComponentBundleStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const phase = payload.phase || 'idle';
  return {
    phase,
    label: payload.label || 'Optional components',
    percent: typeof payload.percent === 'number' ? payload.percent : 0,
    currentComponent: payload.currentComponent || null,
    currentComponentLabel: payload.currentComponentLabel || null,
    needsRestart: !!payload.needsRestart,
    error: payload.error || null,
    bytesDone: payload.bytesDone || 0,
    bytesTotal: payload.bytesTotal || 0,
  };
}

export function componentBundleLabel(status) {
  if (!status) return '';
  if (status.phase === 'downloading') {
    const part = status.currentComponentLabel || status.label || 'components';
    return `Optional components… ${Math.round(status.percent || 0)}% (${part})`;
  }
  if (status.phase === 'done') return 'Optional components ready';
  if (status.phase === 'error') return 'Optional download failed — click to retry';
  if (status.needsRestart) return 'Restart to finish setup';
  return status.label || '';
}

export function retryComponentBundle() {
  if (window.electronAPI?.componentBundle?.retry) {
    return window.electronAPI.componentBundle.retry();
  }
  return Promise.resolve(null);
}
