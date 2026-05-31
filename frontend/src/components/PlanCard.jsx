import { useEffect, useCallback } from 'react';
import { Hammer, FileText, CheckCircle2, Circle } from 'lucide-react';
import useAppStore from '../stores/appStore';

export default function PlanCard({ onBuild, chatStreaming }) {
  const planSession = useAppStore((s) => s.planSession);
  const openFile = useAppStore((s) => s.openFile);

  const handleBuild = useCallback(() => {
    if (chatStreaming || !planSession || planSession.status !== 'ready') return;
    onBuild?.(planSession);
  }, [chatStreaming, onBuild, planSession]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (planSession?.status === 'ready' && !chatStreaming) {
          e.preventDefault();
          handleBuild();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [planSession, chatStreaming, handleBuild]);

  if (!planSession || planSession.status === 'building' || planSession.status === 'done') {
    return null;
  }

  const todos = planSession.todos || [];
  const isReady = planSession.status === 'ready';

  return (
    <div className="mx-2 mb-2 rounded-xl border border-vsc-accent/30 bg-vsc-sidebar/90 shadow-[0_8px_24px_rgba(0,0,0,0.25)] overflow-hidden">
      <div className="px-4 py-3 border-b border-vsc-panel-border/20">
        <div className="text-[13px] font-semibold text-vsc-text">{planSession.title || 'Implementation Plan'}</div>
        {planSession.overview && (
          <p className="mt-1 text-[11px] text-vsc-text-dim leading-snug line-clamp-2">{planSession.overview}</p>
        )}
      </div>

      {todos.length > 0 && (
        <div className="px-4 py-2 space-y-1.5 max-h-[160px] overflow-y-auto scrollbar-thin">
          {todos.map((todo) => (
            <div key={todo.id} className="flex items-start gap-2 text-[11px] text-vsc-text-dim">
              {todo.status === 'completed' ? (
                <CheckCircle2 size={13} className="mt-0.5 text-vsc-success flex-shrink-0" />
              ) : (
                <Circle size={13} className="mt-0.5 text-vsc-text-dim/50 flex-shrink-0" />
              )}
              <span>{todo.content}</span>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 py-2.5 flex items-center justify-between gap-2 border-t border-vsc-panel-border/15 bg-vsc-bg/40">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-[11px] text-vsc-accent hover:text-vsc-accent-hover transition-colors"
          onClick={() => {
            if (planSession.path) {
              openFile({ path: planSession.path, name: planSession.path.split(/[/\\]/).pop(), content: planSession.content || '', modified: false });
            }
          }}
        >
          <FileText size={13} />
          View plan
        </button>

        {isReady ? (
          <button
            type="button"
            disabled={chatStreaming}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-vsc-accent text-vsc-bg text-[11px] font-semibold hover:bg-vsc-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            onClick={handleBuild}
            title="Build plan (Ctrl+Enter)"
          >
            <Hammer size={13} />
            Build
            <span className="text-[10px] opacity-75 font-normal">Ctrl+Enter</span>
          </button>
        ) : (
          <span className="text-[10px] text-vsc-text-dim">Planning…</span>
        )}
      </div>
    </div>
  );
}
