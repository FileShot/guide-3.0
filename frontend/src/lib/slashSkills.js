/**
 * Slash skills — procedures live in skills/<id>/SKILL.md.
 * Parser matches skills/parseSkillMd.js (that file is CommonJS for the main process).
 */
function parseSkillMarkdown(raw, fallbackId) {
  const text = String(raw || '');
  let body = text.trim();
  const meta = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (m) {
    body = m[2].trim();
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const id = String(meta.name || fallbackId || '').replace(/^\//, '').toLowerCase();
  return {
    id,
    name: `/${id}`,
    description: meta.description || id,
    mode: meta.mode || null,
    requires: meta.requires || null,
    body,
  };
}

function resolveFromSkills(rawInput, skills) {
  const raw = String(rawInput || '').trim();
  if (!raw.startsWith('/')) return null;
  const matched = raw.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!matched) return null;
  const id = matched[1].toLowerCase();
  const args = (matched[2] || '').trim();
  const list = Array.isArray(skills) ? skills : [];
  if (id === 'skills') {
    const lines = ['Available skills (type in the chat box):', ''];
    for (const s of list) lines.push(`${s.name} — ${s.description}`);
    return {
      skill: { id: 'skills', name: '/skills', description: 'List available slash skills' },
      localText: lines.join('\n'),
      sendToModel: false,
    };
  }
  const skill = list.find((s) => s.id === id);
  if (!skill) return null;
  if (skill.requires === 'args' && !args) {
    return { skill, error: `Usage: /${id} <argument>`, sendToModel: false };
  }
  const text = `${skill.body}\n\nArgument:\n${args || '(none)'}\n\nFollow the skill above. Use tools. Do not stop at a promise.`;
  const out = {
    skill: { id: skill.id, name: skill.name, description: skill.description, kind: 'expand' },
    text,
    sendToModel: true,
    preferChatMode: skill.mode || null,
  };
  if (id === 'goal') out.goal = { objective: args };
  return out;
}

const skillFiles = import.meta.glob('../../../skills/*/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function loadBundledSkills() {
  const skills = [];
  for (const [file, raw] of Object.entries(skillFiles)) {
    const parts = file.split(/[/\\]/);
    const id = parts[parts.length - 2];
    const skill = parseSkillMarkdown(raw, id);
    if (skill.id && skill.id !== 'skills') skills.push(skill);
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

const BUNDLED = loadBundledSkills();

export function listSlashSkills() {
  return BUNDLED.map(({ id, name, description }) => ({ id, name, description, kind: 'expand' }));
}

export function matchSlashSkills(input) {
  const raw = String(input || '');
  if (!raw.startsWith('/')) return [];
  const token = raw.slice(1).toLowerCase().split(/\s/)[0] || '';
  const all = [
    { id: 'skills', name: '/skills', description: 'List available slash skills' },
    ...BUNDLED,
  ];
  return all.filter((s) => s.id.startsWith(token) || s.name.slice(1).startsWith(token));
}

export function resolveSlashSkill(rawInput) {
  return resolveFromSkills(rawInput, BUNDLED);
}
