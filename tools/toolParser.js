'use strict';

const { canonicalizeToolParams, getCanonicalPathParamForRecovery } = require('./canonicalizeToolParams');

// ─── Tool Name Aliases ───
// Maps common model misspellings/hallucinations to canonical tool names
const TOOL_NAME_ALIASES = {
  // Browser
  navigate: 'browser_navigate', open_url: 'browser_navigate', goto: 'browser_navigate',
  go_to: 'browser_navigate', visit: 'browser_navigate', browse: 'browser_navigate',
  snapshot: 'browser_snapshot', get_snapshot: 'browser_snapshot', page_snapshot: 'browser_snapshot',
  accessibility_snapshot: 'browser_snapshot',
  click: 'browser_click', press: 'browser_click', tap: 'browser_click',
  type: 'browser_type', input: 'browser_type', fill: 'browser_type', enter_text: 'browser_type',
  screenshot: 'browser_screenshot', take_screenshot: 'browser_screenshot', capture: 'browser_screenshot',
  scroll: 'browser_scroll', scroll_page: 'browser_scroll',
  wait: 'browser_wait', sleep: 'browser_wait', delay: 'browser_wait',
  back: 'browser_back', go_back: 'browser_back',
  get_url: 'browser_get_url', current_url: 'browser_get_url',
  get_links: 'browser_get_links', list_links: 'browser_get_links',
  close_browser: 'browser_close',
  // Web
  search: 'web_search', google: 'web_search', duckduckgo: 'web_search',
  search_web: 'web_search', internet_search: 'web_search',
  fetch: 'fetch_webpage', fetch_url: 'fetch_webpage', get_page: 'fetch_webpage',
  // File
  read: 'read_file', cat: 'read_file', open: 'read_file', view: 'read_file',
  write: 'write_file', create: 'write_file', save: 'write_file', create_file: 'write_file',
  edit: 'edit_file', modify: 'edit_file', update: 'edit_file', patch: 'edit_file',
  append: 'append_to_file', add_to_file: 'append_to_file',
  delete: 'delete_file', remove: 'delete_file', rm: 'delete_file',
  rename: 'rename_file', move: 'rename_file', mv: 'rename_file',
  copy: 'copy_file', cp: 'copy_file',
  // Directory
  ls: 'list_directory', dir: 'list_directory', list_dir: 'list_directory',
  mkdir: 'create_directory', make_dir: 'create_directory',
  find: 'find_files', glob: 'find_files', locate: 'find_files',
  // Command
  run: 'run_command', exec: 'run_command', execute: 'run_command',
  shell: 'run_command', terminal: 'run_command', run_terminal_cmd: 'run_command',
  run_terminal: 'run_command', command: 'run_command',
  persistent_terminal: 'terminal_run', pty: 'terminal_run', terminal_session: 'terminal_run',
  install: 'install_packages', npm_install: 'install_packages', pip_install: 'install_packages',
  // Search
  grep: 'grep_search', search_code: 'search_codebase', codebase_search: 'search_codebase',
  code_search: 'search_codebase', find_in_files: 'grep_search',
  // Git
  status: 'git_status', commit: 'git_commit', diff: 'git_diff',
  log: 'git_log', branch: 'git_branch', stash: 'git_stash',
  // Memory
  remember: 'save_memory', recall: 'get_memory',
  // Other
  undo: 'undo_edit', todos: 'write_todos', todo: 'update_todo',
  ask: 'ask_question', question: 'ask_question', ask_user: 'ask_question',
  vscode_askquestions: 'ask_question', vscode_askquestion: 'ask_question',
  ask_questions: 'ask_question', askquestion: 'ask_question',
  askquestionstool: 'ask_question', ask_user_questions: 'ask_question',
  ask_user_question: 'ask_question',
  request: 'http_request', http: 'http_request', curl: 'http_request',
  // Additional common model misspellings / alternate casings
  browsernavigate: 'browser_navigate', browsersnapshot: 'browser_snapshot',
  browserclick: 'browser_click', browsertype: 'browser_type',
  browserscreenshot: 'browser_screenshot', browserscroll: 'browser_scroll',
  browserwait: 'browser_wait', browserback: 'browser_back',
  browserclose: 'browser_close', browserevaluate: 'browser_evaluate',
  browserfillform: 'browser_fill_form', browserselectoption: 'browser_select_option',
  browserhover: 'browser_hover', browserpresskey: 'browser_press_key',
  browsertabs: 'browser_tabs', browserdrag: 'browser_drag',
  browserhandledialog: 'browser_handle_dialog',
  readfile: 'read_file', writefile: 'write_file', editfile: 'edit_file',
  appendtofile: 'append_to_file', deletefile: 'delete_file',
  renamefile: 'rename_file', copyfile: 'copy_file',
  listdirectory: 'list_directory', createdirectory: 'create_directory',
  findfiles: 'find_files', grepsearch: 'grep_search',
  runcommand: 'run_command', websearch: 'web_search',
  fetchwebpage: 'fetch_webpage', httprequest: 'http_request',
  gitstatus: 'git_status', gitcommit: 'git_commit', gitdiff: 'git_diff',
  gitlog: 'git_log', gitbranch: 'git_branch', gitstash: 'git_stash',
  gitreset: 'git_reset', savememory: 'save_memory', getmemory: 'get_memory',
  listmemories: 'list_memories', writetodos: 'write_todos', updatetodo: 'update_todo',
  writescratchpad: 'write_scratchpad', readscratchpad: 'read_scratchpad',
  save_rule: 'save_rule', list_rules: 'list_rules',
  diff_files: 'diff_files', check_port: 'check_port',
  open_file_in_editor: 'open_file_in_editor', generate_image: 'generate_image',
  get_project_structure: 'get_project_structure', analyze_error: 'analyze_error',
  install_packages: 'install_packages', undo_edit: 'undo_edit',
  list_undoable: 'list_undoable', get_file_info: 'get_file_info',
  search_codebase: 'search_codebase', search_in_file: 'search_in_file',
  replace_in_files: 'replace_in_files',
};

