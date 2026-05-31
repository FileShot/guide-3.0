'use strict';

/**
 * prIntegration — GitHub CLI wrapper for PR comments and review.
 */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');

function _ghAvailable() {
  try {
    execSync('gh --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function _runGh(args, cwd) {
  const out = execFileSync('gh', args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return out.trim();
}

function getPrInfo(projectPath, prNumber) {
  if (!_ghAvailable()) return { success: false, error: 'gh CLI not installed' };
  try {
    const json = _runGh(['pr', 'view', String(prNumber), '--json', 'title,body,url,state,author,comments,reviews'], projectPath);
    return { success: true, pr: JSON.parse(json) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function listPrComments(projectPath, prNumber) {
  if (!_ghAvailable()) return { success: false, error: 'gh CLI not installed' };
  try {
    const json = _runGh(['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`], projectPath);
    return { success: true, comments: JSON.parse(json) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function addPrComment(projectPath, prNumber, body) {
  if (!_ghAvailable()) return { success: false, error: 'gh CLI not installed' };
  try {
    _runGh(['pr', 'comment', String(prNumber), '--body', body], projectPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function submitReview(projectPath, { prNumber, event = 'COMMENT', body, comments = [] }) {
  if (!_ghAvailable()) return { success: false, error: 'gh CLI not installed' };
  try {
    if (comments.length > 0) {
      const reviewPayload = {
        body: body || '',
        event: event.toUpperCase(),
        comments: comments.map(c => ({
          path: c.path,
          line: c.line,
          body: c.body,
        })),
      };
      const tmp = require('path').join(require('os').tmpdir(), `guide-review-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(reviewPayload));
      try {
        _runGh(['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`, '--input', tmp], projectPath);
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
      return { success: true, reviewEvent: event };
    }

    if (body) {
      _runGh(['pr', 'comment', String(prNumber), '--body', body], projectPath);
    }
    if (['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event.toUpperCase())) {
      _runGh(['pr', 'review', String(prNumber), '--comment', body || 'Review via guIDE'], projectPath);
    }
    return { success: true, reviewEvent: event };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  _ghAvailable,
  getPrInfo,
  listPrComments,
  addPrComment,
  submitReview,
};
