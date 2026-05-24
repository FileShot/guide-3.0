#!/usr/bin/env node
/** Print paths that should be removed from the public repo (stdout, one per line). */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KEEP_DOCS = new Set([
  path.join(ROOT, 'docs', 'RELEASE_HISTORY.md'),
  path.join(ROOT, 'docs', 'RELEASE_HISTORY_guide-3.0.md'),
  path.join(ROOT, 'docs', 'GEMMA4_BUILD_POLICY.md'),
]);

const ROOT_MD_BLOCK = [
  /^412-report\.md$/i,
  /^413-report\.md$/i,
  /^516-plan\.md$/i,
  /^ALL_FAILURES\.md$/i,
  /^PAST_FAILURES\.md$/i,
  /^BUGFIX_PLAN\.md$/i,
  /^bug-report-/i,
  /^BUG_/i,
  /^LOG_AUDIT_/i,
  /^IMPLEMENTATION_PLAN_/i,
  /^FINAL_IMPLEMENTATION_PLAN_/i,
  /^INVESTIGATION_/i,
  /^PRODUCTION_/i,
  /^PHASE_B_/i,
  /^GLM_/i,
  /^USER_REPORTED_/i,
  /^USER_FEEDBACK_/i,
  /^REGRESSION_/i,
  /^V0\.3\./i,
  /^CODEBASE_FULL_AUDIT_/i,
  /^GUIDE_MAIN_LOG_/i,
  /^CONTEXT_RESEARCH\.md$/i,
  /^TOOL_SCHEMA_AUDIT\.md$/i,
  /^PROPOSED_SLIM_SYSTEM_PROMPT\.md$/i,
  /^CHANGES_LOG\.md$/i,
  /^VISION\.md$/i,
  /^RULES\.md$/i,
  /^server-vs-electron/i,
  /^pipeline-parity-/i,
  /^I'm so ashamed/i,
];

function shouldDropRootFile(name) {
  if (!name.endsWith('.md')) return false;
  return ROOT_MD_BLOCK.some((re) => re.test(name));
}

const out = [];

for (const name of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, name);
  if (!fs.statSync(full).isFile()) continue;
  if (/\.(png|jpg|gif|webp)$/i.test(name)) out.push(full);
  if (shouldDropRootFile(name)) out.push(full);
  if (/\.(log|txt)$/i.test(name) && !name.endsWith('.md')) {
    if (/^(linux-|mac-|log-|temp|tmp|session|build-output|probe|test-console|pipeline-html)/i.test(name)) {
      out.push(full);
    }
  }
  if (/^(_releases|_r[12]|_audit)/i.test(name)) out.push(full);
  if (/^Qwen.*\.gguf$/i.test(name)) out.push(full);
  if (/^\.(bash|profile|wget)/i.test(name)) out.push(full);
  if (/^NTUSER|^ntuser/i.test(name)) out.push(full);
}

const guide3 = path.join(ROOT, 'guide3');
if (fs.existsSync(guide3)) out.push(guide3);

for (const p of out) {
  if (KEEP_DOCS.has(path.resolve(p))) continue;
  console.log(path.relative(ROOT, p));
}
