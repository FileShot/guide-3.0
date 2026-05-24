#!/usr/bin/env node
/**
 * Delete all GitHub releases and remote tags except KEEP_TAG (default: latest published release).
 * Usage: node scripts/prune-github-releases.mjs [--keep v0.3.132] [--dry-run]
 */
'use strict';

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gh(args, dryRun) {
  const cmd = ['gh', ...args];
  if (dryRun) {
    console.log('[dry-run]', cmd.join(' '));
    return { status: 0, stdout: '', stderr: '' };
  }
  return spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT });
}

function ghJson(args) {
  const r = gh(args, false);
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  return JSON.parse(r.stdout || '[]');
}

const dryRun = process.argv.includes('--dry-run');
const keepIdx = process.argv.indexOf('--keep');
let keepTag = keepIdx !== -1 ? process.argv[keepIdx + 1] : null;

if (!keepTag) {
  const latest = ghJson(['release', 'view', '--json', 'tagName', '-q', '.tagName']);
  keepTag = latest;
}

console.log(`[prune-releases] keeping tag: ${keepTag}`);

const releases = [];
let page = 1;
for (;;) {
  const batch = ghJson([
    'api',
    `repos/FileShot/guide-3.0/releases?per_page=100&page=${page}`,
  ]);
  if (!batch.length) break;
  releases.push(...batch);
  if (batch.length < 100) break;
  page++;
}

for (const rel of releases) {
  const tag = rel.tag_name;
  if (!tag || tag === keepTag) continue;
  console.log(`[prune-releases] delete release ${tag}`);
  const r = gh(['release', 'delete', tag, '--yes'], dryRun);
  if (!dryRun && r.status !== 0) {
    console.error(`failed delete release ${tag}:`, r.stderr);
    process.exit(1);
  }
}

const tags = spawnSync('git', ['tag', '-l'], { encoding: 'utf8', cwd: ROOT });
if (tags.status !== 0) process.exit(1);
const allTags = (tags.stdout || '').trim().split('\n').filter(Boolean);

for (const tag of allTags) {
  if (tag === keepTag) continue;
  console.log(`[prune-releases] delete remote tag ${tag}`);
  const r = dryRun
    ? { status: 0 }
    : spawnSync('git', ['push', 'origin', `:refs/tags/${tag}`], { encoding: 'utf8', cwd: ROOT });
  if (!dryRun && r.status !== 0) {
    console.error(`failed delete tag ${tag}:`, r.stderr);
  }
}

console.log('[prune-releases] done');
