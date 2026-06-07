'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { By } = require('selenium-webdriver');

const TOR_SOCKS_HOST = '127.0.0.1';
const TOR_SOCKS_PORT = 9150;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 120000;
const GUIDE_TOR_DEFAULTS_MARKER = '// guIDE Tor defaults — managed by guIDE; do not edit this block';
const GUIDE_TOR_DEFAULTS_END = '// end guIDE Tor defaults';

const TOR_FAILURE_RE = /tor exited during startup|restart tor browser|could not connect to tor|still cannot connect|tor process exited|failed to establish a tor network connection/i;
const SECURITY_RESTART_RE = /restart needed to apply security settings|restart tor browser to apply/i;

/**
 * Tor prefs: auto-connect at launch. Security slider is profile-only (not runtime)
 * so Tor does not show "restart needed to apply security settings" every session.
 */
const TOR_RUNTIME_PREFS = {
  'extensions.torlauncher.quickstart': true,
  'extensions.torlauncher.start_tor': true,
  'extensions.torlauncher.prompt_at_startup': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'torbrowser.settings.bridges.enabled': false,
};

/** Written to user.js once — includes Safest security level. */
const TOR_PROFILE_PREFS = {
  ...TOR_RUNTIME_PREFS,
  'browser.security_level.security_slider': 1,
};

/** @deprecated use TOR_PROFILE_PREFS */
const TOR_AUTO_CONNECT_PREFS = TOR_PROFILE_PREFS;

function _managedTorRoot(userDataPath) {
  const base = userDataPath || path.join(process.env.APPDATA || os.homedir(), 'guide-ide');
  return path.join(base, 'tor-browser');
}

function _serializeUserPrefValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function resolveTorProfileDir(userDataPath, firefoxPath) {
  const candidates = [];
  if (firefoxPath) {
    candidates.push(path.join(path.dirname(firefoxPath), 'TorBrowser', 'Data', 'Browser', 'profile.default'));
  }
  const managedRoot = _managedTorRoot(userDataPath);
  candidates.push(
    path.join(managedRoot, 'Browser', 'TorBrowser', 'Data', 'Browser', 'profile.default'),
    path.join(managedRoot, 'Tor Browser', 'Browser', 'TorBrowser', 'Data', 'Browser', 'profile.default'),
  );
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  const preferred = candidates[0] || candidates[1];
  if (!preferred) return null;
  fs.mkdirSync(preferred, { recursive: true });
  return preferred;
}

function writeTorProfileDefaults(userDataPath, firefoxPath) {
  const profileDir = resolveTorProfileDir(userDataPath, firefoxPath);
  if (!profileDir) return false;

  const blockLines = [GUIDE_TOR_DEFAULTS_MARKER];
  for (const [key, value] of Object.entries(TOR_PROFILE_PREFS)) {
    blockLines.push(`user_pref("${key}", ${_serializeUserPrefValue(value)});`);
  }
  blockLines.push(GUIDE_TOR_DEFAULTS_END);
  const block = `${blockLines.join('\n')}\n`;

  const userJsPath = path.join(profileDir, 'user.js');
  let existing = '';
  try {
    existing = fs.readFileSync(userJsPath, 'utf8');
  } catch {
    // new profile
  }

  const startIdx = existing.indexOf(GUIDE_TOR_DEFAULTS_MARKER);
  const endIdx = existing.indexOf(GUIDE_TOR_DEFAULTS_END);
  const next = startIdx >= 0 && endIdx >= 0
    ? `${existing.slice(0, startIdx)}${block}${existing.slice(endIdx + GUIDE_TOR_DEFAULTS_END.length).replace(/^\r?\n/, '')}`
    : `${existing ? `${existing.trimEnd()}\n\n` : ''}${block}`;

  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(userJsPath, next, 'utf8');
  return true;
}

function resolveTorDataDir(userDataPath, firefoxPath) {
  const candidates = [];
  if (firefoxPath) {
    candidates.push(path.join(path.dirname(firefoxPath), 'TorBrowser', 'Data', 'Tor'));
  }
  const managedRoot = _managedTorRoot(userDataPath);
  candidates.push(path.join(managedRoot, 'Browser', 'TorBrowser', 'Data', 'Tor'));
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0] || null;
}

