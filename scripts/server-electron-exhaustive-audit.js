const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = process.cwd();

const SKIP_DIRS = new Set([
  '.git',
]);

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function walkAllFiles(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = toPosix(path.relative(root, abs));
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkAllFiles(abs, out);
      continue;
    }
    out.push(rel);
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function tryReadUtf8(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function lineCountFromText(text) {
  if (text == null) return null;
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(absPath);
  hash.update(data);
  return hash.digest('hex');
}

function resolveLocal(fromFileAbs, spec) {
  const base = path.resolve(path.dirname(fromFileAbs), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    path.join(base, 'index.js'),
  ];
  const found = candidates.find(fileExists);
  return found || null;
}

function parseRequires(absFile) {
  const src = tryReadUtf8(absFile);
  if (src == null) return [];
  const deps = new Set();

  let m;
  const relRe = /require\(\s*['\"](\.[^'\"]+)['\"]\s*\)/g;
  while ((m = relRe.exec(src))) {
    const resolved = resolveLocal(absFile, m[1]);
    if (resolved) deps.add(toPosix(path.relative(root, resolved)));
  }

  const rootJoinRe = /require\(\s*path\.join\(\s*ROOT_DIR\s*,\s*['\"]([^'\"]+)['\"]\s*\)\s*\)/g;
  while ((m = rootJoinRe.exec(src))) {
    const target = path.resolve(root, m[1]);
    const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
    const found = candidates.find(fileExists);
    if (found) deps.add(toPosix(path.relative(root, found)));
  }

  const dirJoinRe = /require\(\s*path\.join\(\s*__dirname\s*,\s*['\"]([^'\"]+)['\"]\s*\)\s*\)/g;
  while ((m = dirJoinRe.exec(src))) {
    const target = path.resolve(path.dirname(absFile), m[1]);
    const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
    const found = candidates.find(fileExists);
    if (found) deps.add(toPosix(path.relative(root, found)));
  }

  return [...deps];
}

function buildClosure(entryRel) {
  const seen = new Set();
  const queue = [entryRel];

  while (queue.length > 0) {
    const rel = toPosix(queue.shift());
    if (seen.has(rel)) continue;
    seen.add(rel);

    const abs = path.resolve(root, rel);
    if (!fileExists(abs)) continue;
    const deps = parseRequires(abs);
    for (const dep of deps) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }

  return seen;
}

function detectCategory(inServer, inElectron) {
  if (inServer && inElectron) return 'shared-runtime';
  if (inServer) return 'server-runtime-only';
  if (inElectron) return 'electron-runtime-only';
  return 'non-runtime';
}

function quoteCsv(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function extractVersions() {
  const out = {};
  const read = (rel) => {
    const abs = path.resolve(root, rel);
    return tryReadUtf8(abs);
  };

  const pkg = read('package.json');
  if (pkg) {
    try {
      out.packageVersion = JSON.parse(pkg).version;
    } catch {}
  }

  const latestYml = read('dist-electron/latest.yml');
  if (latestYml) {
    const m = latestYml.match(/^version:\s*(.+)$/m);
    out.distLatestVersion = m ? m[1].trim() : null;
  }

  const appJsx = read('frontend/src/App.jsx');
  if (appJsx) {
    const m = appJsx.match(/guIDE\s+([0-9]+\.[0-9]+\.[0-9]+)/);
    out.frontendAppLiteral = m ? m[1] : null;
  }

  const statusBar = read('frontend/src/components/StatusBar.jsx');
  if (statusBar) {
    const m = statusBar.match(/v([0-9]+\.[0-9]+\.[0-9]+)/);
    out.frontendStatusLiteral = m ? m[1] : null;
  }

  const installer = read('scripts/build-installers.js');
  if (installer) {
    const m = installer.match(/const\s+VERSION\s*=\s*'([^']+)'/);
    out.installerScriptVersion = m ? m[1] : null;
  }

  const serverMain = read('server/main.js');
  if (serverMain) {
    const m = serverMain.match(/version:\s*'([^']+)'/);
    out.serverHealthVersion = m ? m[1] : null;
  }

  const electronMain = read('electron-main.js');
  if (electronMain) {
    const m = electronMain.match(/version:\s*'([^']+)'/);
    out.electronHealthVersion = m ? m[1] : null;
  }

  return out;
}

function main() {
  const serverClosure = buildClosure('server/main.js');
  const electronClosure = buildClosure('electron-main.js');

  const allFiles = [];
  walkAllFiles(root, allFiles);
  allFiles.sort();

  const runtimeUnion = new Set([...serverClosure, ...electronClosure]);

  const rows = [];
  for (const rel of allFiles) {
    const abs = path.resolve(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }

    const inServer = serverClosure.has(rel);
    const inElectron = electronClosure.has(rel);
    const category = detectCategory(inServer, inElectron);

    let lines = '';
    let textReadable = false;
    let sha256 = '';

    const isRuntimeFile = runtimeUnion.has(rel);
    if (isRuntimeFile) {
      const text = tryReadUtf8(abs);
      if (text != null) {
        textReadable = true;
        lines = String(lineCountFromText(text));
      }
      try {
        sha256 = sha256File(abs);
      } catch {
        sha256 = '';
      }
    }

    rows.push({
      path: rel,
      sizeBytes: stat.size,
      ext: path.extname(rel),
      inServerRuntime: inServer,
      inElectronRuntime: inElectron,
      category,
      lines,
      textReadable,
      runtimeSha256: sha256,
    });
  }

  const csvHeader = [
    'path',
    'sizeBytes',
    'ext',
    'inServerRuntime',
    'inElectronRuntime',
    'category',
    'lines',
    'textReadable',
    'runtimeSha256',
  ];

  const csvLines = [csvHeader.join(',')];
  for (const r of rows) {
    csvLines.push([
      quoteCsv(r.path),
      quoteCsv(r.sizeBytes),
      quoteCsv(r.ext),
      quoteCsv(r.inServerRuntime),
      quoteCsv(r.inElectronRuntime),
      quoteCsv(r.category),
      quoteCsv(r.lines),
      quoteCsv(r.textReadable),
      quoteCsv(r.runtimeSha256),
    ].join(','));
  }

  const shared = [...serverClosure].filter((f) => electronClosure.has(f)).sort();
  const serverOnly = [...serverClosure].filter((f) => !electronClosure.has(f)).sort();
  const electronOnly = [...electronClosure].filter((f) => !serverClosure.has(f)).sort();

  const countsByCategory = rows.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {});

  const versions = extractVersions();

  const summary = {
    generatedAt: new Date().toISOString(),
    workspaceRoot: root,
    totalFiles: rows.length,
    closure: {
      serverRuntimeFiles: serverClosure.size,
      electronRuntimeFiles: electronClosure.size,
      sharedRuntimeFiles: shared.length,
      serverOnlyRuntimeFiles: serverOnly.length,
      electronOnlyRuntimeFiles: electronOnly.length,
    },
    categories: countsByCategory,
    versions,
    sharedRuntimeFiles: shared,
    serverOnlyRuntimeFiles: serverOnly,
    electronOnlyRuntimeFiles: electronOnly,
  };

  fs.writeFileSync(path.resolve(root, 'server-vs-electron-full-inventory.csv'), csvLines.join('\n'));
  fs.writeFileSync(path.resolve(root, 'server-vs-electron-exhaustive-summary.json'), JSON.stringify(summary, null, 2));

  console.log('WROTE server-vs-electron-full-inventory.csv');
  console.log('WROTE server-vs-electron-exhaustive-summary.json');
  console.log(`TOTAL_FILES=${rows.length}`);
  console.log(`SERVER_RUNTIME=${serverClosure.size}`);
  console.log(`ELECTRON_RUNTIME=${electronClosure.size}`);
  console.log(`SHARED_RUNTIME=${shared.length}`);
  console.log(`SERVER_ONLY_RUNTIME=${serverOnly.length}`);
  console.log(`ELECTRON_ONLY_RUNTIME=${electronOnly.length}`);
}

main();
