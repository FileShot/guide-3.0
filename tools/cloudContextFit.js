'use strict';

/** Chars per token used to stay under the server window. Code is denser than English. */
const CHARS_PER_TOKEN = 3;
const NOTICE_MARK = '[System: Session memory condensed]';

function messageText(message) {
  if (message == null) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (part && part.type === 'text' ? String(part.text || '') : '')).join('');
  }
  return JSON.stringify(message.content || '');
}

function estimateTokens(text) {
  const s = String(text || '');
  return Math.ceil(s.length / CHARS_PER_TOKEN) + 4;
}

function inputBudgetTokens(contextLimit, outputTokens) {
  const ctx = contextLimit > 0 ? contextLimit : 24576;
  const out = outputTokens > 0 ? outputTokens : 8192;
  return Math.max(512, ctx - out - 256);
}

function isNotice(message) {
  return message && message.role === 'user' && messageText(message).includes(NOTICE_MARK);
}

function buildDroppedSummary(dropped, taskHint) {
  const done = [];
  const seen = new Set();
  const push = (line) => {
    const t = String(line || '').trim();
    if (!t || seen.has(t) || done.length >= 24) return;
    seen.add(t);
    done.push(t);
  };
  const users = [];
  for (const message of dropped) {
    const text = messageText(message).trim();
    if (!text || isNotice(message)) continue;
    if (message.role === 'user' && !/^\[System:/i.test(text)) {
      if (users.length < 3) users.push(text.replace(/\s+/g, ' ').slice(0, 400));
    }
    const toolNames = text.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/g) || [];
    const filePaths = text.match(/"(?:filePath|path)"\s*:\s*"([^"]+)"/g) || [];
    const names = [...new Set(toolNames.map((m) => m.replace(/.*:\s*"/, '').replace(/"$/, '')))];
    const paths = [...new Set(filePaths.map((m) => m.replace(/.*:\s*"/, '').replace(/"$/, '')))];
    if (names.length) push(paths.length ? `${names.join(', ')} → ${paths.join(', ')}` : names.join(', '));
    const loosePath = text.match(/\b[\w./\\-]+\.(?:js|ts|tsx|jsx|py|html|css|json|md)\b/g) || [];
    for (const p of loosePath.slice(0, 4)) push(`file: ${p}`);
  }
  const sections = [];
  if (taskHint) sections.push(`TASK:\n${String(taskHint).replace(/\s+/g, ' ').slice(0, 400)}`);
  else if (users[0]) sections.push(`TASK:\n${users[0]}`);
  if (done.length) sections.push(`DONE:\n${done.join('\n')}`);
  if (users.length > 1) sections.push(`RECENT USER:\n${users.slice(-2).join('\n---\n')}`);
  sections.push('NEXT: continue the active task. Do not repeat completed work.');
  return sections.join('\n\n').slice(0, 2400);
}

function noticeFor(dropped, taskHint) {
  const summary = buildDroppedSummary(dropped, taskHint);
  return {
    role: 'user',
    content: `${NOTICE_MARK} ${dropped.length} earlier turn(s) summarized.\n${summary}\nDo not mention context limits or rotation to the user.\n`,
  };
}

/**
 * Keep system + recent history + the current user text inside the server window.
 * Dropped turns become one condensation notice so the task can continue.
 */
function fitCloudHistory({ systemPrompt, history, nextUser, contextLimit, outputTokens, budgetTokens }) {
  const budget = budgetTokens > 0 ? budgetTokens : inputBudgetTokens(contextLimit, outputTokens);
  let hist = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.role)
    .map((m) => ({ role: m.role, content: messageText(m) }));
  let user = String(nextUser || '');

  const cost = (list, userText) => (
    estimateTokens(systemPrompt)
    + estimateTokens(userText)
    + list.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  );

  if (cost(hist, user) <= budget) {
    return { history: hist, nextUser: user, droppedCount: 0, droppedText: '' };
  }

  const dropped = [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (isNotice(hist[i])) dropped.unshift(hist.splice(i, 1)[0]);
  }
  while (hist.length > 0 && cost(hist, user) > budget) {
    dropped.push(hist.shift());
  }
  while (estimateTokens(systemPrompt) + estimateTokens(user) > budget && user.length > 400) {
    user = user.slice(0, Math.floor(user.length * 0.75));
  }

  if (dropped.length) {
    hist = [noticeFor(dropped, user), ...hist];
    while (hist.length > 1 && cost(hist, user) > budget) hist.splice(1, 1);
    if (cost(hist, user) > budget && isNotice(hist[0])) {
      hist[0] = { role: 'user', content: hist[0].content.slice(0, 1500) };
    }
  }

  return {
    history: hist,
    nextUser: user,
    droppedCount: dropped.length,
    droppedText: dropped.map((m) => `${m.role}: ${messageText(m).slice(0, 500)}`).join('\n').slice(0, 6000),
  };
}

function replaceCondensedNotice(history, summary) {
  const text = String(summary || '').trim();
  if (!text) return history;
  const copy = history.slice();
  const idx = copy.findIndex(isNotice);
  if (idx < 0) return copy;
  copy[idx] = {
    role: 'user',
    content: `${NOTICE_MARK}\n${text.slice(0, 1800)}\nDo not mention context limits or rotation to the user.\n`,
  };
  return copy;
}

module.exports = {
  CHARS_PER_TOKEN,
  NOTICE_MARK,
  messageText,
  estimateTokens,
  inputBudgetTokens,
  fitCloudHistory,
  replaceCondensedNotice,
  buildDroppedSummary,
};
