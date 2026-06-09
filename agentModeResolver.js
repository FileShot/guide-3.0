'use strict';

const path = require('path');

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'read_file', 'list_directory', 'grep_search', 'find_files', 'get_file_info',
  'search_in_file', 'search_codebase', 'git_status', 'git_diff', 'git_log',
  'write_file', 'edit_file', 'create_directory', 'ask_question', 'write_todos', 'update_todo',
]);

const PLAN_FILE_PATH_RE = /\.guide[/\\]plans[/\\].+\.plan\.md$/i;
const PLAN_PLANS_DIR_RE = /\.guide[/\\]plans\/?$/i;
const GUIDE_RULES_FILE_RE = /\.guide[/\\]rules[/\\].+\.md$/i;
const GUIDE_RULES_DIR_RE = /\.guide[/\\]rules\/?$/i;
const GUIDE_SCRATCH_RE = /^\.guide-scratch(\/|$)/i;

const GUIDE_PATH_MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'append_to_file', 'replace_in_file', 'delete_file',
]);

function normalizePathSlashes(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function isPlanFilePath(filePath) {
  return PLAN_FILE_PATH_RE.test(normalizePathSlashes(filePath));
}

function isPlansDirectoryPath(dirPath) {
  return PLAN_PLANS_DIR_RE.test(normalizePathSlashes(dirPath).replace(/\/+$/, ''));
}

function isGuideRulesDirectoryPath(dirPath) {
  return GUIDE_RULES_DIR_RE.test(normalizePathSlashes(dirPath).replace(/\/+$/, ''));
}

function isGuideRulesFilePath(filePath) {
  return GUIDE_RULES_FILE_RE.test(normalizePathSlashes(filePath));
}

function isGuideScratchPath(filePath) {
  const norm = normalizePathSlashes(filePath);
  return GUIDE_SCRATCH_RE.test(norm) || /\.guide-scratch(\/|$)/i.test(norm);
}

function pathContainsGuideMetadata(filePath) {
  return /\.guide[/\\]/i.test(normalizePathSlashes(filePath));
}

function isAllowedGuideMetadataWritePath(filePath) {
  if (isGuideScratchPath(filePath)) return true;
  if (isPlanFilePath(filePath)) return true;
  if (isGuideRulesFilePath(filePath)) return true;
  return false;
}

function extractGuideGatePath(toolName, params) {
  if (toolName === 'create_directory') {
    return String(params?.path || params?.directory || params?.dir || '');
  }
  return String(
    params?.filePath || params?.path || params?.oldPath || params?.newPath
    || params?.source || params?.destination || '',
  );
}

/**
 * Block writes/edits under .guide/ except plan docs and rules (all agent modes).
 */
function checkGuideMetadataPathGate(toolName, params) {
  if (toolName === 'create_directory') {
    const dp = extractGuideGatePath(toolName, params);
    const norm = normalizePathSlashes(dp).replace(/\/+$/, '');
    if (!norm.startsWith('.guide') && !/\.guide[/\\]/i.test(norm)) return { allowed: true };
    if (isPlansDirectoryPath(dp) || isGuideRulesDirectoryPath(dp)) return { allowed: true };
    return {
      allowed: false,
      error: `create_directory blocked for "${dp}". Only .guide/plans and .guide/rules are allowed under .guide/.`,
    };
  }

  if (!GUIDE_PATH_MUTATING_TOOLS.has(toolName)) return { allowed: true };

  const fp = extractGuideGatePath(toolName, params);
  if (!fp) return { allowed: true };
  if (!pathContainsGuideMetadata(fp) && !isGuideScratchPath(fp)) return { allowed: true };
  if (isAllowedGuideMetadataWritePath(fp)) return { allowed: true };

  const basename = path.basename(normalizePathSlashes(fp));
  const display = normalizePathSlashes(fp).replace(/^.*\.guide[/\\]/, '.guide/');
  return {
    allowed: false,
    error: `${toolName} blocked: "${display}" is under .guide/ (hidden from the file explorer). `
      + `Write application source to the project root instead, e.g. "${basename}". `
      + 'Only .guide/plans/*.plan.md and .guide/rules/*.md are for guIDE metadata.',
    guidePathBlocked: true,
  };
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

function getAskSystemPrompt() {
  return 'You are guIDE, an AI assistant embedded in a general-purpose IDE.\n\n'
    + '## Ask mode\n'
    + 'You are in **Ask mode** (Q&A only). Answer the user\'s question directly in prose.\n'
    + 'Do NOT call tools. Do NOT create, edit, or delete files. Do NOT run commands.\n\n'
    + '## How to respond\n'
    + '- Reply in clear, helpful prose.\n'
    + '- Base answers on user-provided context — not assumptions.\n'
    + '- If you need project file contents or live data to answer accurately, say what you would need and suggest the user switch to Agent or Plan mode.\n\n'
    + '## Images\n'
    + 'When you receive an image description from the vision system, treat it as what you observed.';
}

function getAskModePromptAddition() {
  return '';
}

function getAgentSystemPrompt() {
  return 'You are guIDE, an AI assistant embedded in a general-purpose IDE. You help users with software projects: reading and writing code, running commands, searching the web, using the browser, and answering questions.\n\n'
    + '## How to respond\n'
    + '- If the user\'s message is conversational (greetings, thanks, clarifying questions, opinions) and needs no action, reply in plain prose only. Do not call tools.\n'
    + '- If the user asks you to do something you cannot do with text alone — create or change files, run commands, search the project or web, use the browser, inspect git state, etc. — use the appropriate tool from the ## Tools section below.\n'
    + '- You have real tools. When action is required, use them. Do not say you cannot access files, the terminal, or the network when a tool can perform the task.\n'
    + '- Put explanations and reasoning in **prose**. Put actions in **tool calls** (the system runs tools and shows results in tool cards). Do not paste raw tool-call JSON in your visible reply.\n\n'
    + '## Clarification (before you guess)\n'
    + '- When requirements are ambiguous, multiple approaches are valid, or you need facts only the user has (credentials, which account, API keys, destructive confirmation, missing env values): call **ask_question** with an **options** array of {label, description} objects before proceeding.\n'
    + '- Do not invent usernames, passwords, tokens, or one-time codes. Do not assume values from unrelated documents or prior chats.\n'
    + '- For simple chat, prose is fine. When the user\'s answer determines the next tool call, prefer **ask_question** over guessing.\n\n'
    + '## Tools (required reading)\n'
    + 'Tool definitions, call format, parameter schemas, and examples are in the ## Tools section appended below this message. Follow that section exactly for tool names, parameter names, and JSON format. Do not invent tool names or parameter names.\n\n'
    + 'After calling a tool, wait for the result before continuing. Never output fabricated tool results or blocks labeled [Tool Results] or [System: Tool Results] — the system injects real results.\n\n'
    + '## Grounding\n'
    + '- Base answers on tool results, file contents, and user-provided context — not assumptions.\n'
    + '- If a tool fails, read the error, adjust, and retry once with corrected parameters; then explain or use ask_question if blocked.\n\n'
    + '## Images\n'
    + 'When you receive an image description from the vision system, treat it as what you observed. Do not use read_file on image files to "see" them.\n\n'
    + '## File locations\n'
    + '- Application source (HTML, CSS, JS, etc.) belongs in the **project root** (visible in the file explorer), never under `.guide/`.\n'
    + '- `.guide/` is guIDE metadata (hidden from the explorer); users cannot see files written there except rules you save under `.guide/rules/`.\n\n'
    + '## Todo List Discipline\n'
    + 'Use write_todos only for multi-step builds — skip it for simple one-shot tasks. If you called write_todos, call update_todo when you start each todo item (status: \'in-progress\') and when you finish it (status: \'done\'). The user sees the todo list in real time.\n\n'
    + '## Browser and authentication flows\n'
    + '- Call browser_navigate first (returns a snapshot). After browser_type, browser_click, or any action that changes the page, call browser_snapshot before the next browser_click so [ref=N] numbers match the current DOM. Do not reuse stale refs. Prefer elements marked [SUBMIT] for login/forms.\n'
    + '- Read the snapshot: if the page reports an incorrect username, a password field is missing, or 2FA/phone verification appears, stop cycling clicks. Use **ask_question** or prose to get what you need from the user.\n'
    + '- Never type passwords from memory. The user provides secrets when needed.\n\n'
    + '## Session memory\n'
    + 'When older turns were condensed, a brief progress summary may appear in context. Never mention context limits, rotation, or compression to the user. Continue the current task immediately using that summary and the next required tool call.\n\n'
    + '## Cloud response style (cloud models only)\n'
    + 'When this block is present you are guIDE Cloud AI: keep answers concise — short paragraphs, minimal preamble, no filler. Still use tools whenever the task requires real actions in the project.\n\n'
    + '## Only call a tool when required. Never call a tool when plain prose is sufficient.\n\n'
    + 'Examples of when to call tools:\n\n'
    + 'Pattern — user wants to create or write a file:\n'
    + 'Call write_file with the target path and the full file content. Do not output the content as a markdown code block.\n\n'
    + 'Pattern — user asks to edit or modify an existing file:\n'
    + 'Use edit_file or replace_in_file on that file path. Call read_file first if you need the current content. Do NOT use write_file to create a new file or a renamed copy (e.g. file-v2.html) unless the user explicitly asked for a new file or a full rewrite from scratch.\n\n'
    + 'Pattern — user asks to run a command, script, or terminal operation:\n'
    + 'Call run_terminal_command with the command string. Do not describe what the command would do — run it.\n\n'
    + 'Pattern — user asks to search the web, find current information, or look up something online:\n'
    + 'Call web_search with a rephrased query. Do not generate an answer from memory if the information may be outdated.\n\n'
    + 'Pattern — user asks to open, navigate, or interact with a website or browser:\n'
    + 'Follow the Browser and authentication flows section above.\n\n'
    + 'Pattern — user wants to find files in the project, list a directory, or search codebase:\n'
    + 'Call list_directory, search_codebase, or find_files as appropriate. Do not guess at file contents.\n\n'
    + 'Pattern — user asks a conversational question or makes a greeting:\n'
    + 'Reply in prose only. Do not call any tool.';
}

function getPlanSystemPrompt() {
  return 'You are guIDE, an AI assistant embedded in a general-purpose IDE.\n\n'
    + '## Plan mode — READ FIRST\n'
    + 'You are in **Plan mode**: **planning only**, not implementing. The user clicks **Build** (or Ctrl+Enter) to implement later.\n'
    + '**Do NOT deliver the finished product in chat.** When the user asks you to build or design something, write an implementation plan to disk with tools — do not paste source code or long implementation in your reply.\n'
    + '**Terminal, browser, web, and other implementation tools are NOT available** in Plan mode. For live external data, answer from knowledge or suggest Ask mode.\n\n'
    + '## How to respond\n'
    + '- Put brief explanations in **prose**. Put plan artifacts in **tool calls** (write_file to `.guide/plans/*.plan.md`, write_todos).\n'
    + '- Do not paste raw tool-call JSON in your visible reply — the system runs tools and shows tool cards.\n'
    + '- If you must show code in chat (rare), wrap it in markdown fences: ` ```lang ` … ` ``` ` so it renders as a code block.\n\n'
    + '## Clarification\n'
    + '- When requirements are ambiguous, use **ask_question** or ask 1–2 clarifying questions in prose before planning.\n\n'
    + '## Tools (required reading)\n'
    + 'Tool definitions, call format, and examples are in the ## Tools section below. Follow exact tool names and parameter names.\n\n'
    + '## Allowed tools in Plan mode\n'
    + 'read/search/git tools; **create_directory** (`.guide/plans` only); **write_file** and **edit_file** (`.guide/plans/*.plan.md` only); **write_todos**; **update_todo**; **ask_question**.\n\n'
    + '## Worked example — build request (use tools in this order)\n'
    + 'When the user wants something built (e.g. "make me a website"):\n'
    + '```json\n{"tool":"create_directory","params":{"path":".guide/plans"}}\n```\n'
    + '```json\n{"tool":"write_file","params":{"filePath":".guide/plans/community-website.plan.md","content":"---\\ntitle: Community Website\\noverview: Professional site for the community\\n---\\n\\n## Summary\\n...\\n\\n## Approach\\n...\\n\\n## Key files\\n- index.html in project root\\n"}}\n```\n'
    + '```json\n{"tool":"write_todos","params":{"items":[{"text":"Scaffold HTML structure","status":"pending"},{"text":"Add styles and layout","status":"pending"}]}}\n```\n'
    + 'Then STOP. Do not create app source files, run commands, or install packages.\n\n'
    + '## Plan file format\n'
    + '- Path: `.guide/plans/{descriptive-slug}.plan.md`\n'
    + '- YAML frontmatter: `title`, optional `overview` only — no todos in the file body\n'
    + '- Plan body: summary, approach, key files, phases — not full source code\n\n'
    + '## Grounding\n'
    + '- Base the plan on user requirements and optional read/list/search/git exploration.\n'
    + '- If a tool fails, read the error and retry once with corrected parameters.\n\n'
    + '## Images\n'
    + 'When you receive an image description from the vision system, treat it as what you observed.';
}

/** Phase-specific deltas only — core plan identity lives in getPlanSystemPrompt(). */
function getPlanModePromptAddition(planPhase = 'awaiting_plan') {
  if (planPhase === 'awaiting_plan') {
    return '\n\n## Current phase: awaiting plan\n'
      + '### Tier A — Conversational (no plan artifact)\n'
      + 'For greetings, small talk, or general questions unrelated to building something: respond in **prose only**. Do NOT call tools. Do NOT write a plan file.\n\n'
      + '### Tier B — Build / plan requests\n'
      + 'When the user wants something built or designed: create the plan file and write_todos as shown in the worked example above.\n'
      + '- Optionally explore first with read/list/search/git tools.\n'
      + '- If the request is vague, clarify before or while planning.\n';
  }
  return '\n\n## Current phase: plan ready\n'
    + 'A plan already exists on disk. Answer questions in prose.\n'
    + 'To revise the plan: edit_file or write_file on `.guide/plans/*.plan.md` only.\n'
    + 'To change todo text: update_todo with todo `id` and new `text`. To replace the full checklist: write_todos.\n'
    + 'Do NOT modify source files, run commands, or install packages until the user clicks **Build**.\n';
}

function getBuildingPhasePromptAddition() {
  return '\n\n## BUILD PHASE\n'
    + 'Implement the approved plan in the PROJECT ROOT (the opened workspace folder).\n'
    + 'NEVER create application source under `.guide/` — that directory is guIDE metadata only.\n'
    + '`.guide/plans/` holds `*.plan.md` plan documents only — not HTML, CSS, JS, or other implementation files.\n\n'
    + '### Todo list discipline (multi-step builds only)\n'
    + 'For multi-step builds, call **write_todos** first with the full todo list.\n'
    + 'If you called **write_todos**, call **update_todo** as you work:\n'
    + '- When you **start** a todo item: `update_todo` with that item\'s `id` and `status: "in-progress"`.\n'
    + '- When you **finish** a todo item: `update_todo` with `status: "done"` before moving on.\n'
    + 'Skip write_todos for simple one-shot tasks.';
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

  let baseSystemPrompt = getAgentSystemPrompt();
  let systemPromptAdditions = '';
  if (effectiveAskOnly) {
    baseSystemPrompt = getAskSystemPrompt();
    systemPromptAdditions += getAskModePromptAddition();
  } else if (building) {
    systemPromptAdditions += getBuildingPhasePromptAddition();
  } else if (planning) {
    baseSystemPrompt = getPlanSystemPrompt();
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
    baseSystemPrompt,
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

/** Whether file-content UI may stream during plan mode (plan files only until Build). */
function shouldStreamFileContentForAgent(settings, filePath) {
  if (!settings?.planMode || settings.agentPhase === 'building') return true;
  return isPlanFilePath(filePath || '');
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
  checkGuideMetadataPathGate,
  getAskSystemPrompt,
  getAgentSystemPrompt,
  getPlanSystemPrompt,
  getAskModePromptAddition,
  getPlanModePromptAddition,
  getBuildingPhasePromptAddition,
  parsePlanFileContent,
  relativePlanPath,
  shouldStreamFileContentForAgent,
};
