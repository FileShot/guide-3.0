#!/usr/bin/env node
/**
 * node-llama-cpp@3.18.1 addon CMake still links target "common"; b9253 names it llama-common.
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CMAKE = path.join(ROOT, 'node_modules', 'node-llama-cpp', 'llama', 'CMakeLists.txt');

function log(msg) {
  console.log(`[patch-llama-cmake] ${msg}`);
}

if (!fs.existsSync(CMAKE)) {
  log(`skip — missing ${CMAKE}`);
  process.exit(0);
}

const src = fs.readFileSync(CMAKE, 'utf8');
if (!src.includes('project("llama-addon"')) {
  log('skip — not node-llama-cpp addon CMakeLists layout');
  process.exit(0);
}

let next = src;
if (next.includes('target_link_libraries(${PROJECT_NAME} "common")')) {
  next = next.replace(
    'target_link_libraries(${PROJECT_NAME} "common")',
    'target_link_libraries(${PROJECT_NAME} "llama-common")',
  );
  log('linked llama-addon against llama-common');
} else if (next.includes('target_link_libraries(${PROJECT_NAME} "llama-common")')) {
  log('already links llama-common');
} else {
  log('warn: expected target_link_libraries(common) not found');
}

if (next !== src) {
  fs.writeFileSync(CMAKE, next);
}
log('done');
