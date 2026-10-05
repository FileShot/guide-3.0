'use strict';

const {
  NOTICE_MARK,
  replaceCondensedNotice,
  buildDroppedSummary,
  todoLedgerNote,
  estimateTokens,
  inputBudgetTokens,
  measuredCost,
} = require('./cloudContextFit');

/** Dedicated prompt for cipher-fast summarizer calls only. Not the chatbot identity. */
const SUMMARIZER_SYSTEM_PROMPT = [
  'You are a context compressor for a coding agent.',
  'Your only job is to summarize dropped conversation turns into a compact progress note.',
  'The main coding model will read your note and continue the task.',
  '',
  'Output ONLY these sections, with no preamble and no closing chatter:',
  'TASK: one sentence for the active user goal',
  'DONE: bullet lines for completed work, tools used, and files touched',
  'ERRORS: bullet lines for failures or blockers, or the word none',
  'OPEN: bullet lines for remaining work',
  'NEXT: one concrete next step',
  '',
  'Rules:',
  '- Preserve exact file paths, error strings, and decisions.',
  '- Do not invent work that did not happen.',
  '- Do not address the user.',
  '- Do not call tools.',
  '- Do not continue coding the task yourself.',
  '- Do not mention being a summarizer or context limits.',
  '- If your previous reply was cut off, continue exactly where you left off without repeating.',
  '- When a TODO LEDGER lists open ids, every open id+text must appear under OPEN.',
  '- When the TODO LEDGER is empty or all done, still fill OPEN from TASK + dropped + kept transcripts.',
  '- Never write OPEN: none if TASK or transcripts still describe unfinished work.',
  '- Use every input block provided (todo ledger, dropped transcript, kept tail, heuristic stub).',
].join('\n');

const SUMMARIZER_MODEL = 'cipher-fast';
/** P40 cipher-fast slot — never send a larger prompt than this window. */
const SUMMARIZER_CONTEXT_TOKENS = 6144;
/** Chunk size per API call — length stop continues (RULES §2), not a product ceiling. */
const SUMMARIZER_MAX_TOKENS = 512;
const SUMMARIZER_TIMEOUT_MS = 120000;
/** Length-continue cap for the progress note — never chase dropped-transcript size. */
const SUMMARIZER_CONTINUE_CAP = 3;
const SUMMARIZER_DROPPED_CHARS = 14000;
const SUMMARIZER_KEPT_CHARS = 4000;
const SUMMARIZER_TASK_CHARS = 1200;

function formatOpenTodos(activeTodos) {
  return todoLedgerNote(activeTodos);
}

function buildSummarizerUserPrompt({
  droppedText,
  keptTailText,
  taskHint,
  heuristicSummary,
  droppedCount,
  activeTodos,
  continuationPrefix,
}) {
  const parts = [];
  parts.push(`Dropped turns: ${droppedCount || 0}`);
  if (taskHint) {
    parts.push(`Active user text (current turn / next prompt):\n${String(taskHint).slice(0, SUMMARIZER_TASK_CHARS)}`);
  }
  parts.push(formatOpenTodos(activeTodos));
  if (heuristicSummary) {
    parts.push(`Heuristic stub (may be incomplete — improve it):\n${String(heuristicSummary).slice(0, 4000)}`);
  }
  if (keptTailText) {
    parts.push(
      `Kept conversation tail (still in context — do not treat as finished just because it was kept):\n`
      + String(keptTailText).slice(0, SUMMARIZER_KEPT_CHARS),
    );
  }
  parts.push(`Dropped transcript:\n${String(droppedText || '').slice(0, SUMMARIZER_DROPPED_CHARS)}`);
  if (continuationPrefix) {
    parts.push('Your note so far (continue from the end; do not restart):\n' + String(continuationPrefix));
    parts.push('Continue the progress note now from the exact cut point.');
  } else {
    parts.push('Write the progress note now using all blocks above.');
  }
  return parts.join('\n\n');
}

