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
import { Copy, Check, Download, ChevronDown, ChevronRight, FileCode, Loader } from 'lucide-react';
import useAppStore from '../../stores/appStore';

const COLLAPSE_THRESHOLD = 15;

const FileContentBlock = React.memo(function FileContentBlock({ filePath, language, fileName, content, complete }) {
  const [copied, setCopied] = useState(false);
  const scrollContainerRef = useRef(null);
  const contentRef = useRef(null);

  // R37-Step8: Read/write expanded state from the store so it survives unmount/remount.
  const expanded = useAppStore(state => state.fileBlockExpandedStates[filePath] || false);
  const setFileBlockExpanded = useAppStore(state => state.setFileBlockExpanded);

  const lineCount = useMemo(() => {
    if (!content) return 0;
    return content.split('\n').length;
  }, [content]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  const handleDownload = useCallback(() => {
    const name = fileName || filePath || 'file.txt';
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.split('/').pop().split('\\').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [content, fileName, filePath]);

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
  const isCollapsible = lineCount > COLLAPSE_THRESHOLD;
  const isCollapsed = !expanded && isCollapsible;

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
    <div className="code-block-container group relative my-2 rounded-md overflow-hidden border border-vsc-panel-border/40">
      {/* Header */}
      <div className="code-block-header flex items-center justify-between px-3 py-1 bg-vsc-sidebar/80 border-b border-vsc-panel-border/30">
        <div className="flex items-center gap-1.5">
          <FileCode size={12} className="text-vsc-accent" />
          <span className="text-[11px] text-vsc-text font-medium">{displayName}</span>
          {language && <span className="text-[10px] text-vsc-text-dim uppercase">{language}</span>}
          {lineCount > 0 && <span className="text-[10px] text-vsc-text-dim">({lineCount} lines)</span>}
          {!complete && <Loader size={10} className="animate-spin text-vsc-accent ml-1" />}
        </div>
        <div className="flex items-center gap-0.5">
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

      {/* Content */}
      <div className="relative">
        <div ref={scrollContainerRef} style={contentStyle}>
          <pre className="!m-0 !rounded-none !border-0 p-3 text-vsc-sm leading-relaxed bg-vsc-bg" style={preStyle}>
            <code ref={contentRef}>{content}</code>
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
    </div>
  );
});

export default FileContentBlock;
