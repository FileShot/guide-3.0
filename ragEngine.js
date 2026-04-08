/**
 * guIDE 2.0 — RAG Engine
 *
 * Retrieval-Augmented Generation engine for codebase understanding.
 * Indexes project files and provides text-based search (BM25-style scoring).
 * Fully offline — no embedding models or external services required.
 *
 * Features:
 *   - Indexes all text files in a project (respects .gitignore + defaults)
 *   - Chunk-level search with BM25 scoring
 *   - File name/path search
 *   - Error context analysis (stack trace → relevant code)
 *   - File cache for grep-style inline search by other tools
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constants ───────────────────────────────────────────

const MAX_FILE_SIZE = 512 * 1024; // 512KB per file
const CHUNK_SIZE = 40;            // lines per chunk
const CHUNK_OVERLAP = 10;         // overlapping lines between chunks

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.avif',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.webm', '.avi', '.mkv', '.mov',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.gguf', '.safetensors', '.pt', '.onnx', '.pth',
  '.pyc', '.class', '.o', '.obj', '.a', '.lib',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  'dist', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage',
  '.idea', '.vscode', '.vs', 'target', 'vendor',
]);

// ─── BM25 helpers ────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9_$]+/g) || [];
}

function computeIDF(docs, totalDocs) {
  // docs = number of documents containing the term
  return Math.log((totalDocs - docs + 0.5) / (docs + 0.5) + 1);
}

function scoreBM25(queryTokens, docTokens, avgDL, idfMap) {
  const k1 = 1.5;
  const b = 0.75;
  const dl = docTokens.length;

  // Term frequency map for this document
  const tf = {};
  for (const t of docTokens) {
    tf[t] = (tf[t] || 0) + 1;
  }

  let score = 0;
  for (const qt of queryTokens) {
    const freq = tf[qt] || 0;
    if (freq === 0) continue;
    const idf = idfMap[qt] || 0;
    score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * dl / avgDL)));
  }
  return score;
}

// ─── RAGEngine class ─────────────────────────────────────

class RAGEngine {
  constructor() {
    this.projectPath = null;
    this._fileCache = {};      // { relativePath: content }
    this._chunks = [];         // [{ relativePath, startLine, endLine, content, tokens }]
    this._idfMap = {};         // { token: idf }
    this._avgDL = 0;
    this._indexed = false;
    this._indexing = false;
  }

  /**
   * Index all text files in the project.
   * @param {string} projectPath — absolute path to project root
   */
  async indexProject(projectPath) {
    if (this._indexing) return;
    this._indexing = true;

    try {
      this.projectPath = projectPath;
      this._fileCache = {};
      this._chunks = [];

      // Load .gitignore patterns
      const ignorePatterns = this._loadGitignore(projectPath);

      // Walk the file tree
      await this._walkDir(projectPath, '', ignorePatterns);

      // Build chunks and IDF index
      this._buildIndex();

      this._indexed = true;
      console.log(`[RAGEngine] Indexed ${Object.keys(this._fileCache).length} files, ${this._chunks.length} chunks`);
    } finally {
      this._indexing = false;
    }
  }

  /**
   * Search for relevant code chunks.
   * @param {string} query
   * @param {number} maxResults
   * @returns {Array<{ relativePath, startLine, endLine, score, content }>}
   */
  search(query, maxResults) {
    if (!maxResults) maxResults = 10;
    if (!this._indexed || this._chunks.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored = this._chunks.map(chunk => ({
      relativePath: chunk.relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      score: scoreBM25(queryTokens, chunk.tokens, this._avgDL, this._idfMap),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).filter(r => r.score > 0);
  }

  /**
   * Search for files by name/path pattern.
   * @param {string} pattern — glob-like pattern (simple substring or wildcard)
   * @param {number} maxResults
   * @returns {string[]} — matching relative paths
   */
  searchFiles(pattern, maxResults) {
    if (!maxResults) maxResults = 20;
    if (!this._indexed) return [];

    const p = (pattern || '').toLowerCase();
    const files = Object.keys(this._fileCache);

    // Convert simple glob to regex
    const globRegex = new RegExp(
      p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'),
      'i'
    );

    return files
      .filter(f => globRegex.test(f))
      .slice(0, maxResults);
  }

  /**
   * Find code relevant to an error message and stack trace.
   * @param {string} errorMessage
   * @param {string} stackTrace
   * @returns {{ relevantFiles: Array, suggestedFix: string }}
   */
  findErrorContext(errorMessage, stackTrace) {
    const result = { relevantFiles: [], suggestedFix: '' };

    // Extract file references from stack trace
    const fileRefs = this._extractFileRefs(stackTrace || '');
    const relevantFiles = new Set();

    for (const ref of fileRefs) {
      // Try to find the file in our cache
      const normalizedRef = ref.file.replace(/\\/g, '/');
      for (const cachedPath of Object.keys(this._fileCache)) {
        if (cachedPath.endsWith(normalizedRef) || normalizedRef.endsWith(cachedPath)) {
          const content = this._fileCache[cachedPath];
          const lines = content.split('\n');
          const lineNum = ref.line || 0;
          const contextStart = Math.max(0, lineNum - 5);
          const contextEnd = Math.min(lines.length, lineNum + 5);
          relevantFiles.add(cachedPath);
          result.relevantFiles.push({
            file: cachedPath,
            line: lineNum,
            context: lines.slice(contextStart, contextEnd).join('\n'),
          });
          break;
        }
      }
    }

    // Also search for error-related code
    const errorSearch = this.search(errorMessage, 5);
    for (const r of errorSearch) {
      if (!relevantFiles.has(r.relativePath)) {
        result.relevantFiles.push({
          file: r.relativePath,
          line: r.startLine,
          context: r.content.substring(0, 500),
        });
      }
    }

    return result;
  }

  // ─── Internal methods ──────────────────────────────────

  _loadGitignore(projectPath) {
    const patterns = [];
    try {
      const gitignorePath = path.join(projectPath, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            patterns.push(trimmed);
          }
        }
      }
    } catch {
      // No .gitignore or unreadable
    }
    return patterns;
  }

  _isIgnored(relativePath, ignorePatterns) {
    const parts = relativePath.split('/');

    // Check directory name against built-in ignores
    for (const part of parts) {
      if (IGNORED_DIRS.has(part)) return true;
    }

    // Check file extension
    const ext = path.extname(relativePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return true;

    // Check .gitignore patterns (simple matching)
    for (const pattern of ignorePatterns) {
      const p = pattern.replace(/^\//, '');
      if (relativePath.startsWith(p) || relativePath.includes('/' + p)) return true;
      // Simple glob
      const globRegex = new RegExp(
        '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '<<GLOBSTAR>>').replace(/\*/g, '[^/]*').replace(/<<GLOBSTAR>>/g, '.*') + '(/|$)',
        'i'
      );
      if (globRegex.test(relativePath)) return true;
    }

    return false;
  }

  async _walkDir(fullPath, relativePath, ignorePatterns) {
    let entries;
    try {
      entries = fs.readdirSync(fullPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;

      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (this._isIgnored(relPath, ignorePatterns)) continue;
        await this._walkDir(path.join(fullPath, entry.name), relPath, ignorePatterns);
      } else if (entry.isFile()) {
        if (this._isIgnored(relPath, ignorePatterns)) continue;
        this._readFile(path.join(fullPath, entry.name), relPath);
      }
    }
  }

  _readFile(fullPath, relativePath) {
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) return;
      if (stat.size === 0) return;

      const content = fs.readFileSync(fullPath, 'utf8');
      // Quick binary check — if there are null bytes, skip
      if (content.includes('\0')) return;

      this._fileCache[relativePath] = content;
    } catch {
      // Unreadable file
    }
  }

  _buildIndex() {
    // Split all files into overlapping chunks
    const docFreq = {}; // token → number of chunks containing it

    for (const [relativePath, content] of Object.entries(this._fileCache)) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        const chunkLines = lines.slice(i, i + CHUNK_SIZE);
        const chunkContent = chunkLines.join('\n');
        const tokens = tokenize(chunkContent);

        this._chunks.push({
          relativePath,
          startLine: i,
          endLine: Math.min(i + CHUNK_SIZE, lines.length),
          content: chunkContent,
          tokens,
        });

        // Track document frequency (unique tokens per chunk)
        const seen = new Set(tokens);
        for (const t of seen) {
          docFreq[t] = (docFreq[t] || 0) + 1;
        }
      }
    }

    // Compute IDF for each token
    const totalDocs = this._chunks.length;
    for (const [token, freq] of Object.entries(docFreq)) {
      this._idfMap[token] = computeIDF(freq, totalDocs);
    }

    // Average document length
    const totalTokens = this._chunks.reduce((sum, c) => sum + c.tokens.length, 0);
    this._avgDL = totalTokens / (this._chunks.length || 1);
  }

  _extractFileRefs(stackTrace) {
    const refs = [];
    // Match patterns like:
    //   at Module._compile (path/to/file.js:123:45)
    //   at path\to\file.js:123
    //   File "path/to/file.py", line 123
    const patterns = [
      /(?:at\s+(?:\S+\s+)?\(?)([^:(\s]+\.[a-z]+):(\d+)/gi,
      /File\s+"([^"]+)",\s+line\s+(\d+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(stackTrace)) !== null) {
        refs.push({
          file: match[1],
          line: parseInt(match[2], 10),
        });
      }
    }

    return refs;
  }
}

module.exports = { RAGEngine };
