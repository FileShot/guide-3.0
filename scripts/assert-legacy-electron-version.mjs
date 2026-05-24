#!/usr/bin/env node
/** Fail CI if fetch-legacy-electron selected newer Chromium than Haswell legacy allows. */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  LEGACY_ELECTRON_PREFER_MAX_MAJOR,
  electronMajor,
} from './lib/legacy-electron.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'build', 'legacy-electron-version.txt');

if (!fs.existsSync(file)) {
  console.error('[assert-legacy-electron] missing build/legacy-electron-version.txt');
  process.exit(1);
}

const version = fs.readFileSync(file, 'utf8').trim();
const major = electronMajor(version);
const allow = process.env.LEGACY_ALLOW_ELECTRON_FALLBACK === '1';

console.log(`[assert-legacy-electron] selected Electron ${version} (major ${major})`);

if (major > LEGACY_ELECTRON_PREFER_MAX_MAJOR && !allow) {
  console.error(
    `[assert-legacy-electron] FAIL: Electron ${version} is too new for Haswell legacy (max major ${LEGACY_ELECTRON_PREFER_MAX_MAJOR}).`,
  );
  console.error(
    '[assert-legacy-electron] This blocks repeats of v0.3.128 (22 passed QEMU, rejected for Node<18, shipped 30).',
  );
  process.exit(1);
}

console.log('[assert-legacy-electron] OK');
