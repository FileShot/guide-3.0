/** Custom Electron protocol URL for streaming workspace media files. */
export function guideMediaUrl(filePath) {
  if (!filePath) return '';
  return `guide-media://media/?path=${encodeURIComponent(filePath)}`;
}

export function resolveMediaSrc(filePath, dataUrl) {
  if (dataUrl) return dataUrl;
  const s = String(filePath || '');
  if (s.startsWith('blob:') || s.startsWith('data:') || s.startsWith('guide-media:')) return s;
  if (typeof window !== 'undefined' && window.electronAPI) {
    return guideMediaUrl(filePath);
  }
  return `file:///${s.replace(/\\/g, '/')}`;
}
