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

    // Read the actual next.config.js content
    const r1 = await post('/system/run', { cmd: 'Get-Content "E:\\IDE-website\\next.config.js" -Raw' }, token);
    console.log('[2] next.config.js:\n' + (JSON.parse(r1.body).output || ''));
    
    // Also check server free RAM before we try building
    const r2 = await post('/system/run', { cmd: '(Get-CimInstance Win32_OperatingSystem | Select-Object -ExpandProperty FreePhysicalMemory) / 1024' }, token);
    console.log('[3] Free RAM (MB):', (JSON.parse(r2.body).output || '').trim());

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
