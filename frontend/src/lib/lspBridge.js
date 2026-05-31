/**
 * LSP ↔ Monaco bridge — diagnostics, completion, hover, definition, symbols.
 * Communicates with main-process LSP via electronAPI.apiFetch or fetch.
 */

let _nextLocalId = 1;
let _markersCallback = null;
let _monacoRef = null;
let _cleanupFns = [];

/** Map filesystem path to Monaco/LSP file URI */
export function pathToUri(filePath) {
  if (!filePath) return '';
  const normalized = String(filePath).replace(/\\/g, '/');
  if (normalized.startsWith('file://')) return normalized;
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith('/')) return `file://${normalized}`;
  return `file:///${normalized}`;
}

/** Map LSP file URI back to filesystem path */
export function uriToPath(uri) {
  if (!uri) return '';
  if (!uri.startsWith('file://')) return uri;
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  const isWin = typeof window !== 'undefined' && window.electronAPI?.platform === 'win32';
  if (isWin && p.startsWith('/') && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return isWin ? p.replace(/\//g, '\\') : p;
}

async function apiFetch(url, options = {}) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (api?.apiFetch) return api.apiFetch(url, options);
  const r = await fetch(url, options);
  return r.json();
}

function lspSeverityToMonaco(severity, monaco) {
  if (!monaco?.MarkerSeverity) return 2;
  switch (severity) {
    case 1: return monaco.MarkerSeverity.Error;
    case 2: return monaco.MarkerSeverity.Warning;
    case 3: return monaco.MarkerSeverity.Info;
    case 4: return monaco.MarkerSeverity.Hint;
    default: return monaco.MarkerSeverity.Info;
  }
}

function convertDiagnostics(uri, diagnostics, monaco) {
  return (diagnostics || []).map((d) => ({
    severity: lspSeverityToMonaco(d.severity, monaco),
    startLineNumber: (d.range?.start?.line ?? 0) + 1,
    startColumn: (d.range?.start?.character ?? 0) + 1,
    endLineNumber: (d.range?.end?.line ?? 0) + 1,
    endColumn: (d.range?.end?.character ?? 0) + 1,
    message: d.message || '',
    source: d.source || 'LSP',
    code: d.code != null ? String(d.code) : undefined,
  }));
}

function applyDiagnostics({ uri, diagnostics }, monaco) {
  if (!monaco || !uri) return;
  const filePath = uriToPath(uri);
  const markers = convertDiagnostics(uri, diagnostics, monaco);
  const models = monaco.editor.getModels();
  const model = models.find((m) => {
    const mp = m.uri?.fsPath || uriToPath(m.uri?.toString());
    return mp === filePath || pathToUri(mp) === uri;
  });
  if (model) {
    monaco.editor.setModelMarkers(model, 'lsp', markers);
  }
  if (_markersCallback) _markersCallback({ uri, filePath, markers });
}

function handleLspMessage({ msg }) {
  if (!msg) return;
  if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
    applyDiagnostics(msg.params, _monacoRef);
  }
}

/** Handle diagnostics pushed via lsp-diagnostics IPC channel */
export function handleLspDiagnostics(data) {
  if (!data) return;
  applyDiagnostics(data, _monacoRef);
}

export function setLspMarkersCallback(cb) {
  _markersCallback = cb;
}

export async function requestCompletion({ uri, line, character, language, cwd }) {
  const r = await apiFetch('/api/lsp/completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri, line, character, language, cwd }),
  });
  return r?.result ?? r;
}

export async function requestHover({ uri, line, character, language, cwd }) {
  const r = await apiFetch('/api/lsp/hover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri, line, character, language, cwd }),
  });
  return r?.result ?? r;
}

export async function requestDefinition({ uri, line, character, language, cwd }) {
  const r = await apiFetch('/api/lsp/definition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri, line, character, language, cwd }),
  });
  return r?.result ?? r;
}

export async function requestDocumentSymbols({ uri, language, cwd }) {
  const r = await apiFetch('/api/lsp/documentSymbol', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri, language, cwd }),
  });
  return r?.result ?? r;
}

export async function notifyDidOpen({ uri, language, text, version = 1 }) {
  return apiFetch('/api/lsp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: language, version, text: text || '' } },
    }),
  });
}

