'use strict';

/**
 * Resolve @mentions in chat input into context blocks for the agent.
 * Supports @file/path, @folder/path, @codebase, @selection, @web, @docs/query
 */
const fs = require('fs');
const path = require('path');

const MENTION_RE = /@(file|folder|codebase|selection|web|docs)(?:\/([^\s@]+))?/gi;

function readFileSafe(fullPath, maxChars = 12000) {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    const text = fs.readFileSync(fullPath, 'utf8');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n...[truncated]' : text;
  } catch {
    return null;
  }
}

function listFolderFiles(dir, max = 40) {
  try {
    const names = fs.readdirSync(dir).slice(0, max);
    return names.map(n => path.join(dir, n).replace(/\\/g, '/')).join('\n');
  } catch {
    return null;
  }
}

/**
 * @param {string} message
 * @param {{ projectPath?: string, ragEngine?: object, docsIndexService?: object, selection?: string, activeFile?: string }} ctx
 */
async function resolveMentions(message, ctx = {}) {
  const blocks = [];
  const projectPath = ctx.projectPath;
  if (!message || typeof message !== 'string') return { message, blocks };

  const matches = [...message.matchAll(MENTION_RE)];
  if (!matches.length) return { message, blocks };

  for (const m of matches) {
    const kind = (m[1] || '').toLowerCase();
    const arg = (m[2] || '').trim();

    if (kind === 'file' && arg && projectPath) {
      const full = path.isAbsolute(arg) ? arg : path.join(projectPath, arg);
      const content = readFileSafe(full);
      if (content != null) {
        blocks.push(`[@file ${arg}]\n${content}`);
      }
    } else if (kind === 'folder' && arg && projectPath) {
      const full = path.isAbsolute(arg) ? arg : path.join(projectPath, arg);
      const listing = listFolderFiles(full);
      if (listing) blocks.push(`[@folder ${arg}]\n${listing}`);
    } else if (kind === 'codebase' && ctx.ragEngine) {
      const q = arg || message.replace(MENTION_RE, '').trim() || 'project overview';
      const results = ctx.ragEngine.semanticSearch?.(q, 8) || ctx.ragEngine.embedSearch?.(q, 8) || ctx.ragEngine.search?.(q, 8) || [];
      if (results.length) {
        const text = results.map(r => `--- ${r.file || r.path} (score ${(r.score || 0).toFixed(2)}) ---\n${r.content || r.snippet || ''}`).join('\n\n');
        blocks.push(`[@codebase ${q}]\n${text}`);
      }
    } else if (kind === 'selection' && ctx.selection) {
      blocks.push(`[@selection]\n${ctx.selection}`);
    } else if (kind === 'web' && arg) {
      blocks.push(`[@web ${arg}]\n(User requested web context for: ${arg}. Use web_search tool if needed.)`);
    } else if (kind === 'docs' && ctx.docsIndexService) {
      const q = arg || '';
      const hits = ctx.docsIndexService.search?.(q, 5) || [];
      if (hits.length) {
        blocks.push(`[@docs ${q}]\n${hits.map(h => `--- ${h.path} ---\n${h.snippet || h.content || ''}`).join('\n\n')}`);
      }
    }
  }

  if (!blocks.length) return { message, blocks: [] };
  const enriched = `${message}\n\n[Mention context]\n${blocks.join('\n\n---\n\n')}`;
  return { message: enriched, blocks };
}

module.exports = { resolveMentions, MENTION_RE };
