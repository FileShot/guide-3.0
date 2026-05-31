/**
 * RestClientPanel — simple HTTP client (Thunder Client / REST Client style).
 */
import { useState } from 'react';
import useAppStore from '../stores/appStore';
import { Send, Copy, Check } from 'lucide-react';

export default function RestClientPanel() {
  const addNotification = useAppStore((s) => s.addNotification);
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('https://httpbin.org/get');
  const [headers, setHeaders] = useState('Content-Type: application/json');
  const [body, setBody] = useState('');
  const [response, setResponse] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const sendRequest = async () => {
    if (!url.trim()) {
      addNotification({ type: 'warning', message: 'Enter a URL' });
      return;
    }
    setLoading(true);
    setResponse('');
    setStatus('');
    try {
      const hdrs = {};
      for (const line of headers.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) hdrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const opts = { method, headers: hdrs };
      if (method !== 'GET' && method !== 'HEAD' && body.trim()) opts.body = body;
      const t0 = Date.now();
      const res = await fetch(url.trim(), opts);
      const text = await res.text();
      setStatus(`${res.status} ${res.statusText} (${Date.now() - t0}ms)`);
      try {
        setResponse(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setResponse(text);
      }
    } catch (e) {
      setStatus('Error');
      setResponse(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const copyResponse = async () => {
    try {
      await navigator.clipboard.writeText(response);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  };

  return (
    <div className="flex flex-col h-full text-vsc-xs">
      <div className="flex items-center gap-2 p-2 border-b border-vsc-panel-border/20 flex-shrink-0">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="bg-vsc-input border border-vsc-panel-border/30 rounded px-2 py-1 text-vsc-text"
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.example.com/endpoint"
          className="flex-1 bg-vsc-input border border-vsc-panel-border/30 rounded px-2 py-1 text-vsc-text font-vsc-code"
        />
        <button
          className="flex items-center gap-1 px-3 py-1 rounded bg-vsc-accent text-white hover:opacity-90 disabled:opacity-50"
          onClick={sendRequest}
          disabled={loading}
        >
          <Send size={12} />
          {loading ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div className="grid grid-cols-2 flex-1 min-h-0 divide-x divide-vsc-panel-border/20">
        <div className="flex flex-col min-h-0">
          <div className="px-2 py-1 text-vsc-text-dim border-b border-vsc-panel-border/15">Headers</div>
          <textarea
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            className="flex-1 min-h-0 p-2 bg-transparent text-vsc-text font-vsc-code resize-none outline-none"
            spellCheck={false}
          />
          <div className="px-2 py-1 text-vsc-text-dim border-t border-vsc-panel-border/15">Body</div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="flex-1 min-h-0 p-2 bg-transparent text-vsc-text font-vsc-code resize-none outline-none"
            spellCheck={false}
            placeholder='{"key": "value"}'
          />
        </div>
        <div className="flex flex-col min-h-0">
          <div className="flex items-center px-2 py-1 border-b border-vsc-panel-border/15 gap-2">
            <span className="text-vsc-text-dim flex-1 truncate">{status || 'Response'}</span>
            {response && (
              <button className="p-1 hover:bg-vsc-list-hover rounded" title="Copy" onClick={copyResponse}>
                {copied ? <Check size={12} className="text-vsc-success" /> : <Copy size={12} className="text-vsc-text-dim" />}
              </button>
            )}
          </div>
          <pre className="flex-1 min-h-0 p-2 overflow-auto scrollbar-thin text-vsc-text font-vsc-code whitespace-pre-wrap">
            {response || (loading ? 'Waiting for response…' : 'Response will appear here')}
          </pre>
        </div>
      </div>
    </div>
  );
}
