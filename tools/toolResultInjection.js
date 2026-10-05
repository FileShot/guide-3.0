'use strict';

const crypto = require('crypto');

const TOOL_INJECT_MULTIPLIERS = {
  browser_snapshot: 1.5,
  browser_navigate: 1.5,
  browser_click: 1.5,
  browser_type: 1.5,
  viewport_browser_snapshot: 1.5,
  browser_screenshot: 0.5,
  read_file: 0.5,
  fetch_webpage: 0.5,
  web_search: 0.25,
  http_request: 0.25,
};

const BROWSER_SMART_TOOLS = new Set([
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'viewport_browser_snapshot',
]);

const WRITE_ACK_TOOLS = new Set(['write_file', 'create_file', 'append_to_file']);

/**
 * Format a tool result for injection into model context (prose or native FC).
 * Adaptive: under cap → full; over cap → keep refs / metadata + max body.
 */
function formatListDirectoryInject(toolResult) {
  const items = toolResult && Array.isArray(toolResult.items) ? toolResult.items : null;
  if (!items) return null;
  const lines = items.slice(0, 80).map((item) => {
    const name = item && (item.name || item.path) ? (item.name || item.path) : '';
    const kind = item && item.type ? item.type : 'file';
    return name ? `${kind}\t${name}` : '';
  }).filter(Boolean);
  const more = items.length > lines.length ? `\n… ${items.length - lines.length} more` : '';
  return `Listed ${items.length} entries\n${lines.join('\n')}${more}`;
}

