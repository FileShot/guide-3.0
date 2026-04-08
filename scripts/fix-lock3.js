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

    // Step 1: Try cmd /c rmdir - sometimes works when PowerShell fails
    console.log('[2] Trying cmd rmdir on standalone...');
    const r1 = await post('/system/run', { cmd: 'cmd /c "rmdir /s /q E:\\IDE-website\\.next-ready\\standalone" 2>&1; if (Test-Path "E:\\IDE-website\\.next-ready\\standalone") { "STILL EXISTS" } else { "DELETED" }' }, token);
    console.log('    Result:', (JSON.parse(r1.body).output || '').trim());

    const exists = (JSON.parse(r1.body).output || '').includes('STILL EXISTS');
    
    if (exists) {
      // Strategy: build to .next-v2, then robocopy INTO .next-ready/standalone/
      // This doesn't require deleting locked files - just adds/overwrites
      console.log('[3] Directory still locked. Building to .next-v2, then copying into .next-ready...');
      
      // Backup and modify next.config.js to use .next-v2
      const r2 = await post('/system/run', { cmd: `
        Copy-Item "E:\\IDE-website\\next.config.js" "E:\\IDE-website\\next.config.js.bak" -Force
        $c = Get-Content "E:\\IDE-website\\next.config.js" -Raw
        $c = $c -replace "distDir:\\s*['\"]\.next-ready['\"]", "distDir: '.next-v2'"
        Set-Content "E:\\IDE-website\\next.config.js" $c
        "Config updated"
      ` }, token);
      console.log('[4]', (JSON.parse(r2.body).output || '').trim());
      
      // Build 
      console.log('[5] Building (this may take a while)...');
      const r3 = await post('/system/run', { cmd: 'Set-Location "E:\\IDE-website"; $env:NODE_OPTIONS="--max-old-space-size=3072"; npm run build 2>&1 | Select-Object -Last 15 | Out-String' }, token);
      const buildOut = (JSON.parse(r3.body).output || '').trim();
      console.log('    Build output:', buildOut.substring(0, 500));
      
      // Restore next.config.js immediately
      await post('/system/run', { cmd: 'Copy-Item "E:\\IDE-website\\next.config.js.bak" "E:\\IDE-website\\next.config.js" -Force; Remove-Item "E:\\IDE-website\\next.config.js.bak" -Force' }, token);
      console.log('[6] Restored next.config.js');
      
      if (buildOut.includes('Build error') || buildOut.includes('failed')) {
        console.log('BUILD FAILED - stopping');
        return;
      }
      
      // Verify .next-v2 build output
      const r4 = await post('/system/run', { cmd: 'Test-Path "E:\\IDE-website\\.next-v2\\standalone\\server.js"' }, token);
      const v2exists = (JSON.parse(r4.body).output || '').trim();
      console.log('[7] .next-v2/standalone/server.js exists:', v2exists);
      
      if (v2exists !== 'True') {
        console.log('Build did not produce server.js - stopping');
        return;
      }
      
      // Use robocopy to copy .next-v2/standalone/ INTO .next-ready/standalone/
      // /E = copy subdirs including empty, /IS = include same files, /IT = include tweaked
      // This ADDS files without needing to delete the locked ones
      console.log('[8] Copying .next-v2/standalone/ → .next-ready/standalone/ via robocopy...');
      const r5 = await post('/system/run', { cmd: 'robocopy "E:\\IDE-website\\.next-v2\\standalone" "E:\\IDE-website\\.next-ready\\standalone" /E /IS /IT /R:1 /W:1 /NFL /NDL /NP 2>&1 | Select-Object -Last 10 | Out-String' }, token);
      console.log('    Robocopy:', (JSON.parse(r5.body).output || '').trim());
      
      // Verify server.js is now in .next-ready
      const r6 = await post('/system/run', { cmd: 'Test-Path "E:\\IDE-website\\.next-ready\\standalone\\server.js"' }, token);
      console.log('[9] .next-ready/standalone/server.js exists:', (JSON.parse(r6.body).output || '').trim());
      
      // Start graysoft (PM2 still points to .next-ready/standalone/server.js)
      console.log('[10] Starting graysoft...');
      const r7 = await post('/system/run', { cmd: 'pm2 start graysoft 2>&1 | Out-String' }, token);
      console.log('     PM2:', (JSON.parse(r7.body).output || '').trim().substring(0, 300));
      
      await sleep(5000);
      
      // Check if running
      const r8 = await post('/system/run', { cmd: 'pm2 describe graysoft --no-color 2>&1 | Select-String "status|restarts|uptime" | Out-String' }, token);
      console.log('[11] Status:', (JSON.parse(r8.body).output || '').trim());

    } else {
      // Directory deleted successfully! Normal build
      console.log('[3] Directory deleted! Building...');
      const r2 = await post('/system/run', { cmd: 'Set-Location "E:\\IDE-website"; $env:NODE_OPTIONS="--max-old-space-size=3072"; npm run build 2>&1 | Select-Object -Last 15 | Out-String' }, token);
      console.log('    Build:', (JSON.parse(r2.body).output || '').trim());
      
      const r3 = await post('/system/run', { cmd: 'Test-Path "E:\\IDE-website\\.next-ready\\standalone\\server.js"' }, token);
      console.log('[4] server.js exists:', (JSON.parse(r3.body).output || '').trim());
      
      console.log('[5] Starting graysoft...');
      const r4 = await post('/system/run', { cmd: 'pm2 start graysoft 2>&1 | Out-String' }, token);
      console.log('    PM2:', (JSON.parse(r4.body).output || '').trim().substring(0, 300));
      
      await sleep(5000);
      
      const r5 = await post('/system/run', { cmd: 'pm2 describe graysoft --no-color 2>&1 | Select-String "status|restarts|uptime" | Out-String' }, token);
      console.log('[6] Status:', (JSON.parse(r5.body).output || '').trim());
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
})();
