'use strict';

const TOOL_INJECT_MULTIPLIERS = {
  browser_snapshot: 1.5,
  browser_navigate: 1.5,
  browser_click: 1.5,
  browser_type: 1.5,
  browser_screenshot: 0.5,
  read_file: 0.5,
  fetch_webpage: 0.5,
  web_search: 0.25,
};

/**
 * Format a tool result for injection into model context (prose or native FC).
 * Applies context-proportional truncation matching local chatEngine behavior.
 */
function formatToolResultForInject(toolName, toolResult, { contextTokens = 8192 } = {}) {
  let injectResult = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

  const ctxChars = (contextTokens || 8192) * 4;
  const TOOL_RESULT_SHARE = 0.25;
  const MAX_TOOL_SHARE = 0.40;
  const baseCap = Math.floor(ctxChars * TOOL_RESULT_SHARE);
  const multiplier = TOOL_INJECT_MULTIPLIERS[toolName] || 1.0;
  const injectCap = Math.min(
    Math.floor(baseCap * multiplier),
    Math.floor(ctxChars * MAX_TOOL_SHARE),
  );

  if (injectResult.length <= injectCap) return injectResult;

  if (
    toolName === 'browser_snapshot' ||
    toolName === 'browser_navigate' ||
    toolName === 'browser_click' ||
    toolName === 'browser_type'
  ) {
    const pageTextIdx = injectResult.indexOf('\nPage text:\n');
    if (pageTextIdx !== -1) {
      const elementSection = injectResult.substring(0, pageTextIdx + 12);
      const textSection = injectResult.substring(pageTextIdx + 12);
      const budgetForText = injectCap - elementSection.length;
      if (budgetForText > 500) {
        const headSize = Math.floor(budgetForText * 0.7);
        const tailSize = budgetForText - headSize - 60;
        return (
          elementSection +
          textSection.substring(0, headSize) +
          '\n[... middle section omitted for context size — call browser_scroll to see more]\n' +
          textSection.substring(Math.max(headSize, textSection.length - tailSize))
        );
      }
      return (
        elementSection +
        textSection.substring(0, budgetForText) +
        '\n[... result truncated — call browser_scroll to see more content]'
      );
    }
  }

  return injectResult.slice(0, injectCap) + '\n[... result truncated by system for context size; use only text above]';
}

/**
 * Build the user-turn message that carries tool results back to the model (prose path / native fallback).
 */
function buildToolResultsUserMessage(toolResultLines, { interruptPrefix = '' } = {}) {
  const lines = Array.isArray(toolResultLines) ? toolResultLines : [];
  return (
    `${interruptPrefix}[System: Tool Results]\n` +
    'The tools below have ALREADY been executed. Do not repeat these actions or re-narrate work that is already complete. ' +
    'Use the results below and call a different tool only if more work is still needed.\n\n' +
    `${lines.join('\n')}\n\n` +
    'Continue with any remaining steps. Call the next tool if more work is needed, or explain the result if the task is complete.'
  );
}

/**
 * Sanitize UI chat messages before sending as cloud API conversation history.
 */
function sanitizeCloudConversationHistory(messages, { parseToolCalls, stripToolCallText }) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    let content = String(m.content ?? '').trim();
    if (!content) continue;
    if (/^\[(?:System: )?Tool Results\]/i.test(content)) continue;
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
  formatToolResultForInject,
  buildToolResultsUserMessage,
  sanitizeCloudConversationHistory,
};
