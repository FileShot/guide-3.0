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

const modules = ['node-pty'];

for (const mod of modules) {
  log(`rebuilding ${mod} from source`);
  run('npm', ['rebuild', mod, '--build-from-source']);
}

log('done');
