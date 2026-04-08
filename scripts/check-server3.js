'use strict';
const https = require('https');
const CP_HOST = 'cp.graysoft.dev';
const CP_PASS = 'diggabyte2026';

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: CP_HOST, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
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

    // Check what's in .next-ready on the server
    const r1 = await post('/system/run', { cmd: 'Get-ChildItem "E:\\IDE-website\\.next-ready" -ErrorAction SilentlyContinue | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String' }, token);
    console.log('[2] .next-ready contents:', (JSON.parse(r1.body).output || 'empty'));

    // Check if standalone dir exists at all
    const r2 = await post('/system/run', { cmd: 'Test-Path "E:\\IDE-website\\.next-ready\\standalone"' }, token);
    console.log('[3] standalone dir exists:', (JSON.parse(r2.body).output || '').trim());

    // Check Syncthing status for the folder
    const r3 = await post('/system/run', { cmd: 'Get-ChildItem "E:\\IDE-website\\.next-ready\\standalone" -ErrorAction SilentlyContinue | Select-Object Name -First 10 | Format-Table -AutoSize | Out-String' }, token);
    console.log('[4] standalone contents:', (JSON.parse(r3.body).output || 'empty'));

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
