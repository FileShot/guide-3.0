/**
 * DiffViewer — Side-by-side diff viewer using Monaco's DiffEditor.
 * Opened via store.openDiff(original, modified, title).
 */
import { useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import useAppStore from '../stores/appStore';
import { X, Columns, Rows } from 'lucide-react';

export default function DiffViewer() {
  const diffState = useAppStore(s => s.diffState);
  const closeDiff = useAppStore(s => s.closeDiff);
  const [inline, setInline] = useState(false);

  if (!diffState) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-[35px] flex items-center justify-between px-3 border-b border-vsc-panel-border/50 no-select flex-shrink-0 bg-vsc-tab-border">
        <div className="flex items-center gap-2 text-vsc-sm text-vsc-text">
          <span className="text-vsc-accent font-medium">Diff</span>
          <span className="text-vsc-text-dim truncate max-w-[200px]">{diffState.title || 'Untitled'}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={`p-1 rounded hover:bg-vsc-list-hover ${inline ? 'text-vsc-accent' : 'text-vsc-text-dim'}`}
            title={inline ? 'Side by side' : 'Inline diff'}
            onClick={() => setInline(!inline)}
          >
            {inline ? <Columns size={14} /> : <Rows size={14} />}
          </button>
          <button
            className="p-1 hover:bg-vsc-list-hover rounded text-vsc-text-dim hover:text-vsc-text"
            title="Close diff"
            onClick={closeDiff}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Diff Editor */}
      <div className="flex-1 min-h-0">
        <DiffEditor
          original={diffState.original || ''}
          modified={diffState.modified || ''}
          theme="vs-dark"
          options={{
            readOnly: true,
            renderSideBySide: !inline,
            fontSize: 14,
            fontFamily: 'Consolas, "Courier New", monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderOverviewRuler: false,
            automaticLayout: true,
            padding: { top: 8 },
          }}
          loading={
            <div className="flex items-center justify-center h-full text-vsc-text-dim">
              Loading diff...
            </div>
          }
        />
      </div>
    </div>
  );
}
