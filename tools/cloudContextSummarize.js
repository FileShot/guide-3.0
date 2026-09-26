'use strict';

const { NOTICE_MARK, replaceCondensedNotice, buildDroppedSummary } = require('./cloudContextFit');

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
  '- Maximum 1800 characters total.',
  '- Preserve exact file paths, error strings, and decisions.',
  '- Do not invent work that did not happen.',
  '- Do not address the user.',
  '- Do not call tools.',
  '- Do not continue coding the task yourself.',
  '- Do not mention being a summarizer or context limits.',
].join('\n');

const SUMMARIZER_MODEL = 'cipher-fast';
const SUMMARIZER_MAX_TOKENS = 512;
const SUMMARIZER_TIMEOUT_MS = 12000;
const SUMMARY_CHAR_CAP = 1800;

function buildSummarizerUserPrompt({ droppedText, taskHint, heuristicSummary, droppedCount }) {
  const parts = [];
  parts.push(`Dropped turns: ${droppedCount || 0}`);
  if (taskHint) parts.push(`Active user text:\n${String(taskHint).slice(0, 500)}`);
  if (heuristicSummary) parts.push(`Heuristic stub (may be incomplete):\n${String(heuristicSummary).slice(0, 1200)}`);
  parts.push(`Dropped transcript excerpt:\n${String(droppedText || '').slice(0, 6000)}`);
  parts.push('Write the progress note now.');
  return parts.join('\n\n');
}

function extractHeuristicFromNotice(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const first = history[0];
  const text = first && first.content != null ? String(first.content) : '';
  if (!text.includes(NOTICE_MARK)) return '';
  return text.replace(NOTICE_MARK, '').trim().slice(0, 2400);
}

function isValidSummary(text) {
  const s = String(text || '').trim();
  if (s.length < 40 || s.length > SUMMARY_CHAR_CAP + 400) return false;
  if (/^\s*\{[\s\S]*"tool"\s*:/.test(s)) return false;
  if (/<\/?think>/i.test(s)) return false;
  const hasSection = /\b(TASK|DONE|ERRORS|OPEN|NEXT)\s*:/i.test(s);
  return hasSection;
}

function normalizeSummary(text) {
  let s = String(text || '').trim();
  s = s.replace(/<\/?think>/gi, '').trim();
  if (s.length > SUMMARY_CHAR_CAP) s = s.slice(0, SUMMARY_CHAR_CAP);
  return s;
}

function providerIsSecryptCloud(provider) {
  const p = String(provider || '').toLowerCase();
  return p === 'secrypt' || p === 'cipher' || p === 'graysoft' || p === 'cerebras';
}

/**
 * Upgrade a rotated history notice using cipher-fast (2B).
 * Never mutates worker defaults — per-request system prompt only.
 * On any failure, returns history unchanged (heuristic notice stays).
 */
async function upgradeRotatedHistoryWithFastSummary({
  cloudLLM,
  history,
  droppedText,
  droppedCount,
  taskHint,
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
      String(droppedText || '').split('\n').map((line) => ({ role: 'user', content: line })),
      taskHint,
    );

  if (typeof onPhase === 'function') onPhase('start');

  const userPrompt = buildSummarizerUserPrompt({
    droppedText,
    taskHint,
    heuristicSummary,
    droppedCount,
  });

  let timedOut = false;
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ __timeout: true });
    }, timeoutMs);
  });

  try {
    if (getCancelled?.()) {
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'cancelled' };
    }

    const genPromise = cloudLLM.generate(userPrompt, {
      provider,
      model: SUMMARIZER_MODEL,
      systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
      conversationHistory: [],
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

    const result = await Promise.race([genPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    if (timedOut || result?.__timeout) {
      console.warn('[CloudSummarize] cipher-fast timeout — keeping heuristic notice');
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'timeout' };
    }

    if (getCancelled?.()) {
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'cancelled' };
    }

    if (result?.isQuotaError) {
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'quota' };
    }

    const summary = normalizeSummary(result?.text || '');
    if (!isValidSummary(summary)) {
      console.warn('[CloudSummarize] cipher-fast returned unusable summary — keeping heuristic');
      if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
      return { history, usedLlm: false, reason: 'invalid', raw: summary.slice(0, 200) };
    }

    const upgraded = replaceCondensedNotice(history, summary);
    if (typeof onPhase === 'function') onPhase('done', summary);
    console.log(`[CloudSummarize] cipher-fast upgraded notice chars=${summary.length} dropped=${droppedCount}`);
    return { history: upgraded, usedLlm: true, summary };
  } catch (err) {
    if (timer) clearTimeout(timer);
    console.warn('[CloudSummarize] cipher-fast failed:', String(err?.message || err).slice(0, 160));
    if (typeof onPhase === 'function') onPhase('fallback', heuristicSummary);
    return { history, usedLlm: false, reason: 'error', error: String(err?.message || err) };
  }
}

module.exports = {
  SUMMARIZER_SYSTEM_PROMPT,
  SUMMARIZER_MODEL,
  SUMMARIZER_MAX_TOKENS,
  SUMMARIZER_TIMEOUT_MS,
  SUMMARY_CHAR_CAP,
  buildSummarizerUserPrompt,
  isValidSummary,
  normalizeSummary,
  extractHeuristicFromNotice,
  providerIsSecryptCloud,
  upgradeRotatedHistoryWithFastSummary,
};
