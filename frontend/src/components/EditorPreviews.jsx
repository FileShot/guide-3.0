/**
 * EditorPreviews — Rich preview components for various file types.
 * HTML (live iframe), Markdown, JSON (collapsible tree), CSV/TSV (sortable table),
 * SVG (zoomable), Image, Binary.
 */
import { useState, useRef, useMemo } from 'react';
import { Play, Code2, ExternalLink, RefreshCw, Eye } from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────

function getFileName(filePath) {
  return filePath?.split(/[\\/]/).pop() || '';
}

function getFileDir(filePath) {
  return filePath?.replace(/\\/g, '/').replace(/\/[^/]*$/, '') || '';
}

const PREVIEW_EXTENSIONS = new Set([
  'html', 'htm', 'md', 'markdown', 'json', 'csv', 'tsv',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
]);

export function isPreviewable(filePath) {
  if (!filePath) return false;
  const ext = filePath.split('.').pop()?.toLowerCase();
  return PREVIEW_EXTENSIONS.has(ext);
}

export function getPreviewType(filePath) {
  if (!filePath) return null;
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'json') return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'svg') return 'svg';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'].includes(ext)) return 'image';
  return null;
}

// ─── Preview Toolbar (shared) ────────────────────────────

function PreviewToolbar({ icon: Icon, iconColor, label, fileName, onToggleCode, children }) {
  return (
    <div className="h-8 bg-vsc-tab-active border-b border-vsc-panel-border flex items-center px-3 gap-2 flex-shrink-0">
      <Icon size={12} className={iconColor} />
      <span className={`text-[11px] font-medium ${iconColor}`}>{label}</span>
      <span className="text-[11px] text-vsc-text-dim truncate">{fileName}</span>
      <div className="flex-1" />
      {children}
      <button
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-vsc-text-dim hover:text-vsc-text rounded hover:bg-vsc-list-hover transition-colors"
        onClick={onToggleCode}
        title="Back to code"
      >
        <Code2 size={12} />
        <span>Code</span>
      </button>
    </div>
  );
}

// ─── HTML Preview ────────────────────────────────────────

