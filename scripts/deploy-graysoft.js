/**
 * Deploy graysoft.dev — stop, clean, rebuild via CP API
 * Usage: node scripts/deploy-graysoft.js
 */
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

function get(path, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CP_HOST, path, method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      rejectUnauthorized: false
    };
    https.get(opts, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  try {
    // Login
    const login = await post('/auth/login', { password: CP_PASS });
    if (login.status !== 200) { console.error('Login failed:', login.body); process.exit(1); }
    const token = JSON.parse(login.body).token;
    console.log('[1/5] Logged in');

    // Stop graysoft
    const stop = await post('/system/run', { cmd: 'pm2 stop graysoft' }, token);
    console.log('[2/5] Stopped graysoft:', stop.status === 200 ? 'OK' : stop.body.slice(0, 200));

    // Wait 15 seconds for file locks to release
    console.log('[3/5] Waiting 15s for locks to release...');
    await sleep(15000);

    // Check what's locking .next-ready
    const lockCheck = await post('/system/run', {
      cmd: 'Get-Process | Where-Object { $_.Path -like "*IDE-website*" } | Select-Object Id,ProcessName,Path | Format-Table -AutoSize | Out-String'
    }, token);
    console.log('[3a] Processes in IDE-website:', (JSON.parse(lockCheck.body).stdout || 'none').trim());

    // Try to clean .next-ready now that process is stopped
    const clean = await post('/system/run', {
      cmd: 'Remove-Item -Path "E:\\IDE-website\\.next-ready" -Recurse -Force -ErrorAction SilentlyContinue; Write-Output "cleaned"'
    }, token);
    const cleanOut = JSON.parse(clean.body).stdout || '';
    console.log('[3b] Clean result:', cleanOut.trim());

    // Trigger rebuild
    const rebuild = await post('/pm2/rebuild/graysoft', {}, token);
    console.log('[4/5] Rebuild triggered:', rebuild.body.slice(0, 200));
    const jobId = JSON.parse(rebuild.body).jobId;

    // Poll status
    console.log('[5/5] Polling rebuild status...');
    for (let i = 0; i < 20; i++) {
      await sleep(15000);
      const status = await get('/pm2/rebuild-status/' + jobId, token);
      const parsed = JSON.parse(status.body);
      const log = parsed.log || [];
      const lastLine = log.length > 0 ? log[log.length - 1] : '';
      console.log(`  [${i + 1}] ${parsed.status} — ${lastLine.slice(0, 120)}`);
      if (parsed.status === 'done' || parsed.status === 'failed') {
        if (parsed.status === 'failed') {
          console.error('BUILD FAILED. Last 5 lines:');
          log.slice(-5).forEach(l => console.error('  ', l));
        } else {
          console.log('BUILD SUCCEEDED');
        }
        break;
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
