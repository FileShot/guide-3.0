/**
 * BrowserPanel — Live preview panel with iframe, URL bar, and controls.
 * External/SSO pages cannot be embedded (X-Frame-Options); agent browse shows status instead.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import useAppStore from '../stores/appStore';
import {
  Globe, RefreshCw, ArrowLeft, ArrowRight, X,
  ExternalLink, Play, Square,
} from 'lucide-react';

function isLikelyBlockedInIframe(url) {
  try {
    const u = new URL(url);
    if (/^localhost$/i.test(u.hostname) || u.hostname === '127.0.0.1') return false;
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function BrowserPanel() {
  const projectPath = useAppStore(s => s.projectPath);
  const addNotification = useAppStore(s => s.addNotification);
  const viewportNavigateUrl = useAppStore(s => s.viewportNavigateUrl);
  const clearViewportNavigateUrl = useAppStore(s => s.clearViewportNavigateUrl);

  const [previewUrl, setPreviewUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const iframeRef = useRef(null);

  const applyAgentStatus = useCallback((data) => {
    if (!data?.url) return;
    setAgentStatus({
      url: data.url,
      title: data.title || '',
      message: data.message || 'Agent browser is active. Use browser_snapshot in chat — this site cannot be shown in an embedded preview.',
      reason: data.reason || '',
    });
    setPreviewUrl('');
    setUrlInput(data.url);
    setActive(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onPreviewEvent) return;
    return window.electronAPI.onPreviewEvent((event, data) => {
      if (event === 'preview-started') {
        setAgentStatus(null);
        setPreviewUrl(data.url);
        setUrlInput(data.url);
        setActive(true);
        setLoading(false);
      } else if (event === 'preview-stopped') {
        setPreviewUrl('');
        setUrlInput('');
        setActive(false);
        setAgentStatus(null);
      } else if (event === 'preview-navigate') {
        if (isLikelyBlockedInIframe(data.url)) {
          applyAgentStatus({ url: data.url, message: 'This URL cannot be embedded in the preview (typical for login/SSO sites). The agent uses Playwright separately.' });
        } else {
          setAgentStatus(null);
          setPreviewUrl(data.url);
          setUrlInput(data.url);
        }
      } else if (event === 'browser-agent-status') {
        applyAgentStatus(data);
      }
    });
  }, [applyAgentStatus]);

  useEffect(() => {
    if (!viewportNavigateUrl) return;
    if (isLikelyBlockedInIframe(viewportNavigateUrl)) {
      applyAgentStatus({ url: viewportNavigateUrl });
    } else {
      setAgentStatus(null);
      setPreviewUrl(viewportNavigateUrl);
      setUrlInput(viewportNavigateUrl);
      setActive(true);
    }
    clearViewportNavigateUrl();
  }, [viewportNavigateUrl, clearViewportNavigateUrl, applyAgentStatus]);

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
        setAgentStatus(null);
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
    setAgentStatus(null);
  }, []);

  const reload = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
    fetch('/api/preview/reload', { method: 'POST' }).catch(() => {});
  }, []);

  const navigate = useCallback((url) => {
    if (!url) return;
    let target = url.trim();
    if (!/^https?:\/\//i.test(target) && !target.startsWith('file://')) {
      target = 'http://' + target;
    }
    if (isLikelyBlockedInIframe(target)) {
      applyAgentStatus({ url: target });
    } else {
      setAgentStatus(null);
      setPreviewUrl(target);
      setUrlInput(target);
    }
  }, [applyAgentStatus]);

  const handleUrlSubmit = useCallback((e) => {
    e.preventDefault();
    navigate(urlInput);
  }, [urlInput, navigate]);

  const openExternal = useCallback(() => {
    const url = agentStatus?.url || previewUrl;
    if (url) {
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    }
  }, [previewUrl, agentStatus]);

  return (
    <div className="flex flex-col h-full bg-vsc-bg">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-vsc-panel-border bg-vsc-sidebar">
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

      {agentStatus ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-vsc-text-dim max-w-lg mx-auto">
          <Globe size={40} className="mb-4 opacity-40 text-vsc-accent" />
          <p className="text-vsc-sm text-vsc-text mb-2 font-medium">Agent browser session</p>
          {agentStatus.title && (
            <p className="text-vsc-xs text-vsc-text-bright mb-1 truncate w-full">{agentStatus.title}</p>
          )}
          <p className="text-vsc-xs break-all mb-3 opacity-80">{agentStatus.url}</p>
          <p className="text-vsc-xs leading-relaxed mb-4">{agentStatus.message}</p>
          {agentStatus.reason && (
            <p className="text-[10px] opacity-50 mb-4">{agentStatus.reason}</p>
          )}
          <button type="button" className="btn btn-secondary text-vsc-xs" onClick={openExternal}>
            Open in system browser
          </button>
        </div>
      ) : previewUrl ? (
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
                className="btn btn-primary"
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
