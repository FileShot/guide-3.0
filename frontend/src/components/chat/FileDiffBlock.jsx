/**
 * FileDiffBlock — streaming file write/edit with green (add) / red (del) line highlights.
 */
import React, { useMemo, useCallback, useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, FileCode, Loader } from 'lucide-react';
import { computeLineDiffDisplay } from '../../utils/lineDiff';

const FileDiffBlock = React.memo(function FileDiffBlock({
  filePath,
  language,
  fileName,
  content,
  complete,
  op = 'write',
  oldText = '',
  newText = '',
}) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const isEdit = op === 'edit';
  const displayNew = newText || content || '';

  const lines = useMemo(() => {
    if (!isEdit || !oldText) {
      return String(displayNew).split('\n').map((text) => ({ type: 'add', text }));
    }
    return computeLineDiffDisplay(oldText, displayNew);
  }, [isEdit, oldText, displayNew]);

  const handleCopy = useCallback(async () => {
    const text = isEdit ? displayNew : String(content || '');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
  }, [isEdit, displayNew, content]);

  const label = fileName || filePath?.split(/[\\/]/).pop() || 'file';
  const title = isEdit ? `Editing ${label}` : `Writing ${label}`;

  return (
    <div className="my-2 rounded-lg border border-vsc-panel-border bg-vsc-editor overflow-hidden text-[12px]">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-vsc-panel border-b border-vsc-panel-border">
        <FileCode size={12} className="text-vsc-accent shrink-0" />
        <span className="font-medium text-vsc-text truncate flex-1">{title}</span>
        {!complete && <Loader size={12} className="animate-spin text-vsc-accent shrink-0" />}
        <button type="button" className="p-1 text-vsc-text-dim hover:text-vsc-text" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <button type="button" className="p-1 text-vsc-text-dim hover:text-vsc-text" onClick={handleCopy} title="Copy">
          {copied ? <Check size={12} className="text-vsc-success" /> : <Copy size={12} />}
        </button>
      </div>
      {!collapsed && (
        <pre className="p-2 m-0 overflow-auto max-h-[min(420px,50vh)] font-mono text-[11px] leading-relaxed">
          <code>
            {lines.map((line, idx) => {
              const cls = line.type === 'add'
                ? 'dirty-diff-added-line block'
                : line.type === 'del'
                  ? 'dirty-diff-deleted-line block opacity-80'
                  : 'block text-vsc-text';
              return (
                <span key={idx} className={cls}>
                  {line.text}
                  {idx < lines.length - 1 ? '\n' : ''}
                </span>
              );
            })}
          </code>
        </pre>
      )}
    </div>
  );
});

export default FileDiffBlock;