/**
 * Build the summarizer prompt so system + prompt fit budgetTokens on the summarizer model.
 * The note so far is always whole. When the window is short, the heuristic stub goes first,
 * then the kept tail, then the oldest dropped lines. Returns null when the note plus the
 * fixed blocks alone no longer fit.
 */
function fitSummarizerPrompt(inputs, budgetTokens, measured) {
  const cost = (prompt) => measuredCost(
    measured,
    SUMMARIZER_SYSTEM_PROMPT.length + prompt.length,
    estimateTokens(SUMMARIZER_SYSTEM_PROMPT) + estimateTokens(prompt),
  );
  const dropped = String(inputs.droppedText || '').slice(0, SUMMARIZER_DROPPED_CHARS);
  const shapes = [
    { heuristicSummary: inputs.heuristicSummary, keptTailText: inputs.keptTailText },
    { heuristicSummary: '', keptTailText: inputs.keptTailText },
    { heuristicSummary: '', keptTailText: '' },
  ];
  for (const shape of shapes) {
    const prompt = buildSummarizerUserPrompt({ ...inputs, ...shape, droppedText: dropped });
    if (cost(prompt) <= budgetTokens) return { prompt, droppedChars: dropped.length, shed: shape };
  }
  const bare = { ...inputs, heuristicSummary: '', keptTailText: '' };
  if (cost(buildSummarizerUserPrompt({ ...bare, droppedText: '' })) > budgetTokens) return null;
  let lo = 0;
  let hi = dropped.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const prompt = buildSummarizerUserPrompt({ ...bare, droppedText: dropped.slice(dropped.length - mid) });
    if (cost(prompt) <= budgetTokens) lo = mid;
    else hi = mid - 1;
  }
  return {
    prompt: buildSummarizerUserPrompt({ ...bare, droppedText: dropped.slice(dropped.length - lo) }),
    droppedChars: lo,
    shed: bare,
  };
}

function extractHeuristicFromNotice(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const first = history[0];
  const text = first && first.content != null ? String(first.content) : '';
  if (!text.includes(NOTICE_MARK)) return '';
  return text.replace(NOTICE_MARK, '').trim().slice(0, 8000);
}

