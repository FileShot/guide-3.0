/**
 * InlineChat â€” Floating chat input at the editor cursor position.
 * Triggered by Ctrl+I. Sends selected code + prompt to AI,
 * then shows a diff preview with accept/reject buttons.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, X, Sparkles, Check, RotateCcw, Loader2 } from 'lucide-react';
import useAppStore from '../stores/appStore';

/**
 * Extract code blocks from model response text.
 * Returns the first code block found, or null.
 */
function extractCodeFromResponse(text) {
  // Match ```lang\n...``` blocks
  const match = text.match(/```(?:\w*)\n([\s\S]*?)```/);
  return match ? match[1] : null;
}

/**
 * Simple unified diff line renderer.
 * Returns JSX lines with color coding.
 */
function DiffLines({ original, modified }) {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  // Simple LCS-based diff: mark added/removed lines
  const lines = [];
  const maxLen = Math.max(origLines.length, modLines.length);

  // Find common prefix and suffix
  let prefixEnd = 0;
  while (prefixEnd < origLines.length && prefixEnd < modLines.length && origLines[prefixEnd] === modLines[prefixEnd]) {
    prefixEnd++;
  }
  let suffixStartOrig = origLines.length - 1;
  let suffixStartMod = modLines.length - 1;
  while (suffixStartOrig > prefixEnd && suffixStartMod > prefixEnd && origLines[suffixStartOrig] === modLines[suffixStartMod]) {
    suffixStartOrig--;
    suffixStartMod--;
  }

  // Context lines before change
  const contextBefore = Math.max(0, prefixEnd - 3);
  for (let i = contextBefore; i < prefixEnd; i++) {
    lines.push({ type: 'context', text: origLines[i], num: i + 1 });
  }

  // Removed lines
  for (let i = prefixEnd; i <= suffixStartOrig; i++) {
    lines.push({ type: 'removed', text: origLines[i], num: i + 1 });
  }
  // Added lines
  for (let i = prefixEnd; i <= suffixStartMod; i++) {
    lines.push({ type: 'added', text: modLines[i], num: i + 1 });
  }

  // Context lines after change
  const contextAfter = Math.min(origLines.length, suffixStartOrig + 4);
  for (let i = suffixStartOrig + 1; i < contextAfter; i++) {
    lines.push({ type: 'context', text: origLines[i], num: i + 1 });
  }

  return (
    <div className="font-mono text-[11px] leading-[14px] max-h-[200px] overflow-y-auto scrollbar-thin">
      {lines.map((line, idx) => (
        <div key={idx} className={`px-2 whitespace-pre ${
          line.type === 'removed' ? 'bg-red-500/15 text-red-300' :
          line.type === 'added' ? 'bg-green-500/15 text-green-300' :
          'text-vsc-text-dim'
        }`}>
          {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
          {line.text}
        </div>
      ))}
    </div>
  );
}

export default function InlineChat({ position, selectedText, onClose, onApplyEdit }) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [proposedEdit, setProposedEdit] = useState(null); // { original, modified }
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const addChatMessage = useAppStore(s => s.addChatMessage);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setLoading(true);
    setError(null);

    const prefix = selectedText
      ? `[Selected code]\n\`\`\`\n${selectedText}\n\`\`\`\n\n`
      : '';
    const userMessage = prefix + text;

    // Also add to chat history so the model has context
    addChatMessage({ role: 'user', content: userMessage });

    try {
      // Send to the chat API and stream the response
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage, stream: false }),
      });

      if (!res.ok) throw new Error(`API error: ${res.status}`);

      const data = await res.json();
      const responseText = data.response || data.message || '';

      // Try to extract a code block from the response
      const codeBlock = extractCodeFromResponse(responseText);

      if (codeBlock && selectedText) {
        // Show diff between selected code and proposed replacement
        setProposedEdit({ original: selectedText, modified: codeBlock });
      } else if (codeBlock) {
        // No selection â€” just show the proposed code for review
        setProposedEdit({ original: '', modified: codeBlock });
      } else {
        // No code block found â€” just show the text response
        addChatMessage({ role: 'assistant', content: responseText });
        onClose();
        return;
      }
    } catch (e) {
      setError(e.message || 'Failed to get response');
    } finally {
      setLoading(false);
    }
  }, [input, loading, selectedText, addChatMessage, onClose]);

  const handleAccept = useCallback(() => {
    if (proposedEdit && onApplyEdit) {
      onApplyEdit(proposedEdit.modified);
    }
    setProposedEdit(null);
    onClose();
  }, [proposedEdit, onApplyEdit, onClose]);

  const handleReject = useCallback(() => {
    setProposedEdit(null);
    onClose();
  }, [onClose]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className="absolute z-50 w-[420px] bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl glass-strong overflow-hidden"
      style={{
        top: position?.top ?? 100,
        left: position?.left ?? 100,
      }}
    >
      {/* Input bar */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-vsc-panel-border/15">
        <Sparkles size={12} className="text-vsc-accent flex-shrink-0" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent border-none outline-none text-vsc-sm text-vsc-text placeholder:text-vsc-text-dim"
          placeholder="Describe your edit..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="btn btn-primary p-1 disabled:opacity-30"
          onClick={handleSubmit}
          disabled={!input.trim() || loading}
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={12} strokeWidth={2.5} />}
        </button>
        <button
          className="p-1 hover:bg-vsc-list-hover rounded text-vsc-text-dim hover:text-vsc-text transition-colors"
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center gap-2 px-3 py-2 text-vsc-sm text-vsc-text-dim">
          <Loader2 size={12} className="animate-spin text-vsc-accent" />
          <span>Generating edit...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="px-3 py-2 text-vsc-sm text-red-400">{error}</div>
      )}

      {/* Diff preview */}
      {proposedEdit && (
        <div className="border-t border-vsc-panel-border/15">
          <div className="px-2 py-1 text-[10px] text-vsc-text-dim border-b border-vsc-panel-border/20 bg-vsc-bg/50">
            Proposed changes
          </div>
          <DiffLines original={proposedEdit.original} modified={proposedEdit.modified} />
          <div className="flex items-center gap-2 px-2 py-1.5 border-t border-vsc-panel-border/15">
            <button
              className="flex items-center gap-1 px-2 py-1 text-[10px] bg-green-600/80 hover:bg-green-500 text-white rounded transition-colors"
              onClick={handleAccept}
            >
              <Check size={11} /> Accept
            </button>
            <button
              className="flex items-center gap-1 px-2 py-1 text-[10px] bg-vsc-bg border border-vsc-panel-border hover:bg-vsc-list-hover text-vsc-text-dim hover:text-vsc-text rounded transition-colors"
              onClick={handleReject}
            >
              <RotateCcw size={11} /> Reject
            </button>
            <span className="text-[9px] text-vsc-text-dim ml-auto">Enter = accept, Esc = reject</span>
          </div>
        </div>
      )}
    </div>
  );
}
