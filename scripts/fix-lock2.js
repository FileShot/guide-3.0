'use strict';
const https = require('https');
const CP_HOST = 'cp.graysoft.dev';
const CP_PASS = 'diggabyte2026';

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: CP_HOST, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      rejectUnauthorized: false
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = https.request(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  try {
    const login = await post('/auth/login', { password: CP_PASS });
    const token = JSON.parse(login.body).token;
    console.log('[1] Logged in');

    // See what's actually holding the lock - check with handle/openfiles if available
    console.log('[2] Checking for handle.exe...');
    const r0 = await post('/system/run', { cmd: 'where.exe handle.exe 2>&1' }, token);
    console.log('    handle.exe:', (JSON.parse(r0.body).output || '').trim());

    // Try openfiles (built-in Windows)
    console.log('[3] Trying openfiles...');
    const r1 = await post('/system/run', { cmd: 'openfiles /query /fo csv 2>&1 | Select-Object -First 5' }, token);
    console.log('    openfiles:', (JSON.parse(r1.body).output || '').trim());

    // Delete contents of standalone instead of the dir itself
    console.log('[4] Deleting contents of standalone...');
    const r2 = await post('/system/run', { cmd: 'Get-ChildItem "E:\\IDE-website\\.next-ready\\standalone" -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 2>&1; "Contents deleted"' }, token);
    console.log('    Result:', (JSON.parse(r2.body).output || '').trim());

    // Also empty .next-ready except standalone
    console.log('[5] Cleaning other .next-ready contents...');
    const r3 = await post('/system/run', { cmd: 'Get-ChildItem "E:\\IDE-website\\.next-ready" -Force -Exclude standalone | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 2>&1; "Done"' }, token);
    console.log('    Result:', (JSON.parse(r3.body).output || '').trim());

    // Verify standalone is empty
    const r4 = await post('/system/run', { cmd: 'Get-ChildItem "E:\\IDE-website\\.next-ready\\standalone" -Force 2>&1 | Measure-Object | Select-Object -ExpandProperty Count' }, token);
    console.log('[6] Items in standalone:', (JSON.parse(r4.body).output || '').trim());

    // Check node_modules for the build
    const r5 = await post('/system/run', { cmd: 'Test-Path "E:\\IDE-website\\node_modules\\.package-lock.json"' }, token);
    console.log('[7] node_modules exists:', (JSON.parse(r5.body).output || '').trim());

    // Check if we can cd to the dir and build directly (bypassing the CP rebuild)
    console.log('[8] Attempting direct build...');
    const r6 = await post('/system/run', { cmd: 'Set-Location "E:\\IDE-website"; $env:NODE_OPTIONS="--max-old-space-size=3072"; npm run build 2>&1 | Select-Object -Last 20 | Out-String' }, token);
    const out = (JSON.parse(r6.body).output || '').trim();
    console.log('    Build output:', out);

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
