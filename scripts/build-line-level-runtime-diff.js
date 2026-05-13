const fs = require('fs');
const path = require('path');

const root = process.cwd();

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.resolve(root, rel), 'utf8'));
}

function readLines(rel) {
  const abs = path.resolve(root, rel);
  const text = fs.readFileSync(abs, 'utf8');
  return text.split(/\r?\n/);
}

function section(title) {
  return `\n## ${title}\n`;
}

function main() {
  const summary = readJson('server-vs-electron-exhaustive-summary.json');

  let md = '# Server vs Electron Line-Level Runtime Differences\n';
  md += `\nGenerated: ${new Date().toISOString()}\n`;
  md += `\nWorkspace files scanned: ${summary.totalFiles}\n`;
  md += `\nServer runtime closure files: ${summary.closure.serverRuntimeFiles}\n`;
  md += `\nElectron runtime closure files: ${summary.closure.electronRuntimeFiles}\n`;
  md += `\nShared runtime files: ${summary.closure.sharedRuntimeFiles}\n`;
  md += `\nServer-only runtime files: ${summary.closure.serverOnlyRuntimeFiles}\n`;
  md += `\nElectron-only runtime files: ${summary.closure.electronOnlyRuntimeFiles}\n`;

  md += section('Primary Pair Diff');
  md += 'Full unified diff is in `server-vs-electron-main.diff`.';

  md += section('Server-Only Runtime Files (line-by-line)');
  for (const rel of summary.serverOnlyRuntimeFiles) {
    const lines = readLines(rel);
    md += `\n### ${rel} (lines: ${lines.length})\n`;
    md += '\n```diff\n';
    for (let i = 0; i < lines.length; i++) {
      md += `- ${String(i + 1).padStart(4, ' ')} | ${lines[i]}\n`;
    }
    md += '```\n';
  }

  md += section('Electron-Only Runtime Files (line-by-line)');
  for (const rel of summary.electronOnlyRuntimeFiles) {
    const lines = readLines(rel);
    md += `\n### ${rel} (lines: ${lines.length})\n`;
    md += '\n```diff\n';
    for (let i = 0; i < lines.length; i++) {
      md += `+ ${String(i + 1).padStart(4, ' ')} | ${lines[i]}\n`;
    }
    md += '```\n';
  }

  md += section('Shared Runtime Files');
  md += 'These are identical by path (same source file used by both runtimes):\n';
  for (const rel of summary.sharedRuntimeFiles) {
    md += `- ${rel}\n`;
  }

  md += section('Version Drift Evidence');
  md += '```json\n';
  md += JSON.stringify(summary.versions, null, 2);
  md += '\n```\n';

  fs.writeFileSync(path.resolve(root, 'server-vs-electron-line-level-differences.md'), md, 'utf8');
  console.log('WROTE server-vs-electron-line-level-differences.md');
}

main();
