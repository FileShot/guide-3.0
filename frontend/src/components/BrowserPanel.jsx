/**
 * BrowserPanel — Live preview panel with iframe, URL bar, and controls.
 * Pocket: Playwright screencast via browser_frame WS (canvas + input forwarding).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import useAppStore from '../stores/appStore';
import {
  Globe, RefreshCw, ArrowLeft, ArrowRight, X,
  ExternalLink, Play, Square,
} from 'lucide-react';

const isPocketWeb =
  typeof window !== 'undefined' &&
  (window.__POCKET__ || /pocket\.graysoft\.dev/i.test(window.location?.hostname || ''));

function isLikelyBlockedInIframe(url) {
  if (isPocketWeb) return false;
  try {
    const u = new URL(url);
    if (/^localhost$/i.test(u.hostname) || u.hostname === '127.0.0.1') return false;
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function throttle(fn, ms) {
  let last = 0;
  return function throttled(...args) {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

function drawFrameOnCanvas(canvas, base64) {
  if (!canvas || !base64) return;
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    createImageBitmap(blob)
      .then((bmp) => {
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      })
      .catch(() => {
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          canvas.getContext('2d').drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${base64}`;
      });
  } catch (_) {}
}

export default function BrowserPanel() {
  const projectPath = useAppStore((s) => s.projectPath);
  const addNotification = useAppStore((s) => s.addNotification);
  const viewportNavigateUrl = useAppStore((s) => s.viewportNavigateUrl);
  const clearViewportNavigateUrl = useAppStore((s) => s.clearViewportNavigateUrl);
  const browserReloadTick = useAppStore((s) => s.browserReloadTick);
  const browserPreviewResetTick = useAppStore((s) => s.browserPreviewResetTick);
  const browserControl = useAppStore((s) => s.settings.browserControl || 'auto');
  const browserEngine = useAppStore((s) => s.settings.browserEngine || 'chromium');
  const openBrowserTab = useAppStore((s) => s.openBrowserTab);

  const [previewUrl, setPreviewUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const [liveBrowser, setLiveBrowser] = useState(false);
  const iframeRef = useRef(null);
  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const pendingFrameRef = useRef(null);
  const frameRafRef = useRef(0);
  const rectCacheRef = useRef({ rect: null, time: 0 });

  const scheduleFrameDraw = useCallback(() => {
    if (frameRafRef.current) return;
    frameRafRef.current = requestAnimationFrame(() => {
      frameRafRef.current = 0;
      const b64 = pendingFrameRef.current;
      pendingFrameRef.current = null;
      if (b64 && canvasRef.current) drawFrameOnCanvas(canvasRef.current, b64);
    });
  }, []);

  const sendViewportDimensions = useCallback(() => {
    if (!isPocketWeb || !window.electronAPI?.sendViewportDimensions) return;
    const el = canvasContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(rect.width * dpr);
    const height = Math.floor(rect.height * dpr);
    if (width > 100 && height > 100) {
      window.electronAPI.sendViewportDimensions(width, height);
    }
  }, []);

  const mapInputCoords = useCallback((canvas, clientX, clientY) => {
    const now = Date.now();
    if (!rectCacheRef.current.rect || now - rectCacheRef.current.time > 200) {
      rectCacheRef.current = { rect: canvas.getBoundingClientRect(), time: now };
    }
    const rect = rectCacheRef.current.rect;
    const imgAspect = (canvas.width || 1) / (canvas.height || 1);
    const boxAspect = (rect.width || 1) / (rect.height || 1);
    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (imgAspect > boxAspect) {
      renderH = rect.width / imgAspect;
      offsetY = (rect.height - renderH) / 2;
    } else {
      renderW = rect.height * imgAspect;
      offsetX = (rect.width - renderW) / 2;
    }
    const scaleX = (canvas.width || 1) / renderW;
    const scaleY = (canvas.height || 1) / renderH;
    return {
      x: Math.round(Math.max(0, Math.min(canvas.width, (clientX - rect.left - offsetX) * scaleX))),
      y: Math.round(Math.max(0, Math.min(canvas.height, (clientY - rect.top - offsetY) * scaleY))),
    };
  }, []);

  const applyAgentStatus = useCallback((data) => {
    if (!data?.url) return;
    if (isPocketWeb) {
      setLiveBrowser(true);
      setAgentStatus(null);
      setPreviewUrl('');
      setUrlInput(data.url);
      setActive(true);
      setLoading(false);
      openBrowserTab();
      return;
    }
    setAgentStatus({
      url: data.url,
      title: data.title || '',
      message:
        data.message ||
        'Agent browser is active. Use browser_snapshot in chat — this site cannot be shown in an embedded preview.',
      reason: data.reason || '',
    });
    setPreviewUrl('');
    setUrlInput(data.url);
    setActive(true);
    setLoading(false);
  }, [openBrowserTab]);

  useEffect(() => {
    if (!window.electronAPI?.onPreviewEvent) return;
    return window.electronAPI.onPreviewEvent((event, data) => {
      if (event === 'preview-started') {
        setAgentStatus(null);
        if (isPocketWeb) {
          setLiveBrowser(true);
          openBrowserTab();
        } else {
          setPreviewUrl(data.url);
        }
        setUrlInput(data.url);
        setActive(true);
        setLoading(false);
      } else if (event === 'preview-stopped') {
        setPreviewUrl('');
        setUrlInput('');
        setActive(false);
        setAgentStatus(null);
        setLiveBrowser(false);
      } else if (event === 'preview-navigate') {
        if (isPocketWeb) {
          setLiveBrowser(true);
          setAgentStatus(null);
          setPreviewUrl('');
          setUrlInput(data.url);
          setActive(true);
          openBrowserTab();
        } else if (isLikelyBlockedInIframe(data.url)) {
          applyAgentStatus({
            url: data.url,
            message:
              'This URL cannot be embedded in the preview (typical for login/SSO sites). The agent uses Playwright separately.',
          });
        } else {
          setAgentStatus(null);
          setPreviewUrl(data.url);
          setUrlInput(data.url);
        }
      } else if (event === 'browser-agent-status') {
        applyAgentStatus(data);
      }
    });
  }, [applyAgentStatus, openBrowserTab]);

  useEffect(() => {
    if (!isPocketWeb || !window.electronAPI?.onPocketBrowserFrame) return;
    return window.electronAPI.onPocketBrowserFrame((data) => {
      if (data?.url) {
        setUrlInput(data.url);
        setActive(true);
        setAgentStatus(null);
        setLiveBrowser(true);
        openBrowserTab();
      }
      if (data?.image) {
        pendingFrameRef.current = data.image;
        scheduleFrameDraw();
      }
    });
  }, [openBrowserTab, scheduleFrameDraw]);

  useEffect(() => {
    if (!window.electronAPI?.onBrowserFrame) return;
    return window.electronAPI.onBrowserFrame((data) => {
      const b64 = data?.data || data?.image;
      if (data?.url) setUrlInput(data.url);
      setActive(true);
      setAgentStatus(null);
      setLiveBrowser(true);
      setLoading(false);
      openBrowserTab();
      if (b64) {
        pendingFrameRef.current = b64;
        scheduleFrameDraw();
      }
    });
  }, [openBrowserTab, scheduleFrameDraw]);

  useEffect(() => {
    if (!isPocketWeb || !window.electronAPI?.onShowViewportBrowser) return;
    return window.electronAPI.onShowViewportBrowser(() => {
      setLiveBrowser(true);
      setActive(true);
      openBrowserTab();
    });
  }, [openBrowserTab]);

  useEffect(() => {
    if (!liveBrowser || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const send = window.electronAPI?.sendBrowserInput;
    if (!send) return;

    const throttledMove = throttle((e) => {
      const { x, y } = mapInputCoords(canvas, e.clientX, e.clientY);
      send({
        type: 'mousemove',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    }, 32);

    const throttledScroll = throttle((e) => {
      const { x, y } = mapInputCoords(canvas, e.clientX, e.clientY);
      send({ type: 'scroll', x, y, deltaX: e.deltaX || 0, deltaY: e.deltaY || 0 });
    }, 32);

    const onMouseDown = (e) => {
      e.preventDefault();
      canvas.focus();
      const { x, y } = mapInputCoords(canvas, e.clientX, e.clientY);
      send({
        type: 'mousedown',
        x,
        y,
        button: ['left', 'middle', 'right'][e.button || 0] || 'left',
        clickCount: e.detail || 1,
      });
    };
    const onMouseUp = (e) => {
      e.preventDefault();
      const { x, y } = mapInputCoords(canvas, e.clientX, e.clientY);
      send({
        type: 'mouseup',
        x,
        y,
        button: ['left', 'middle', 'right'][e.button || 0] || 'left',
        clickCount: e.detail || 1,
      });
    };
    const onKeyDown = (e) => {
      e.preventDefault();
      send({
        type: 'keydown',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        text: e.key?.length === 1 ? e.key : '',
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
      });
    };
    const onKeyUp = (e) => {
      e.preventDefault();
      send({
        type: 'keyup',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        text: e.key?.length === 1 ? e.key : '',
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
      });
    };
    const onWheel = (e) => {
      e.preventDefault();
      throttledScroll(e);
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mousemove', throttledMove);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    sendViewportDimensions();
    const ro =
      typeof ResizeObserver !== 'undefined' && canvasContainerRef.current
        ? new ResizeObserver(() => sendViewportDimensions())
        : null;
    if (ro && canvasContainerRef.current) ro.observe(canvasContainerRef.current);
    window.addEventListener('resize', sendViewportDimensions);

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mousemove', throttledMove);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', sendViewportDimensions);
      ro?.disconnect();
    };
  }, [liveBrowser, mapInputCoords, sendViewportDimensions]);

  useEffect(() => {
    if (!viewportNavigateUrl) return;
    if (isLikelyBlockedInIframe(viewportNavigateUrl)) {
      applyAgentStatus({ url: viewportNavigateUrl });
    } else {
      setAgentStatus(null);
      if (isPocketWeb) {
        setLiveBrowser(true);
        openBrowserTab();
      } else {
        setPreviewUrl(viewportNavigateUrl);
      }
      setUrlInput(viewportNavigateUrl);
      setActive(true);
    }
    clearViewportNavigateUrl();
  }, [viewportNavigateUrl, clearViewportNavigateUrl, applyAgentStatus, openBrowserTab]);

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
    } catch (_) {}
    setPreviewUrl('');
    setUrlInput('');
    setActive(false);
    setAgentStatus(null);
    setLiveBrowser(false);
  }, []);

  const reload = useCallback(() => {
    if (liveBrowser && isPocketWeb) {
      sendViewportDimensions();
      return;
    }
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
    }
    fetch('/api/preview/reload', { method: 'POST' }).catch(() => {});
  }, [liveBrowser, sendViewportDimensions]);

  useEffect(() => {
    if (browserReloadTick > 0) reload();
  }, [browserReloadTick, reload]);

  const navigate = useCallback(
    (url) => {
      if (!url) return;
      let target = url.trim();
      if (!/^https?:\/\//i.test(target) && !target.startsWith('file://')) {
        target = `http://${target}`;
      }
      if (isLikelyBlockedInIframe(target)) {
        applyAgentStatus({ url: target });
      } else {
        setAgentStatus(null);
        if (isPocketWeb) {
          setLiveBrowser(false);
        }
        setPreviewUrl(target);
        setUrlInput(target);
      }
    },
    [applyAgentStatus],
  );

  const handleUrlSubmit = useCallback(
    (e) => {
      e.preventDefault();
      navigate(urlInput);
    },
    [urlInput, navigate],
  );

  const openExternal = useCallback(() => {
    const url = agentStatus?.url || urlInput || previewUrl;
    if (url) {
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    }
  }, [previewUrl, agentStatus, urlInput]);

  useEffect(() => {
    if (!browserPreviewResetTick) return;
    setPreviewUrl('');
    setUrlInput('');
    setLiveBrowser(false);
    setAgentStatus(null);
    setActive(false);
  }, [browserPreviewResetTick]);

  const showLiveCanvas = browserControl !== 'playwright' && liveBrowser;

  return (
    <div className="flex flex-col h-full bg-vsc-bg">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-vsc-panel-border bg-vsc-sidebar">
        <button
          type="button"
          className="p-1 text-vsc-text-dim hover:text-vsc-text rounded"
          title="Back"
          onClick={() => iframeRef.current?.contentWindow?.history.back()}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="p-1 text-vsc-text-dim hover:text-vsc-text rounded"
          title="Forward"
          onClick={() => iframeRef.current?.contentWindow?.history.forward()}
        >
          <ArrowRight size={14} />
        </button>
        <button type="button" className="p-1 text-vsc-text-dim hover:text-vsc-text rounded" title="Reload" onClick={reload}>
          <RefreshCw size={14} />
        </button>

        <form onSubmit={handleUrlSubmit} className="flex-1 flex">
          <div className="flex items-center flex-1 bg-vsc-input border border-vsc-input-border rounded px-2 gap-1">
            <Globe size={12} className="text-vsc-text-dim shrink-0" />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder={isPocketWeb ? 'Agent browser URL…' : 'Enter URL or start preview…'}
              className="flex-1 bg-transparent text-vsc-text text-vsc-xs py-1 outline-none"
            />
          </div>
        </form>

        {active ? (
          <button type="button" className="p-1 text-vsc-error hover:text-red-400 rounded" title="Stop preview" onClick={stopPreview}>
            <Square size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="p-1 text-vsc-success hover:text-green-400 rounded"
            title="Start preview"
            onClick={startPreview}
            disabled={loading}
          >
            <Play size={14} />
          </button>
        )}
        <button type="button" className="p-1 text-vsc-text-dim hover:text-vsc-text rounded" title="Open in browser" onClick={openExternal}>
          <ExternalLink size={14} />
        </button>
        <span
          className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${
            browserEngine === 'tor'
              ? 'bg-purple-900/40 text-purple-300 border border-purple-700/40'
              : 'bg-vsc-panel-border/20 text-vsc-text-dim border border-vsc-panel-border/30'
          }`}
          title={browserEngine === 'tor' ? 'Agent uses Tor Browser (geckodriver)' : 'Agent uses Chromium (Playwright)'}
        >
          {browserEngine === 'tor' ? 'Tor' : 'Chromium'}
        </span>
      </div>

      {showLiveCanvas ? (
        <div ref={canvasContainerRef} className="flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className="max-w-full max-h-full w-full h-full object-contain outline-none cursor-default"
            style={{ objectFit: 'contain' }}
            aria-label="Live agent browser"
          />
        </div>
      ) : agentStatus ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-vsc-text-dim max-w-lg mx-auto">
          <Globe size={40} className="mb-4 opacity-40 text-vsc-accent" />
          <p className="text-vsc-sm text-vsc-text mb-2 font-medium">Agent browser session</p>
          {agentStatus.title && <p className="text-vsc-xs text-vsc-text-bright mb-1 truncate w-full">{agentStatus.title}</p>}
          <p className="text-vsc-xs break-all mb-3 opacity-80">{agentStatus.url}</p>
          <p className="text-vsc-xs leading-relaxed mb-4">{agentStatus.message}</p>
          {agentStatus.reason && <p className="text-[10px] opacity-50 mb-4">{agentStatus.reason}</p>}
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
            <p className="text-vsc-sm mb-2">{isPocketWeb ? 'Agent Browser' : 'Browser Preview'}</p>
            <p className="text-vsc-xs opacity-60 mb-4">
              {isPocketWeb
                ? 'Ask the agent to browse the web — the live view appears here.'
                : projectPath
                  ? 'Click the play button to start the live preview server'
                  : 'Open a project folder to enable live preview'}
            </p>
            {!isPocketWeb && projectPath && (
              <button onClick={startPreview} disabled={loading} className="btn btn-primary">
                {loading ? 'Starting...' : 'Start Preview'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
