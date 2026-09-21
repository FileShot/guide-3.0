/**
 * Slash skills for the chat input — keep in sync with skills/registry.js (Node).
 */

const BUILTIN_SKILLS = [
  { id: 'skills', name: '/skills', description: 'List available slash skills', kind: 'local' },
  { id: 'goal', name: '/goal', description: 'Durable objective — keep building until done', kind: 'expand' },
  { id: 'automate', name: '/automate', description: 'Script/automate a workflow in this project', kind: 'expand' },
  { id: 'plan', name: '/plan', description: 'Planning-first turn', kind: 'expand' },
  { id: 'ask', name: '/ask', description: 'Answer without modifying files', kind: 'expand' },
];

function formatSkillsHelp() {
  const lines = ['Available skills (type in the chat box):', ''];
  for (const s of BUILTIN_SKILLS) {
    lines.push(`${s.name} — ${s.description}`);
  }
  lines.push('', 'Example: /goal build a catalog site with cart and checkout');
  return lines.join('\n');
}

function expandSkill(id, args) {
  const a = String(args || '').trim();
  if (id === 'goal') {
    if (!a) return { error: 'Usage: /goal <objective>' };
    return {
      text:
        `GOAL (do not stop at planning or promises — execute with tools until complete):\n${a}\n\n` +
        'Rules: call write_file/edit_file/run_command as needed; verify files exist; keep working until the goal is satisfied. ' +
        'Do not only say you will build — emit tool JSON now.',
    };
  }
  if (id === 'automate') {
    if (!a) return { error: 'Usage: /automate <what to automate>' };
    return {
      text:
        `AUTOMATE THIS WORKFLOW IN THE PROJECT:\n${a}\n\n` +
        'Create the scripts/config needed with write_file, wire them so they can run, and show how to run them.',
    };
  }
  if (id === 'plan') {
    return {
      text:
        `Plan first for: ${a || 'the current task'}\n\n` +
        'Write a concrete implementation plan (steps, files, risks). Prefer write_todos / .guide/plans when tools allow.',
      preferChatMode: 'plan',
    };
  }
  if (id === 'ask') {
    if (!a) return { error: 'Usage: /ask <question>' };
    return { text: a, preferChatMode: 'ask' };
  }
  return null;
}

export function listSlashSkills() {
  return BUILTIN_SKILLS.map(({ id, name, description, kind }) => ({ id, name, description, kind }));
}

export function matchSlashSkills(input) {
  const raw = String(input || '');
  if (!raw.startsWith('/')) return [];
  const q = raw.slice(1).toLowerCase();
  const token = q.split(/\s/)[0] || '';
  return BUILTIN_SKILLS.filter((s) => s.id.startsWith(token) || s.name.slice(1).startsWith(token));
}

/**
 * @returns {null | { sendToModel: boolean, text?: string, localText?: string, error?: string, preferChatMode?: string, skill: object }}
 */
export function resolveSlashSkill(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw.startsWith('/')) return null;
  const m = raw.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const id = m[1].toLowerCase();
  const args = (m[2] || '').trim();
  const skill = BUILTIN_SKILLS.find((s) => s.id === id);
  if (!skill) return null;

  if (skill.id === 'skills') {
    return { skill, localText: formatSkillsHelp(), sendToModel: false };
  }
  const out = expandSkill(id, args);
  if (!out) return null;
  if (out.error) return { skill, error: out.error, sendToModel: false };
  return {
    skill,
    text: out.text,
    preferChatMode: out.preferChatMode || null,
    sendToModel: true,
  };
}
