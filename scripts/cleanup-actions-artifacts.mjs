#!/usr/bin/env node
/**
 * Delete GitHub Actions artifacts older than N days (default 7)
 * Usage: node scripts/cleanup-actions-artifacts.mjs [--dry-run] [--days=7] [owner/repo]
 */
import { execSync } from 'child_process';

const dryRun = process.argv.includes('--dry-run');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
const repo = process.argv.find((a) => a.includes('/')) || 'FileShot/guide-3.0';

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

function fetchArtifacts() {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const raw = execSync(
      `gh api "repos/${repo}/actions/artifacts?per_page=100&page=${page}"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    const data = JSON.parse(raw);
    const batch = data.artifacts || data;
    if (!batch?.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const artifacts = fetchArtifacts();
const old = artifacts.filter((a) => new Date(a.created_at).getTime() < cutoff);

let mb = 0;
for (const a of old) mb += a.size_in_bytes / 1048576;

console.log(`Repo: ${repo}`);
console.log(`Artifacts total: ${artifacts.length}, older than ${days}d: ${old.length} (~${Math.round(mb)} MB)`);

let deleted = 0;
let failed = 0;

for (const a of old) {
  if (dryRun) {
    if (deleted < 5) console.log(`[dry-run] ${a.name} ${Math.round(a.size_in_bytes / 1048576)}MB`);
    deleted++;
    continue;
  }
  try {
    execSync(`gh api -X DELETE "repos/${repo}/actions/artifacts/${a.id}"`, { stdio: 'pipe' });
    deleted++;
    if (deleted % 25 === 0) console.log(`Deleted ${deleted}/${old.length}...`);
  } catch (e) {
    failed++;
  }
}

if (dryRun) console.log(`[dry-run] would delete ${old.length} artifacts`);
else console.log(`Deleted ${deleted}, failed ${failed}`);