// Normalize all alias keys to lowercase so the lowercased lookup in normalizeToolCall
// always finds them, regardless of how they were defined above.
for (const key of Object.keys(TOOL_NAME_ALIASES)) {
  if (key !== key.toLowerCase()) {
    TOOL_NAME_ALIASES[key.toLowerCase()] = TOOL_NAME_ALIASES[key];
    delete TOOL_NAME_ALIASES[key];
  }
}

// ─── Valid Tool Names ───
const VALID_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'append_to_file', 'delete_file',
  'rename_file', 'copy_file', 'get_file_info', 'list_directory', 'find_files',
  'search_codebase', 'grep_search', 'search_in_file', 'replace_in_files',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_select_option', 'browser_screenshot',
  'browser_get_content', 'browser_evaluate', 'browser_scroll', 'browser_wait',
  'browser_wait_for', 'browser_back', 'browser_press_key', 'browser_hover',
  'browser_drag', 'browser_tabs', 'browser_handle_dialog', 'browser_console_messages',
  'browser_file_upload', 'browser_resize', 'browser_get_url', 'browser_get_links',
  'browser_close',
  'web_search', 'fetch_webpage',
  'git_status', 'git_commit', 'git_diff', 'git_log', 'git_branch', 'git_stash', 'git_reset',
  'save_memory', 'get_memory', 'list_memories',
  'run_command', 'terminal_run', 'get_project_structure', 'create_directory', 'analyze_error', 'install_packages',
  'undo_edit', 'list_undoable',
  'write_todos', 'update_todo',
  'ask_question',
  'write_scratchpad', 'read_scratchpad',
  'http_request', 'check_port', 'open_file_in_editor', 'generate_image', 'diff_files',
  'save_rule', 'list_rules',
  // Phase 6: Process/System tools
  'list_processes', 'kill_process', 'get_system_info', 'get_env_var', 'set_env_var',
  // Phase 6: Network tools
  'ping_host', 'dns_lookup', 'download_file',
  // Phase 6: Code quality tools
  'run_linter', 'run_tests', 'run_formatter',
  // Phase 6: IDE integration tools
  'open_terminal', 'switch_file', 'get_diagnostics', 'get_selection',
  // Phase 6: Documentation tools
  'read_doc', 'search_docs',
  // Phase 5: Checkpoint tools
  'list_checkpoints', 'restore_checkpoint',
  // Git tools (previously in _destructiveTools but missing from VALID_TOOLS)
  'git_push', 'git_branch_delete',
]);

// ─── JSON Repair Utilities ───
function stripJsonComments(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let result = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; result += ch; continue; }
    if (ch === '\\' && inStr) { escaped = true; result += ch; continue; }
    if (ch === '"') { inStr = !inStr; result += ch; continue; }
    if (!inStr) {
      // Single-line comment: // → skip to end of line
      if (ch === '/' && raw[i + 1] === '/') {
        while (i < raw.length && raw[i] !== '\n') i++;
        if (i < raw.length) result += '\n';
        continue;
      }
      // Multi-line comment: /* → skip to */
      if (ch === '/' && raw[i + 1] === '*') {
        i += 2;
        while (i < raw.length - 1 && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
        i += 1; // skip the closing /
        continue;
      }
    }
    result += ch;
  }
  return result;
}

function sanitizeJson(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  raw = stripJsonComments(raw);
  console.log(`[ToolParser] sanitizeJson START: rawLen=${raw.length}`);
  let result = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      // Valid JSON escapes
      if ('"\\bfnrtu/'.includes(ch)) {
        result += ch;
      } else {
        // Invalid escape — double the backslash
        result += '\\' + ch;
      }
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inStr) {
        escaped = true;
        result += ch;
        continue;
      } else {
        // Outside a string: model used \" as a string delimiter (common with small models)
        // Peek at next char — if it's ", treat \" as just " (the model meant to start/end a string)
        const nextCh = raw[i + 1];
        if (nextCh === '"') {
          result += '"';
          inStr = !inStr;
          i++; // skip the " — we already consumed both \" as a single "
          continue;
        }
        // Other \ outside string (rare) — pass through as-is
        result += ch;
        continue;
      }
    }
    if (ch === '"' && !escaped) {
      inStr = !inStr;
    }
    // Escape raw control chars inside strings (literal newlines/carriage returns break JSON.parse)
    if (inStr && ch.charCodeAt(0) < 32 && ch !== '\t') {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      result += ' ';
      continue;
    }
    result += ch;
  }
  console.log(`[ToolParser] sanitizeJson DONE: resultLen=${result.length}`);
  return result;
}

function fixQuoting(raw) {
  if (!raw) return raw;
  // Single-quoted strings → double-quoted
  let fixed = raw.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  // Unquoted keys → double-quoted
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_]\w*)(\s*:)/g, '$1"$2"$3');
  // Unquoted path values → double-quoted (e.g., "path":C:\Users\... → "path":"C:\Users\...")
  fixed = fixed.replace(/:\s*([A-Za-z]:[\\/][^\s,}\]]+)/g, ':"$1"');
  return fixed;
}

function fixBackticks(raw) {
  if (!raw) return raw;
  // Replace backtick-delimited strings with properly escaped JSON double-quoted strings
  return raw.replace(/`([\s\S]*?)`/g, (match, inner) => {
    const escaped = inner
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return '"' + escaped + '"';
  });
}

