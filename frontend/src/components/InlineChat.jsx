/**
 * InlineChat — Floating chat input at the editor cursor position.
 * Triggered by Ctrl+I. Sends selected code + prompt to AI.
 */
import { useState, useRef, useEffect } from 'react';
import { ArrowUp, X, Sparkles } from 'lucide-react';

export default function InlineChat({ position, onSubmit, onClose }) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

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

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    onSubmit(text);
    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className="absolute z-50 w-[360px] bg-vsc-sidebar border border-vsc-panel-border rounded-lg shadow-xl glass-strong overflow-hidden"
      style={{
        top: position?.top ?? 100,
        left: position?.left ?? 100,
      }}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-vsc-panel-border/30">
        <Sparkles size={12} className="text-vsc-accent flex-shrink-0" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent border-none outline-none text-vsc-sm text-vsc-text placeholder:text-vsc-text-dim"
          placeholder="Ask guIDE to edit..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="p-1 bg-vsc-accent hover:bg-vsc-accent-hover text-white rounded transition-colors disabled:opacity-30"
          onClick={handleSubmit}
          disabled={!input.trim()}
        >
          <ArrowUp size={12} strokeWidth={2.5} />
        </button>
        <button
          className="p-1 hover:bg-vsc-list-hover rounded text-vsc-text-dim hover:text-vsc-text transition-colors"
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
