'use strict';

const path = require('path');

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'read_file', 'list_directory', 'grep_search', 'find_files', 'get_file_info',
  'search_in_file', 'search_codebase', 'git_status', 'git_diff', 'git_log',
  'write_file', 'edit_file', 'create_directory', 'ask_question', 'write_todos', 'update_todo',
]);

const PLAN_FILE_PATH_RE = /\.guide[/\\]plans[/\\].+\.plan\.md$/i;
const PLAN_PLANS_DIR_RE = /\.guide[/\\]plans\/?$/i;

function normalizePathSlashes(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function isPlanFilePath(filePath) {
  return PLAN_FILE_PATH_RE.test(normalizePathSlashes(filePath));
}

function isPlansDirectoryPath(dirPath) {
  return PLAN_PLANS_DIR_RE.test(normalizePathSlashes(dirPath).replace(/\/+$/, ''));
}

/** Plan workflow phase — artifact/state based, not user-message heuristics. */
function resolvePlanPhase(options = {}) {
  const {
    planMode = false,
    agentPhase = 'planning',
    planReady = false,
    planFileExists = false,
  } = options;
  if (!planMode) return null;
  if (agentPhase === 'building') return 'building';
  if (planReady || planFileExists) return 'plan_ready';
  return 'awaiting_plan';
}

function filterPlanModeToolCalls(calls) {
  if (!calls?.length) return { calls: [], blocked: [] };
  const kept = [];
  const blocked = [];
  for (const c of calls) {
    if (!PLAN_MODE_ALLOWED_TOOLS.has(c.tool)) {
      blocked.push(c);
      continue;
    }
    if (c.tool === 'write_file') {
      const fp = String(c.params?.filePath || c.params?.path || '');
      if (!isPlanFilePath(fp)) {
        blocked.push(c);
        continue;
      }
    }
    if (c.tool === 'edit_file') {
      const fp = String(c.params?.filePath || c.params?.path || '');
      if (!isPlanFilePath(fp)) {
        blocked.push(c);
        continue;
      }
    }
    if (c.tool === 'create_directory') {
      const dp = String(c.params?.path || c.params?.directory || c.params?.dir || '');
      if (!isPlansDirectoryPath(dp)) {
        blocked.push(c);
        continue;
      }
    }
    if (c.tool === 'update_todo') {
      const status = String(c.params?.status || '').toLowerCase().replace(/_/g, '-');
      if (status === 'done' || status === 'in-progress' || status === 'completed') {
        blocked.push(c);
        continue;
      }
    }
    kept.push(c);
  }
  return { calls: kept, blocked };
}

function filterToolDefinitions(allDefs, allowedTools) {
  if (!allowedTools) return allDefs;
  if (allowedTools.size === 0) return [];
  return allDefs.filter((d) => allowedTools.has(d.name));
}

function getAskModePromptAddition() {
  return '\n\n## ASK MODE ACTIVE\nYou are in Q&A mode. Answer the user\'s question directly in text. Do NOT call any tools or make any file or system changes.';
}

function getPlanModePromptAddition(planPhase = 'awaiting_plan') {
  let prompt = '\n\n## PLAN MODE ACTIVE\n'
    + 'You are in **Plan mode** — planning only, not implementing. The user will click **Build** (or Ctrl+Enter) to implement later.\n'
    + '**web_search** and other implementation tools are NOT available in Plan mode. For live external data, answer from knowledge or suggest Ask mode.\n\n';

  if (planPhase === 'awaiting_plan') {
    prompt += '### Tier A — Conversational (no plan artifact)\n'
      + 'For greetings, small talk, or general questions unrelated to building something (e.g. "how are you", "what is X", "what\'s today\'s news?"): '
      + 'respond in **prose only**. Do NOT call tools. Do NOT write a plan file.\n\n'
      + '### Tier B — Build / plan requests (any wording, vague or detailed)\n'
      + 'When the user wants something built or designed (e.g. "make me a website", a product spec): '
      + 'you are creating an **implementation plan**, not building yet.\n'
      + '- Optionally explore with read/list/search/git tools.\n'
      + '- Create `.guide/plans` with create_directory if needed.\n'
      + '- Write ONE plan to `.guide/plans/{descriptive-slug}.plan.md` using write_file (YAML frontmatter: `title`, optional `overview` only — no todos in the file).\n'
      + '- Call **write_todos** with the implementation checklist.\n'
      + '- STOP after plan file + write_todos. Do NOT create app directories, source files, run commands, or install packages.\n'
      + '- If the request is vague, ask 1–2 clarifying questions in prose or use ask_question before or while planning.\n\n';
  } else {
    prompt += '### Tier C — Plan ready\n'
      + 'A plan already exists on disk. Answer questions in prose.\n'
      + 'To revise the plan: edit_file or write_file on `.guide/plans/*.plan.md` only.\n'
      + 'To change todo text: update_todo with todo `id` and new `text` (e.g. id 2 for Phase 2). To replace the full checklist: write_todos.\n'
      + 'Do NOT modify source files, run commands, or install packages until the user clicks **Build**.\n\n';
  }

  prompt += '**Allowed tools in Plan mode:** read/search/git tools; create_directory (`.guide/plans` only); '
    + 'write_file and edit_file (`.guide/plans/*.plan.md` only); write_todos; update_todo; ask_question.\n'
    + 'Implementation begins only after the user clicks **Build**.';
  return prompt;
}

function getBuildingPhasePromptAddition() {
  return '\n\n## BUILD PHASE\n'
    + 'Implement the approved plan in the PROJECT ROOT (the opened workspace folder).\n'
    + 'NEVER create application source under `.guide/` — that directory is guIDE metadata only (`.guide/plans/`, checkpoints).\n\n'
    + '### Todo checklist discipline (required)\n'
    + 'If no todos exist yet, call **write_todos** first with the full checklist.\n'
    + 'Then **throughout implementation** you MUST call **update_todo**:\n'
    + '- When you **start** a step: `update_todo` with that item\'s `id` and `status: "in-progress"`.\n'
    + '- When you **finish** a step: `update_todo` with `status: "done"` before moving to the next step.\n'
    + 'Never leave the checklist at 0/N done while you are actively implementing — the user tracks progress in real time.\n'
    + 'After each major file write or successful command that completes a plan step, update the matching todo before continuing.';
}

/**
 * Shared mode resolver — identical rules for local and cloud backends.
 */
function resolveAgentMode(options = {}) {
  const {
    askOnly = false,
    planMode = false,
    chatMode = 'agent',
    agentPhase = 'planning',
    toolsEnabled = true,
  } = options;

  const effectiveAskOnly = askOnly || chatMode === 'ask';
  const effectivePlanMode = planMode || chatMode === 'plan';
  const planning = effectivePlanMode && agentPhase !== 'building';
  const building = agentPhase === 'building';

  let allowedTools = null;
  if (!toolsEnabled || effectiveAskOnly) {
    allowedTools = new Set();
  } else if (planning) {
    allowedTools = new Set(PLAN_MODE_ALLOWED_TOOLS);
  }

  let systemPromptAdditions = '';
  if (effectiveAskOnly) {
    systemPromptAdditions += getAskModePromptAddition();
  } else if (building) {
    systemPromptAdditions += getBuildingPhasePromptAddition();
  } else if (planning) {
    const planPhase = resolvePlanPhase({
      planMode: effectivePlanMode,
      agentPhase,
      planReady: !!options.planReady,
      planFileExists: !!options.planFileExists,
    });
    systemPromptAdditions += getPlanModePromptAddition(planPhase || 'awaiting_plan');
  }

  const toolsActive = toolsEnabled && !effectiveAskOnly && (allowedTools === null || allowedTools.size > 0);

  return {
    askOnly: effectiveAskOnly,
    planMode: effectivePlanMode,
    planning,
    building,
    allowedTools,
    toolsActive,
    systemPromptAdditions,
    agentPhase,
    planPhase: effectivePlanMode && !building
      ? resolvePlanPhase({
        planMode: effectivePlanMode,
        agentPhase,
        planReady: !!options.planReady,
        planFileExists: !!options.planFileExists,
      })
      : (building ? 'building' : null),
  };
}

function checkPlanModeToolGate(toolName, params, agentContext = {}) {
  const { planMode, agentPhase = 'planning' } = agentContext;
  if (!planMode || agentPhase === 'building') return { allowed: true };

  if (!PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
    return {
      allowed: false,
      error: `Plan mode: tool "${toolName}" is blocked. Use read/search/git tools and write_file for .guide/plans/*.plan.md only. Click Build to implement.`,
    };
  }

  if (toolName === 'write_file') {
    const fp = String(params?.filePath || params?.path || '');
    if (!isPlanFilePath(fp)) {
      return {
        allowed: false,
        error: `Plan mode: write_file blocked for "${fp}". Only .guide/plans/*.plan.md is allowed during planning. Click Build to implement.`,
      };
    }
  }

  if (toolName === 'edit_file') {
    const fp = String(params?.filePath || params?.path || '');
    if (!isPlanFilePath(fp)) {
      return {
        allowed: false,
        error: `Plan mode: edit_file blocked for "${fp}". Only .guide/plans/*.plan.md is allowed during planning.`,
      };
    }
  }

  if (toolName === 'create_directory') {
    const dp = String(params?.path || params?.directory || params?.dir || '');
    if (!isPlansDirectoryPath(dp)) {
      return {
        allowed: false,
        error: `Plan mode: create_directory blocked for "${dp}". Only .guide/plans is allowed during planning.`,
      };
    }
  }

  if (toolName === 'update_todo') {
    const status = String(params?.status || '').toLowerCase().replace(/_/g, '-');
    if (status === 'done' || status === 'in-progress' || status === 'completed') {
      return {
        allowed: false,
        error: 'Plan mode: update_todo status changes (done/in-progress) are blocked until the user clicks Build. Use update_todo with `text` only to revise checklist wording.',
      };
    }
  }

  return { allowed: true };
}

function parsePlanFileContent(content) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { title: 'Implementation Plan', overview: text.split('\n').find((l) => l.trim()) || '', todos: [], body: text };
  }

  const frontmatter = match[1];
  const body = match[2];
  let title = 'Implementation Plan';
  let overview = '';
  const todos = [];

  const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
  if (titleMatch) title = titleMatch[1].replace(/^["']|["']$/g, '').trim();

  const overviewMatch = frontmatter.match(/^overview:\s*(.+)$/m);
  if (overviewMatch) overview = overviewMatch[1].replace(/^["']|["']$/g, '').trim();

  const todosBlock = frontmatter.match(/todos:\s*\n([\s\S]*?)(?:\n[a-zA-Z_]+:|$)/);
  if (todosBlock) {
    const lines = todosBlock[1].split('\n');
    let current = null;
    for (const line of lines) {
      const idMatch = line.match(/^\s*-\s*id:\s*(.+)$/);
      const contentMatch = line.match(/^\s*content:\s*(.+)$/);
      const statusMatch = line.match(/^\s*status:\s*(.+)$/);
      if (idMatch) {
        if (current) todos.push(current);
        current = { id: idMatch[1].trim(), content: '', status: 'pending' };
      } else if (contentMatch && current) {
        current.content = contentMatch[1].replace(/^["']|["']$/g, '').trim();
      } else if (statusMatch && current) {
        current.status = statusMatch[1].trim();
      }
    }
    if (current) todos.push(current);
  }

  if (!overview) {
    const overviewSection = body.match(/##\s*Overview\s*\n([\s\S]*?)(?:\n##|$)/i);
    overview = overviewSection ? overviewSection[1].trim().split('\n')[0] : body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
  }

  return { title, overview, todos, body };
}

function relativePlanPath(fullPath, projectPath) {
  if (!fullPath) return fullPath;
  if (projectPath) {
    try {
      return path.relative(projectPath, fullPath).replace(/\\/g, '/');
    } catch (_) {}
  }
  return normalizePathSlashes(fullPath);
}

module.exports = {
  PLAN_MODE_ALLOWED_TOOLS,
  isPlanFilePath,
  isPlansDirectoryPath,
  resolvePlanPhase,
  filterPlanModeToolCalls,
  filterToolDefinitions,
  resolveAgentMode,
  checkPlanModeToolGate,
  getAskModePromptAddition,
  getPlanModePromptAddition,
  getBuildingPhasePromptAddition,
  parsePlanFileContent,
  relativePlanPath,
};
