#!/usr/bin/env node
/**
 * Phase 0: Export all GitHub release notes to docs/RELEASE_HISTORY.md
 * Usage: node scripts/export-release-history.mjs [owner/repo]
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const repo = process.argv[2] || 'FileShot/guide-3.0';
const outDir = path.join(process.cwd(), 'docs');
const outFile = path.join(outDir, `RELEASE_HISTORY_${repo.split('/')[1]}.md`);

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
releases.sort(
  (a, b) =>
    new Date(a.published_at || a.created_at) - new Date(b.published_at || b.created_at),
);

const lines = [
  `# Release history — ${repo}`,
  '',
  `Exported: ${new Date().toISOString()}`,
  `Total release entries: ${releases.length} (includes duplicate drafts)`,
  '',
  '---',
  '',
];

for (const r of releases) {
  const when = r.published_at || r.created_at || 'unknown';
  lines.push(`## ${r.name || r.tag_name} (\`${r.tag_name}\`)`);
  lines.push('');
  lines.push(`- **Published:** ${when}`);
  lines.push(`- **Draft:** ${r.draft ? 'yes' : 'no'}`);
  lines.push(`- **Prerelease:** ${r.prerelease ? 'yes' : 'no'}`);
  lines.push(`- **URL:** ${r.html_url || 'n/a'}`);
  lines.push('');
  if (r.body && r.body.trim()) {
    lines.push(r.body.trim());
  } else {
    lines.push('*(no release notes body)*');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log(`Wrote ${releases.length} releases to ${outFile}`);

// Summary for cleanup script
const published = releases.filter((r) => !r.draft);
const first = published[0];
const cutoff = new Date('2026-05-15T00:00:00Z');
const keep7 = new Set(
  published
    .filter((r) => new Date(r.published_at || r.created_at) >= cutoff)
    .map((r) => r.tag_name),
);

// guide-3.0: first v3.0.x release + last 7 days (aggressive keep)
if (repo.includes('guide-3.0')) {
  const firstGuide30 =
    published.find((r) => r.tag_name === 'v3.0.0') ||
    published.find((r) => /^v3\.0\./.test(r.tag_name));
  if (firstGuide30) keep7.add(firstGuide30.tag_name);
  // Always keep current latest tag if present
  const latest = published[published.length - 1];
  if (latest) keep7.add(latest.tag_name);
}

// Original guIDE repo: latest published only
if (repo.endsWith('/guIDE')) {
  keep7.clear();
  const latest = published[published.length - 1];
  if (latest) keep7.add(latest.tag_name);
}

const summary = {
  repo,
  firstTag: first?.tag_name,
  keepTags: [...keep7].sort(),
  deleteCandidates: releases
    .filter((r) => !keep7.has(r.tag_name) || r.draft)
    .map((r) => ({ id: r.id, tag: r.tag_name, draft: r.draft, name: r.name })),
};
const summaryPath = path.join(outDir, `RELEASE_CLEANUP_${repo.split('/')[1]}.json`);
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(`Wrote cleanup summary to ${summaryPath}`);
console.log(`Keep tags (${summary.keepTags.length}):`, summary.keepTags.join(', '));
