'use strict';

const fs = require('fs');
const path = require('path');
const { parseSkillMarkdown, formatSkillsHelp: formatSkillsHelpFrom, resolveFromSkills } = require('./parseSkillMd');

const BUILTIN_DIR = __dirname;

function loadSkillsFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  for (const name of names) {
    const skillPath = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const raw = fs.readFileSync(skillPath, 'utf8');
    const skill = parseSkillMarkdown(raw, name);
    if (skill.id) out.push(skill);
  }
  return out;
}

function loadSkills(extraDirs = []) {
  const byId = new Map();
  for (const skill of loadSkillsFromDir(BUILTIN_DIR)) byId.set(skill.id, skill);
  for (const dir of extraDirs) {
    for (const skill of loadSkillsFromDir(dir)) byId.set(skill.id, skill);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function listSkills(extraDirs) {
  return loadSkills(extraDirs).map(({ id, name, description }) => ({ id, name, description, kind: 'expand' }));
}

function resolveSlashSkill(rawInput, extraDirs) {
  return resolveFromSkills(rawInput, loadSkills(extraDirs));
}

function formatSkillsHelp(skills) {
  return formatSkillsHelpFrom(skills || loadSkills());
}

module.exports = {
  loadSkills,
  listSkills,
  formatSkillsHelp,
  resolveSlashSkill,
};
