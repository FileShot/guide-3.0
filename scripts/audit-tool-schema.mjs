import fs from 'fs';

const mcp = fs.readFileSync('mcpToolServer.js', 'utf8');
const ce = fs.readFileSync('chatEngine.js', 'utf8');
const tp = fs.readFileSync('tools/toolParser.js', 'utf8');

const defs = {};
const re = /\{\s*\n\s*name: '([^']+)'[\s\S]*?parameters: \{([\s\S]*?)\n\s*\},/g;
let m;
while ((m = re.exec(mcp)) !== null) {
  const name = m[1];
  const pblock = m[2];
  const params = {};
  const pline = /(\w+): \{ type: '([^']+)'[^}]*required: (true|false)/g;
  let pm;
  while ((pm = pline.exec(pblock)) !== null) {
    params[pm[1]] = { required: pm[3] === 'true' };
  }
  defs[name] = params;
}

const handlerParams = {
  write_scratchpad: ['name', 'content'],
  read_scratchpad: ['name'],
  edit_file: ['filePath', 'oldText', 'newText'],
  list_directory: ['dirPath'],
  save_rule: ['name', 'content'],
};

const issues = [];
for (const [tool, hp] of Object.entries(handlerParams)) {
  const def = defs[tool];
  if (!def) {
    issues.push({ severity: 'HIGH', tool, issue: 'No tool definition' });
    continue;
  }
  for (const p of hp) {
    if (!def[p]) {
      issues.push({
        severity: 'CRITICAL',
        tool,
        issue: `Executor reads "${p}"; definition keys: ${Object.keys(def).join(', ')}`,
      });
    }
  }
}

const sysMatch = ce.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
const sys = sysMatch ? sysMatch[1] : '';
const promptIssues = [];
if (sys.includes('old_string')) {
  promptIssues.push('SYSTEM_PROMPT edit_file example: old_string/new_string (def: oldText/newText)');
}
if (/"path":"<DIRECTORY_PATH>"/.test(sys)) {
  promptIssues.push('SYSTEM_PROMPT list_directory example: path (def: dirPath)');
}

const cases = [...mcp.matchAll(/case '([^']+)':/g)].map((x) => x[1]);
const defNames = new Set(Object.keys(defs));
const ghostHandlers = [...new Set(cases)].filter((c) => !defNames.has(c) && !['npm', 'yarn', 'pip'].includes(c));

const buildPrompt = mcp.includes('browser_list_elements') && !defNames.has('browser_list_elements');

console.log(JSON.stringify({
  totalTools: defNames.size,
  defExecutorMismatches: issues,
  systemPromptExampleMismatches: promptIssues,
  ghostHandlers,
  buildPromptReferencesUndefTool: buildPrompt,
  scratchpad: { def: defs.write_scratchpad, executor: ['key', 'content'] },
}, null, 2));