export function HtmlPreview({ content, filePath, onToggleCode }) {
  const [manualKey, setManualKey] = useState(0);
  const contentHash = useMemo(() => {
    let h = 0;
    for (let i = 0; i < content.length; i++) h = ((h << 5) - h + content.charCodeAt(i)) | 0;
    return h;
  }, [content]);

  const resolvedContent = useMemo(() => {
    const dir = getFileDir(filePath);
    const cssReset = '<style>*{box-sizing:border-box}body{margin:0;padding:0}</style>';
    const baseTag = `<base href="file:///${dir}/">`;
    const inject = baseTag + cssReset;
    if (content.includes('<head>')) {
      return content.replace('<head>', `<head>${inject}`);
    } else if (content.includes('<html')) {
      return content.replace(/(<html[^>]*>)/, `$1<head>${inject}</head>`);
    }
    return `<head>${inject}</head>${content}`;
  }, [content, filePath]);

  return (
    <div className="h-full flex flex-col">
      <PreviewToolbar icon={Play} iconColor="text-green-400" label="HTML Preview" fileName={getFileName(filePath)} onToggleCode={onToggleCode}>
        <button
          className="p-1 text-vsc-text-dim hover:text-vsc-text rounded hover:bg-vsc-list-hover transition-colors"
          onClick={() => setManualKey(k => k + 1)}
          title="Refresh preview"
        >
          <RefreshCw size={12} />
        </button>
        <button
          className="p-1 text-vsc-text-dim hover:text-vsc-text rounded hover:bg-vsc-list-hover transition-colors"
          onClick={() => {
            const blob = new Blob([content], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
          }}
          title="Open in external browser"
        >
          <ExternalLink size={12} />
        </button>
      </PreviewToolbar>
      <div className="flex-1 min-h-0 bg-white">
        <iframe
          key={`${manualKey}-${contentHash}`}
          srcDoc={resolvedContent}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title="HTML Preview"
        />
      </div>
    </div>
  );
}

// ─── Markdown Preview ────────────────────────────────────

export function MarkdownPreview({ content, filePath, onToggleCode }) {
  const mdToHtml = useMemo(() => {
    let html = content
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
        `<pre class="code-block"><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`)
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      // Headings
      .replace(/^######\s+(.*)$/gm, '<h6>$1</h6>')
      .replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>')
      .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
      .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
      .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
      // Formatting
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      // Blockquotes, HR, lists, links, images
      .replace(/^>\s+(.*)$/gm, '<blockquote>$1</blockquote>')
      .replace(/^---$/gm, '<hr/>')
      .replace(/^\*\*\*$/gm, '<hr/>')
      .replace(/^[\*\-]\s+(.*)$/gm, '<li>$1</li>')
      .replace(/^\d+\.\s+(.*)$/gm, '<li>$1</li>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%"/>')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/\n/g, '<br/>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, '<ul>$1</ul>');

    const css = `
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #cccccc; background: #1e1e1e; padding: 24px 32px; line-height: 1.6; max-width: 900px; margin: 0 auto; }
      h1, h2, h3, h4, h5, h6 { color: #e0e0e0; margin: 1.2em 0 0.6em; border-bottom: 1px solid #333; padding-bottom: 0.3em; }
      h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
      h4, h5, h6 { border-bottom: none; }
      a { color: #4fc1ff; text-decoration: none; } a:hover { text-decoration: underline; }
      code.inline-code { background: #2d2d2d; color: #d7ba7d; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
      pre.code-block { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 16px; overflow-x: auto; margin: 1em 0; }
      pre.code-block code { color: #d4d4d4; font-family: 'Consolas', 'Fira Code', monospace; font-size: 13px; }
      blockquote { border-left: 4px solid #007acc; margin: 1em 0; padding: 8px 16px; color: #999; background: #252526; border-radius: 0 4px 4px 0; }
      ul, ol { padding-left: 24px; } li { margin: 4px 0; }
      hr { border: none; border-top: 1px solid #333; margin: 2em 0; }
      img { border-radius: 4px; margin: 1em 0; max-width: 100%; }
      del { color: #858585; }
      strong { color: #e0e0e0; }
      table { border-collapse: collapse; width: 100%; margin: 1em 0; }
      th, td { border: 1px solid #333; padding: 8px 12px; text-align: left; }
      th { background: #252526; }
    `;
    return `<!DOCTYPE html><html><head><style>${css}</style></head><body>${html}</body></html>`;
  }, [content]);

  return (
    <div className="h-full flex flex-col">
      <PreviewToolbar icon={Eye} iconColor="text-blue-400" label="Markdown Preview" fileName={getFileName(filePath)} onToggleCode={onToggleCode} />
      <div className="flex-1 min-h-0">
        <iframe
          srcDoc={mdToHtml}
          className="w-full h-full border-0"
          sandbox="allow-same-origin"
          title="Markdown Preview"
        />
      </div>
    </div>
  );
}

// ─── JSON Preview ────────────────────────────────────────

export function JsonPreview({ content, filePath, onToggleCode }) {
  const [collapsed, setCollapsed] = useState(new Set());

  const parsed = useMemo(() => {
    try {
      return { data: JSON.parse(content), error: null };
    } catch (e) {
      return { data: null, error: e.message };
    }
  }, [content]);

  const togglePath = (path) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const renderValue = (val, path, depth) => {
    if (val === null) return <span className="text-blue-400">null</span>;
    if (typeof val === 'boolean') return <span className="text-blue-400">{String(val)}</span>;
    if (typeof val === 'number') return <span className="text-green-300">{val}</span>;
    if (typeof val === 'string') return <span className="text-orange-300">"{val.length > 500 ? val.slice(0, 500) + '...' : val}"</span>;
    if (Array.isArray(val)) {
      const isCol = collapsed.has(path);
      if (val.length === 0) return <span className="text-vsc-text">[]</span>;
      return (
        <span>
          <span className="cursor-pointer text-vsc-text-dim hover:text-vsc-text select-none" onClick={() => togglePath(path)}>
            {isCol ? '\u25B6' : '\u25BC'}
          </span>
          {isCol ? (
            <span className="text-vsc-text-dim"> [{val.length} items]</span>
          ) : (
            <span>
              {'[\n'}
              {val.map((item, i) => (
                <span key={i}>
                  {'  '.repeat(depth + 1)}
                  {renderValue(item, `${path}[${i}]`, depth + 1)}
                  {i < val.length - 1 ? ',' : ''}
                  {'\n'}
                </span>
              ))}
              {'  '.repeat(depth)}{']'}
            </span>
          )}
        </span>
      );
    }
    if (typeof val === 'object') {
      const entries = Object.entries(val);
      const isCol = collapsed.has(path);
      if (entries.length === 0) return <span className="text-vsc-text">{'{}'}</span>;
      return (
        <span>
          <span className="cursor-pointer text-vsc-text-dim hover:text-vsc-text select-none" onClick={() => togglePath(path)}>
            {isCol ? '\u25B6' : '\u25BC'}
          </span>
          {isCol ? (
            <span className="text-vsc-text-dim"> {'{'}&hellip;{entries.length} keys{'}'}</span>
          ) : (
            <span>
              {'{\n'}
              {entries.map(([k, v], i) => (
                <span key={k}>
                  {'  '.repeat(depth + 1)}
                  <span className="text-sky-300">"{k}"</span>: {renderValue(v, `${path}.${k}`, depth + 1)}
                  {i < entries.length - 1 ? ',' : ''}
                  {'\n'}
                </span>
              ))}
              {'  '.repeat(depth)}{'}'}
            </span>
          )}
        </span>
      );
    }
    return <span className="text-vsc-text">{String(val)}</span>;
  };

  return (
    <div className="h-full flex flex-col">
      <PreviewToolbar icon={Eye} iconColor="text-yellow-300" label="JSON Preview" fileName={getFileName(filePath)} onToggleCode={onToggleCode}>
        <button className="px-2 py-0.5 text-[10px] text-vsc-text-dim hover:text-vsc-text rounded hover:bg-vsc-list-hover"
          onClick={() => setCollapsed(new Set())} title="Expand all">Expand All</button>
      </PreviewToolbar>
      <div className="flex-1 min-h-0 overflow-auto p-4 font-mono text-[13px] leading-[1.5]">
        {parsed.error ? (
          <div className="text-red-400">
            <p className="font-bold mb-2">Invalid JSON</p>
            <p>{parsed.error}</p>
            <pre className="mt-4 text-vsc-text text-[12px] whitespace-pre-wrap">{content.slice(0, 2000)}</pre>
          </div>
        ) : (
          <pre className="whitespace-pre text-vsc-text">{renderValue(parsed.data, '$', 0)}</pre>
        )}
      </div>
    </div>
  );
}

// ─── CSV/TSV Preview ─────────────────────────────────────

export function CsvPreview({ content, filePath, onToggleCode }) {
  const isTsv = filePath?.toLowerCase().endsWith('.tsv');
  const delimiter = isTsv ? '\t' : ',';

  const { headers, rows } = useMemo(() => {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return { headers: [], rows: [] };

    const parseLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && !inQuotes) { inQuotes = true; continue; }
        if (ch === '"' && inQuotes) {
          if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; continue; }
          inQuotes = false; continue;
        }
        if (ch === delimiter && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += ch;
      }
      result.push(current.trim());
      return result;
    };

    const parsed = lines.map(parseLine);
    return { headers: parsed[0] || [], rows: parsed.slice(1) };
  }, [content, delimiter]);

  const [sortCol, setSortCol] = useState(null);
  const [sortAsc, setSortAsc] = useState(true);

  const sortedRows = useMemo(() => {
    if (sortCol === null) return rows;
    return [...rows].sort((a, b) => {
      const va = a[sortCol] || '';
      const vb = b[sortCol] || '';
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return sortAsc ? na - nb : nb - na;
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }, [rows, sortCol, sortAsc]);

  return (
    <div className="h-full flex flex-col">
      <PreviewToolbar icon={Eye} iconColor="text-teal-400" label={`${isTsv ? 'TSV' : 'CSV'} Table`} fileName={getFileName(filePath)} onToggleCode={onToggleCode}>
        <span className="text-[10px] text-vsc-text-dim">({rows.length} rows &times; {headers.length} cols)</span>
      </PreviewToolbar>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-vsc-sidebar z-10">
            <tr>
              <th className="border border-vsc-panel-border px-2 py-1 text-vsc-text-dim text-[10px] font-normal w-10">#</th>
              {headers.map((h, i) => (
                <th key={i}
                  className="border border-vsc-panel-border px-3 py-1.5 text-left text-vsc-text font-medium cursor-pointer hover:bg-vsc-list-hover select-none whitespace-nowrap"
                  onClick={() => { if (sortCol === i) setSortAsc(!sortAsc); else { setSortCol(i); setSortAsc(true); } }}
                >
                  {h} {sortCol === i ? (sortAsc ? '\u25B2' : '\u25BC') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, ri) => (
              <tr key={ri} className="hover:bg-vsc-list-hover">
                <td className="border border-vsc-panel-border px-2 py-0.5 text-vsc-text-dim text-center text-[10px]">{ri + 1}</td>
                {headers.map((_, ci) => (
                  <td key={ci} className="border border-vsc-panel-border px-3 py-0.5 text-vsc-text whitespace-nowrap max-w-[300px] truncate">
                    {row[ci] || ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="text-center text-vsc-text-dim py-8 text-[13px]">No data rows found</div>
        )}
      </div>
    </div>
  );
}

// ─── SVG Preview ─────────────────────────────────────────

export function SvgPreview({ content, filePath, onToggleCode }) {
  const [zoom, setZoom] = useState(1);
  const [bgColor, setBgColor] = useState('#1e1e1e');

  // Basic SVG sanitization — strip script tags and event handlers
  const safeSvg = useMemo(() => {
    return content
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '');
  }, [content]);

  return (
    <div className="h-full flex flex-col">
      <PreviewToolbar icon={Eye} iconColor="text-purple-400" label="SVG Preview" fileName={getFileName(filePath)} onToggleCode={onToggleCode}>
        <button className="px-1 text-[11px] text-vsc-text-dim hover:text-vsc-text" onClick={() => setZoom(z => Math.max(0.25, z - 0.25))} title="Zoom out">&minus;</button>
        <span className="text-[10px] text-vsc-text-dim min-w-[30px] text-center">{Math.round(zoom * 100)}%</span>
        <button className="px-1 text-[11px] text-vsc-text-dim hover:text-vsc-text" onClick={() => setZoom(z => Math.min(4, z + 0.25))} title="Zoom in">+</button>
        <button className="px-1 text-[10px] text-vsc-text-dim hover:text-vsc-text" onClick={() => setZoom(1)} title="Reset zoom">1:1</button>
        <select
          className="bg-vsc-input text-[10px] text-vsc-text rounded px-1 py-0.5 outline-none border border-vsc-input-border"
          value={bgColor}
          onChange={e => setBgColor(e.target.value)}
          title="Background color"
        >
          <option value="#1e1e1e">Dark</option>
          <option value="#ffffff">White</option>
          <option value="#808080">Gray</option>
          <option value="transparent">Checkerboard</option>
        </select>
      </PreviewToolbar>
      <div
        className="flex-1 min-h-0 overflow-auto flex items-center justify-center"
        style={{
          backgroundColor: bgColor === 'transparent' ? undefined : bgColor,
          backgroundImage: bgColor === 'transparent' ? 'repeating-conic-gradient(#333 0% 25%, #2a2a2a 0% 50%)' : undefined,
          backgroundSize: bgColor === 'transparent' ? '16px 16px' : undefined,
        }}
      >
        <div
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
          dangerouslySetInnerHTML={{ __html: safeSvg }}
        />
      </div>
    </div>
  );
}

// ─── Image Preview ───────────────────────────────────────

export function ImagePreview({ filePath, onToggleCode }) {
  const [error, setError] = useState(false);
  const src = filePath?.replace(/\\/g, '/');

  if (error) {
    return (
      <div className="h-full flex flex-col">
        <PreviewToolbar icon={Eye} iconColor="text-vsc-text-dim" label="Image" fileName={getFileName(filePath)} onToggleCode={onToggleCode} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-vsc-text-dim">
            <p className="text-sm mb-2">Unable to preview this image</p>
            <p className="text-vsc-xs">{getFileName(filePath)}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <PreviewToolbar icon={Eye} iconColor="text-vsc-text-dim" label="Image Preview" fileName={getFileName(filePath)} onToggleCode={onToggleCode} />
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto p-4">
        <div className="text-center">
          <img
            src={`file:///${src}`}
            alt={getFileName(filePath)}
            className="max-w-full max-h-[calc(100vh-200px)] object-contain rounded shadow-lg"
            onError={() => setError(true)}
          />
          <p className="text-[11px] text-vsc-text-dim mt-3">{getFileName(filePath)}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Binary Preview ──────────────────────────────────────

export function BinaryPreview({ filePath, onToggleCode }) {
  const name = getFileName(filePath);
  const ext = name.includes('.') ? name.split('.').pop()?.toUpperCase() : 'BIN';
  return (
    <div className="h-full flex flex-col">
      <PreviewToolbar icon={Eye} iconColor="text-vsc-text-dim" label="Binary File" fileName={name} onToggleCode={onToggleCode} />
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4 opacity-20">[ ]</div>
          <p className="text-sm text-vsc-text/50 mb-2">Binary File ({ext})</p>
          <p className="text-vsc-xs text-vsc-text-dim mb-4">{name}</p>
          <p className="text-[11px] text-vsc-text-dim/60">This file is not displayed in the editor because it is either binary or uses an unsupported encoding.</p>
        </div>
      </div>
    </div>
  );
}
