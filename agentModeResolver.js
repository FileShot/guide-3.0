'use strict';

const path = require('path');

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'read_file', 'list_directory', 'grep_search', 'find_files', 'get_file_info',
  'search_in_file', 'search_codebase', 'git_status', 'git_diff', 'git_log',
  'write_file', 'ask_question', 'write_todos', 'update_todo',
]);

const PLAN_FILE_PATH_RE = /\.guide[/\\]plans[/\\].+\.plan\.md$/i;

function normalizePathSlashes(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function isPlanFilePath(filePath) {
  return PLAN_FILE_PATH_RE.test(normalizePathSlashes(filePath));
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

function getPlanModePromptAddition() {
  return '\n\n## PLAN MODE ACTIVE\nYou are in Plan mode. Explore the codebase with read/search/git tools first.\n'
    + 'Then write ONE complete implementation plan to `.guide/plans/{descriptive-slug}.plan.md` using write_file.\n'
    + 'The plan file MUST include YAML frontmatter with `title` and optional `overview` only (no todos in the file).\n'
    + 'After writing the plan file, call **write_todos** with the implementation checklist so the user sees live progress.\n'
    + 'STOP after the plan file and write_todos. Do NOT modify source files, run commands, or install packages.\n'
    + 'The user will review the plan and click **Build** to implement — do not implement until then.\n'
    + 'In Plan mode: read-only tools, write_file (for `.guide/plans/*.plan.md` only), write_todos, and update_todo are permitted.';
}

function getBuildingPhasePromptAddition() {
  return '\n\n## BUILD PHASE\nImplement the approved plan in the PROJECT ROOT (the opened workspace folder).\n'
    + 'NEVER create application source under `.guide/` — that directory is guIDE metadata only (`.guide/plans/`, checkpoints).\n'
    + 'If no todos exist yet, call write_todos first; then call update_todo as you start and finish each step.';
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
    systemPromptAdditions += getPlanModePromptAddition();
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
