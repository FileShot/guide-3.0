/**
 * FileContentBlock — Renders a single file being generated via file-content events.
 * Shows filename, growing line count, raw content, collapse/expand, copy, download.
 * R34: Inline styles for height (bypass Tailwind JIT). React.memo to prevent unnecessary re-renders.
 * R36-Phase1: Auto-scroll collapsed view to show trailing content during streaming.
 * R37-Step8: Expanded state lifted to Zustand store — survives component unmount/remount
 *            across continuation iterations. Key = filePath.
 * R37-Step9: Bottom padding on pre when streaming+collapsed so newest lines are visible
 *            above the gradient overlay instead of being hidden under it.
 */
import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Copy, Check, Download, ChevronDown, ChevronRight, FileCode, Loader, Play, Code, Wrench, AlertTriangle } from 'lucide-react';
import useAppStore from '../../stores/appStore';
import { computeLineDiffDisplay } from '../../utils/lineDiff';

const COLLAPSE_THRESHOLD = 15;

const RENDERABLE_EXTENSIONS = new Set(['html', 'htm', 'svg', 'css', 'js', 'jsx']);

const FileContentBlock = React.memo(function FileContentBlock({
  filePath, language, fileName, content, complete,
  op = 'write', oldText = '', newText = '', showLineDiff = true,
}) {
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(false);

  // Plan F: read lint errors emitted by backend after this file was written
  const lintErrors = useAppStore(s => s.fileLintErrors[filePath]);
  // Auto-fix toggle is the real global setting — toggling it here changes backend behaviour for ALL future file writes
  const autoFixEnabled = useAppStore(s => s.settings.autoLintFix !== false);
  const updateSetting = useAppStore(s => s.updateSetting);
  const scrollContainerRef = useRef(null);
  const contentRef = useRef(null);

  // R37-Step8: Read/write expanded state from the store so it survives unmount/remount.
  const expanded = useAppStore(state => state.fileBlockExpandedStates[filePath] || false);
  const setFileBlockExpanded = useAppStore(state => state.setFileBlockExpanded);

  const displayNew = newText || content || '';
  const isEdit = op === 'edit';
  const useDiffLines = showLineDiff && !complete && !!displayNew;
  const diffLines = useMemo(() => {
    if (!useDiffLines) return null;
    if (!isEdit || !oldText) {
      return String(displayNew).split('\n').map((text) => ({ type: 'add', text }));
    }
    return computeLineDiffDisplay(oldText, displayNew);
  }, [useDiffLines, isEdit, oldText, displayNew]);

  const lineCount = useMemo(() => {
    const src = displayNew || content;
    if (!src) return 0;
    return src.split('\n').length;
  }, [content, displayNew]);

  const handleCopy = useCallback(async () => {
    const text = displayNew || content || '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content, displayNew]);

  const handleDownload = useCallback(() => {
    const name = fileName || filePath || 'file.txt';
    const blob = new Blob([displayNew || content || ''], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.split('/').pop().split('\\').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [content, displayNew, fileName, filePath]);

  const handleExpand = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();
    setFileBlockExpanded(filePath, true);
  }, [filePath, setFileBlockExpanded]);

  const handleCollapse = useCallback((e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    setFileBlockExpanded(filePath, false);
  }, [filePath, setFileBlockExpanded]);

  const displayName = fileName || (filePath ? filePath.split(/[/\\]/).pop() : 'file');
  const ext = (language || '').toLowerCase();
  const isRenderable = complete && RENDERABLE_EXTENSIONS.has(ext);
  const isCollapsible = lineCount > COLLAPSE_THRESHOLD;
  const isCollapsed = !expanded && isCollapsible;

  const buildSrcdoc = useCallback(() => {
    if (!content) return '';
    if (ext === 'html' || ext === 'htm' || ext === 'svg') return content;
    if (ext === 'css') return `<!DOCTYPE html><html><head><style>${content}</style></head><body><div class="preview">CSS Preview</div></body></html>`;
    if (ext === 'js' || ext === 'jsx') return `<!DOCTYPE html><html><head></head><body><script>${content}<\/script></body></html>`;
    return content;
  }, [content, ext]);

  // R36-Phase1: Auto-scroll collapsed view to show trailing content during streaming.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el && !complete && isCollapsed) {
      el.scrollTop = el.scrollHeight;
    }
  }, [content, complete, isCollapsed]);

  // Inline styles — bypass Tailwind JIT entirely
  // R44: Always allow scrolling — 'hidden' on complete blocks prevented Show More / scroll
  const contentStyle = isCollapsed
    ? { maxHeight: '240px', overflowY: 'auto', overflowX: 'auto' }
    : { maxHeight: '80vh', overflowY: 'auto', overflowX: 'auto' };

  // R37-Step9: When streaming+collapsed, pad bottom of content by overlay height (~80px)
  // so the newest streamed line appears above the gradient instead of under it.
  const preStyle = (isCollapsed && !complete) ? { paddingBottom: '80px' } : undefined;

  return (
    <div className="guide-code-block code-block-container group relative my-2 rounded-lg overflow-hidden flex flex-col">
      {/* Header */}
      <div className="code-block-header flex items-center justify-between px-3 py-1 bg-vsc-sidebar/80 border-b border-vsc-panel-border/15">
        <div className="flex items-center gap-1.5">
          <FileCode size={12} className="text-vsc-accent" />
          <span className="text-[11px] text-vsc-text font-medium">{displayName}</span>
          {language && <span className="text-[10px] text-vsc-text-dim">{language}</span>}
          {lineCount > 0 && <span className="text-[10px] text-vsc-text-dim">({lineCount} lines)</span>}
          {!complete && <Loader size={10} className="animate-spin text-vsc-accent ml-1" />}
        </div>
        <div className="flex items-center gap-0.5">
          {isRenderable && (
            <button
              className={`p-1 rounded-sm transition-colors ${
                rendering ? 'text-vsc-success bg-vsc-success/10' : 'text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover'
              }`}
              onClick={() => setRendering(!rendering)}
              title={rendering ? 'Show code' : 'Render preview'}
            >
              {rendering ? <Code size={13} /> : <Play size={13} />}
            </button>
          )}
          <button
            className="p-1 rounded-sm text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover transition-colors"
            onClick={handleDownload}
            title="Download file"
          >
            <Download size={13} />
          </button>
          <button
            className={`p-1 rounded-sm transition-colors ${
              copied ? 'text-vsc-success' : 'text-vsc-text-dim hover:text-vsc-text hover:bg-vsc-list-hover'
            }`}
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy code'}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      {/* Plan F: Lint auto-fix pill — shown when backend detected errors after writing this file */}
      {complete && lintErrors && lintErrors.errors > 0 && (
        <div className="flex items-center justify-between px-3 py-1 bg-yellow-500/10 border-t border-yellow-400/30">
          <div className="flex items-center gap-1.5 text-yellow-300/90 text-[10px]">
            <AlertTriangle size={10} className="flex-shrink-0" />
            <span>{lintErrors.errors} lint error{lintErrors.errors !== 1 ? 's' : ''} detected</span>
          </div>
          <button
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition-colors ${
              autoFixEnabled
                ? 'bg-green-500/20 border-green-400/50 text-green-300'
                : 'bg-vsc-panel-border/20 border-vsc-panel-border/20 text-vsc-text-dim'
            }`}
            onClick={() => updateSetting('autoLintFix', !autoFixEnabled)}
            title={autoFixEnabled ? 'Auto-fix is ON — model will fix errors automatically' : 'Auto-fix is OFF — errors will not be auto-fixed'}
          >
            <Wrench size={9} />
            Auto-fix {autoFixEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      )}

      {/* Content or preview */}
      {rendering ? (
        <div className="relative bg-white">
          <iframe
            srcDoc={buildSrcdoc()}
            className="w-full border-0"
            style={{ minHeight: '200px', maxHeight: '500px' }}
            sandbox="allow-scripts"
            title="File preview"
            onLoad={(e) => {
              try {
                const doc = e.target.contentDocument;
                if (doc?.body) {
                  const h = Math.min(Math.max(doc.body.scrollHeight + 20, 200), 500);
                  e.target.style.height = h + 'px';
                }
              } catch (_) {}
            }}
          />
        </div>
      ) : (
      <div className="relative">
        <div ref={scrollContainerRef} style={contentStyle}>
          <pre className="!m-0 !rounded-none !border-0 p-3 text-vsc-sm leading-snug bg-vsc-bg" style={preStyle}>
            <code ref={contentRef}>
              {diffLines ? diffLines.map((line, idx) => {
                const cls = line.type === 'add'
                  ? 'dirty-diff-added-line'
                  : line.type === 'del'
                    ? 'dirty-diff-deleted-line opacity-80'
                    : '';
                return (
                  <span key={idx} className={cls ? `${cls} block` : 'block'}>
                    {line.text}
                    {idx < diffLines.length - 1 ? '\n' : ''}
                  </span>
                );
              }) : content}
            </code>
          </pre>
        </div>
        {isCollapsed && (
          <div className="absolute bottom-0 left-0 right-0" style={{ zIndex: 2 }}>
            <div className="h-12 bg-gradient-to-t from-vsc-bg to-transparent pointer-events-none" />
            <button
              className="w-full py-1.5 bg-vsc-bg text-vsc-xs text-vsc-accent hover:text-vsc-accent-hover flex items-center justify-center gap-1 border-t border-vsc-panel-border/20"
              onClick={handleExpand}
            >
              <ChevronDown size={12} />
              Show more ({lineCount} lines)
            </button>
          </div>
        )}
        {!isCollapsed && isCollapsible && (
          <button
            className="w-full py-1 bg-vsc-sidebar/60 text-vsc-xs text-vsc-text-dim hover:text-vsc-text flex items-center justify-center gap-1 border-t border-vsc-panel-border/20"
            onClick={handleCollapse}
          >
            <ChevronRight size={12} className="rotate-[-90deg]" />
            Show less
          </button>
        )}
      </div>
      )}
    </div>
  );
});

export default FileContentBlock;
