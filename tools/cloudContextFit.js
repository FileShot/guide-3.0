'use strict';

/** Chars per token used to stay under the server window. Dense HTML/JSON undercounted at 3 vs llama. */
const CHARS_PER_TOKEN = 2;
const NOTICE_MARK = '[System: Session memory condensed]';

/** Per-message and total caps for summarizer transcript (more signal than the old 500×6k). */
const DROPPED_MSG_CHARS = 1800;
const DROPPED_TOTAL_CHARS = 14000;
const KEPT_TAIL_MSG_CHARS = 800;
const KEPT_TAIL_TOTAL_CHARS = 4000;

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
  const ctx = contextLimit > 0 ? contextLimit : 131072;
  const out = outputTokens > 0 ? outputTokens : 8192;
  return Math.max(512, ctx - out - 256);
}

/** Characters of a request as the server receives it: system + history + next user text. */
function promptChars(systemPrompt, list, userText) {
  return String(systemPrompt || '').length
    + String(userText || '').length
    + (Array.isArray(list) ? list.reduce((sum, m) => sum + messageText(m).length, 0) : 0);
}

/**
 * measured = { promptTokens, promptChars } from the server's last reply (llama timings).
 * The measured part costs its real tokens; only characters added since then use chars/2.
 */
function measuredCost(measured, chars, estimate) {
  if (!measured || !(measured.promptTokens > 0) || !(measured.promptChars > 0)) return estimate;
  if (chars >= measured.promptChars) {
    return measured.promptTokens + Math.ceil((chars - measured.promptChars) / CHARS_PER_TOKEN);
  }
  return Math.ceil(chars * (measured.promptTokens / measured.promptChars));
}

function isNotice(message) {
  return message && message.role === 'user' && messageText(message).includes(NOTICE_MARK);
}

