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

    // Raw response to understand structure
    const r = await post('/system/run', { cmd: 'echo hello' }, token);
    console.log('RAW:', r.body.slice(0, 500));

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
