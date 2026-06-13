/**
 * Canonical dedup key for streaming file blocks — resolves relative paths against project root.
 * Kept in frontend bundle (mirrors tools/toolParser.js resolveStreamingFileKey).
 */
export function resolveStreamingFileKey(filePath, projectPath) {
  if (!filePath) return '';
  let p = String(filePath).trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!p) return '';
  const isAbsolute = /^[a-z]:\//i.test(p) || p.startsWith('/');
  if (!isAbsolute && projectPath) {
    const proj = String(projectPath).trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').replace(/\/+/g, '/');
    const projNorm = /^[a-z]:\//i.test(proj) ? proj.toLowerCase() : proj;
    p = `${projNorm}/${p.replace(/^\//, '')}`.replace(/\/+/g, '/');
  }
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
}