/** PowerShell CLIXML → plain error/output lines (runcmdclixml1). */
function stripPowerShellCliXml(text) {
  const s = String(text || '');
  if (!/#<\s*CLIXML/i.test(s) && !/<Objs[\s>]/i.test(s)) return s;
  const msgs = [];
  const re = /<S\b[^>]*>([^<]*)<\/S>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const decoded = m[1]
      .replace(/_x000D_/g, '')
      .replace(/_x000A_/g, '\n')
      .replace(/_x0009_/g, '\t')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
    if (decoded) msgs.push(decoded);
  }
  if (msgs.length) {
    return msgs.join('\n').trim();
  }
  return s.replace(/#<\s*CLIXML[\s\S]*$/i, '').trim() || '[PowerShell CLIXML output stripped]';
}

function normalizeRunCommandResult(toolResult) {
  if (!toolResult || typeof toolResult !== 'object') return toolResult;
  const out = { ...toolResult };
  if (typeof out.output === 'string') out.output = stripPowerShellCliXml(out.output);
  if (typeof out.stderr === 'string') out.stderr = stripPowerShellCliXml(out.stderr);
  if (typeof out.stdout === 'string') out.stdout = stripPowerShellCliXml(out.stdout);
  if (typeof out.error === 'string') out.error = stripPowerShellCliXml(out.error);
  if (typeof out.message === 'string') out.message = stripPowerShellCliXml(out.message);
  return out;
}

function sha12(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
}

/** Compact success ack — never re-echo full file body (writeack1). */
function formatWriteSuccessAck(toolName, toolResult) {
  if (!WRITE_ACK_TOOLS.has(toolName)) return null;
  if (!toolResult || toolResult.success === false) return null;
  const path = toolResult.path || toolResult.filePath || '';
  const body = typeof toolResult.content === 'string'
    ? toolResult.content
    : (typeof toolResult.fullContent === 'string' ? toolResult.fullContent : '');
  const bytes = body ? Buffer.byteLength(body, 'utf8') : (typeof toolResult.bytes === 'number' ? toolResult.bytes : undefined);
  const lines = body ? body.split(/\r?\n/).length : undefined;
  const ack = {
    success: true,
    path,
    isNew: toolResult.isNew,
    note: 'Disk write OK. Call read_file on this path if you need to inspect bytes.',
  };
  if (bytes != null) ack.bytes = bytes;
  if (lines != null) ack.lines = lines;
  if (body) ack.sha256_12 = sha12(body);
  if (toolName === 'append_to_file' && toolResult.message) {
    ack.message = String(toolResult.message).slice(0, 200);
  }
  return JSON.stringify(ack);
}

/** Prefer plain snapshot text so Page-text smart split works (not JSON \\n). */
function extractBrowserPlainText(toolResult) {
  if (typeof toolResult === 'string') return toolResult;
  if (!toolResult || typeof toolResult !== 'object') return null;
  if (typeof toolResult.text === 'string' && toolResult.text.includes('Page text:')) {
    return toolResult.text;
  }
  if (typeof toolResult.snapshot === 'string' && toolResult.snapshot.includes('Page text:')) {
    return toolResult.snapshot;
  }
  return null;
}

function splitPageText(plain) {
  const marker = '\nPage text:\n';
  const idx = plain.indexOf(marker);
  if (idx === -1) {
    const alt = plain.indexOf('Page text:\n');
    if (alt === -1) return null;
    return {
      elementSection: plain.substring(0, alt) + 'Page text:\n',
      textSection: plain.substring(alt + 'Page text:\n'.length),
    };
  }
  return {
    elementSection: plain.substring(0, idx + marker.length),
    textSection: plain.substring(idx + marker.length),
  };
}

function packHeadTail(text, budget) {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  if (budget <= 80) return text.substring(0, budget);
  const headSize = Math.floor(budget * 0.7);
  const tailSize = Math.max(0, budget - headSize - 60);
  const mid = '\n[... middle section omitted for context size — call browser_scroll to see more]\n';
  return (
    text.substring(0, headSize) +
    mid +
    text.substring(Math.max(headSize, text.length - tailSize))
  );
}

function adaptiveBrowserInject(plain, injectCap) {
  if (plain.length <= injectCap) return plain;
  const split = splitPageText(plain);
  if (!split) {
    return plain.slice(0, injectCap) + '\n[... result truncated by system for context size; use browser_scroll to see more]';
  }
  const { elementSection, textSection } = split;
  if (elementSection.length >= injectCap) {
    return (
      elementSection.slice(0, Math.min(elementSection.length, injectCap)) +
      '\n[... page text omitted — interactive refs kept; call browser_scroll / re-snapshot for body]'
    );
  }
  const budgetForText = injectCap - elementSection.length;
  return elementSection + packHeadTail(textSection, budgetForText);
}

function adaptiveReadFileInject(toolResult, injectCap) {
  const path = toolResult.path || toolResult.filePath || '';
  const content = typeof toolResult.content === 'string' ? toolResult.content : '';
  const meta = {
    success: toolResult.success !== false,
    path,
    totalLines: toolResult.totalLines,
    readRange: toolResult.readRange,
  };
  const metaStr = JSON.stringify(meta);
  if (!content) return metaStr.length <= injectCap ? metaStr : metaStr.slice(0, injectCap);
  const prefix = `${metaStr}\n---\n`;
  if (prefix.length + content.length <= injectCap) return prefix + content;
  const budget = Math.max(0, injectCap - prefix.length);
  return prefix + packHeadTail(content, budget);
}

function formatToolResultForInject(toolName, toolResult, { contextTokens = 8192, promptTokensUsed = 0, injectBudgetChars = 0 } = {}) {
  if (toolName === 'list_directory' || toolName === 'get_project_structure') {
    const listed = formatListDirectoryInject(toolResult);
    if (listed) return listed;
  }

  let result = toolResult;
  if (toolName === 'run_command' || toolName === 'terminal_run') {
    result = normalizeRunCommandResult(toolResult);
  }

  const writeAck = formatWriteSuccessAck(toolName, result);
  if (writeAck) return writeAck;

  // bscreenshotnovision1 — never inject raw base64 screenshots into text models
  if (toolName === 'browser_screenshot' && result && typeof result === 'object') {
    const ack = {
      success: !!result.success,
      path: result.path || null,
      bytes: result.bytes || 0,
      note: result.note || 'image saved; text model cannot view pixels — use browser_snapshot',
      error: result.error || undefined,
    };
    return JSON.stringify(ack);
  }

  // Size from room left in the window. Also bound one inject so the next prefill stays
  // interactive (~3k tokens). Full files stay available via read_file startLine/endLine.
  // Live 2026-09-29: empty-window 40% share let AGENT-CHANGES inject 40140 chars → ~2 min prefill.
  const ctx = contextTokens > 0 ? contextTokens : 8192;
  const used = Math.max(0, Number(promptTokensUsed) || 0);
  const remainingTokens = Math.max(1024, ctx - used - 8192);
  const remainingChars = remainingTokens * 4;
  const TOOL_RESULT_SHARE = 0.25;
  const MAX_TOOL_SHARE = 0.40;
  const INTERACTIVE_PREFILL_CHARS = 12000;
  const baseCap = Math.floor(remainingChars * TOOL_RESULT_SHARE);
  const multiplier = TOOL_INJECT_MULTIPLIERS[toolName] || 1.0;
  const callerBudget = injectBudgetChars > 0 ? injectBudgetChars : INTERACTIVE_PREFILL_CHARS;
  const injectCap = Math.max(
    2000,
    Math.min(
      Math.floor(baseCap * multiplier),
      Math.floor(remainingChars * MAX_TOOL_SHARE),
      callerBudget,
      INTERACTIVE_PREFILL_CHARS,
    ),
  );

  if (BROWSER_SMART_TOOLS.has(toolName)) {
    const plain = extractBrowserPlainText(result);
    if (plain) return adaptiveBrowserInject(plain, injectCap);
  }

  if (toolName === 'read_file' && result && typeof result === 'object') {
    return adaptiveReadFileInject(result, injectCap);
  }

  let injectResult = typeof result === 'string' ? result : JSON.stringify(result);
  if (injectResult.length <= injectCap) return injectResult;
  return injectResult.slice(0, injectCap) + '\n[... result truncated by system for context size; use only text above]';
}

function buildToolResultsUserMessage(toolResultLines, { interruptPrefix = '' } = {}) {
  const lines = Array.isArray(toolResultLines) ? toolResultLines : [];
  // Structural results only (RULES §11). Host continue/stop = roundIsIncomplete + todo ledger.
  // No English next-step coaching in this inject — results lines only.
  return (
    `${interruptPrefix}[System: Tool Results]\n`
    + `${lines.join('\n')}`
  );
}

function sanitizeCloudConversationHistory(messages, { parseToolCalls, stripToolCallText }) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    let content = String(m.content ?? '').trim();
    if (!content) continue;
    if (/^\[(?:System: )?Tool Results\]/i.test(content)) continue;
    content = content.replace(/\n*\*\*Tool run\*\*[^\n]*/g, '').trim();
    if (!content) continue;
    if (m.role === 'assistant' && parseToolCalls && stripToolCallText) {
      const calls = parseToolCalls(content);
      if (calls.length > 0) {
        const visible = stripToolCallText(content).trim();
        if (!visible) continue;
        content = visible;
      }
    }
    out.push({ role: m.role, content });
  }
  return out;
}

module.exports = {
  TOOL_INJECT_MULTIPLIERS,
  BROWSER_SMART_TOOLS,
  formatToolResultForInject,
  buildToolResultsUserMessage,
  sanitizeCloudConversationHistory,
  stripPowerShellCliXml,
  formatWriteSuccessAck,
};
