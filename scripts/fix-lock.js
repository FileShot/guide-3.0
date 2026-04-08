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

(async () => {
  try {
    const login = await post('/auth/login', { password: CP_PASS });
    const token = JSON.parse(login.body).token;
    console.log('[1] Logged in');

    // Check if it's a junction/symlink
    const r1 = await post('/system/run', { cmd: '(Get-Item "E:\\IDE-website" -Force).LinkType; (Get-Item "E:\\IDE-website" -Force).Target' }, token);
    console.log('[2] Link info:', (JSON.parse(r1.body).output || '').trim());

    // Check C:\SelfHost\IDE-website relationship
    const r2 = await post('/system/run', { cmd: '(Get-Item "C:\\SelfHost\\IDE-website" -Force -ErrorAction SilentlyContinue).LinkType; (Get-Item "C:\\SelfHost\\IDE-website" -Force -ErrorAction SilentlyContinue).Target' }, token);
    console.log('[3] C:\\SelfHost link:', (JSON.parse(r2.body).output || '').trim());

    // Try to find what process has .next-ready locked
    // Use PowerShell to check for open handles
    const r3 = await post('/system/run', { cmd: '[System.IO.Directory]::GetDirectories("E:\\IDE-website\\.next-ready\\standalone") 2>&1 | Out-String' }, token);
    console.log('[4] standalone subdirs:', (JSON.parse(r3.body).output || '').trim());

    // Try renaming instead of deleting
    const r4 = await post('/system/run', { cmd: 'Rename-Item "E:\\IDE-website\\.next-ready\\standalone" "E:\\IDE-website\\.next-ready\\standalone-old" -Force -ErrorAction Stop 2>&1' }, token);
    console.log('[5] Rename result:', (JSON.parse(r4.body).output || '').trim() || 'success (no output)');

    // Check if rename worked
    const r5 = await post('/system/run', { cmd: 'Test-Path "E:\\IDE-website\\.next-ready\\standalone"; Test-Path "E:\\IDE-website\\.next-ready\\standalone-old"' }, token);
    console.log('[6] standalone exists / standalone-old exists:', (JSON.parse(r5.body).output || '').trim());

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
