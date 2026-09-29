/**
 * Cursor cloud provider is admin-only (operator keys — not a public/Pro feature).
 * Anyone else must not see Cursor in the provider list and must not call it.
 */
'use strict';

const CURSOR_ADMIN_EMAILS = new Set(['brendan36363@gmail.com']);

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

/**
 * @param {object} [opts]
 * @param {object} [opts.licenseManager]
 * @param {object} [opts.settingsManager]
 * @param {string} [opts.email] explicit override (tests)
 */
function isCursorAdmin(opts = {}) {
  if (opts.email) return CURSOR_ADMIN_EMAILS.has(normalizeEmail(opts.email));

  const candidates = [];
  const lic = opts.licenseManager?.licenseData?.email;
  if (lic) candidates.push(lic);

  const settingsLic = opts.settingsManager?.get?.('licenseData')?.email;
  if (settingsLic) candidates.push(settingsLic);

  // Do NOT trust free/graysoft accountUser alone — admin is the licensed email.
  for (const e of candidates) {
    if (CURSOR_ADMIN_EMAILS.has(normalizeEmail(e))) return true;
  }
  return false;
}

function assertCursorAdmin(opts = {}) {
  if (!isCursorAdmin(opts)) {
    const err = new Error('Cursor provider is admin-only and is not available on this account.');
    err.code = 'CURSOR_ADMIN_ONLY';
    err.status = 403;
    throw err;
  }
}

module.exports = {
  CURSOR_ADMIN_EMAILS,
  isCursorAdmin,
  assertCursorAdmin,
  normalizeEmail,
};
