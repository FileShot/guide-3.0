'use strict';

const { BrowserWindow } = require('electron');

/** URLs the OAuth window may land on after provider sign-in (must match graysoft.dev trusted hosts). */
const TRUSTED_OAUTH_HOSTS = new Set(['graysoft.dev', 'www.graysoft.dev', 'pocket.graysoft.dev']);

/**
 * Run OAuth in an in-app window. graysoft.dev completes Google/GitHub OAuth server-side and
 * redirects to ?return= with guide_token=JWT (see graysoft Google/GitHub callback routes).
 */
function runOAuthInWindow({ parent, oauthUrl }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        if (win && !win.isDestroyed()) win.close();
      } catch (_) {}
      resolve(result);
    };

    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !!(parent && !parent.isDestroyed()),
      show: false,
      autoHideMenuBar: true,
      title: 'Sign in to guIDE',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const handleCallbackUrl = (rawUrl) => {
      if (!rawUrl || typeof rawUrl !== 'string') return false;

      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return false;
      }

      if (!TRUSTED_OAUTH_HOSTS.has(parsed.hostname)) return false;

      const oauthError = parsed.searchParams.get('error');
      if (oauthError) {
        const desc = parsed.searchParams.get('error_description') || oauthError;
        finish({ success: false, error: desc });
        return true;
      }

      const guideToken = parsed.searchParams.get('guide_token');
      if (guideToken) {
        finish({ success: true, guideToken });
        return true;
      }

      return false;
    };

    const onBeforeUrl = (event, url) => {
      if (handleCallbackUrl(url)) {
        event.preventDefault();
      }
    };

    win.webContents.on('will-navigate', onBeforeUrl);
    win.webContents.on('will-redirect', onBeforeUrl);
    win.webContents.on('did-navigate', (_event, url) => {
      handleCallbackUrl(url);
    });

    win.on('closed', () => {
      finish({ success: false, error: 'Sign-in window closed' });
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });

    win.loadURL(oauthUrl).catch((e) => {
      finish({ success: false, error: e.message || 'Failed to open sign-in page' });
    });
  });
}

module.exports = { runOAuthInWindow };