function isValidSummary(text) {
  const s = String(text || '').trim();
  if (s.length < 40) return false;
  if (/^\s*\{[\s\S]*"(?:tool|function|name)"\s*:/.test(s)) return false;
  if (/<\/?think>/i.test(s)) return false;
  return true;
}

function normalizeSummary(text) {
  let s = String(text || '').trim();
  s = s.replace(/<\/?think>/gi, '').trim();
  return s;
}

function isLengthStop(stopReason) {
  const s = String(stopReason || '').toLowerCase();
  return s === 'length' || s === 'max_tokens' || s === 'max_token';
}

function providerIsSecryptCloud(provider) {
  const p = String(provider || '').toLowerCase();
  return p === 'secrypt' || p === 'cipher' || p === 'graysoft' || p === 'cerebras';
}

/**
 * Upgrade a rotated history notice using cipher-fast (2B).
 * Length stops continue in the same notice (RULES §2). No body-text scanners.
 */
async function upgradeRotatedHistoryWithFastSummary({
  cloudLLM,
  history,
  droppedText,
  keptTailText,
  droppedCount,
  taskHint,
  activeTodos,
  provider,
  onPhase,
  getCancelled,
  timeoutMs = SUMMARIZER_TIMEOUT_MS,
}) {
  if (!cloudLLM || typeof cloudLLM.generate !== 'function') {
    return { history, usedLlm: false, reason: 'no-llm' };
  }
  if (!providerIsSecryptCloud(provider)) {
    return { history, usedLlm: false, reason: 'non-secrypt' };
  }
  if (!droppedCount || !Array.isArray(history) || !history.length) {
    return { history, usedLlm: false, reason: 'nothing-dropped' };
  }

  const heuristicSummary = extractHeuristicFromNotice(history)
    || buildDroppedSummary(
      String(droppedText || '').split('\n').map((line) => {
        const m = String(line).match(/^(user|assistant|system):\s([\s\S]*)$/i);
        if (m) return { role: m[1].toLowerCase(), content: m[2] };
        return { role: 'user', content: line };
      }),
      taskHint,
      activeTodos,
    );

  if (typeof onPhase === 'function') onPhase('start');

  let timedOut = false;
  let timer = null;
  const armTimeout = () => {
    if (timer) clearTimeout(timer);
    timedOut = false;
    return new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ __timeout: true });
      }, timeoutMs);
    });
  };

  try {
    if (getCancelled?.()) {
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'cancelled' };
    }

    let summaryAcc = '';
    let continueRounds = 0;
    let measured = null;
    let endedBy = 'stop';
    const summarizeStartedAt = Date.now();
    // The note may not grow past the transcript it replaces.
    const replacedChars = String(droppedText || '').length;
    const reportedWindow = typeof cloudLLM._getModelContextLimit === 'function'
      ? cloudLLM._getModelContextLimit('secrypt', SUMMARIZER_MODEL)
      : 0;
    // Clamp to the real cipher-fast slot. A wrong override (or quality window bleed)
    // used to fit a 20k-char prompt that then 400'd on the 6144-token worker.
    const windowTokens = Math.min(
      reportedWindow > 0 ? reportedWindow : SUMMARIZER_CONTEXT_TOKENS,
      SUMMARIZER_CONTEXT_TOKENS,
    );
    const promptBudget = inputBudgetTokens(windowTokens, SUMMARIZER_MAX_TOKENS);

    const abortOrphanSummarizer = async (why, pendingPromise) => {
      try {
        if (cloudLLM && typeof cloudLLM.abortActiveStream === 'function') {
          cloudLLM.abortActiveStream();
        }
      } catch (_) { /* ignore */ }
      if (pendingPromise && typeof pendingPromise.then === 'function') {
        try {
          await Promise.race([
            pendingPromise.catch(() => null),
            new Promise((r) => setTimeout(r, 80)),
          ]);
        } catch (_) { /* ignore */ }
      }
      console.warn(`[CloudSummarize] abort orphan after ${why}`);
    };

    for (;;) {
      if (getCancelled?.()) {
        if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
        return { history, usedLlm: false, reason: 'cancelled' };
      }

      const fitted = fitSummarizerPrompt({
        droppedText,
        keptTailText,
        taskHint,
        heuristicSummary,
        droppedCount,
        activeTodos,
        continuationPrefix: summaryAcc || '',
      }, promptBudget, measured);
      if (!fitted) {
        if (!summaryAcc) {
          console.warn(`[CloudSummarize] prompt blocks exceed ${SUMMARIZER_MODEL} window=${windowTokens} — keeping heuristic`);
          if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
          return { history, usedLlm: false, reason: 'window' };
        }
        endedBy = 'window';
        break;
      }
      const userPrompt = fitted.prompt;

      const timeoutPromise = armTimeout();
      const genPromise = cloudLLM.generate(userPrompt, {
        provider,
        model: SUMMARIZER_MODEL,
        systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
        conversationHistory: [],
        measuredPrompt: measured,
        temperature: 0.2,
        maxTokens: SUMMARIZER_MAX_TOKENS,
        topP: 0.9,
        topK: 20,
        minP: 0,
        presencePenalty: 0,
        repeatPenalty: 1.0,
        enableThinking: false,
        thinkingMode: 'off',
        reasoningEffort: 'low',
        stream: false,
        noFallback: true,
        images: [],
      });
      // Prevent unhandled rejection when timeout wins the race and we abort later.
      genPromise.catch(() => null);

      const result = await Promise.race([genPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      if (timedOut || result?.__timeout) {
        await abortOrphanSummarizer('timeout', genPromise);
        console.warn(
          `[CloudSummarize] cipher-fast timeout — keeping heuristic notice elapsedMs=${Date.now() - summarizeStartedAt}`,
        );
        if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
        return { history, usedLlm: false, reason: 'timeout' };
      }

      if (result?.isQuotaError) {
        if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
        return { history, usedLlm: false, reason: 'quota' };
      }

      const chunk = String(result?.text || '');
      summaryAcc += chunk;
      const stopReason = result?.stopReason || '';
      if (result && result.promptTokens > 0 && result.promptChars > 0) {
        measured = { promptTokens: result.promptTokens, promptChars: result.promptChars };
      }

      // A summary is supposed to be shorter than the dropped transcript. Only continue
      // when the note is still unusable and we have continue budget left — never until
      // summaryAcc.length >= replacedChars (that hung live multi-rotate at 8+ continues).
      const usableNow = isValidSummary(normalizeSummary(summaryAcc));
      if (
        isLengthStop(stopReason)
        && !usableNow
        && continueRounds < SUMMARIZER_CONTINUE_CAP
      ) {
        continueRounds += 1;
        console.log(
          `[CloudSummarize] cipher-fast length-continue #${continueRounds} acc=${summaryAcc.length} `
          + `replacedChars=${replacedChars} droppedShown=${fitted.droppedChars}`,
        );
        if (typeof onPhase === 'function') onPhase('start', summaryAcc);
        continue;
      }
      if (isLengthStop(stopReason)) endedBy = usableNow ? 'valid' : 'cap';

      break;
    }

    const summary = normalizeSummary(summaryAcc);
    if (!isValidSummary(summary)) {
      console.warn(`[CloudSummarize] cipher-fast returned unusable summary len=${summary.length} — keeping heuristic: ${summary.slice(0, 180)}`);
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'invalid', raw: summary.slice(0, 200) };
    }

    const upgraded = replaceCondensedNotice(history, summary);
    if (typeof onPhase === 'function') onPhase('done', summary);
    console.log(
      `[CloudSummarize] cipher-fast upgraded notice chars=${summary.length} dropped=${droppedCount} `
      + `continues=${continueRounds} replacedChars=${replacedChars} endedBy=${endedBy} `
      + `window=${windowTokens} elapsedMs=${Date.now() - summarizeStartedAt}`,
    );
    return { history: upgraded, usedLlm: true, summary, continueRounds };
  } catch (err) {
    if (timer) clearTimeout(timer);
    try {
      if (cloudLLM && typeof cloudLLM.abortActiveStream === 'function') cloudLLM.abortActiveStream();
    } catch (_) { /* ignore */ }
    if (err?.code === 'ABORTED' || /Generation cancelled/i.test(String(err?.message || ''))) {
      console.warn('[CloudSummarize] cipher-fast aborted orphan — keeping heuristic');
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'aborted-orphan' };
    }
    console.warn('[CloudSummarize] cipher-fast failed:', String(err?.message || err).slice(0, 160));
    if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
    return { history, usedLlm: false, reason: 'error', error: String(err?.message || err) };
  }
}

module.exports = {
  SUMMARIZER_SYSTEM_PROMPT,
  SUMMARIZER_MODEL,
  SUMMARIZER_CONTEXT_TOKENS,
  SUMMARIZER_MAX_TOKENS,
  SUMMARIZER_CONTINUE_CAP,
  SUMMARIZER_TIMEOUT_MS,
  buildSummarizerUserPrompt,
  fitSummarizerPrompt,
  formatOpenTodos,
  isValidSummary,
  normalizeSummary,
  isLengthStop,
  extractHeuristicFromNotice,
  providerIsSecryptCloud,
  upgradeRotatedHistoryWithFastSummary,
};
