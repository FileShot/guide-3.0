const fs = require('fs');
const path = require('path');

const root = process.cwd();

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base + '.js',
    base + '.cjs',
    base + '.mjs',
    path.join(base, 'index.js'),
  ];
  return candidates.find(fileExists) || null;
}

function parseRequires(absFile) {
  const src = read(absFile);
  const out = new Set();

  const rel = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = rel.exec(src))) {
    const r = resolveLocal(absFile, m[1]);
    if (r) out.add(path.relative(root, r).replace(/\\/g, '/'));
  }

  const rootJoin = /require\(\s*path\.join\(\s*ROOT_DIR\s*,\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
  while ((m = rootJoin.exec(src))) {
    const target = path.resolve(root, m[1]);
    const r = resolveLocal(absFile, target.startsWith('.') ? target : './' + path.relative(path.dirname(absFile), target).replace(/\\/g, '/'));
    const direct = [target, target + '.js', path.join(target, 'index.js')].find(fileExists);
    if (direct) out.add(path.relative(root, direct).replace(/\\/g, '/'));
  }

  const dirJoin = /require\(\s*path\.join\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
  while ((m = dirJoin.exec(src))) {
    const target = path.resolve(path.dirname(absFile), m[1]);
    const direct = [target, target + '.js', path.join(target, 'index.js')].find(fileExists);
    if (direct) out.add(path.relative(root, direct).replace(/\\/g, '/'));
  }

  return [...out];
}

function closure(entryRel) {
  const entry = path.resolve(root, entryRel);
  const seen = new Set([entryRel.replace(/\\/g, '/')]);
  const queue = [entry];

  while (queue.length) {
    const cur = queue.shift();
    const curRel = path.relative(root, cur).replace(/\\/g, '/');
    let requires = [];
    try { requires = parseRequires(cur); } catch { continue; }
    for (const depRel of requires) {
      if (!seen.has(depRel)) {
        seen.add(depRel);
        queue.push(path.resolve(root, depRel));
      }
    }
  }

  return [...seen].sort();
}

const serverSet = closure('server/main.js');
const electronSet = closure('electron-main.js');

const serverOnly = serverSet.filter(x => !electronSet.includes(x));
const electronOnly = electronSet.filter(x => !serverSet.includes(x));
const shared = serverSet.filter(x => electronSet.includes(x));

function print(title, arr) {
  console.log(title + ' (' + arr.length + ')');
  for (const x of arr) console.log(' - ' + x);
}

print('SHARED_FILES', shared);
print('SERVER_ONLY_FILES', serverOnly);
print('ELECTRON_ONLY_FILES', electronOnly);
