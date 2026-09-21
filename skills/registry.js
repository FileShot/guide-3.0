'use strict';

/**
 * guIDE slash skills — typing /skill in chat expands to a prompt or local action.
 * Keep this list small and explicit; project skills can live under .guide/skills/*.md later.
 */

const BUILTIN_SKILLS = [
  {
    id: 'skills',
    name: '/skills',
    description: 'List available slash skills',
    kind: 'local',
  },
  {
    id: 'goal',
    name: '/goal',
    description: 'Treat the rest of the message as a durable objective until done',
    kind: 'expand',
    expand: (args) => {
      const objective = String(args || '').trim();
      if (!objective) {
        return {
          error: 'Usage: /goal <objective> — example: /goal build a full auto parts store with HTML CSS JS',
        };
      }
      return {
        text:
          `GOAL (do not stop at planning or promises — execute with tools until complete):\n${objective}\n\n` +
          'Rules: call write_file/edit_file/run_command as needed; verify files exist; keep working across turns until the goal is satisfied. ' +
          'Do not only say you will build — emit tool JSON now.',
      };
    },
  },
  {
    id: 'automate',
    name: '/automate',
    description: 'Ask the agent to script/automate a workflow in this project',
    kind: 'expand',
    expand: (args) => {
      const task = String(args || '').trim();
      if (!task) {
        return {
          error: 'Usage: /automate <what to automate> — example: /automate scrape product prices into a CSV nightly script',
        };
      }
      return {
        text:
          `AUTOMATE THIS WORKFLOW IN THE PROJECT:\n${task}\n\n` +
          'Create the scripts/config needed with write_file, wire them so they can run (package.json scripts, .bat/.sh, or documented commands), ' +
          'and show how to run them. Prefer simple, maintainable automation over heavy frameworks.',
      };
    },
  },
  {
    id: 'plan',
    name: '/plan',
    description: 'Switch this turn into a planning-first request',
    kind: 'expand',
    expand: (args) => {
      const topic = String(args || '').trim() || 'the current task';
      return {
        text:
          `Plan first for: ${topic}\n\n` +
          'Write a concrete implementation plan (steps, files to create/change, risks). Prefer write_todos / a plan file under .guide/plans/ when tools allow. Do not start building until the plan is clear unless I already approved build.',
        preferChatMode: 'plan',
      };
    },
  },
  {
    id: 'ask',
    name: '/ask',
    description: 'Answer without modifying files this turn',
    kind: 'expand',
    expand: (args) => {
      const q = String(args || '').trim();
      if (!q) return { error: 'Usage: /ask <question>' };
      return {
        text: q,
        preferChatMode: 'ask',
      };
    },
  },
];

function listSkills() {
  return BUILTIN_SKILLS.map(({ id, name, description, kind }) => ({ id, name, description, kind }));
}

function formatSkillsHelp() {
  const lines = ['Available skills (type in the chat box):', ''];
  for (const s of BUILTIN_SKILLS) {
    lines.push(`${s.name} — ${s.description}`);
  }
  lines.push('', 'Example: /goal build a catalog site with cart and checkout');
  return lines.join('\n');
}

/**
 * Parse leading /skill rest-of-line. Returns null if not a skill command.
 */
function resolveSlashSkill(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw.startsWith('/')) return null;
  const m = raw.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const id = m[1].toLowerCase();
  const args = (m[2] || '').trim();
  const skill = BUILTIN_SKILLS.find((s) => s.id === id || s.name.slice(1) === id);
  if (!skill) return null;

  if (skill.kind === 'local' && skill.id === 'skills') {
    return { skill, localText: formatSkillsHelp(), sendToModel: false };
  }
  if (typeof skill.expand === 'function') {
    const out = skill.expand(args);
    if (out.error) return { skill, error: out.error, sendToModel: false };
    return {
      skill,
      text: out.text,
      preferChatMode: out.preferChatMode || null,
      sendToModel: true,
    };
  }
  return null;
}

module.exports = {
  BUILTIN_SKILLS,
  listSkills,
  formatSkillsHelp,
  resolveSlashSkill,
};
