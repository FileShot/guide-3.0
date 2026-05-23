#!/usr/bin/env node
/**
 * Packaged with legacy installers; CI runs under QEMU Haswell via legacy electron + ELECTRON_RUN_AS_NODE.
 */
'use strict';

import path from 'path';
import { fileURLToPath } from 'url';
import { getLlama } from 'node-llama-cpp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(__dirname, '..'));

const llama = await getLlama({ gpu: false, logger: () => {} });
console.log('[test-load-llama-legacy] getLlama ok', typeof llama);
