'use strict';
// CJS: avoids ESM import-attributes 'with' syntax in cli-spinners (node-llama-cpp dep).
// Directly loads the native .node addon so QEMU Haswell catches SIGILL if AVX-512 is present.
const path = require('path');
const fs = require('fs');

const appDir = path.resolve(__dirname, '..');
const localBuildsDir = path.join(
  appDir,
  'node_modules',
  'node-llama-cpp',
  'llama',
  'localBuilds',
);

if (!fs.existsSync(localBuildsDir)) {
  console.error('[test-load-llama-legacy] missing localBuilds:', localBuildsDir);
  process.exit(1);
}

let addonPath = null;
for (const d of fs.readdirSync(localBuildsDir)) {
  const candidate = path.join(localBuildsDir, d, 'Release', 'llama-addon.node');
  if (fs.existsSync(candidate)) { addonPath = candidate; break; }
}
if (!addonPath) {
  console.error('[test-load-llama-legacy] llama-addon.node not found under', localBuildsDir);
  process.exit(1);
}

try {
  const addon = require(addonPath);
  const keys = Object.keys(addon).slice(0, 5).join(', ');
  console.log('[test-load-llama-legacy] ok —', path.relative(appDir, addonPath), '| exports:', keys);
} catch (e) {
  console.error('[test-load-llama-legacy] load failed:', e.message);
  process.exit(1);
}