function fixSeparatorTypos(raw) {
  if (!raw) return raw;
  // Models occasionally emit a punctuation mark where a colon belongs, e.g.
  //   {"tool":"list_directory","params":{"dirPath".""}}
  //                                              ^ dot instead of colon
  // Only repair when: quoted alphanumeric key immediately followed by one of
  // [ . ; , | ] (the common typos) and then a value-start token. Never touches
  // the inside of a string (extractJsonObjects has already isolated one object).
  return raw.replace(
    /("[A-Za-z_][\w-]*")\s*([.;,|])\s*(?=["\d\[\{tfn-])/g,
    '$1:'
  );
}

function tryParseJson(raw) {
  console.log(`[ToolParser] tryParseJson START: rawLen=${raw?.length || 0}`);
  // Quadruple-try chain: raw → fixQuoting → fixBackticks → fixSeparatorTypos
  try { const r = JSON.parse(sanitizeJson(raw)); console.log('[ToolParser] tryParseJson: raw parse OK'); return r; } catch {}
  try { const r = JSON.parse(sanitizeJson(fixQuoting(raw))); console.log('[ToolParser] tryParseJson: fixQuoting parse OK'); return r; } catch {}
  try { const r = JSON.parse(sanitizeJson(fixBackticks(fixQuoting(raw)))); console.log('[ToolParser] tryParseJson: fixBackticks parse OK'); return r; } catch {}
  try { const r = JSON.parse(sanitizeJson(fixSeparatorTypos(fixBackticks(fixQuoting(raw))))); console.log('[ToolParser] tryParseJson: fixSeparatorTypos parse OK'); return r; } catch {}
  console.log('[ToolParser] tryParseJson: all parse attempts failed');
  return null;
}

// ─── Brace-Counting JSON Extractor ───
function extractJsonObjects(text) {
  console.log(`[ToolParser] extractJsonObjects START: textLen=${text?.length || 0}`);
  const objects = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let inBacktick = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '`' && !inStr) { inBacktick = !inBacktick; continue; }
    if (ch === '"' && !inBacktick) { inStr = !inStr; continue; }
    if (inStr || inBacktick) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        const parsed = tryParseJson(slice);
        if (parsed) {
          objects.push(parsed);
        } else {
          // Regex-based recovery for tool calls with large content that breaks JSON.parse
          // (e.g., write_file with huge HTML/CSS where encoding edge cases defeat sanitizeJson)
          const toolMatch = slice.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/);
          if (toolMatch) {
            const toolName = toolMatch[1];
            // Try multiple param patterns for different tool types
            const pathKeyMatch = slice.match(/"(filePath|path|dirPath)"\s*:\s*"([^"]+)"/);
            const urlMatch = slice.match(/"(?:url|href|link)"\s*:\s*"([^"]+)"/);
            const cmdMatch = slice.match(/"(?:command|cmd)"\s*:\s*"([^"]+)"/);
            const searchMatch = slice.match(/"(?:pattern|query|search)"\s*:\s*"([^"]+)"/);
            const dirMatch = slice.match(/"(?:dirPath|directory|dir)"\s*:\s*"([^"]+)"/);
            // Browser tool params — small models frequently produce malformed JSON for browser calls
            const browserRefMatch = slice.match(/"(?:ref|elementRef|elementId|id|selector)"\s*:\s*"([^"]+)"/);
            const browserTextMatch = slice.match(/"(?:text|value|input)"\s*:\s*"([^"]+)"/);
            const browserReasonMatch = slice.match(/"(?:reason|description|purpose)"\s*:\s*"([^"]+)"/);
            
            let recovered = null;
            if (pathKeyMatch) {
              const canonicalKey = getCanonicalPathParamForRecovery(toolName) || pathKeyMatch[1];
              recovered = {
                tool: toolName,
                params: { [canonicalKey]: pathKeyMatch[2] },
                _recovered: true,
              };
            } else if (urlMatch) {
              recovered = { tool: toolName, params: { url: urlMatch[1] }, _recovered: true };
            } else if (cmdMatch) {
              recovered = { tool: toolName, params: { command: cmdMatch[1] }, _recovered: true };
            } else if (searchMatch) {
              recovered = { tool: toolName, params: { pattern: searchMatch[1] }, _recovered: true };
            } else if (dirMatch) {
              recovered = { tool: toolName, params: { dirPath: dirMatch[1] }, _recovered: true };
            } else if (browserRefMatch || browserTextMatch || browserReasonMatch) {
              // Browser tool recovery — assemble all found browser params
              const params = {};
              if (urlMatch) params.url = urlMatch[1];
              if (browserRefMatch) params.ref = browserRefMatch[1];
              if (browserTextMatch) params.text = browserTextMatch[1];
              if (browserReasonMatch) params.reason = browserReasonMatch[1];
              recovered = { tool: toolName, params, _recovered: true };
            }
            
            if (recovered) {
              // Try to extract content field for write/create/edit/append tools
              // Fix 78: Forward-scan approach — take everything after the content opening
              // quote instead of scanning backward for a closing quote. Backward scanning
              // fails on truncated tool calls (55K+ chars of HTML) because the last `"` in
              // the slice may be an escaped `\"` inside content, yielding empty extraction.
              const contentIdx = slice.indexOf('"content"');
              if (contentIdx >= 0) {
                const colonIdx = slice.indexOf(':', contentIdx + 9);
                if (colonIdx >= 0) {
                  const quoteIdx = slice.indexOf('"', colonIdx + 1);
                  if (quoteIdx >= 0) {
                    let rawContent = slice.slice(quoteIdx + 1);
                    // Strip trailing JSON structure: closing quote + braces/brackets
                    // Pattern: optional `"` then `}` then optional `}` then optional `]`
                    rawContent = rawContent.replace(/"\s*\}\s*\}\s*\]?\s*$/, '');
                    rawContent = rawContent.replace(/"\s*\}\s*$/, '');
                    // Trim to last complete line (avoid partial escape sequences)
                    const lastNewline = rawContent.lastIndexOf('\\n');
                    if (lastNewline > 50) rawContent = rawContent.substring(0, lastNewline);
                    try {
                      rawContent = rawContent
                        .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
                        .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                    } catch (_) {}
                    if (rawContent.trim().length > 20) {
                      recovered.params.content = rawContent;
                    }
                  }
                }
              }
              objects.push(recovered);
              console.log(`[ToolParser] Recovered tool call via regex: ${toolName}`);
            }
          }
        }
        start = -1;
      }
    }
  }

  // Handle truncated JSON (unclosed braces)
  if (depth > 0 && start >= 0) {
    const partial = text.slice(start);
    // C1: Scope-aware recovery — extract tool name FIRST, then find the LAST
    // filePath/content pair that belongs to the same tool call.
    const toolMatch = partial.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/);
    if (toolMatch) {
      const recoveredTool = TOOL_NAME_ALIASES[toolMatch[1].toLowerCase()] || toolMatch[1].toLowerCase();
      // Find the LAST occurrence of filePath and content in the partial string
      const pathMatches = [...partial.matchAll(/"(?:filePath|path)"\s*:\s*"([^"]+)"/g)];
      const contentMatches = [...partial.matchAll(/"content"\s*:\s*"([\s\S]{20,})$/g)];
      if (pathMatches.length > 0 && contentMatches.length > 0) {
        const lastPath = pathMatches[pathMatches.length - 1][1];
        const lastContent = contentMatches[contentMatches.length - 1][1];
        // Heuristic: only pair them if they appear close together (within 200 chars)
        const lastPathIdx = partial.lastIndexOf(pathMatches[pathMatches.length - 1][0]);
        const lastContentIdx = partial.lastIndexOf(contentMatches[contentMatches.length - 1][0]);
        if (Math.abs(lastPathIdx - lastContentIdx) < 200) {
          let truncatedContent = lastContent;
          truncatedContent = truncatedContent
            .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
            .replace(/\\'/g, "'").replace(/\\\\/g, '\\');
          objects.push({
            tool: VALID_TOOLS.has(recoveredTool) ? recoveredTool : 'write_file',
            params: { filePath: lastPath, content: truncatedContent },
            _truncated: true,
          });
        }
      }
    }

    // Fix 40A: General recovery for ANY tool call with malformed JSON (e.g. missing closing braces).
    // Close unclosed braces and attempt JSON.parse. This handles write_todos, update_todo, run_command,
    // etc. that the write_file-specific recovery above doesn't cover.
    if (objects.length === 0) {
      const toolNameMatch = partial.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/);
      if (toolNameMatch) {
        let repaired = partial;
        let bd = 0, ad = 0;
        let inS = false, esc = false;
        for (let i = 0; i < repaired.length; i++) {
          const c = repaired[i];
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === '"') { inS = !inS; continue; }
          if (inS) continue;
          if (c === '{') bd++;
          else if (c === '}') bd--;
          else if (c === '[') ad++;
          else if (c === ']') ad--;
        }
        for (let i = 0; i < ad; i++) repaired += ']';
        for (let i = 0; i < bd; i++) repaired += '}';
        const parsed = tryParseJson(repaired);
        if (parsed && typeof parsed === 'object') {
          objects.push(parsed);
          console.log(`[ToolParser] Recovered malformed tool call via brace-closing: ${toolNameMatch[1]}`);
        }
      }
    }
  }

  console.log(`[ToolParser] extractJsonObjects DONE: objects=${objects.length}`);
  return objects;
}

