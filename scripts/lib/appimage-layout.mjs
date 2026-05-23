/** Resolve electron-builder AppImage layout (binary is productName, not "electron"). */
import fs from 'fs';
import path from 'path';

const BINARY_NAMES = ['guide-ide', 'guIDE', 'electron'];

function isElf(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveAppImageRoot(extractDir) {
  const squash = path.join(extractDir, 'squashfs-root');
  if (fs.existsSync(squash)) return squash;
  return extractDir;
}

export function findAppImageBinary(root) {
  for (const name of BINARY_NAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && isElf(candidate)) {
      return candidate;
    }
  }
  const elfCandidates = [];
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    try {
      if (
        fs.statSync(candidate).isFile() &&
        isElf(candidate) &&
        fs.statSync(candidate).size > 256 * 1024
      ) {
        elfCandidates.push(candidate);
      }
    } catch {
      /* skip */
    }
  }
  if (elfCandidates.length) {
    elfCandidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return elfCandidates[0];
  }
  const entries = fs.readdirSync(root);
  throw new Error(
    `AppImage has no ELF shell binary at root. Found: ${entries.join(', ')}`,
  );
}

export function findPackagedAppDir(root) {
  const direct = path.join(root, 'resources', 'app');
  if (fs.existsSync(direct)) return direct;
  const resources = path.join(root, 'resources');
  if (fs.existsSync(resources)) {
    for (const name of fs.readdirSync(resources)) {
      const full = path.join(resources, name);
      if (name.startsWith('app') && fs.statSync(full).isDirectory()) return full;
    }
  }
  throw new Error(`no resources/app in AppImage (root=${root})`);
}

export function appImageLibraryPath(root) {
  const dirs = [root];
  for (const sub of ['usr/lib', 'usr/lib/x86_64-linux-gnu', 'lib']) {
    const p = path.join(root, sub);
    if (fs.existsSync(p)) dirs.push(p);
  }
  return dirs.join(':');
}
