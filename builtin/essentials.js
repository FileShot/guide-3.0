'use strict';

/**
 * Built-in guIDE Essentials — native capabilities (not VSIX).
 * Listed in marketplace as pre-installed; no download required.
 */
const BUILTIN_ESSENTIALS = [
  { id: 'builtin-prettier', name: 'Prettier', category: 'formatter', description: 'Format on save via bundled Prettier', builtin: true },
  { id: 'builtin-eslint', name: 'ESLint', category: 'linter', description: 'Lint on save via ESLint CLI', builtin: true },
  { id: 'builtin-error-lens', name: 'Error Lens', category: 'editor', description: 'Inline diagnostic messages in the editor', builtin: true },
  { id: 'builtin-git-blame', name: 'Git Blame (lite)', category: 'git', description: 'Per-line git blame on hover', builtin: true },
  { id: 'builtin-brackets', name: 'Bracket Colorization', category: 'editor', description: 'Colorized bracket pairs in Monaco', builtin: true },
  { id: 'builtin-yaml-lsp', name: 'YAML Language Server', category: 'language', description: 'YAML IntelliSense via bundled LSP', builtin: true },
  { id: 'builtin-rest', name: 'REST Client', category: 'tools', description: 'HTTP client in bottom panel REST tab', builtin: true },
  { id: 'builtin-todo', name: 'Better Comments', category: 'editor', description: 'TODO/FIXME highlights in editor', builtin: true },
];

module.exports = { BUILTIN_ESSENTIALS };
