'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { TOR_BROWSER_VERSION, getManagedTorRoot } = require('../browserBackends/torBrowserResolver');
const { DEFAULT_GECKODRIVER_VERSION, resolveGeckodriver } = require('../browserBackends/geckodriverResolver');

describe('Tor on-demand path (smoke)', () => {
  it('pins a Tor Browser version with Windows download URL', () => {
    assert.ok(TOR_BROWSER_VERSION);
    const url = `https://archive.torproject.org/tor-package-archive/torbrowser/${TOR_BROWSER_VERSION}/tor-browser-windows-x86_64-portable-${TOR_BROWSER_VERSION}.exe`;
    assert.match(url, /archive\.torproject\.org/);
    assert.match(url, /tor-browser-windows-x86_64-portable/);
  });

  it('resolves geckodriver from cache without download when present', async () => {
    const tmp = path.join(os.tmpdir(), `guide-tor-qa-${Date.now()}`);
    const cacheDir = path.join(tmp, 'geckodriver', DEFAULT_GECKODRIVER_VERSION);
    fs.mkdirSync(cacheDir, { recursive: true });
    const bin = path.join(cacheDir, process.platform === 'win32' ? 'geckodriver.exe' : 'geckodriver');
    fs.writeFileSync(bin, 'fake');
    const result = await resolveGeckodriver({ userDataPath: tmp });
    assert.equal(result.success, true);
    assert.equal(result.source, 'cache');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('managed Tor root is under userData', () => {
    const root = getManagedTorRoot('/fake/userdata');
    assert.match(root, /tor-browser$/);
  });
});

console.log('torOnDemand.test.js: all passed');
