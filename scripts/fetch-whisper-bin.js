'use strict';

/**
 * Download whisper.cpp binary + ggml-base.en model for bundling in guIDE installers.
 * Usage: node scripts/fetch-whisper-bin.js [--skip-model]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'resources', 'whisper');
const SKIP_MODEL = process.argv.includes('--skip-model');

const PLATFORM_DIRS = {
  win32: 'win32',
  linux: 'linux',
  darwin: 'darwin',
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = (u) => {
      https.get(u, { headers: { 'User-Agent': 'guIDE-whisper-fetch' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(dest, () => {});
          return req(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', reject);
    };
    req(url);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = (u) => {
      https.get(u, { headers: { 'User-Agent': 'guIDE-whisper-fetch' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return req(res.headers.location);
        }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    };
    req(url);
  });
}

async function fetchRelease() {
  return fetchJson('https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest');
}

function pickAsset(release, platform) {
  const assets = release.assets || [];
  if (platform === 'win32') {
    return assets.find((a) => /whisper.*bin.*x64.*\.zip$/i.test(a.name))
      || assets.find((a) => /whisper.*x64.*\.zip$/i.test(a.name))
      || assets.find((a) => a.name.includes('x64') && a.name.endsWith('.zip'));
  }
  if (platform === 'darwin') {
    return assets.find((a) => /macos|darwin|mac/i.test(a.name) && (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz')));
  }
  return assets.find((a) => /linux.*x64|ubuntu/i.test(a.name) && (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz')));
}

function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -o "${archive}" -d "${destDir}"`, { stdio: 'inherit' });
    }
  } else if (archive.endsWith('.tar.gz') || archive.endsWith('.tgz')) {
    execSync(`tar -xzf "${archive}" -C "${destDir}"`, { stdio: 'inherit' });
  }
}

function findBinary(dir, names) {
  for (const name of names) {
    const direct = path.join(dir, name);
    if (fs.existsSync(direct)) return direct;
  }
  const walk = (d) => {
    if (!fs.existsSync(d)) return null;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        const found = walk(p);
        if (found) return found;
      } else if (names.includes(ent.name)) {
        return p;
      }
    }
    return null;
  };
  return walk(dir);
}

async function fetchBinaryForPlatform(platform) {
  const platDir = path.join(OUT, PLATFORM_DIRS[platform] || platform);
  const binNames = platform === 'win32'
    ? ['whisper-cli.exe', 'whisper.exe', 'main.exe']
    : ['whisper-cli', 'whisper', 'main'];
  const existing = findBinary(platDir, binNames);
  if (existing) {
    console.log(`[whisper-fetch] ${platform}: already have ${existing}`);
    return;
  }

  const release = await fetchRelease();
  const asset = pickAsset(release, platform);
  if (!asset) throw new Error(`No whisper.cpp asset for ${platform} in ${release.tag_name}`);

  const archive = path.join(OUT, '_cache', asset.name);
  console.log(`[whisper-fetch] ${platform}: downloading ${asset.name}`);
  await download(asset.browser_download_url, archive);

  const tmp = path.join(OUT, '_cache', `extract-${platform}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  extract(archive, tmp);

  const found = findBinary(tmp, binNames);
  if (!found) throw new Error(`Binary not found after extracting ${asset.name}`);

  fs.mkdirSync(platDir, { recursive: true });
  const destName = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  fs.copyFileSync(found, path.join(platDir, destName));
  if (platform !== 'win32') fs.chmodSync(path.join(platDir, destName), 0o755);
  console.log(`[whisper-fetch] ${platform}: installed ${destName}`);
}

async function fetchModel() {
  const modelPath = path.join(OUT, 'ggml-base.en.bin');
  if (fs.existsSync(modelPath)) {
    console.log('[whisper-fetch] model already present');
    return;
  }
  const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
  console.log('[whisper-fetch] downloading ggml-base.en.bin (~150MB)...');
  await download(url, modelPath);
  console.log('[whisper-fetch] model ready');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const target = process.env.WHISPER_PLATFORM || process.platform;
  await fetchBinaryForPlatform(target);
  if (!SKIP_MODEL) await fetchModel();
  console.log('[whisper-fetch] done');
}

main().catch((e) => {
  console.error('[whisper-fetch] failed:', e.message);
  process.exit(1);
});
