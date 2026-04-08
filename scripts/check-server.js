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
    console.log('Logged in');

    // Check server source version
    const r1 = await post('/system/run', {
      cmd: 'Get-Content "E:\\IDE-website\\src\\app\\download\\page.tsx" -TotalCount 6 | Select-Object -Last 1'
    }, token);
    console.log('Server source:', (JSON.parse(r1.body).stdout || '').trim());

    // Check if .next-ready/standalone/server.js exists
    const r2 = await post('/system/run', {
      cmd: 'Test-Path "E:\\IDE-website\\.next-ready\\standalone\\server.js"'
    }, token);
    console.log('server.js exists:', (JSON.parse(r2.body).stdout || '').trim());

    // Check graysoft PM2 status
    const r3 = await post('/system/run', {
      cmd: 'pm2 show graysoft 2>&1 | Select-String "status|restarts" | Out-String'
    }, token);
    console.log('graysoft status:', (JSON.parse(r3.body).stdout || '').trim());

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