// ─── Tool Call Normalization ───
function normalizeToolCall(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  console.log(`[ToolParser] normalizeToolCall START: raw=${JSON.stringify(parsed).substring(0,200)}`);

  // Extract tool name
  let toolName = parsed.tool || parsed.name || parsed.function || parsed.action;
  if (!toolName) {
    console.log('[ToolParser] normalizeToolCall: no tool name found');
    return null;
  }

  toolName = String(toolName).trim().toLowerCase().replace(/\s+/g, '_');

  // Alias resolution
  if (TOOL_NAME_ALIASES[toolName]) toolName = TOOL_NAME_ALIASES[toolName];

  // CLI-binary recovery: if toolName is a shell binary, convert to run_command
  const shellBinaries = /^(node|npm|npx|git|python|pip|cargo|go|ruby|java|gcc|make|cmake|dotnet|curl|wget)\b/;
  if (shellBinaries.test(toolName) && !VALID_TOOLS.has(toolName)) {
    const cmd = parsed.params?.command || `${toolName} ${parsed.params?.args || ''}`.trim();
    console.log(`[ToolParser] normalizeToolCall: shell binary recovered as run_command`);
    return { tool: 'run_command', params: { command: cmd } };
  }

  // Reject hallucinated tool names
  if (!VALID_TOOLS.has(toolName)) {
    console.log(`[ToolParser] normalizeToolCall: invalid toolName=${toolName}`);
    return null;
  }

  // Extract params
  let params = parsed.params || parsed.parameters || parsed.arguments || parsed.args || {};
  if (typeof params !== 'object' || Array.isArray(params)) params = {};

  // If top-level props look like params (not tool metadata), merge them
  const metaKeys = new Set(['tool', 'name', 'function', 'action', 'params', 'parameters', 'arguments', 'args']);
  for (const [k, v] of Object.entries(parsed)) {
    if (!metaKeys.has(k) && !(k in params)) {
      params[k] = v;
    }
  }
  console.log(`[ToolParser] normalizeToolCall DONE: tool=${toolName}`);

  return { tool: toolName, params: canonicalizeToolParams(toolName, params) };
}

