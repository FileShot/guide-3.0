#!/usr/bin/env node
/**
 * Aggressive release cleanup after export-release-history.mjs
 * Deletes: all drafts, releases not in KEEP set
 * Usage: node scripts/cleanup-github-releases.mjs [--dry-run] [owner/repo]
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const dryRun = process.argv.includes('--dry-run');
const repo = process.argv.find((a) => a.includes('/')) || 'FileShot/guide-3.0';
const summaryPath = path.join(
  process.cwd(),
  'docs',
  `RELEASE_CLEANUP_${repo.split('/')[1]}.json`,
);

if (!fs.existsSync(summaryPath)) {
  console.error(`Missing ${summaryPath} — run export-release-history.mjs first`);
  process.exit(1);
}

const { keepTags, deleteCandidates } = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const keep = new Set(keepTags);

// Fetch fresh list with IDs (drafts need id for delete)
function fetchAllReleases() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const raw = execSync(
      `gh api "repos/${repo}/releases?per_page=100&page=${page}"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    const batch = JSON.parse(raw);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const releases = fetchAllReleases();
const toDelete = releases.filter((r) => r.draft || !keep.has(r.tag_name));

console.log(`Repo: ${repo}`);
console.log(`Keep tags (${keep.size}):`, [...keep].sort().join(', '));
console.log(`Delete ${toDelete.length} release entries (${releases.length} total)`);

let deleted = 0;
let failed = 0;

for (const r of toDelete) {
  const label = `${r.tag_name}${r.draft ? ' (draft)' : ''} id=${r.id}`;
  if (dryRun) {
    console.log(`[dry-run] would delete ${label}`);
    continue;
  }
  try {
    // gh release delete works by tag; drafts may need API
    if (r.draft) {
      execSync(`gh api -X DELETE "repos/${repo}/releases/${r.id}"`, { stdio: 'pipe' });
    } else {
      execSync(`gh release delete "${r.tag_name}" -R ${repo} --yes --cleanup-tag`, {
        stdio: 'pipe',
      });
    }
    console.log(`Deleted ${label}`);
    deleted++;
  } catch (e) {
    console.error(`Failed ${label}:`, e.stderr?.toString() || e.message);
    failed++;
  }
}

console.log(`Done: deleted=${deleted} failed=${failed} dryRun=${dryRun}`);
