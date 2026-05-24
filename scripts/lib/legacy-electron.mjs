/** Legacy Electron policy: Node 20+ (ESM import attributes), but not v34+ (Haswell SIGILL). */
export const LEGACY_ELECTRON_MIN_NODE_MAJOR = 20;

/** Newest-first; must pass QEMU Haswell in fetch-legacy-electron.mjs. */
export const LEGACY_ELECTRON_CANDIDATES = [
  '33.4.11',
  '32.3.3',
  '31.7.7',
  '30.5.1',
];