// ─── Main Parser ───
function parseToolCalls(text) {
  if (!text || typeof text !== 'string') {
    console.log('[ToolParser] parseToolCalls: empty or non-string input');
    return [];
  }
  console.log(`[ToolParser] parseToolCalls START: textLen=${text.length}`);

  const calls = [];
  const seen = new Set(); // dedup by signature

  const addCall = (call) => {
    if (!call) return;
    const sig = `${call.tool}:${JSON.stringify(call.params)}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    calls.push(call);
  };

  // Method 0: XML tags — ◠...◠
  const xmlRe = /◠\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = xmlRe.exec(text)) !== null) {
    const parsed = tryParseJson(m[1]);
    if (parsed) addCall(normalizeToolCall(parsed));
  }

  // Method 0.5: <tool_code>...</tool_code> tags — some models output this format
  const toolCodeRe = /<tool_code>\s*([\s\S]*?)\s*<\/tool_code>/g;
  while ((m = toolCodeRe.exec(text)) !== null) {
    const inner = m[1].trim();
    const parsed = tryParseJson(inner);
    if (parsed) {
      addCall(normalizeToolCall(parsed));
    } else {
      const objects = extractJsonObjects(inner);
      for (const obj of objects) addCall(normalizeToolCall(obj));
    }
  }

  if (calls.length > 0) return _postProcess(calls, text);

  // Method 1: Fenced code blocks — ```tool_call / ```tool / ```json
  const fenceRe = /```(?:tool_call|tool|json)[^\n]*\n([\s\S]*?)```/g;
  while ((m = fenceRe.exec(text)) !== null) {
    const fenceContent = m[1];
    console.log(`[ToolParser] Method 1: Found fenced block (${fenceContent.length} chars). First 200: ${fenceContent.substring(0, 200).replace(/\n/g, '\\n')}`);
    const objects = extractJsonObjects(fenceContent);
    console.log(`[ToolParser] Method 1: extractJsonObjects returned ${objects.length} object(s)`);
    for (const obj of objects) {
      const normalized = normalizeToolCall(obj);
      if (!normalized) console.log(`[ToolParser] Method 1: normalizeToolCall returned null for keys: ${Object.keys(obj).join(', ')}`);
      addCall(normalized);
    }

    // Method 1.1 (Fix D): Regex fallback when JSON.parse fails on large fenced content
    // If the fenced block clearly contains a tool call but extractJsonObjects failed,
    // recover ALL tool calls via regex extraction (not just the first).
    if (objects.length === 0 && fenceContent.length > 50) {
      const toolMatches = [...fenceContent.matchAll(/"(?:tool|name)"\s*:\s*"([^"]+)"/g)];
      for (const toolMatch of toolMatches) {
        const rawToolName = toolMatch[1].toLowerCase().replace(/-/g, '_');
        const toolName = TOOL_NAME_ALIASES[rawToolName] || rawToolName;
        if (!VALID_TOOLS.has(toolName)) continue;
        console.log(`[ToolParser] Method 1.1: JSON parse failed but found tool name "${toolMatch[1]}" — attempting regex recovery`);
        const call = { tool: toolName, params: {}, _regexRecovered: true };
        // Extract filePath — find the one closest to this tool name match
        const pathMatches = [...fenceContent.matchAll(/"(?:filePath|file_path|path|filename)"\s*:\s*"([^"]+)"/gi)];
        if (pathMatches.length > 0) {
          // Use the path closest to this tool name (within 500 chars before or after)
          const toolIdx = toolMatch.index;
          let bestPath = null;
          let bestDist = Infinity;
          for (const pm of pathMatches) {
            const dist = Math.abs(pm.index - toolIdx);
            if (dist < bestDist) { bestDist = dist; bestPath = pm[1]; }
          }
          if (bestDist < 500) call.params.filePath = bestPath;
        }
        // Extract content for write/append tools
        if (toolName === 'write_file' || toolName === 'append_to_file') {
          const contentIdx = fenceContent.indexOf('"content"', toolMatch.index);
          if (contentIdx >= 0 && contentIdx - toolMatch.index < 500) {
            const colonIdx = fenceContent.indexOf(':', contentIdx + 9);
            if (colonIdx >= 0) {
              const quoteIdx = fenceContent.indexOf('"', colonIdx + 1);
              if (quoteIdx >= 0) {
                let rawContent = fenceContent.slice(quoteIdx + 1);
                rawContent = rawContent.replace(/"\s*\}\s*\}\s*\]?\s*$/, '');
                rawContent = rawContent.replace(/"\s*\}\s*$/, '');
                try {
                  rawContent = rawContent
                    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
                    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                } catch (_) {}
                if (rawContent.trim().startsWith('{"tool":') || rawContent.trim().startsWith('{"tool" :')) {
                  console.log(`[ToolParser] Method 1.1: Skipping recovered content — looks like tool call JSON leak`);
                } else if (rawContent.trim().length > 10) {
                  call.params.content = rawContent;
                  console.log(`[ToolParser] Method 1.1: Recovered ${toolName} with content (${rawContent.length} chars)`);
                }
              }
            }
          }
        }
        // Extract oldText/newText for edit_file
        if (toolName === 'edit_file') {
          const oldMatch = fenceContent.match(/"oldText"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (oldMatch) {
            try { call.params.oldText = oldMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); } catch (_) { call.params.oldText = oldMatch[1]; }
          }
          const newMatch = fenceContent.match(/"newText"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (newMatch) {
            try { call.params.newText = newMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); } catch (_) { call.params.newText = newMatch[1]; }
          }
          // If oldText is empty and newText has content, convert to write_file
          if (!call.params.oldText && call.params.newText && call.params.newText.length > 10) {
            console.log(`[ToolParser] Method 1.1: edit_file with empty oldText → converting to write_file`);
            call.tool = 'write_file';
            call.params.content = call.params.newText;
            delete call.params.oldText;
            delete call.params.newText;
          }
        }
        // Extract other common params via regex
        const _unescape = s => s.replace(/\\(.)/g, '$1');
        const queryMatch = fenceContent.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (queryMatch) call.params.query = _unescape(queryMatch[1]);
        const cmdMatch = fenceContent.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (cmdMatch) call.params.command = _unescape(cmdMatch[1]);
        const urlMatch = fenceContent.match(/"url"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (urlMatch) call.params.url = _unescape(urlMatch[1]);
        const dirMatch = fenceContent.match(/"dirPath"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (dirMatch) call.params.dirPath = _unescape(dirMatch[1]);
        // Infer filePath from content if missing
        if (!call.params.filePath && call.params.content) {
          call.params.filePath = _inferFilePath(text, call.params.content);
          console.log(`[ToolParser] Method 1.1: Inferred filePath: ${call.params.filePath}`);
        }
        addCall(call);
      }
    }
  }

  // Method 1.5: Unclosed fence at end of response
  if (calls.length === 0) {
    const unclosedRe = /```(?:tool_call|tool|json)[^\n]*\n([\s\S]+)$/;
    const unclosed = text.match(unclosedRe);
    if (unclosed) {
      const objects = extractJsonObjects(unclosed[1]);
      for (const obj of objects) addCall(normalizeToolCall(obj));
    }
  }

  // Method 1.6: Truncated tool call recovery — handles incomplete JSON from maxTokens cutoff
  // This catches cases where Method 1.5 fails because JSON is truncated mid-content
  if (calls.length === 0) {
    const fenceStart = text.search(/```(?:tool_call|tool|json)/);
    if (fenceStart !== -1) {
      const afterFence = text.slice(fenceStart);
      const hasClosingFence = /```(?:tool_call|tool|json)[^\n]*\n[\s\S]*?```/.test(afterFence);
      if (!hasClosingFence) {
        const toolNameMatch = afterFence.match(/\{\s*["']?(?:tool|name)["']?\s*:\s*["']([^"']+)["']/i);
        if (toolNameMatch) {
          const rawToolName = toolNameMatch[1].toLowerCase().replace(/-/g, '_');
          const toolName = TOOL_NAME_ALIASES[rawToolName] || rawToolName;
          if (VALID_TOOLS.has(toolName)) {
            const call = { tool: toolName, params: {}, _truncated: true };
            const pathMatch = afterFence.match(/"(?:filePath|file_path|path)"\s*:\s*"([^"]+)"/i);
            if (pathMatch) call.params.filePath = pathMatch[1];
            if (toolName === 'write_file' || toolName === 'append_to_file') {
              const contentMatch = afterFence.match(/"content"\s*:\s*"([\s\S]*)/);
              if (contentMatch) {
                let content = contentMatch[1];
                const lines = content.split('\\n');
                if (lines.length > 1) {
                  lines.pop();
                  content = lines.join('\\n');
                }
                content = content
                  .replace(/\\n/g, '\n')
                  .replace(/\\t/g, '\t')
                  .replace(/\\r/g, '\r')
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, '\\');
                call.params.content = content;
              }
            }
            if (toolName === 'read_file') {
              const rangeMatch = afterFence.match(/"(?:lineRange|lines)"\s*:\s*\[(\d+)\s*,\s*(\d+)\]/i);
              if (rangeMatch) call.params.lineRange = [parseInt(rangeMatch[1]), parseInt(rangeMatch[2])];
            }
            console.log(`[ToolParser] Recovered truncated ${toolName} call`);
            addCall(call);
          }
        }
      }
    }
  }

  if (calls.length > 0) return _postProcess(calls, text);

  // Method 1.8: OpenAI array format — [{"name":"...", "arguments":{...}}]
  const arrayRe = /\[\s*\{/g;
  while ((m = arrayRe.exec(text)) !== null) {
    let depth = 0;
    let inString = false;
    let escape = false;
    const start = m.index;
    let end = start;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"' && !inString) { inString = true; continue; }
      if (ch === '"' && inString) { inString = false; continue; }
      if (inString) continue;
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > start) {
      const arrayStr = text.slice(start, end);
      try {
        const arr = JSON.parse(arrayStr);
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const call = normalizeToolCall(item);
            if (call) addCall(call);
          }
        }
      } catch (_) {}
    }
  }

  if (calls.length > 0) return _postProcess(calls, text);

  // Method 2: Raw JSON objects with "tool" or "name" key
  const rawJsonRe = /\{\s*["']?(?:tool|name)["']?\s*:\s*["'][^"']+["']/g;
  while ((m = rawJsonRe.exec(text)) !== null) {
    console.log(`[ToolParser] Method 2: Found raw JSON at offset ${m.index}. Match: ${m[0]}`);
    const objects = extractJsonObjects(text.slice(m.index));
    console.log(`[ToolParser] Method 2: extractJsonObjects returned ${objects.length} object(s)`);
    for (const obj of objects) addCall(normalizeToolCall(obj));
  }

  if (calls.length > 0) return _postProcess(calls, text);

  // Method 3: Alternative formats
  // 3a: Function-call syntax — tool_name({"param":"value"})
  for (const toolName of VALID_TOOLS) {
    const funcRe = new RegExp(`\\b${toolName}\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)`, 'g');
    while ((m = funcRe.exec(text)) !== null) {
      const parsed = tryParseJson(m[1]);
      if (parsed) addCall(normalizeToolCall({ tool: toolName, params: parsed }));
    }
  }

  // 3a.5: String-arg function calls — write_file('path', 'content')
  const stringArgRe = /\b(write_file|read_file|edit_file)\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"`]([\s\S]*?)['"`]\s*\)/g;
  while ((m = stringArgRe.exec(text)) !== null) {
    const toolName = m[1];
    if (toolName === 'write_file') {
      addCall({ tool: 'write_file', params: { filePath: m[2], content: m[3] } });
    } else if (toolName === 'read_file') {
      addCall({ tool: 'read_file', params: { filePath: m[2] } });
    } else if (toolName === 'edit_file') {
      addCall({ tool: 'edit_file', params: { filePath: m[2], oldText: m[3] } });
    }
  }

  // 3b: Plain JSON with filePath+content but no "tool" key → write_file
  if (calls.length === 0) {
    const objects = extractJsonObjects(text);
    for (const obj of objects) {
      if (obj.filePath && obj.content && !obj.tool) {
        addCall({ tool: 'write_file', params: { filePath: obj.filePath, content: obj.content } });
      }
    }
  }

  console.log(`[ToolParser] parseToolCalls DONE: calls=${calls.length}`);
  return _postProcess(calls, text);
}

function _postProcess(calls, text) {
  console.log(`[ToolParser] _postProcess: calls=${calls?.length || 0}`);
  // Passthrough — no regex-based tool conversion.
  // The model must call the correct tool explicitly.
  return calls;
}

// ─── Tool Call Repair ───
function repairToolCalls(toolCalls, responseText) {
  console.log(`[ToolParser] repairToolCalls START: toolCalls=${toolCalls?.length || 0}`);
  const repaired = [];
  const issues = [];
  const droppedFilePaths = [];

  for (const call of toolCalls) {
    const { tool, params } = call;

    if (tool === 'write_file') {
      // Empty content recovery
      if (!params.content || String(params.content).length < 5) {
        const recovered = _recoverWriteFileContent(responseText, params.filePath);
        if (recovered) {
          repaired.push(recovered);
          issues.push(`Recovered write_file content for ${params.filePath || 'unknown'}`);
          continue;
        }
        // Unrecoverable — drop and record path
        if (params.filePath) droppedFilePaths.push(params.filePath);
        issues.push(`Dropped write_file with empty content: ${params.filePath || 'unknown'}`);
        continue;
      }
      // Empty filePath
      if (!params.filePath) {
        params.filePath = _inferFilePath(responseText, params.content);
        issues.push(`Inferred filePath: ${params.filePath}`);
      }
    }

    if (tool === 'edit_file') {
      if (!params.oldText && !params.newText && !params.lineRange) {
        issues.push('Dropped edit_file with empty oldText/newText');
        continue;
      }
    }

    if (tool === 'browser_navigate') {
      if (!params.url) {
        issues.push('Dropped browser_navigate with empty URL');
        continue;
      }
      // Auto-prepend https:// if missing
      if (!/^https?:\/\//i.test(params.url) && !params.url.startsWith('file://')) {
        params.url = 'https://' + params.url;
      }
    }

    // Plan D: structural recovery for browser interaction tools that need an element handle.
    if (tool === 'browser_click' || tool === 'browser_type' || tool === 'browser_hover' ||
        tool === 'browser_fill' || tool === 'browser_select' || tool === 'browser_select_option' ||
        tool === 'browser_drag' || tool === 'browser_press_key') {
      const hasHandle = params.ref || params.element || params.selector || params.target ||
                        params.startTarget || params.endTarget || params.key;
      if (!hasHandle) {
        issues.push(`Dropped ${tool} with no ref/element/selector/target`);
        continue;
      }
    }

    if (tool === 'run_command' || tool === 'execute_command' || tool === 'shell') {
      const cmd = params.command || params.cmd || params.script;
      if (!cmd || String(cmd).trim().length === 0) {
        issues.push(`Dropped ${tool} with empty command`);
        continue;
      }
      // Normalize alternative param names
      if (!params.command && cmd) params.command = cmd;
    }

    if (tool === 'read_file' || tool === 'get_file_info') {
      if (!params.filePath && !params.path && !params.file) {
        issues.push(`Dropped ${tool} with no filePath`);
        continue;
      }
      // Normalize alternative param names
      if (!params.filePath) params.filePath = params.path || params.file;
    }

    if (tool === 'web_search') {
      if (!params.query && !params.q) {
        issues.push('Dropped web_search with empty query');
        continue;
      }
      if (!params.query && params.q) params.query = params.q;
    }

    if (tool === 'fetch_webpage') {
      if (!params.url) {
        issues.push('Dropped fetch_webpage with empty url');
        continue;
      }
      if (!/^https?:\/\//i.test(params.url) && !params.url.startsWith('file://')) {
        params.url = 'https://' + params.url;
      }
    }

    repaired.push(call);
  }

  // Last-resort recovery if all calls were dropped
  if (repaired.length === 0 && toolCalls.length > 0) {
    const recovered = _recoverWriteFileContent(responseText);
    if (recovered) {
      repaired.push(recovered);
      issues.push('Last-resort write_file recovery from response text');
    }
  }

  console.log(`[ToolParser] repairToolCalls DONE: repaired=${repaired.length}, issues=${issues.length}, dropped=${droppedFilePaths.length}`);
  return { repaired, issues, droppedFilePaths };
}

// ─── Content Recovery ───
function _recoverWriteFileContent(text, preferredFilePath) {
  if (!text) return null;
  const codeBlockRe = /```(?:\w+)?\n([\s\S]*?)```/g;
  let largest = '';
  let m;
  while ((m = codeBlockRe.exec(text)) !== null) {
    const block = m[1];
    // Skip blocks that are tool-call JSON syntax — they are NOT file content
    if (/"(?:tool|name)"\s*:\s*"/.test(block)) continue;
    if (block.length > largest.length) largest = block;
  }
  if (largest.length < 50) return null;
  const filePath = preferredFilePath || _inferFilePath(text, largest);
  return { tool: 'write_file', params: { filePath, content: largest } };
}

function _inferFilePath(text, content, lang) {
  // Try to find a file path mentioned in the response
  const pathRe = /\b([\w.-]+\.(?:js|ts|jsx|tsx|py|html|css|json|md|yaml|yml|xml|toml|sh|bat|sql|rb|go|rs|c|cpp|h|hpp|java|swift|kt))\b/i;
  const match = text.match(pathRe);
  if (match) return match[1];
  // Infer from content type
  if (content) {
    if (content.includes('<!DOCTYPE') || content.includes('<html')) return 'index.html';
    if (content.includes('import React') || content.includes('from "react"')) return 'component.jsx';
    if (/^[.#@][a-zA-Z][\w-]*\s*\{/m.test(content) || /@media\s|@keyframes\s|@import\s|:root\s*\{/.test(content)) return 'style.css';
    if (content.includes('def ') || content.includes('import ')) return 'script.py';
    if (content.trimStart().startsWith('{')) return 'data.json';
  }
  // Infer from language hint
  const langToExt = {
    javascript: 'script.js', typescript: 'script.ts', python: 'script.py',
    html: 'index.html', css: 'style.css', json: 'data.json',
    markdown: 'document.md', yaml: 'config.yaml', shell: 'script.sh',
    bash: 'script.sh', ruby: 'script.rb', go: 'main.go', rust: 'main.rs',
  };
  if (lang && langToExt[lang.toLowerCase()]) return langToExt[lang.toLowerCase()];
  return 'output.txt';
}

// ─── Strip Tool Call Text ───
// Removes tool call JSON blocks from model output text, leaving only prose.
// Uses the same structural patterns that parseToolCalls detects.
// Returns the cleaned text (empty string if nothing remains).
function stripToolCallText(text) {
  if (!text || typeof text !== 'string') {
    console.log('[ToolParser] stripToolCallText: empty or non-string input');
    return '';
  }
  console.log(`[ToolParser] stripToolCallText START: textLen=${text.length}`);
  const ranges = [];
  let m;

  // Pattern 0a: <tool_call>...</tool_call> blocks (GLM/Qwen XML)
  const toolCallXmlRe = /<tool_call>[\s\S]*?<\/tool_call>/g;
  while ((m = toolCallXmlRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Pattern 0b: orphan <tool_call> through end (truncated generation)
  const orphanToolCallRe = /<tool_call>[\s\S]*$/g;
  while ((m = orphanToolCallRe.exec(text)) !== null) {
    if (!_isInsideExistingRange(ranges, m.index)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }

  // Pattern 0c: <arg_key>...</arg_key><arg_value>...</arg_value> pairs
  const argPairRe = /<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>/g;
  while ((m = argPairRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Pattern 1: XML ◠...◠
  const xmlRe = /◠\s*[\s\S]*?\s*<\/tool_call>/g;
  while ((m = xmlRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Pattern 1.5: <tool_code>...</tool_code> tags
  const toolCodeRe = /<tool_code>\s*[\s\S]*?\s*<\/tool_code>/g;
  while ((m = toolCodeRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Pattern 2: Fenced code blocks (```json / ```tool_call / ```tool / ```) containing "tool":
  const fenceRe = /```(?:json|tool_call|tool)?\s*\n([\s\S]*?)```/g;
  while ((m = fenceRe.exec(text)) !== null) {
    const inner = m[1];
    if (/"tool"\s*:/.test(inner) || /"name"\s*:/.test(inner)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }

  // Pattern 3: Unclosed fenced blocks at end of text
  const unclosedFenceRe = /```(?:json|tool_call|tool)\s*\n([\s\S]*)$/g;
  while ((m = unclosedFenceRe.exec(text)) !== null) {
    const inner = m[1];
    if (/"tool"\s*:/.test(inner) || /"name"\s*:/.test(inner)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }

  // Pattern 4: Raw JSON objects with "tool" or "name" key, using brace-counting
  const rawJsonRe = /(?:^|\n)[ \t]*\{/gm;
  while ((m = rawJsonRe.exec(text)) !== null) {
    const jsonStart = text.indexOf('{', m.index);
    if (_isInsideExistingRange(ranges, jsonStart)) continue;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let jsonEnd = -1;
    for (let i = jsonStart; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inStr) { escaped = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    }
    if (jsonEnd > jsonStart) {
      const slice = text.slice(jsonStart, jsonEnd);
      if (/"tool"\s*:/.test(slice) || /"name"\s*:/.test(slice)) {
        try {
          const parsed = JSON.parse(slice);
          if (parsed && typeof parsed === 'object' && (parsed.tool || parsed.name)) {
            const rangeStart = (text[m.index] === '\n') ? m.index : jsonStart;
            ranges.push([rangeStart, jsonEnd]);
          }
        } catch { /* not valid JSON — skip */ }
      }
    }
  }

  if (ranges.length === 0) return text;

  // Sort and merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push([...ranges[i]]);
    }
  }

  // Build result excluding the removed ranges
  let result = '';
  let pos = 0;
  for (const [start, end] of merged) {
    result += text.slice(pos, start);
    pos = end;
  }
  result += text.slice(pos);

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function _isInsideExistingRange(ranges, index) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

// Add a tool name to VALID_TOOLS at runtime (used by MCP client for dynamically discovered tools)
function addValidTool(name) {
  if (typeof name === 'string' && name.trim() && !VALID_TOOLS.has(name)) {
    VALID_TOOLS.add(name);
  }
}

module.exports = {
  TOOL_NAME_ALIASES,
  VALID_TOOLS,
  addValidTool,
  sanitizeJson,
  fixQuoting,
  fixBackticks,
  tryParseJson,
  extractJsonObjects,
  normalizeToolCall,
  parseToolCalls,
  repairToolCalls,
  stripToolCallText,
  _recoverWriteFileContent,
  _inferFilePath,
};
