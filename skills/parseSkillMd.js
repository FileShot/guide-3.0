'use strict';

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

function formatSkillsHelp(skills) {
  const lines = ['Available skills (type in the chat box):', ''];
  for (const s of skills) lines.push(`${s.name} — ${s.description}`);
  lines.push('', 'Example: /goal build a catalog site with cart and checkout');
  return lines.join('\n');
}

function resolveFromSkills(rawInput, skills) {
  const raw = String(rawInput || '').trim();
  if (!raw.startsWith('/')) return null;
  const m = raw.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const id = m[1].toLowerCase();
  const args = (m[2] || '').trim();
  const list = Array.isArray(skills) ? skills : [];

  if (id === 'skills') {
    return {
      skill: { id: 'skills', name: '/skills', description: 'List available slash skills' },
      localText: formatSkillsHelp(list),
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

module.exports = {
  parseSkillMarkdown,
  formatSkillsHelp,
  resolveFromSkills,
};
