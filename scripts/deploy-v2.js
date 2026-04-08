'use strict';
const https = require('https');
const CP_HOST = 'cp.graysoft.dev';
const CP_PASS = 'diggabyte2026';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: CP_HOST, path, method,
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: false
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const req = https.request(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  try {
    // Login
    const login = await request('POST', '/auth/login', { password: CP_PASS });
    const token = JSON.parse(login.body).token;
    console.log('[1] Logged in');

    // Stop graysoft to end crash loop
    console.log('[2] Stopping graysoft...');
    const stop = await request('POST', '/system/run', { cmd: 'pm2 stop graysoft 2>&1' }, token);
    console.log('    Result:', (JSON.parse(stop.body).output || '').trim());
    
    await sleep(3000);

    // Check if .next-ready/standalone is now unlocked - try to clean it
    console.log('[3] Cleaning .next-ready...');
    const clean = await request('POST', '/system/run', { cmd: 'Remove-Item "E:\\IDE-website\\.next-ready" -Recurse -Force -ErrorAction SilentlyContinue 2>&1; "Done"' }, token);
    console.log('    Result:', (JSON.parse(clean.body).output || '').trim());

    await sleep(2000);

    // Verify it's gone
    const check = await request('POST', '/system/run', { cmd: 'Test-Path "E:\\IDE-website\\.next-ready"' }, token);
    console.log('[4] .next-ready exists after clean:', (JSON.parse(check.body).output || '').trim());

    // Trigger rebuild
    console.log('[5] Triggering rebuild...');
    const rebuild = await request('POST', '/pm2/rebuild/graysoft', null, token);
    const rbody = JSON.parse(rebuild.body);
    console.log('    Status:', rebuild.status, 'JobId:', rbody.jobId, 'Message:', rbody.message);

    if (!rbody.jobId) {
      console.log('    Full response:', rebuild.body);
      return;
    }

    // Poll for completion
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const status = await request('GET', '/pm2/rebuild-status/' + rbody.jobId, null, token);
      const s = JSON.parse(status.body);
      process.stdout.write(`    [${i+1}] Status: ${s.status || s.state}`);
      if (s.step) process.stdout.write(` Step: ${s.step}`);
      process.stdout.write('\n');
      if (s.status === 'completed' || s.status === 'complete' || s.state === 'completed') {
        console.log('[6] BUILD SUCCEEDED');
        return;
      }
      if (s.status === 'failed' || s.state === 'failed') {
        console.log('[6] BUILD FAILED:', s.error || s.message || JSON.stringify(s));
        return;
      }
    }
    console.log('[6] Timed out waiting for rebuild');
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
