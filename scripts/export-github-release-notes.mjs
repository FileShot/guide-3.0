#!/usr/bin/env node
/**
 * Export all GitHub release notes from guide-3.0, guide-2.0, and guIDE.
 * Usage: node scripts/export-github-release-notes.mjs
 */
'use strict';

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

const REPOS = [
  { repo: 'FileShot/guide-3.0', mdFile: 'RELEASE_HISTORY.md', title: 'guIDE 3.0 (guide-3.0)' },
  { repo: 'FileShot/guide-2.0', mdFile: 'RELEASE_HISTORY_guide-2.0.md', title: 'guIDE 2.0 (guide-2.0)' },
  { repo: 'FileShot/guIDE', mdFile: 'RELEASE_HISTORY_guIDE.md', title: 'guIDE original (guIDE)' },
];

function ghApi(route) {
  return execSync(`gh api "${route}"`, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

function fetchAllReleases(repo) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const batch = JSON.parse(ghApi(`repos/${repo}/releases?per_page=100&page=${page}`));
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function fetchAllTags(repo) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const batch = JSON.parse(ghApi(`repos/${repo}/tags?per_page=100&page=${page}`));
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function formatReleaseSection(r) {
  const lines = [];
  const tag = r.tag_name || '(no tag)';
  lines.push(`## ${r.name || tag} (\`${tag}\`)`, '');
  lines.push(`- **Published:** ${r.published_at || r.created_at || 'unknown'}`);
  lines.push(`- **Draft:** ${r.draft ? 'yes' : 'no'}`);
  lines.push(`- **Prerelease:** ${r.prerelease ? 'yes' : 'no'}`);
  if (r.html_url) lines.push(`- **URL:** ${r.html_url}`);
  if (r.assets?.length) {
    lines.push('- **Assets:**');
    for (const a of r.assets) {
      lines.push(`  - ${a.name} (${a.size} bytes) — ${a.browser_download_url}`);
    }
  }
  lines.push('');
  const body = (r.body || '').trim();
  lines.push(body || '*(no release notes body)*', '');
  return lines.join('\n');
}

function writeMarkdown({ repo, mdFile, title }, releases, tags) {
  const sorted = [...releases].sort(
    (a, b) => new Date(a.published_at || a.created_at) - new Date(b.published_at || b.created_at),
  );

  const lines = [
    `# Release history — ${title}`,
    '',
    `- **Repository:** https://github.com/${repo}`,
    `- **Exported:** ${new Date().toISOString()}`,
    `- **Release entries:** ${releases.length} (includes drafts)`,
    `- **Tags on repo:** ${tags.length}`,
    '',
    'This file preserves notes from releases pruned from GitHub. Install artifacts use the latest release only per repo cleanup policy.',
    '',
    '---',
    '',
  ];

  for (const r of sorted) {
    lines.push(formatReleaseSection(r), '---', '');
  }

  // guIDE v1.8.1: tag exists but may have no GitHub Release object
  if (repo === 'FileShot/guIDE' && !releases.some((r) => r.tag_name === 'v1.8.1')) {
    const tag181 = tags.find((t) => t.name === 'v1.8.1');
    lines.push('## guIDE v1.8.1 (`v1.8.1`) — tag only (no release object at export time)', '');
    lines.push('- **Published:** unknown (tag preserved; release recreated after prune)');
    if (tag181?.commit?.sha) {
      lines.push(`- **Commit:** https://github.com/${repo}/commit/${tag181.commit.sha}`);
    }
    lines.push('- **URL:** https://github.com/FileShot/guIDE/releases/tag/v1.8.1 *(after recreate)*');
    lines.push('');
    lines.push('*(First release in v1.8.x tag series — kept as archival anchor.)*', '');
    lines.push('---', '');
  }

  const outPath = path.join(DOCS, mdFile);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`[export] ${outPath} (${releases.length} releases)`);
  return { repo, mdFile, releases: sorted, tags };
}

function main() {
  const archive = { exportedAt: new Date().toISOString(), repos: [] };

  for (const cfg of REPOS) {
    const releases = fetchAllReleases(cfg.repo);
    const tags = fetchAllTags(cfg.repo);
    const result = writeMarkdown(cfg, releases, tags);
    archive.repos.push({
      repo: cfg.repo,
      releaseCount: releases.length,
      tagCount: tags.length,
      releases: releases.map((r) => ({
        id: r.id,
        tag_name: r.tag_name,
        name: r.name,
        published_at: r.published_at,
        created_at: r.created_at,
        draft: r.draft,
        prerelease: r.prerelease,
        html_url: r.html_url,
        body: r.body || '',
        assets: (r.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          browser_download_url: a.browser_download_url,
        })),
      })),
      tags: tags.map((t) => ({ name: t.name, sha: t.commit?.sha })),
    });
  }

  const jsonPath = path.join(DOCS, 'releases-archive.json');
  fs.writeFileSync(jsonPath, JSON.stringify(archive, null, 2), 'utf8');
  console.log(`[export] ${jsonPath}`);
}

main();
