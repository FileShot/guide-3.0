#!/usr/bin/env node
/**
 * Rebuild native npm modules (node-pty, etc.) with -march=haswell for legacy installers.
 */
'use strict';

import { spawnSync } from 'child_process';
import { legacyCompileEnv } from './lib/legacy-cpu-env.mjs';

function log(msg) {
  console.log(`[rebuild-native-legacy] ${msg}`);
}

function run(cmd, args) {
  log(`${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: process.cwd(),
    env: legacyCompileEnv(),
    stdio: 'inherit',
    shell: false,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.platform !== 'linux') {
  log('skip node-pty rebuild on non-Linux (Haswell SIGILL target is Linux AppImage)');
} else {
  log('rebuilding node-pty from source with -march=haswell');
  run('npm', ['rebuild', 'node-pty', '--build-from-source']);
}

log('done');
