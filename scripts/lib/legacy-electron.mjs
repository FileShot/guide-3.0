/** Legacy: Haswell-safe Chromium + Node 18+ (cli-spinners patched for import attributes). */
export const LEGACY_ELECTRON_MIN_NODE_MAJOR = 18;

/**
 * Oldest / safest first. Electron 22 (Chromium 108) is the usual last Haswell-safe line.
 * 30+ only if QEMU Haswell passes real `electron --version` (not just ELECTRON_RUN_AS_NODE).
 */
export const LEGACY_ELECTRON_CANDIDATES = [
  '22.3.27',
  '30.5.1',
  '31.7.7',
  '32.3.3',
];