/** Light repair: clear disconnect flag only. Does not delete auth cookies every launch. */
function repairTorNetworkState(userDataPath, firefoxPath, { log } = {}) {
  const torDir = resolveTorDataDir(userDataPath, firefoxPath);
  if (!torDir) return false;

  let repaired = false;
  const torrcPath = path.join(torDir, 'torrc');
  if (fs.existsSync(torrcPath)) {
    const content = fs.readFileSync(torrcPath, 'utf8');
    if (/^\s*DisableNetwork\s+1\s*$/m.test(content)) {
      const next = content.replace(/^\s*DisableNetwork\s+1\s*$/gm, 'DisableNetwork 0');
      fs.writeFileSync(torrcPath, next, 'utf8');
      repaired = true;
      if (log) log('tor repair: cleared DisableNetwork in torrc');
      const lockPath = path.join(torDir, 'lock');
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          if (log) log('tor repair: removed stale lock');
        } catch {
          // best effort
        }
      }
    }
  }

  return repaired;
}

/** Heavy repair after repeated Tor daemon crashes — let Tor regenerate torrc/state. */
function resetTorDaemonState(userDataPath, firefoxPath, { log } = {}) {
  const torDir = resolveTorDataDir(userDataPath, firefoxPath);
  if (!torDir) return false;

  const resetFiles = ['torrc', 'state', 'lock', 'control_auth_cookie'];
  let reset = false;
  for (const name of resetFiles) {
    const filePath = path.join(torDir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      fs.unlinkSync(filePath);
      reset = true;
    } catch {
      // best effort
    }
  }
  if (reset && log) log('tor repair: reset tor daemon state (torrc/state/lock)');
  return reset;
}

function applyTorAutoConnectPrefs(firefoxOptions) {
  for (const [key, value] of Object.entries(TOR_RUNTIME_PREFS)) {
    firefoxOptions.setPreference(key, value);
  }
}

function waitForTcpPort(host, port, timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.createConnection({ host, port });
      const finish = (err) => {
        sock.destroy();
        if (!err) return resolve(true);
        if (Date.now() >= deadline) {
          return reject(new Error(`Tor SOCKS proxy not ready at ${host}:${port} (${err.message})`));
        }
        setTimeout(attempt, 1500);
      };
      sock.setTimeout(3000, () => finish(new Error('timeout')));
      sock.once('connect', () => finish(null));
      sock.once('error', (e) => finish(e));
    };
    attempt();
  });
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _isTorConnectPage(url) {
  return typeof url === 'string' && url.includes('about:torconnect');
}

async function _pageText(driver) {
  try {
    return await driver.executeScript(() => document.body?.innerText || '');
  } catch {
    return '';
  }
}

async function _pageIndicatesTorFailure(driver) {
  const text = await _pageText(driver);
  return TOR_FAILURE_RE.test(text);
}

async function _pageIndicatesSecurityRestart(driver) {
  const text = await _pageText(driver);
  return SECURITY_RESTART_RE.test(text);
}

function _isProxyError(url) {
  return typeof url === 'string' && (url.includes('proxyConnectFailure') || url.includes('about:neterror'));
}