export async function notifyDidChange({ uri, text, version }) {
  return apiFetch('/api/lsp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: version || ++_nextLocalId },
        contentChanges: [{ text: text || '' }],
      },
    }),
  });
}

export async function requestRename({ uri, line, character, newName, language, cwd }) {
  const r = await apiFetch('/api/lsp/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri, line, character, newName, language, cwd }),
  });
  return r?.result ?? r;
}

/** Disable Monaco built-in TS/JS diagnostics when external LSP provides them */
export function disableMonacoBuiltInTsDiagnostics(monaco) {
  if (!monaco?.languages?.typescript) return;
  const opts = { noSemanticValidation: true, noSyntaxValidation: true };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(opts);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(opts);
}

export async function refreshLspDiagnosticsMode(monaco) {
  if (!monaco) return;
  try {
    const r = await apiFetch('/api/lsp/status', { method: 'GET' });
    const tsOk = r?.status?.typescript?.installed || (r?.running || []).some((s) => s.key === 'typescript');
    if (tsOk) disableMonacoBuiltInTsDiagnostics(monaco);
  } catch (_) {}
}

export async function notifyDidClose({ uri }) {
  return apiFetch('/api/lsp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'textDocument/didClose',
      params: { textDocument: { uri } },
    }),
  });
}

/** Flatten hierarchical document symbols into a list with line ranges */
export function flattenDocumentSymbols(symbols, parent = null) {
  const out = [];
  for (const sym of symbols || []) {
    const entry = {
      name: sym.name,
      kind: sym.kind,
      line: (sym.range?.start?.line ?? sym.location?.range?.start?.line ?? 0) + 1,
      endLine: (sym.range?.end?.line ?? sym.location?.range?.end?.line ?? 0) + 1,
      parent,
    };
    out.push(entry);
    if (sym.children?.length) out.push(...flattenDocumentSymbols(sym.children, sym.name));
  }
  return out;
}

/** Build symbol breadcrumb chain for a given line */
export function symbolPathAtLine(symbols, line) {
  const flat = flattenDocumentSymbols(symbols);
  const containing = flat.filter((s) => s.line <= line && s.endLine >= line);
  containing.sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line) || a.line - b.line);
  const seen = new Set();
  const chain = [];
  for (const s of containing) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      chain.push({ name: s.name, line: s.line, kind: s.kind });
    }
  }
  return chain.slice(0, 5);
}

/** Scan content for TODO/FIXME-style comments → Monaco decorations */
export function computeTodoDecorations(content) {
  const lines = (content || '').split('\n');
  const decorations = [];
  const pattern = /\b(TODO|FIXME|HACK|NOTE|BUG)\b[:\s]*/gi;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(line)) !== null) {
      decorations.push({
        range: {
          startLineNumber: i + 1,
          startColumn: m.index + 1,
          endLineNumber: i + 1,
          endColumn: m.index + m[0].length + 1,
        },
        options: {
          inlineClassName: 't5-todo-editor-highlight',
          overviewRuler: { color: '#cca700', position: 4 },
          minimap: { color: '#cca700', position: 1 },
        },
      });
    }
  }
  return decorations;
}

/**
 * Initialize LSP bridge — subscribe to IPC, attach Monaco reference.
 * Returns cleanup function.
 */
export function initLspBridge(monaco, { onMarkers } = {}) {
  _cleanupFns.forEach((fn) => fn());
  _cleanupFns = [];
  if (monaco) _monacoRef = monaco;
  if (onMarkers) _markersCallback = onMarkers;

  const api = typeof window !== 'undefined' ? window.electronAPI : null;
  if (api?.onLspMessage) {
    const unsub = api.onLspMessage(handleLspMessage);
    if (typeof unsub === 'function') _cleanupFns.push(unsub);
  }

  return () => {
    _cleanupFns.forEach((fn) => fn());
    _cleanupFns = [];
    _monacoRef = null;
    _markersCallback = null;
  };
}

export default {
  pathToUri,
  uriToPath,
  initLspBridge,
  handleLspDiagnostics,
  setLspMarkersCallback,
  requestCompletion,
  requestHover,
  requestDefinition,
  requestDocumentSymbols,
  notifyDidOpen,
  notifyDidChange,
  notifyDidClose,
  flattenDocumentSymbols,
  symbolPathAtLine,
  computeTodoDecorations,
};
