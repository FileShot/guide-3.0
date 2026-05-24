#!/usr/bin/env node
/** Export every GitHub release body to docs/RELEASE_HISTORY.md */
'use strict';

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'RELEASE_HISTORY.md');

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  return JSON.parse(r.stdout || '[]');
}

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

releases.sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));

const lines = [
  '# guIDE release history (archived)',
  '',
  `Exported: ${new Date().toISOString()}`,
  `Total releases: ${releases.length}`,
  '',
  'This file preserves notes from releases pruned from GitHub. Install artifacts use the latest release only.',
  '',
];

for (const rel of releases) {
  const tag = rel.tag_name || '(no tag)';
  lines.push('---', '', `## ${rel.name || tag} (\`${tag}\`)`, '');
  lines.push(`- **Published:** ${rel.published_at || rel.created_at || 'unknown'}`);
  lines.push(`- **Draft:** ${rel.draft ? 'yes' : 'no'}`);
  lines.push(`- **Prerelease:** ${rel.prerelease ? 'yes' : 'no'}`);
  if (rel.html_url) lines.push(`- **URL:** ${rel.html_url}`);
  lines.push('');
  const body = (rel.body || '').trim();
  lines.push(body || '*(no release notes body)*', '');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`[export-release-notes] wrote ${OUT} (${releases.length} releases)`);
