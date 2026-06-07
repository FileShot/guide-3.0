/** Desktop Electron file import helpers (drag-and-drop from OS explorer). */

export async function importFilesToPath(sources, destDir) {
  const r = await fetch('/api/files/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources, destDir }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Import failed (${r.status})`);
  return d;
}

export function extractDropPaths(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []);
  const paths = [];
  for (const f of files) {
    if (f.path) {
      paths.push(f.path);
    } else if (typeof window !== 'undefined' && window.electronAPI?.getPathForFile) {
      paths.push(window.electronAPI.getPathForFile(f));
    }
  }
  return paths.filter(Boolean);
}
