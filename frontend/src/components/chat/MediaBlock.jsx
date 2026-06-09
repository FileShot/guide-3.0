import React, { useState, useCallback } from 'react';
import { Copy, Check, RotateCcw, Download, ImageIcon } from 'lucide-react';

export default function MediaBlock({
  src,
  mimeType = 'image/png',
  prompt = '',
  mediaType = 'image',
  onRetry,
  onSaveToProject,
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyPrompt = useCallback(async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  }, [prompt]);

  const handleSave = useCallback(() => {
    if (!src) return;
    if (onSaveToProject) {
      onSaveToProject();
      return;
    }
    const a = document.createElement('a');
    a.href = src;
    a.download = mediaType === 'video' ? 'guide-video.mp4' : 'guide-image.png';
    a.click();
  }, [src, mediaType, onSaveToProject]);

  return (
    <div className="my-2 rounded-lg border border-vsc-border overflow-hidden bg-vsc-editor">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-vsc-fg-dim border-b border-vsc-border bg-vsc-sidebar">
        <ImageIcon size={14} />
        <span>{mediaType === 'video' ? 'Generated video' : 'Generated image'}</span>
        <div className="ml-auto flex items-center gap-1">
          {prompt && (
            <button type="button" className="p-1 hover:bg-vsc-list-hover rounded" title="Copy prompt" onClick={handleCopyPrompt}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          )}
          {onRetry && (
            <button type="button" className="p-1 hover:bg-vsc-list-hover rounded" title="Retry" onClick={onRetry}>
              <RotateCcw size={12} />
            </button>
          )}
          <button type="button" className="p-1 hover:bg-vsc-list-hover rounded" title="Save" onClick={handleSave}>
            <Download size={12} />
          </button>
        </div>
      </div>
      <div className="p-2 flex justify-center bg-black/20">
        {mediaType === 'video' ? (
          <video src={src} controls className="max-w-full max-h-96 rounded" />
        ) : (
          <img src={src} alt={prompt || 'Generated'} className="max-w-full max-h-96 rounded object-contain" />
        )}
      </div>
      {prompt && (
        <div className="px-3 py-2 text-xs text-vsc-fg-dim border-t border-vsc-border truncate" title={prompt}>
          {prompt}
        </div>
      )}
    </div>
  );
}