async function _tryClickConnectButton(driver) {
  const selectors = [
    By.css('button[name="connectButton"]'),
    By.css('#connectButton'),
    By.css('button[data-l10n-id="tor-connect-connect"]'),
  ];
  for (const sel of selectors) {
    try {
      const el = await driver.findElement(sel);
      if (await el.isDisplayed()) {
        await el.click();
        return true;
      }
    } catch {
      // try next selector
    }
  }
  try {
    const clicked = await driver.executeScript(() => {
      const buttons = Array.from(document.querySelectorAll('button[name="connectButton"], button#connectButton'));
      const btn = buttons.find((b) => b.name === 'connectButton' || b.id === 'connectButton');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    return !!clicked;
  } catch {
    return false;
  }
}

async function _tryClickRestartTorButton(driver) {
  const selectors = [
    By.css('button[name="restartButton"]'),
    By.css('button[data-l10n-id="tor-connect-restart"]'),
  ];
  for (const sel of selectors) {
    try {
      const el = await driver.findElement(sel);
      if (await el.isDisplayed()) {
        await el.click();
        return true;
      }
    } catch {
      // try next
    }
  }
  try {
    const clicked = await driver.executeScript(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => /restart tor browser/i.test((b.textContent || '').trim()));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    return !!clicked;
  } catch {
    return false;
  }
}

async function _socksReady(timeoutMs) {
  try {
    await waitForTcpPort(TOR_SOCKS_HOST, TOR_SOCKS_PORT, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until Tor is bootstrapped: SOCKS port open and past connect/failure screens.
 * Never uses bridges — clicks Connect / Restart only.
 */
async function ensureTorBootstrap(driver, {
  timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  log,
  userDataPath = null,
  firefoxPath = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let failureRecoveries = 0;

  while (Date.now() < deadline) {
    let url = '';
    try {
      url = await driver.getCurrentUrl();
    } catch {
      if (log) log('tor bootstrap: driver session lost');
      return { success: false, needsRelaunch: true };
    }

    try {
      if (await _pageIndicatesSecurityRestart(driver)) {
        if (log) log('tor bootstrap: security settings restart required');
        const restarted = await _tryClickRestartTorButton(driver);
        if (restarted && log) log('tor bootstrap: clicked restart for security settings');
        return { success: false, needsRelaunch: true };
      }
    } catch {
      return { success: false, needsRelaunch: true };
    }

    if (_isTorConnectPage(url)) {
      const failed = await _pageIndicatesTorFailure(driver);
      if (failed) {
        failureRecoveries += 1;
        if (failureRecoveries === 1) {
          repairTorNetworkState(userDataPath, firefoxPath, { log });
          const restarted = await _tryClickRestartTorButton(driver);
          if (restarted && log) log('tor bootstrap: clicked Restart Tor Browser');
          if (restarted) return { success: false, needsRelaunch: true };
          const connected = await _tryClickConnectButton(driver);
          if (connected && log) log('tor bootstrap: clicked Connect after failure screen');
        } else if (failureRecoveries >= 2) {
          resetTorDaemonState(userDataPath, firefoxPath, { log });
          try {
            await driver.get('about:torconnect');
          } catch {}
          await _sleep(2000);
          await _tryClickConnectButton(driver);
          if (log) log('tor bootstrap: reset tor daemon state and retried Connect');
        }
        await _sleep(3000);
        continue;
      }

      const connected = await _tryClickConnectButton(driver);
      if (connected && log) log('tor bootstrap: clicked Connect on about:torconnect');
      await _sleep(2500);
      continue;
    }

    const socksUp = await _socksReady(Math.min(5000, deadline - Date.now()));
    if (socksUp && !_isProxyError(url)) {
      if (log) log('tor bootstrap: SOCKS ready');
      return { success: true };
    }

    if (_isProxyError(url)) {
      try {
        await driver.get('about:torconnect');
        await _sleep(1500);
      } catch {}
      continue;
    }

    await _sleep(1500);
  }

  return {
    success: false,
    error: 'Timed out waiting for Tor network connection. Try again or delete %APPDATA%\\guide-ide\\tor-browser\\Browser\\TorBrowser\\Data\\Tor',
  };
}

/** True when the current browser page shows a Tor connect/failure screen. */
async function isTorConnectionScreen(driver) {
  try {
    const url = await driver.getCurrentUrl();
    if (_isTorConnectPage(url)) return true;
    return _pageIndicatesTorFailure(driver);
  } catch {
    return false;
  }
}

module.exports = {
  TOR_SOCKS_HOST,
  TOR_SOCKS_PORT,
  TOR_AUTO_CONNECT_PREFS,
  applyTorAutoConnectPrefs,
  ensureTorBootstrap,
  isTorConnectionScreen,
  repairTorNetworkState,
  resetTorDaemonState,
  resolveTorDataDir,
  resolveTorProfileDir,
  writeTorProfileDefaults,
  waitForTcpPort,
};
