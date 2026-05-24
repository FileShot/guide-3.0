#!/usr/bin/env node
/**
 * Packaged with legacy installers. CI runs under QEMU Haswell — same import path as /api/model/load.
 * Fails at import time on Node 18 (cli-spinners `import ... with` syntax).
 */
'use strict';

import path from 'path';
import { fileURLToPath } from 'url';
import { getLlama } from 'node-llama-cpp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));

console.log('[test-load-llama-legacy] node', process.versions.node, 'electron', process.versions.electron);

try {
  const llama = await getLlama('lastBuild', { gpu: false, logger: () => {} });
  console.log('[test-load-llama-legacy] getLlama ok', typeof llama);
} catch (e) {
  const msg = e?.message || String(e);
  if (/libcuda|nvidia|CUDA driver/i.test(msg)) {
    console.log('[test-load-llama-legacy] getLlama skipped (no GPU in CI):', msg);
    process.exit(0);
  }
  console.error('[test-load-llama-legacy] getLlama failed:', msg);
  process.exit(1);
}
