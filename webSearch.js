/**
 * webSearch.js — Multi-backend web search + page fetch.
 * Prefer keyed search APIs when configured; HTML scrapers as fallback.
 * Optional HTTP(S) proxy rotation for scrapers and fetch_webpage.
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const tls = require('tls');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

function parseProxyList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s || '').trim()).filter(Boolean);
  }
  return String(raw)
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

class WebSearch {
  constructor(options = {}) {
    this.timeout = options.timeout || 15000;
    this._uaIndex = Math.floor(Math.random() * USER_AGENTS.length);
    this._electronNet = null;
    this._braveApiKey = '';
    this._serpApiKey = '';
    this._tavilyApiKey = '';
    this._proxyUrls = [];
    this._proxyIndex = 0;
    try {
      this._electronNet = require('electron').net;
    } catch { /* not in Electron main process */ }
    this.configure(options);
  }

  /**
   * Hot-reload search keys + proxy pool from settings.
   * @param {{ braveApiKey?: string, serpApiKey?: string, tavilyApiKey?: string, proxyUrls?: string|string[], timeout?: number }} options
   */
  configure(options = {}) {
    if (options.timeout != null) this.timeout = Number(options.timeout) || this.timeout;
    if (options.braveApiKey != null) this._braveApiKey = String(options.braveApiKey || '').trim();
    if (options.serpApiKey != null) this._serpApiKey = String(options.serpApiKey || '').trim();
    if (options.tavilyApiKey != null) this._tavilyApiKey = String(options.tavilyApiKey || '').trim();
    if (options.proxyUrls != null) {
      this._proxyUrls = parseProxyList(options.proxyUrls);
      this._proxyIndex = 0;
    }
  }

  status() {
    return {
      braveApi: !!this._braveApiKey,
      serpApi: !!this._serpApiKey,
      tavilyApi: !!this._tavilyApiKey,
      proxyCount: this._proxyUrls.length,
    };
  }

  _getUA() {
    return USER_AGENTS[this._uaIndex++ % USER_AGENTS.length];
  }

  _nextProxy() {
    if (!this._proxyUrls.length) return null;
    const url = this._proxyUrls[this._proxyIndex % this._proxyUrls.length];
    this._proxyIndex += 1;
    return url;
  }

  /**
   * Primary fetch using Electron's net module (Chromium network stack).
   * Skipped when a proxy is forced (Electron session proxy is not wired here).
   */
  async _electronFetch(url, options = {}) {
    if (!this._electronNet) throw new Error('Electron net not available');
    const resp = await this._electronNet.fetch(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': this._getUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers,
      },
      body: options.body,
      signal: AbortSignal.timeout(this.timeout),
    });
    const text = await resp.text();
    return { status: resp.status, body: text };
  }

  _nodeFetch(url, extraHeaders = {}, maxRedirects = 5, proxyUrl = null) {
    if (proxyUrl) return this._proxyFetch(url, proxyUrl, { method: 'GET', headers: extraHeaders, maxRedirects });
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(url, {
        headers: { 'User-Agent': this._getUA(), ...extraHeaders },
        timeout: this.timeout,
        rejectUnauthorized: false,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
          let redir = res.headers.location;
          if (redir.startsWith('/')) redir = `${parsed.protocol}//${parsed.host}${redir}`;
          res.resume();
          this._nodeFetch(redir, extraHeaders, maxRedirects - 1, null).then(resolve, reject);
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => { total += c.length; if (total > 5 * 1024 * 1024) { res.destroy(); reject(new Error('Response too large')); return; } chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  /**
   * HTTP(S) proxy fetch (CONNECT for https targets). SOCKS not supported without extra deps.
   */
  _proxyFetch(targetUrl, proxyUrl, options = {}) {
    return new Promise((resolve, reject) => {
      let proxy;
      let target;
      try {
        proxy = new URL(proxyUrl);
        target = new URL(targetUrl);
      } catch (e) {
        reject(new Error(`Invalid proxy/target URL: ${e.message}`));
        return;
      }
      if (!['http:', 'https:'].includes(proxy.protocol)) {
        reject(new Error(`Unsupported proxy scheme ${proxy.protocol} (use http:// or https://)`));
        return;
      }

      const method = options.method || 'GET';
      const headers = {
        'User-Agent': this._getUA(),
        ...(options.headers || {}),
      };
      const body = options.body || null;
      if (body != null) headers['Content-Length'] = Buffer.byteLength(String(body));

      const settleTimeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, this.timeout);

      const finish = (err, result) => {
        clearTimeout(settleTimeout);
        if (err) reject(err);
        else resolve(result);
      };

      const readResponse = (socket, isTls) => {
        const chunks = [];
        let total = 0;
        let headerDone = false;
        let headerBuf = Buffer.alloc(0);
        let statusCode = 0;

        const onData = (c) => {
          if (!headerDone) {
            headerBuf = Buffer.concat([headerBuf, c]);
            const idx = headerBuf.indexOf('\r\n\r\n');
            if (idx < 0) return;
            const head = headerBuf.subarray(0, idx).toString('utf8');
            const rest = headerBuf.subarray(idx + 4);
            const statusLine = head.split('\r\n')[0] || '';
            const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
            statusCode = m ? Number(m[1]) : 0;
            headerDone = true;
            if (rest.length) {
              total += rest.length;
              chunks.push(rest);
            }
            return;
          }
          total += c.length;
          if (total > 5 * 1024 * 1024) {
            socket.destroy();
            finish(new Error('Response too large'));
            return;
          }
          chunks.push(c);
        };

        socket.on('data', onData);
        socket.on('end', () => {
          if (!headerDone) {
            finish(new Error('Proxy response incomplete'));
            return;
          }
          if ([301, 302, 303, 307, 308].includes(statusCode) && options.maxRedirects !== 0) {
            // Redirects through proxy: caller retries via _fetch with same proxy once.
            finish(null, { status: statusCode, body: Buffer.concat(chunks).toString('utf-8'), _headersIncomplete: true });
            return;
          }
          finish(null, { status: statusCode, body: Buffer.concat(chunks).toString('utf-8') });
        });
        socket.on('error', (e) => finish(e));
      };

      const proxyAuth = proxy.username
        ? Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64')
        : null;

      if (target.protocol === 'http:') {
        const reqHeaders = { ...headers, Host: target.host };
        if (proxyAuth) reqHeaders['Proxy-Authorization'] = `Basic ${proxyAuth}`;
        const path = target.href;
        const req = http.request({
          hostname: proxy.hostname,
          port: proxy.port || 80,
          method,
          path,
          headers: reqHeaders,
          timeout: this.timeout,
        }, (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', (c) => { total += c.length; if (total > 5 * 1024 * 1024) { res.destroy(); finish(new Error('Response too large')); return; } chunks.push(c); });
          res.on('end', () => finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
          res.on('error', finish);
        });
        req.on('error', finish);
        req.on('timeout', () => { req.destroy(); finish(new Error('Request timeout')); });
        if (body != null) req.write(String(body));
        req.end();
        return;
      }

      // HTTPS via CONNECT
      const connectReq = http.request({
        hostname: proxy.hostname,
        port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: {
          Host: `${target.hostname}:${target.port || 443}`,
          ...(proxyAuth ? { 'Proxy-Authorization': `Basic ${proxyAuth}` } : {}),
        },
        timeout: this.timeout,
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          finish(new Error(`Proxy CONNECT HTTP ${res.statusCode}`));
          return;
        }
        const tlsSock = tls.connect({
          socket,
          servername: target.hostname,
          rejectUnauthorized: false,
        }, () => {
          const path = `${target.pathname}${target.search || ''}` || '/';
          const lines = [
            `${method} ${path} HTTP/1.1`,
            `Host: ${target.host}`,
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            'Connection: close',
            '',
            '',
          ];
          tlsSock.write(lines.join('\r\n'));
          if (body != null) tlsSock.write(String(body));
          readResponse(tlsSock, true);
        });
        tlsSock.on('error', finish);
      });
      connectReq.on('error', finish);
      connectReq.on('timeout', () => { connectReq.destroy(); finish(new Error('Request timeout')); });
      connectReq.end();
    });
  }

  async _fetch(url, options = {}) {
    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...options.headers,
    };
    const forceProxy = options.proxyUrl || null;
    if (forceProxy) {
      return this._proxyFetch(url, forceProxy, { method: options.method || 'GET', headers, body: options.body, maxRedirects: 5 });
    }
    if (this._electronNet && !options.preferNode) {
      return this._electronFetch(url, { ...options, headers });
    }
    return this._nodeFetch(url, headers, 5, null);
  }

  async _postFetch(url, body, headers = {}, proxyUrl = null) {
    if (proxyUrl) {
      return this._proxyFetch(url, proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body,
      });
    }
    if (this._electronNet) {
      return this._electronFetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
    }
    return this._nodePost(url, body, headers);
  }

  _nodePost(url, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request({
        method: 'POST', hostname: parsed.hostname, port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': this._getUA(), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        timeout: this.timeout, rejectUnauthorized: false,
      }, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (c) => { total += c.length; if (total > 5 * 1024 * 1024) { res.destroy(); reject(new Error('Response too large')); return; } chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  async _jsonGet(url, headers = {}) {
    const resp = await this._fetch(url, {
      preferNode: true,
      headers: { Accept: 'application/json', ...headers },
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    let data;
    try { data = JSON.parse(resp.body); } catch { throw new Error('Invalid JSON response'); }
    return data;
  }

  async _jsonPost(url, payload, headers = {}) {
    const body = JSON.stringify(payload);
    // Use node https directly for JSON APIs (no HTML proxy needed)
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': this._getUA(),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          ...headers,
        },
        timeout: this.timeout,
        rejectUnauthorized: true,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON response')); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  /**
   * Search the web. Tries keyed APIs first, then HTML backends (optionally via proxy).
   * Returns [{title, url, snippet}] or {error: string}
   */
  async search(query, maxResults = 5) {
    const errors = [];
    const q = String(query || '').trim();
    if (!q) return { error: 'Empty query' };

    // API backends first (bypass HTML bot walls)
    if (this._braveApiKey) {
      try {
        const results = await this._searchBraveApi(q, maxResults);
        if (Array.isArray(results) && results.length > 0) {
          console.log(`[WebSearch] brave-api hits=${results.length}`);
          return results;
        }
        errors.push('Brave API: no results');
      } catch (e) {
        errors.push(`Brave API: ${e.message}`);
        console.log(`[WebSearch] Brave API failed:`, e.message);
      }
    }

    if (this._tavilyApiKey) {
      try {
        const results = await this._searchTavily(q, maxResults);
        if (Array.isArray(results) && results.length > 0) {
          console.log(`[WebSearch] tavily hits=${results.length}`);
          return results;
        }
        errors.push('Tavily: no results');
      } catch (e) {
        errors.push(`Tavily: ${e.message}`);
        console.log(`[WebSearch] Tavily failed:`, e.message);
      }
    }

    if (this._serpApiKey) {
      try {
        const results = await this._searchSerpApi(q, maxResults);
        if (Array.isArray(results) && results.length > 0) {
          console.log(`[WebSearch] serpapi hits=${results.length}`);
          return results;
        }
        errors.push('SerpAPI: no results');
      } catch (e) {
        errors.push(`SerpAPI: ${e.message}`);
        console.log(`[WebSearch] SerpAPI failed:`, e.message);
      }
    }

    // HTML scrapers (direct)
    const scrapers = [
      ['DDG POST', (proxy) => this._searchDDGPost(q, maxResults, proxy)],
      ['DDG GET', (proxy) => this._searchDDGGet(q, maxResults, proxy)],
      ['Brave HTML', (proxy) => this._searchBraveHtml(q, maxResults, proxy)],
      ['Bing', (proxy) => this._searchBing(q, maxResults, proxy)],
    ];
    for (const [name, run] of scrapers) {
      try {
        const results = await run(null);
        if (Array.isArray(results) && results.length > 0) {
          console.log(`[WebSearch] ${name} direct hits=${results.length}`);
          return results;
        }
        errors.push(`${name} (direct): no results`);
      } catch (e) {
        errors.push(`${name} (direct): ${e.message}`);
        console.log(`[WebSearch] ${name} failed:`, e.message);
      }
    }

    // Rotate HTTP proxies for scrapers after direct bot walls
    for (const proxyUrl of this._proxyUrls.slice(0, 4)) {
      for (const [name, run] of scrapers.slice(0, 2)) {
        try {
          const results = await run(proxyUrl);
          if (Array.isArray(results) && results.length > 0) {
            console.log(`[WebSearch] ${name} proxy hits=${results.length}`);
            return results;
          }
          errors.push(`${name} (proxy): no results`);
        } catch (e) {
          errors.push(`${name} (proxy): ${e.message}`);
          console.log(`[WebSearch] ${name} proxy failed:`, e.message);
        }
      }
    }

    console.error(`[WebSearch] All backends failed:`, errors.join(' | '));
    return { error: `Web search failed. Backends: ${errors.join('; ')}` };
  }

  async _searchBraveApi(query, maxResults) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, maxResults)}`;
    const data = await this._jsonGet(url, { 'X-Subscription-Token': this._braveApiKey });
    const web = data?.web?.results || [];
    return web.slice(0, maxResults).map((r) => ({
      title: String(r.title || '').trim(),
      url: String(r.url || '').trim(),
      snippet: String(r.description || r.extra_snippets?.[0] || '').trim(),
    })).filter((r) => r.url && r.title);
  }

  async _searchTavily(query, maxResults) {
    const data = await this._jsonPost('https://api.tavily.com/search', {
      api_key: this._tavilyApiKey,
      query,
      max_results: Math.min(10, maxResults),
      include_answer: false,
      search_depth: 'basic',
    });
    const web = data?.results || [];
    return web.slice(0, maxResults).map((r) => ({
      title: String(r.title || '').trim(),
      url: String(r.url || '').trim(),
      snippet: String(r.content || '').trim().slice(0, 500),
    })).filter((r) => r.url && r.title);
  }

  async _searchSerpApi(query, maxResults) {
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${Math.min(10, maxResults)}&api_key=${encodeURIComponent(this._serpApiKey)}`;
    const data = await this._jsonGet(url);
    const web = data?.organic_results || [];
    return web.slice(0, maxResults).map((r) => ({
      title: String(r.title || '').trim(),
      url: String(r.link || '').trim(),
      snippet: String(r.snippet || '').trim(),
    })).filter((r) => r.url && r.title);
  }

  async _searchDDGPost(query, maxResults, proxyUrl = null) {
    const body = `q=${encodeURIComponent(query)}`;
    const resp = await this._postFetch('https://lite.duckduckgo.com/lite/', body, {
      'Accept': 'text/html',
      'Referer': 'https://lite.duckduckgo.com/',
      'Origin': 'https://lite.duckduckgo.com',
    }, proxyUrl);
    if (resp.status === 202 || resp.body.includes('cc=botnet') || resp.body.includes('anomaly.js')) {
      throw new Error('Bot detection triggered');
    }
    return this._parseDDGLite(resp.body, maxResults);
  }

  async _searchDDGGet(query, maxResults, proxyUrl = null) {
    const resp = await this._fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { 'Referer': 'https://lite.duckduckgo.com/' },
      proxyUrl: proxyUrl || undefined,
      preferNode: !!proxyUrl,
    });
    if (resp.status === 202 || resp.body.includes('cc=botnet') || resp.body.includes('anomaly.js')) {
      throw new Error('Bot detection triggered');
    }
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    return this._parseDDGLite(resp.body, maxResults);
  }

  async _searchBraveHtml(query, maxResults, proxyUrl = null) {
    const resp = await this._fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
      headers: {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
      proxyUrl: proxyUrl || undefined,
      preferNode: !!proxyUrl,
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    return this._parseBrave(resp.body, maxResults);
  }

  async _searchBing(query, maxResults, proxyUrl = null) {
    const resp = await this._fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
      headers: { 'Referer': 'https://www.bing.com/' },
      proxyUrl: proxyUrl || undefined,
      preferNode: !!proxyUrl,
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    return this._parseBing(resp.body, maxResults);
  }

  // ─── Parsers ─────────────────────────────────────────────

  _parseDDGLite(html, maxResults) {
    const results = [];
    const blocks = html.split(/class=['"]result-link['"]/);
    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const prevBlock = blocks[i - 1];
      const hrefMatch = prevBlock.match(/href="([^"]+)"\s*$/);
      if (!hrefMatch) continue;
      let resultUrl = hrefMatch[1];
      const uddgMatch = resultUrl.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) resultUrl = decodeURIComponent(uddgMatch[1]);
      const titleMatch = blocks[i].match(/^[^>]*>([^<]*(?:<[^>]*>[^<]*)*?)<\/a>/);
      const title = titleMatch ? this._stripTags(titleMatch[1]).trim() : '';
      const snippetMatch = blocks[i].match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
      const snippet = snippetMatch ? this._stripTags(snippetMatch[1]).trim() : '';
      if (resultUrl && title) results.push({ title, url: resultUrl, snippet });
    }
    return results;
  }

  _parseBrave(html, maxResults) {
    const results = [];
    const re = /<a[^>]*class="[^"]*heading-serpresult[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const url = this._decodeEntities(m[1]);
      const title = this._stripTags(m[2]).trim();
      if (url && title && url.startsWith('http')) results.push({ title, url, snippet: '' });
    }
    if (results.length === 0) {
      const altRe = /data-type="web"[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = altRe.exec(html)) !== null && results.length < maxResults) {
        const url = this._decodeEntities(m[1]);
        const title = this._stripTags(m[2]).trim();
        if (url && title) results.push({ title, url, snippet: '' });
      }
    }
    const snippetRe = /class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\//g;
    let si = 0;
    while ((m = snippetRe.exec(html)) !== null && si < results.length) {
      results[si++].snippet = this._stripTags(m[1]).trim();
    }
    return results;
  }

  _parseBing(html, maxResults) {
    const results = [];
    const re = /<li class="b_algo">([\s\S]*?)<\/li>/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const block = m[1];
      const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!linkMatch) continue;
      const url = this._decodeEntities(linkMatch[1]);
      const title = this._stripTags(linkMatch[2]).trim();
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const snippet = snippetMatch ? this._stripTags(snippetMatch[1]).trim() : '';
      if (url && title) results.push({ title, url, snippet });
    }
    return results;
  }

  /**
   * Fetch a webpage and extract readable text content.
   * Retries once through the next proxy on hard failure / bot wall.
   */
  async fetchPage(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false, error: 'Only http and https URLs are supported' };
      }
      const attempts = [null];
      if (this._proxyUrls.length) attempts.push(this._nextProxy());
      let lastErr = null;
      for (const proxyUrl of attempts) {
        try {
          const resp = await this._fetch(url, {
            proxyUrl: proxyUrl || undefined,
            preferNode: !!proxyUrl,
          });
          if (resp.status === 403 || resp.status === 429 || resp.status === 202) {
            lastErr = new Error(`HTTP ${resp.status}`);
            continue;
          }
          if (resp.status < 200 || resp.status >= 300) {
            lastErr = new Error(`HTTP ${resp.status}`);
            continue;
          }
          const html = resp.body;
          if (html.includes('cc=botnet') || html.includes('anomaly.js') || /captcha/i.test(html.slice(0, 2000))) {
            lastErr = new Error('Bot detection triggered');
            continue;
          }
          const title = this._extractTitle(html);
          const content = this._extractTextContent(html);
          const maxLen = 15000;
          const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[Content truncated]' : content;
          return { success: true, title, url, content: truncated, viaProxy: !!proxyUrl };
        } catch (err) {
          lastErr = err;
        }
      }
      return { success: false, error: `Fetch failed: ${lastErr?.message || 'unknown'}` };
    } catch (err) {
      return { success: false, error: `Fetch failed: ${err.message}` };
    }
  }

  // ─── HTML helpers ────────────────────────────────────────

  _stripTags(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }

  _decodeEntities(str) {
    return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  _extractTitle(html) {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? this._stripTags(match[1]).trim() : '';
  }

  _extractTextContent(html) {
    let body = html;
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) body = bodyMatch[1];
    body = body.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
    body = body.replace(/<!--[\s\S]*?-->/g, '');
    body = this._stripTags(body);
    body = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return body;
  }
}

module.exports = WebSearch;
module.exports.parseProxyList = parseProxyList;
