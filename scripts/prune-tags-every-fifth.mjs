#!/usr/bin/env node
/**
 * Keep first tag + every 5th + last tag. Delete everything else (local + remote tags + GitHub releases).
 * Usage:
 *   node scripts/prune-tags-every-fifth.mjs          -- live run
 *   node scripts/prune-tags-every-fifth.mjs --dry-run -- preview only
 */
'use strict';

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  return r;
}

function ghJson(args) {
  const r = run('gh', args);
  if (r.status !== 0) {
    console.error('[gh error]', r.stderr || r.stdout);
    return [];
  }
  try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
}

// ── 1. Get all local tags sorted by version ───────────────────────────────────
const tagsRaw = run('git', ['tag', '--sort=version:refname']).stdout || '';
const allTags = tagsRaw.trim().split('\n').filter(Boolean);
console.log(`[prune] Total tags: ${allTags.length}`);

// ── 2. Compute keep set (index 0, 5, 10, ... and last) ───────────────────────
const keepSet = new Set();
for (let i = 0; i < allTags.length; i += 5) keepSet.add(allTags[i]);
keepSet.add(allTags[allTags.length - 1]); // always keep latest

const toDelete = allTags.filter(t => !keepSet.has(t));

console.log(`\n[prune] KEEPING (${keepSet.size}):`);
[...keepSet].forEach(t => console.log(`  + ${t}`));
console.log(`\n[prune] DELETING (${toDelete.length}):`);
toDelete.forEach(t => console.log(`  - ${t}`));

if (DRY) {
  console.log('\n[prune] DRY RUN — no changes made');
  process.exit(0);
}

// ── 3. Fetch all GitHub releases (to delete matching ones) ────────────────────
console.log('\n[prune] Fetching GitHub releases...');
const releases = [];
let page = 1;
for (;;) {
  const batch = ghJson(['api', `repos/FileShot/guide-3.0/releases?per_page=100&page=${page}`]);
  if (!batch.length) break;
  releases.push(...batch);
  if (batch.length < 100) break;
  page++;
}
const releaseTagSet = new Set(releases.map(r => r.tag_name));
console.log(`[prune] ${releases.length} GitHub releases found`);

// ── 4. Delete GitHub releases for tags being removed ──────────────────────────
let releasesDeleted = 0;
for (const tag of toDelete) {
  if (!releaseTagSet.has(tag)) continue;
  console.log(`[prune] Delete GitHub release: ${tag}`);
  const r = run('gh', ['release', 'delete', tag, '--yes']);
  if (r.status !== 0) console.error(`  ERROR: ${r.stderr}`);
  else releasesDeleted++;
}
console.log(`[prune] Deleted ${releasesDeleted} GitHub releases`);

// ── 5. Delete remote tags ─────────────────────────────────────────────────────
console.log('\n[prune] Deleting remote tags...');
let remoteDeleted = 0;
for (const tag of toDelete) {
  const r = run('git', ['push', 'origin', `:refs/tags/${tag}`]);
  if (r.status !== 0) {
    const msg = (r.stderr || '').trim();
    if (msg.includes('remote ref does not exist') || msg.includes('error: unable to delete')) {
      // already gone remotely — fine
    } else {
      console.error(`  WARN remote delete ${tag}: ${msg}`);
    }
  } else {
    remoteDeleted++;
  }
}
console.log(`[prune] Deleted ${remoteDeleted} remote tags`);

// ── 6. Delete local tags ──────────────────────────────────────────────────────
console.log('\n[prune] Deleting local tags...');
let localDeleted = 0;
for (const tag of toDelete) {
  const r = run('git', ['tag', '-d', tag]);
  if (r.status !== 0) console.error(`  WARN local delete ${tag}: ${r.stderr}`);
  else localDeleted++;
}
console.log(`[prune] Deleted ${localDeleted} local tags`);

console.log(`\n[prune] Done. Kept ${keepSet.size} tags, deleted ${toDelete.length}.`);