function isSystemInject(text) {
  return /^\[System:/i.test(String(text || '').trim());
}

/** Role-prefixed transcript for the summarizer — users get full slice, assistants get body too. */
function formatDroppedTranscript(dropped, { perMsg = DROPPED_MSG_CHARS, total = DROPPED_TOTAL_CHARS } = {}) {
  if (!Array.isArray(dropped) || !dropped.length) return '';
  const lines = [];
  let used = 0;
  for (const message of dropped) {
    const role = message?.role || 'unknown';
    const text = messageText(message).trim();
    if (!text || isNotice(message)) continue;
    const slice = text.slice(0, perMsg);
    const line = `${role}: ${slice}`;
    if (used + line.length + 1 > total) {
      const room = total - used - 1;
      if (room > 80) lines.push(line.slice(0, room));
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function formatKeptTail(history, { perMsg = KEPT_TAIL_MSG_CHARS, total = KEPT_TAIL_TOTAL_CHARS, maxMsgs = 6 } = {}) {
  if (!Array.isArray(history) || !history.length) return '';
  const nonNotice = history.filter((m) => m && !isNotice(m));
  const tail = nonNotice.slice(-maxMsgs);
  return formatDroppedTranscript(tail, { perMsg, total });
}

function todoLedgerNote(activeTodos) {
  if (!Array.isArray(activeTodos)) {
    return 'TODO LEDGER: unavailable this rotation — derive OPEN from TASK + dropped + kept transcript.';
  }
  if (activeTodos.length === 0) {
    return (
      'TODO LEDGER: empty (agent never called write_todos, or list was cleared). '
      + 'Do NOT write OPEN: none. List unfinished goals from TASK and the transcripts under OPEN.'
    );
  }
  const open = activeTodos.filter((t) => t && (t.status === 'pending' || t.status === 'in-progress'));
  const done = activeTodos.filter((t) => t && t.status === 'done');
  if (open.length) {
    const lines = open.map((t) => `- id ${t.id}: ${String(t.text || '').slice(0, 120)} [${t.status}]`);
    return `TODO LEDGER (open — must appear under OPEN):\n${lines.join('\n')}`;
  }
  return (
    `TODO LEDGER: ${done.length} item(s) marked done, zero open. `
    + 'Do NOT write OPEN: none solely because of that. If TASK / dropped / kept transcript still imply unfinished work, list it under OPEN.'
  );
}

function buildDroppedSummary(dropped, taskHint, activeTodos) {
  const done = [];
  const seen = new Set();
  const push = (line) => {
    const t = String(line || '').trim();
    if (!t || seen.has(t) || done.length >= 24) return;
    seen.add(t);
    done.push(t);
  };
  const users = [];
  const assistantSnips = [];
  for (const message of dropped) {
    const text = messageText(message).trim();
    if (!text || isNotice(message)) continue;
    if (message.role === 'user' && !isSystemInject(text)) {
      if (users.length < 4) users.push(text.replace(/\s+/g, ' ').slice(0, 500));
    }
    if (message.role === 'assistant' && assistantSnips.length < 4) {
      // Prefer non-tool prose heads so the stub keeps plan/answer text, not only JSON.
      const proseHead = text.replace(/^\s*\{[\s\S]*$/, '').trim().replace(/\s+/g, ' ').slice(0, 350);
      if (proseHead.length >= 40) assistantSnips.push(proseHead);
    }
    const toolNames = text.match(/"(?:tool|name|function)"\s*:\s*"([^"]+)"/g) || [];
    const filePaths = text.match(/"(?:filePath|path)"\s*:\s*"([^"]+)"/g) || [];
    const names = [...new Set(toolNames.map((m) => m.replace(/.*:\s*"/, '').replace(/"$/, '')))];
    const paths = [...new Set(filePaths.map((m) => m.replace(/.*:\s*"/, '').replace(/"$/, '')))];
    if (names.length) push(paths.length ? `${names.join(', ')} → ${paths.join(', ')}` : names.join(', '));
    const loosePath = text.match(/\b[\w./\\-]+\.(?:js|ts|tsx|jsx|py|html|css|json|md)\b/g) || [];
    for (const p of loosePath.slice(0, 4)) push(`file: ${p}`);
  }
  const sections = [];
  if (taskHint) sections.push(`TASK:\n${String(taskHint).replace(/\s+/g, ' ').slice(0, 500)}`);
  else if (users[0]) sections.push(`TASK:\n${users[0]}`);
  if (done.length) sections.push(`DONE:\n${done.join('\n')}`);
  sections.push(todoLedgerNote(activeTodos));
  if (users.length) sections.push(`DROPPED USER TURNS:\n${users.join('\n---\n')}`);
  if (assistantSnips.length) sections.push(`DROPPED ASSISTANT PROSE (excerpt):\n${assistantSnips.join('\n---\n')}`);
  sections.push('NEXT: continue the active task from OPEN / TASK. Do not repeat completed work.');
  return sections.join('\n\n');
}

function noticeFor(dropped, taskHint, activeTodos, writtenNote) {
  const summary = buildDroppedSummary(dropped, taskHint, activeTodos);
  const files = String(writtenNote || '').trim();
  const fileBlock = files ? `\nFILES ON DISK THIS TURN (continue from these, not from memory):\n${files}\n` : '';
  return {
    role: 'user',
    content: `${NOTICE_MARK} ${dropped.length} earlier turn(s) summarized.\n${summary}${fileBlock}\nDo not mention context limits or rotation to the user.\n`,
  };
}

/**
 * Keep system + recent history + the current user text inside the server window.
 * Dropped turns become one condensation notice so the task can continue.
 */
function fitCloudHistory({ systemPrompt, history, nextUser, contextLimit, outputTokens, budgetTokens, activeTodos, measured, pinned, writtenNote }) {
  const budget = budgetTokens > 0 ? budgetTokens : inputBudgetTokens(contextLimit, outputTokens);
  const pin = pinned instanceof Set ? pinned : null;
  let hist = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.role)
    .map((m) => ({ role: m.role, content: messageText(m), pin: !!(pin && pin.has(m)) }));
  let user = String(nextUser || '');

  const cost = (list, userText) => measuredCost(
    measured,
    promptChars(systemPrompt, list, userText),
    estimateTokens(systemPrompt)
      + estimateTokens(userText)
      + list.reduce((sum, m) => sum + estimateTokens(m.content), 0),
  );

  if (cost(hist, user) <= budget) {
    return {
      history: hist.map((m) => ({ role: m.role, content: m.content })),
      nextUser: user,
      droppedCount: 0,
      droppedText: '',
      keptTailText: '',
    };
  }

  const dropped = [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (isNotice(hist[i])) dropped.unshift(hist.splice(i, 1)[0]);
  }
  while (cost(hist, user) > budget) {
    const idx = hist.findIndex((m) => !m.pin);
    if (idx === -1) break;
    dropped.push(hist.splice(idx, 1)[0]);
  }
  while (estimateTokens(systemPrompt) + estimateTokens(user) > budget && user.length > 400) {
    user = user.slice(0, Math.floor(user.length * 0.75));
  }

  const droppedText = formatDroppedTranscript(dropped);
  const keptTailText = formatKeptTail(hist);

  if (dropped.length) {
    hist = [noticeFor(dropped, user, activeTodos, writtenNote), ...hist];
    while (hist.length > 1 && cost(hist, user) > budget) {
      const idx = hist.findIndex((m, i) => i > 0 && !m.pin);
      if (idx === -1) break;
      hist.splice(idx, 1);
    }
    if (cost(hist, user) > budget && isNotice(hist[0])) {
      hist[0] = { role: 'user', content: hist[0].content.slice(0, Math.max(1500, Math.floor(budget * CHARS_PER_TOKEN * 0.4))) };
    }
  }

  return {
    history: hist.map((m) => ({ role: m.role, content: m.content })),
    nextUser: user,
    droppedCount: dropped.length,
    droppedText,
    keptTailText,
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
    content: `${NOTICE_MARK}\n${text}\nDo not mention context limits or rotation to the user.\n`,
  };
  return copy;
}

module.exports = {
  CHARS_PER_TOKEN,
  NOTICE_MARK,
  DROPPED_MSG_CHARS,
  DROPPED_TOTAL_CHARS,
  messageText,
  estimateTokens,
  inputBudgetTokens,
  promptChars,
  measuredCost,
  fitCloudHistory,
  replaceCondensedNotice,
  buildDroppedSummary,
  formatDroppedTranscript,
  formatKeptTail,
  todoLedgerNote,
};
