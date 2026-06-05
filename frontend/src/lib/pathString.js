/** Coerce file/project paths from strings, objects, or bad localStorage entries. */
export function pathString(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
  if (typeof entry === 'object') {
    for (const k of ['path', 'projectPath', 'relPath', 'name', 'fsPath']) {
      const v = entry[k];
      if (v != null && typeof v !== 'object') {
        const s = String(v).trim();
        if (s) return s;
      }
    }
    return '';
  }
  return String(entry);
}

export function fileBaseName(filePath) {
  const s = pathString(filePath);
  if (!s) return '';
  return s.replace(/\\/g, '/').split('/').filter(Boolean).pop() || s;
}
