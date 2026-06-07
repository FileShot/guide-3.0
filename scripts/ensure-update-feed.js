#!/usr/bin/env node
'use strict';

/**
 * Ensure electron-updater feed YAML exists after electron-builder.
 * CUDA channel builds sometimes skip yml generation with --publish never;
 * this writes cuda.yml / cuda-linux.yml matching electron-updater naming.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs() {
  const args = { channel: 'latest', platform: 'win', glob: null, feedName: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--channel') args.channel = process.argv[++i];
    else if (a === '--platform') args.platform = process.argv[++i];
    else if (a === '--glob') args.glob = process.argv[++i];
    else if (a === '--feed') args.feedName = process.argv[++i];
  }
  return args;
}

function getFeedName(channel, platform) {
  if (platform === 'linux') return `${channel}-linux.yml`;
  if (platform === 'mac') return `${channel}-mac.yml`;
  return `${channel}.yml`;
}

function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('base64')));
    stream.on('error', reject);
  });
}

function matchGlob(name, pattern) {
  const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
  return re.test(name);
}

async function main() {
  const args = parseArgs();
  const distDir = path.join(process.cwd(), 'dist-electron');
  if (!fs.existsSync(distDir)) {
    console.error('[ensure-update-feed] dist-electron not found');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const feedName = args.feedName || getFeedName(args.channel, args.platform);
  const feedPath = path.join(distDir, feedName);

  if (fs.existsSync(feedPath)) {
    console.log(`[ensure-update-feed] ${feedName} already exists`);
    return;
  }

  const globs = args.glob
    ? [args.glob]
    : args.platform === 'win'
      ? ['guIDE-*-setup.exe']
      : args.platform === 'linux'
        ? ['guIDE-*.AppImage']
        : ['guIDE-*.dmg'];

  const files = fs.readdirSync(distDir);
  let artifact = null;
  for (const g of globs) {
    artifact = files.find((f) => matchGlob(f, g) && !f.endsWith('.blockmap'));
    if (artifact) break;
  }
  if (!artifact) {
    console.error(`[ensure-update-feed] No installer matching ${globs.join(', ')} in dist-electron`);
    process.exit(1);
  }

  const artifactPath = path.join(distDir, artifact);
  const sha512 = await sha512File(artifactPath);
  const stat = fs.statSync(artifactPath);
  const releaseDate = new Date().toISOString();

  const content = [
    `version: ${pkg.version}`,
    'files:',
    `  - url: ${artifact}`,
    `    sha512: ${sha512}`,
    `    size: ${stat.size}`,
    `path: ${artifact}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');

  fs.writeFileSync(feedPath, content);
  console.log(`[ensure-update-feed] wrote ${feedName} for ${artifact}`);
}

main().catch((err) => {
  console.error('[ensure-update-feed]', err);
  process.exit(1);
});
