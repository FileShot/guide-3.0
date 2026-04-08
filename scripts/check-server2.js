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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  try {
    const login = await post('/auth/login', { password: CP_PASS });
    const token = JSON.parse(login.body).token;
    console.log('[1] Logged in');

    // Check server source version
    const r1 = await post('/system/run', { cmd: 'Get-Content "E:\\IDE-website\\src\\app\\download\\page.tsx" -TotalCount 6' }, token);
    console.log('[2] Server source lines:', JSON.parse(r1.body).output || 'empty');

    // Check .next-ready
    const r2 = await post('/system/run', { cmd: 'Test-Path "E:\\IDE-website\\.next-ready\\standalone\\server.js"' }, token);
    console.log('[3] server.js exists:', (JSON.parse(r2.body).output || '').trim());

    // Check graysoft PM2 status  
    const r3 = await post('/system/run', { cmd: 'pm2 describe graysoft --no-color 2>&1 | Select-Object -First 10' }, token);
    console.log('[4] graysoft:', (JSON.parse(r3.body).output || '').trim());

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
