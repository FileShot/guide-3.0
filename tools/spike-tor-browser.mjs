#!/usr/bin/env node
'use strict';

/**
 * Phase 0 spike: launch Tor Browser via geckodriver, navigate, snapshot, click.
 *
 * Usage:
 *   node tools/spike-tor-browser.mjs "C:\Path\To\Tor Browser\Browser\firefox.exe"
 *   node tools/spike-tor-browser.mjs --url https://check.torproject.org/
 */

const path = require('path');
const os = require('os');
const { TorBrowserBackend } = require('../browserBackends/TorBrowserBackend');

async function main() {
  const args = process.argv.slice(2);
  let torPath = process.env.TOR_BROWSER_PATH || '';
  let targetUrl = 'https://check.torproject.org/';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      targetUrl = args[++i];
    } else if (!args[i].startsWith('-')) {
      torPath = args[i];
    }
  }

  if (!torPath) {
    console.error('Usage: node tools/spike-tor-browser.mjs <path-to-firefox.exe> [--url URL]');
    console.error('  Or set TOR_BROWSER_PATH environment variable.');
    process.exit(1);
  }

  const userDataPath = path.join(process.env.APPDATA || os.homedir(), 'guide-ide');
  const backend = new TorBrowserBackend({ userDataPath });
  backend.configure({ torBrowserPath: torPath, debugTorBrowser: true });

  console.log('[spike] launch...');
  const launch = await backend.launch();
  if (!launch.success) {
    console.error('[spike] launch FAILED:', launch.error);
    process.exit(2);
  }

  console.log(`[spike] navigate ${targetUrl}...`);
  const nav = await backend.navigate(targetUrl);
  if (!nav.success) {
    console.error('[spike] navigate FAILED:', nav.error);
    await backend.close();
    process.exit(3);
  }
  console.log('[spike] navigate OK, title/url in snapshot');

  const snap = await backend.getSnapshot();
  if (!snap.success) {
    console.error('[spike] snapshot FAILED:', snap.error);
    await backend.close();
    process.exit(4);
  }
  console.log('[spike] snapshot excerpt:\n', snap.text.slice(0, 1200));

  const clickTarget = snap.text.match(/\[ref=(\d+)\][^\n]*(?:button|link|a)/i);
  if (clickTarget) {
    const ref = clickTarget[1];
    console.log(`[spike] click ref=${ref}...`);
    const click = await backend.click(`[ref=${ref}]`);
    console.log('[spike] click result:', click.success ? 'OK' : click.error);
  } else {
    console.log('[spike] no obvious clickable ref found — skipping click test');
  }

  await backend.close();
  console.log('[spike] DONE — geckodriver + Tor Browser automation verified');
}

main().catch((e) => {
  console.error('[spike] fatal:', e);
  process.exit(99);
});
