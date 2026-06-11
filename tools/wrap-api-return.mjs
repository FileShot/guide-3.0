import fs from 'fs';

const p = 'd:/Guide3/repo/electron-main.js';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.includes("ipcMain.handle('api-fetch'"));
const end = lines.findIndex((l) => l.includes('PTY Terminal over IPC')) - 2;
let wrapped = 0;
for (let i = start; i < end; i++) {
  const line = lines[i];
  if (line.includes('const apiReturn')) continue;
  const m = line.match(/^(\s+)return (.+);?\s*$/);
  if (m && !m[2].startsWith('apiReturn(')) {
    const expr = m[2].replace(/;+\s*$/, '');
    lines[i] = `${m[1]}return apiReturn(${expr});`;
    wrapped++;
  }
}
fs.writeFileSync(p, lines.join('\n'));
console.log(`apiReturn wrap done: ${wrapped} returns (lines ${start}-${end})`);
