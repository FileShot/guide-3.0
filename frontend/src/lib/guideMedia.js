/** Custom Electron protocol URL for streaming workspace media files. */
export function guideMediaUrl(filePath) {
  if (!filePath) return '';
  return `guide-media://media/?path=${encodeURIComponent(filePath)}`;
}

export function resolveMediaSrc(filePath, dataUrl) {
  const s = String(filePath || '');
  if (dataUrl && (dataUrl.startsWith('guide-media:') || dataUrl.startsWith('blob:') || dataUrl.startsWith('data:'))) {
    return dataUrl;
  }
  if (s && (s.startsWith('guide-media:') || s.startsWith('blob:') || s.startsWith('data:'))) return s;
  if (typeof window !== 'undefined' && window.electronAPI && (filePath || !dataUrl)) {
    return guideMediaUrl(filePath);
  }
  if (dataUrl) return dataUrl;
  return `file:///${s.replace(/\\/g, '/')}`;
}
