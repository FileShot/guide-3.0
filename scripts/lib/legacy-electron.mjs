/**
 * Legacy Linux/Windows: oldest Chromium that runs on Haswell-class CPUs.
 * cli-spinners is patched in prepare-legacy-runtime (import attributes need Node 20+ unpatched).
 *
 * Electron → bundled Node (do not assume 18 for Electron 22):
 *   22.x → Node 16
 *   23–28 → Node 18
 *   30+ → Node 20+
 */

/** Prefer not to ship above this major without LEGACY_ALLOW_ELECTRON_FALLBACK=1 (SIGILL risk on i7-4xxx). */
export const LEGACY_ELECTRON_PREFER_MAX_MAJOR = 22;

/**
 * Oldest / safest first. Electron 22 (Chromium 108) is the usual last Haswell-safe line.
 * 30+ only if older candidates SIGILL under QEMU Haswell on real `electron --version`.
 */
export const LEGACY_ELECTRON_CANDIDATES = [
  '22.3.27',
  '30.5.1',
  '31.7.7',
  '32.3.3',
];

/** @param {string} electronVersion e.g. "22.3.27" */
export function minNodeMajorForElectron(electronVersion) {
  const em = parseInt(String(electronVersion).split('.')[0], 10);
  if (em <= 22) return 16;
  if (em <= 28) return 18;
  return 20;
}

/** @param {string} electronVersion */
export function electronMajor(electronVersion) {
  return parseInt(String(electronVersion).split('.')[0], 10);
}
