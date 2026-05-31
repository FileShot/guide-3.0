/**
 * ComposerPanel — Multi-file edit session UI with checklist, diff preview, apply/reject all.
 */
import { useState, useEffect } from 'react';
import useAppStore from '../stores/appStore';
import { DiffEditor } from '@monaco-editor/react';
import { X, Check, Undo2, FileCode, ChevronDown, ChevronRight } from 'lucide-react';

export default function ComposerPanel() {
  const composerOpen = useAppStore((s) => s.composerOpen);
  const composerFiles = useAppStore((s) => s.composerFiles);
  const chatFilesChanged = useAppStore((s) => s.chatFilesChanged);
  const toggleComposer = useAppStore((s) => s.toggleComposer);
  const syncComposerFiles = useAppStore((s) => s.syncComposerFiles);
  const toggleComposerFileSelected = useAppStore((s) => s.toggleComposerFileSelected);
  const applyComposerFiles = useAppStore((s) => s.applyComposerFiles);
  const rejectComposerFiles = useAppStore((s) => s.rejectComposerFiles);
  const startComposerAgent = useAppStore((s) => s.startComposerAgent);
  const [previewPath, setPreviewPath] = useState(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    syncComposerFiles();
  }, [chatFilesChanged, syncComposerFiles]);

  useEffect(() => {
    if (composerOpen) syncComposerFiles();
  }, [composerOpen, syncComposerFiles]);

  useEffect(() => {
    if (!previewPath && composerFiles.length > 0) {
      setPreviewPath(composerFiles[0].path);
    }
    if (previewPath && !composerFiles.find((f) => f.path === previewPath)) {
      setPreviewPath(composerFiles[0]?.path || null);
    }
  }, [composerFiles, previewPath]);

  if (!composerOpen) return null;

  const previewFile = composerFiles.find((f) => f.path === previewPath);
  const selectedCount = composerFiles.filter((f) => f.selected).length;

  return (
    <div className="absolute inset-y-0 right-0 w-[420px] max-w-[45vw] z-40 flex flex-col bg-vsc-sidebar border-l border-vsc-panel-border shadow-2xl">
      <div className="h-[35px] flex items-center px-3 border-b border-vsc-panel-border/25 flex-shrink-0 gap-2">
        <FileCode size={14} className="text-vsc-accent flex-shrink-0" />
        <span className="text-vsc-sm font-medium text-vsc-text flex-1 truncate">Composer</span>
        <span className="text-[10px] text-vsc-text-dim">{composerFiles.length} file{composerFiles.length !== 1 ? 's' : ''}</span>
        <button className="p-1 hover:bg-vsc-list-hover rounded" title="Close" onClick={toggleComposer}>
          <X size={14} className="text-vsc-text-dim" />
        </button>
      </div>

      {composerFiles.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-vsc-text-dim text-vsc-xs p-4 text-center">
          No pending file edits. AI changes will appear here.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-vsc-panel-border/15 flex-shrink-0">
            <button
              className="flex items-center gap-1 text-[11px] text-vsc-text-dim hover:text-vsc-text"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Files ({selectedCount} selected)
            </button>
            <div className="flex-1" />
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-accent hover:bg-vsc-accent/10"
              onClick={() => startComposerAgent()}
              disabled={composerFiles.length === 0}
            >
              Run agent
            </button>
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-success hover:bg-vsc-success/10"
              onClick={() => applyComposerFiles()}
              disabled={selectedCount === 0}
            >
              <Check size={11} />
              Apply all
            </button>
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-text-dim hover:text-vsc-error hover:bg-vsc-error/10"
              onClick={() => rejectComposerFiles()}
              disabled={selectedCount === 0}
            >
              <Undo2 size={11} />
              Reject all
            </button>
          </div>

          {expanded && (
            <div className="max-h-[140px] overflow-y-auto scrollbar-thin border-b border-vsc-panel-border/15 flex-shrink-0">
              {composerFiles.map((file) => (
                <div
                  key={file.path}
                  className={`flex items-center gap-2 px-3 py-1 text-[11px] cursor-pointer hover:bg-vsc-list-hover/50 ${
                    previewPath === file.path ? 'bg-vsc-list-active/40' : ''
                  }`}
                  onClick={() => setPreviewPath(file.path)}
                >
                  <input
                    type="checkbox"
                    checked={!!file.selected}
                    onChange={(e) => { e.stopPropagation(); toggleComposerFileSelected(file.path); }}
                    className="accent-vsc-accent"
                  />
                  <span className="truncate flex-1 text-vsc-text">{file.name}</span>
                  <button
                    className="text-vsc-success hover:underline flex-shrink-0"
                    onClick={(e) => { e.stopPropagation(); applyComposerFiles([file.path]); }}
                  >
                    Apply
                  </button>
                  <button
                    className="text-vsc-text-dim hover:text-vsc-error flex-shrink-0"
                    onClick={(e) => { e.stopPropagation(); rejectComposerFiles([file.path]); }}
                  >
                    Reject
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col">
            {previewFile ? (
              <>
                <div className="px-3 py-1 text-[10px] text-vsc-text-dim border-b border-vsc-panel-border/10 truncate flex-shrink-0">
                  {previewFile.path}
                </div>
                <div className="flex-1 min-h-0">
                  <DiffEditor
                    key={previewFile.path}
                    original={previewFile.original || ''}
                    modified={previewFile.modified || ''}
                    theme="vs-dark"
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      fontSize: 12,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                    }}
                    loading={
                      <div className="flex items-center justify-center h-full text-vsc-text-dim text-vsc-xs">
                        Loading diff...
                      </div>
                    }
                  />
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-vsc-text-dim text-vsc-xs">
                Select a file to preview diff
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
