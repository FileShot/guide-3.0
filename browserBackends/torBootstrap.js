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

/**
 * Tor Browser prefs applied at launch and persisted in profile user.js.
 * security_slider: 1 = Safest, 2 = Safer, 4 = Standard.
 */
const TOR_AUTO_CONNECT_PREFS = {
  'extensions.torlauncher.quickstart': true,
  'extensions.torlauncher.start_tor': true,
  'extensions.torlauncher.prompt_at_startup': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.security_level.security_slider': 1,
  // Do not force bridges on — that crashes Tor for most direct connections.
  // obfs4 is the default transport when bridges are enabled in Settings.
  'torbrowser.settings.bridges.enabled': false,
  'torbrowser.settings.bridges.builtin_type': 'obfs4',
};

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

/** Persist prefs in Tor profile so first launch respects Safest + obfs4 before Marionette runs. */
function writeTorProfileDefaults(userDataPath, firefoxPath) {
  const profileDir = resolveTorProfileDir(userDataPath, firefoxPath);
  if (!profileDir) return false;

  const blockLines = [GUIDE_TOR_DEFAULTS_MARKER];
  for (const [key, value] of Object.entries(TOR_AUTO_CONNECT_PREFS)) {
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

/** Clear stale disconnect flags left when Tor crashes (DisableNetwork 1 in torrc). */
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
    }
  }

  for (const name of ['lock', 'control_auth_cookie']) {
    const filePath = path.join(torDir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      fs.unlinkSync(filePath);
      repaired = true;
      if (log) log(`tor repair: removed stale ${name}`);
    } catch {
      // best effort
    }
  }

  return repaired;
}

function applyTorAutoConnectPrefs(firefoxOptions) {
  for (const [key, value] of Object.entries(TOR_AUTO_CONNECT_PREFS)) {
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

async function _pageIndicatesTorCrash(driver) {
  try {
    const text = await driver.executeScript(() => document.body?.innerText || '');
    return /tor exited during startup|restart tor browser/i.test(text);
  } catch {
    return false;
  }
}

function _isProxyError(url) {
  return typeof url === 'string' && (url.includes('proxyConnectFailure') || url.includes('about:neterror'));
}

async function _tryClickConnectButton(driver) {
  const selectors = [
    By.css('#connectButton'),
    By.css('button[data-l10n-id="tor-connect-connect"]'),
    By.xpath("//button[contains(translate(normalize-space(.), 'CONNECT', 'connect'), 'connect')]"),
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
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => /connect/i.test((b.textContent || '').trim()));
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

/**
 * Wait until Tor is bootstrapped: SOCKS port open and browser past connect screen.
 * Auto-clicks Connect on about:torconnect when quickstart prefs did not fire yet.
 */
async function ensureTorBootstrap(driver, {
  timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  log,
  userDataPath = null,
  firefoxPath = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let clickedConnect = false;
  let restartedTor = false;

  while (Date.now() < deadline) {
    let url = '';
    try {
      url = await driver.getCurrentUrl();
    } catch {
      await _sleep(1000);
      continue;
    }

    if (_isTorConnectPage(url)) {
      const crashed = await _pageIndicatesTorCrash(driver);
      if (crashed && !restartedTor) {
        repairTorNetworkState(userDataPath, firefoxPath, { log });
        const ok = await _tryClickRestartTorButton(driver);
        restartedTor = ok;
        clickedConnect = false;
        if (ok && log) log('tor bootstrap: clicked Restart Tor Browser after crash');
        await _sleep(3000);
        continue;
      }
      if (!clickedConnect) {
        const ok = await _tryClickConnectButton(driver);
        clickedConnect = ok;
        if (ok && log) log('tor bootstrap: clicked Connect on about:torconnect');
      }
      await _sleep(2000);
      continue;
    }

    try {
      await waitForTcpPort(TOR_SOCKS_HOST, TOR_SOCKS_PORT, Math.min(8000, deadline - Date.now()));
      if (!_isProxyError(url) && !_isTorConnectPage(url)) {
        if (log) log('tor bootstrap: SOCKS ready');
        return { success: true };
      }
    } catch {
      // SOCKS not up yet — keep polling
    }

    if (_isProxyError(url)) {
      if (!clickedConnect) {
        try {
          await driver.get('about:torconnect');
          await _sleep(1500);
        } catch {}
        continue;
      }
    }

    await _sleep(1500);
  }

  return {
    success: false,
    error: 'Timed out waiting for Tor network connection. Click Connect in Tor Browser or check your network.',
  };
}

module.exports = {
  TOR_SOCKS_HOST,
  TOR_SOCKS_PORT,
  TOR_AUTO_CONNECT_PREFS,
  applyTorAutoConnectPrefs,
  ensureTorBootstrap,
  repairTorNetworkState,
  resolveTorDataDir,
  resolveTorProfileDir,
  writeTorProfileDefaults,
  waitForTcpPort,
};
