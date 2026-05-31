'use strict';

/**
 * formatOnSave — run Prettier / ESLint on file save.
 * Returns formatted content and lint problems for the Problems panel.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const PRETTIER_PARSER_MAP = {
  javascript: 'babel', js: 'babel', jsx: 'babel', mjs: 'babel', cjs: 'babel',
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  css: 'css', scss: 'css', less: 'less',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  markdown: 'markdown', md: 'markdown', mdx: 'mdx',
  graphql: 'graphql', gql: 'graphql',
};

function loadPrettierConfig(projectPath) {
  if (!projectPath) return {};
  try {
    const rcPath = path.join(projectPath, '.prettierrc');
    if (fs.existsSync(rcPath)) return JSON.parse(fs.readFileSync(rcPath, 'utf8'));
  } catch (_) {}
  return {};
}

function runEslint(filePath, projectPath) {
  const problems = [];
  const cwd = projectPath || path.dirname(filePath);
  try {
    const out = execSync(
      `npx eslint --format json "${filePath}"`,
      { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(out || '[]');
    for (const file of parsed) {
      for (const msg of file.messages || []) {
        problems.push({
          file: filePath,
          line: msg.line || 1,
          column: msg.column || 1,
          message: msg.message,
          severity: msg.severity === 2 ? 'error' : 'warning',
          source: 'eslint',
        });
      }
    }
  } catch (e) {
    const stdout = e.stdout || '';
    if (stdout.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(stdout);
        for (const file of parsed) {
          for (const msg of file.messages || []) {
            problems.push({
              file: filePath,
              line: msg.line || 1,
              column: msg.column || 1,
              message: msg.message,
              severity: msg.severity === 2 ? 'error' : 'warning',
              source: 'eslint',
            });
          }
        }
        return problems;
      } catch (_) {}
    }
    if (!/eslint.*not found|Cannot find module 'eslint'/i.test(String(e.message))) {
      problems.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `ESLint: ${e.message}`,
        severity: 'warning',
        source: 'eslint',
      });
    }
  }
  return problems;
}

async function formatOnSave({ content, filePath, projectPath, formatEnabled = true, lintEnabled = true }) {
  const result = { content, formatted: false, problems: [], error: null };
  if (typeof content !== 'string' || !filePath) {
    return { ...result, error: 'content and filePath required' };
  }

  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const problems = [];

  if (formatEnabled) {
    try {
      const prettier = require('prettier');
      const parser = PRETTIER_PARSER_MAP[ext] || 'babel';
      const prettierConfig = loadPrettierConfig(projectPath);
      const formatted = await prettier.format(content, {
        parser,
        ...prettierConfig,
        filepath: filePath,
      });
      if (formatted !== content) {
        result.content = formatted;
        result.formatted = true;
      }
    } catch (e) {
      problems.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Prettier: ${e.message}`,
        severity: 'error',
        source: 'prettier',
      });
    }
  }

  if (lintEnabled && ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    const tmpPath = filePath;
    try {
      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      fs.writeFileSync(tmpPath, result.content, 'utf8');
      problems.push(...runEslint(tmpPath, projectPath));
    } catch (e) {
      problems.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Lint failed: ${e.message}`,
        severity: 'warning',
        source: 'eslint',
      });
    }
  }

  result.problems = problems;
  return result;
}

module.exports = { formatOnSave };
