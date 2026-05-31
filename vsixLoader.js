'use strict';

/**
 * vsixLoader — extract VSIX zip, read package.json, register as guIDE extension.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

async function _extractZip(buffer, destDir) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    zip.extractAllTo(destDir, true);
    return;
  } catch (_) {}

  const tmpZip = path.join(destDir, 'ext.zip');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(tmpZip, buffer);
  if (process.platform === 'win32') {
    execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${destDir}' -Force"`, { timeout: 60000 });
  } else {
    execSync(`unzip -o "${tmpZip}" -d "${destDir}"`, { timeout: 60000 });
  }
  try { fs.unlinkSync(tmpZip); } catch (_) {}
}

function _findPackageJson(rootDir) {
  const direct = path.join(rootDir, 'extension', 'package.json');
  if (fs.existsSync(direct)) return { pkgPath: direct, extRoot: path.join(rootDir, 'extension') };
  const rootPkg = path.join(rootDir, 'package.json');
  if (fs.existsSync(rootPkg)) return { pkgPath: rootPkg, extRoot: rootDir };
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(rootDir, e.name, 'package.json');
    if (fs.existsSync(sub)) return { pkgPath: sub, extRoot: path.join(rootDir, e.name) };
  }
  return null;
}

function _vsixToManifest(vscodePkg, extRoot) {
  const id = (vscodePkg.name || 'vsix-extension').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const publisher = (vscodePkg.publisher || 'unknown').toLowerCase();
  return {
    id: `${publisher}-${id}`.replace(/[^a-z0-9-]/g, '-'),
    name: vscodePkg.displayName || vscodePkg.name || id,
    version: vscodePkg.version || '0.0.1',
    description: vscodePkg.description || 'Imported VSIX extension',
    author: vscodePkg.publisher || 'Unknown',
    category: 'other',
    main: vscodePkg.main || null,
    homepage: vscodePkg.homepage || null,
    repository: typeof vscodePkg.repository === 'string' ? vscodePkg.repository : vscodePkg.repository?.url,
    engines: vscodePkg.engines,
    contributes: vscodePkg.contributes,
    _vsix: true,
    _extRoot: extRoot,
  };
}

async function loadVsix(buffer, extensionManager) {
  const tmpDir = path.join(os.tmpdir(), `guide-vsix-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await _extractZip(buffer, tmpDir);
    const found = _findPackageJson(tmpDir);
    if (!found) throw new Error('No package.json found in VSIX');

    const vscodePkg = JSON.parse(fs.readFileSync(found.pkgPath, 'utf8'));
    const manifest = _vsixToManifest(vscodePkg, found.extRoot);

    const installDir = path.join(tmpDir, 'guide-ext');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Copy VSIX extension files into install dir
    const copyRecursive = (src, dest) => {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(destPath, { recursive: true });
          copyRecursive(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    };
    copyRecursive(found.extRoot, installDir);

    const result = await extensionManager.installFromDir(installDir);
    return { success: true, ...result, manifest };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { loadVsix, _vsixToManifest };
