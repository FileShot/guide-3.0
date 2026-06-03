/** Pocket cloud IDE file upload/download helpers */

export function downloadFileUrl(filePath) {
  return `/api/files/download?path=${encodeURIComponent(filePath)}`;
}

export function downloadFolderZipUrl(dirPath) {
  return `/api/files/download-all?path=${encodeURIComponent(dirPath)}`;
}

export function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function uploadFilesToPath(files, destPath) {
  const fd = new FormData();
  fd.append('path', destPath);
  for (const f of files) fd.append('files', f);
  const r = await fetch('/api/files/upload', { method: 'POST', credentials: 'include', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
  return d;
}