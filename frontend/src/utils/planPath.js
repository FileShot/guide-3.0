/** Client-side plan file path check (mirrors agentModeResolver.isPlanFilePath). */
export function isPlanFilePath(filePath) {
  return /\.guide[/\\]plans[/\\].+\.plan\.md$/i.test(
    String(filePath || '').replace(/\\/g, '/'),
  );
}

export function planPathsMatch(a, b) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}
