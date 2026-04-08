/**
 * BrowserPanel — Live preview panel with iframe, URL bar, and controls.
 * Connects to the live server for hot-reload preview of project files.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import useAppStore from '../stores/appStore';
import {
  Globe, RefreshCw, ArrowLeft, ArrowRight, X,
  ExternalLink, Play, Square, Maximize2,
} from 'lucide-react';

export default function BrowserPanel() {
  const projectPath = useAppStore(s => s.projectPath);
  const addNotification = useAppStore(s => s.addNotification);

  const [previewUrl, setPreviewUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(false);
  const iframeRef = useRef(null);

  // Listen for preview events from backend
  useEffect(() => {
    if (!window.electronAPI?.onPreviewEvent) return;
    window.electronAPI.onPreviewEvent((event, data) => {
      if (event === 'preview-started') {
        setPreviewUrl(data.url);
        setUrlInput(data.url);
        setActive(true);
        setLoading(false);
      } else if (event === 'preview-stopped') {
        setPreviewUrl('');
        setUrlInput('');
        setActive(false);
      } else if (event === 'preview-navigate') {
        setPreviewUrl(data.url);
        setUrlInput(data.url);
      }
    });
  }, []);

  const startPreview = useCallback(async () => {
    if (!projectPath) {
      addNotification({ type: 'error', message: 'Open a project folder first' });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/preview/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: projectPath }),
      });
      const data = await res.json();
      if (data.success) {
        setPreviewUrl(data.url);
        setUrlInput(data.url);
        setActive(true);
      } else {
        addNotification({ type: 'error', message: data.error || 'Failed to start preview' });
      }
    } catch (e) {
      addNotification({ type: 'error', message: e.message });
    }
    setLoading(false);
  }, [projectPath, addNotification]);

  const stopPreview = useCallback(async () => {
    try {
      await fetch('/api/preview/stop', { method: 'POST' });
    } catch {}
    setPreviewUrl('');
    setUrlInput('');
    setActive(false);
  }, []);

  const reload = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
    // Also tell live server to broadcast reload
    fetch('/api/preview/reload', { method: 'POST' }).catch(() => {});
  }, []);

  const navigate = useCallback((url) => {
    if (!url) return;
    let target = url.trim();
    if (!/^https?:\/\//i.test(target) && !target.startsWith('file://')) {
      target = 'http://' + target;
    }
    setPreviewUrl(target);
    setUrlInput(target);
  }, []);

  const handleUrlSubmit = useCallback((e) => {
    e.preventDefault();
    navigate(urlInput);
  }, [urlInput, navigate]);

  const openExternal = useCallback(() => {
    if (previewUrl) {
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(previewUrl);
      } else {
        window.open(previewUrl, '_blank');
      }
    }
  }, [previewUrl]);

  return (
    <div className="flex flex-col h-full bg-vsc-bg">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-vsc-panel-border bg-vsc-sidebar">
        {/* Navigation buttons */}
        <button className="p-1 text-vsc-text-dim hover:text-vsc-text rounded" title="Back"
          onClick={() => iframeRef.current?.contentWindow?.history.back()}>
          <ArrowLeft size={14} />
        </button>
        <button className="p-1 text-vsc-text-dim hover:text-vsc-text rounded" title="Forward"
          onClick={() => iframeRef.current?.contentWindow?.history.forward()}>
          <ArrowRight size={14} />
        </button>
        <button className="p-1 text-vsc-text-dim hover:text-vsc-text rounded" title="Reload"
          onClick={reload}>
          <RefreshCw size={14} />
        </button>

        {/* URL bar */}
        <form onSubmit={handleUrlSubmit} className="flex-1 flex">
          <div className="flex items-center flex-1 bg-vsc-input border border-vsc-input-border rounded px-2 gap-1">
            <Globe size={12} className="text-vsc-text-dim shrink-0" />
            <input
              type="text"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              placeholder="Enter URL or start preview..."
              className="flex-1 bg-transparent text-vsc-text text-vsc-xs py-1 outline-none"
            />
          </div>
        </form>

        {/* Action buttons */}
        {active ? (
          <button className="p-1 text-vsc-error hover:text-red-400 rounded" title="Stop preview"
            onClick={stopPreview}>
            <Square size={14} />
          </button>
        ) : (
          <button className="p-1 text-vsc-success hover:text-green-400 rounded" title="Start preview"
            onClick={startPreview} disabled={loading}>
            <Play size={14} />
          </button>
        )}
        <button className="p-1 text-vsc-text-dim hover:text-vsc-text rounded" title="Open in browser"
          onClick={openExternal}>
          <ExternalLink size={14} />
        </button>
      </div>

      {/* Content area */}
      {previewUrl ? (
        <iframe
          ref={iframeRef}
          src={previewUrl}
          className="flex-1 w-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title="Preview"
          onLoad={() => setLoading(false)}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-vsc-text-dim">
          <div className="text-center">
            <Globe size={48} className="mx-auto mb-4 opacity-30" />
            <p className="text-vsc-sm mb-2">Browser Preview</p>
            <p className="text-vsc-xs opacity-60 mb-4">
              {projectPath
                ? 'Click the play button to start the live preview server'
                : 'Open a project folder to enable live preview'}
            </p>
            {projectPath && (
              <button
                onClick={startPreview}
                disabled={loading}
                className="px-3 py-1.5 bg-vsc-accent text-white text-vsc-xs rounded hover:bg-vsc-accent/80 transition-colors"
              >
                {loading ? 'Starting...' : 'Start Preview'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
