#!/usr/bin/env node
/**
 * Prune GitHub releases and tags for guide-3.0, guide-2.0, guIDE.
 * Usage: node scripts/prune-all-guide-repos.mjs [--dry-run]
 */
'use strict';

import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const dryRun = process.argv.includes('--dry-run');

const CONFIG = [
  { repo: 'FileShot/guide-3.0', keepRelease: 'v0.4.9', keepTag: 'v0.4.9' },
  { repo: 'FileShot/guide-2.0', keepRelease: 'v2.3.14', keepTag: 'v2.3.14' },
  { repo: 'FileShot/guIDE', keepRelease: null, keepTag: 'v1.8.1' },
];

function ghApi(method, route, body) {
  const args = ['api', route];
  if (method === 'DELETE') args.unshift('-X', 'DELETE');
  if (body) args.push('-f', ...Object.entries(body).flat());
  const cmd = dryRun ? null : () => execSync(`gh ${args.join(' ')}`, { encoding: 'utf8', stdio: dryRun ? 'pipe' : 'inherit' });
  if (dryRun) {
    console.log(`[dry-run] gh ${args.join(' ')}`);
    return '';
  }
  return execSync(`gh ${args.join(' ')}`, { encoding: 'utf8' });
}

function ghJson(route) {
  if (dryRun) {
    console.log(`[dry-run] gh api "${route}"`);
    return [];
  }
  const raw = execSync(`gh api "${route}"`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(raw || '[]');
}

function fetchAllReleases(repo) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const batch = ghJson(`repos/${repo}/releases?per_page=100&page=${page}`);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function fetchAllTags(repo) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const batch = ghJson(`repos/${repo}/tags?per_page=100&page=${page}`);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function deleteRelease(repo, rel) {
  const label = `${rel.tag_name}${rel.draft ? ' (draft)' : ''}`;
  if (dryRun) {
    console.log(`[dry-run] delete release ${repo} ${label} id=${rel.id}`);
    return;
  }
  try {
    if (rel.draft) {
      execSync(`gh api -X DELETE "repos/${repo}/releases/${rel.id}"`, { stdio: 'pipe' });
    } else {
      execSync(`gh release delete "${rel.tag_name}" -R ${repo} --yes`, { stdio: 'pipe' });
    }
    console.log(`[prune] deleted release ${repo} ${label}`);
  } catch (e) {
    console.error(`[prune] FAILED release ${repo} ${label}:`, e.stderr?.toString() || e.message);
    throw e;
  }
}

function deleteTag(repo, tag) {
  if (dryRun) {
    console.log(`[dry-run] delete tag ${repo} ${tag}`);
    return;
  }
  const r = spawnSync('gh', ['api', '-X', 'DELETE', `repos/${repo}/git/refs/tags/${encodeURIComponent(tag)}`], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`[prune] FAILED tag ${repo} ${tag}:`, r.stderr);
    throw new Error(`tag delete failed: ${tag}`);
  }
  console.log(`[prune] deleted tag ${repo} ${tag}`);
}

function sleep(ms) {
  if (!dryRun) execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function pruneRepo({ repo, keepRelease, keepTag }) {
  console.log(`\n[prune] === ${repo} keep release=${keepRelease || '(none)'} tag=${keepTag} ===`);

  const releases = fetchAllReleases(repo);
  for (const rel of releases) {
    if (keepRelease && rel.tag_name === keepRelease && !rel.draft) continue;
    deleteRelease(repo, rel);
    sleep(300);
  }

  const tags = fetchAllTags(repo);
  for (const t of tags) {
    if (t.name === keepTag) continue;
    deleteTag(repo, t.name);
    sleep(200);
  }
}

for (const cfg of CONFIG) {
  pruneRepo(cfg);
}

console.log('\n[prune] all repos done' + (dryRun ? ' (dry-run)' : ''));
