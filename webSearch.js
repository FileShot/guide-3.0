/**
 * webSearch.js — Multi-backend web search.
 * Uses Electron's net module (Chromium networking stack) when available,
 * falls back to Node.js https for non-Electron environments.
 * No API key required.
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

class WebSearch {
  constructor(options = {}) {
    this.timeout = options.timeout || 15000;
    this._uaIndex = Math.floor(Math.random() * USER_AGENTS.length);
    this._electronNet = null;
    try {
      this._electronNet = require('electron').net;
    } catch { /* not in Electron main process */ }
  }

  _getUA() {
    return USER_AGENTS[this._uaIndex++ % USER_AGENTS.length];
  }

  /**
   * Primary fetch using Electron's net module (Chromium network stack).
   * Handles TLS, compression, and cookies like a real browser.
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

  /**
   * Fallback fetch using Node.js https module.
   */
  _nodeFetch(url, extraHeaders = {}, maxRedirects = 5) {
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
          this._nodeFetch(redir, extraHeaders, maxRedirects - 1).then(resolve, reject);
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

  async _fetch(url, options = {}) {
    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...options.headers,
    };
    if (this._electronNet) {
      return this._electronFetch(url, { ...options, headers });
    }
    return this._nodeFetch(url, headers);
  }

  async _postFetch(url, body, headers = {}) {
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

  /**
   * Search the web. Tries multiple backends in order.
   * Returns [{title, url, snippet}] or {error: string}
   */
  async search(query, maxResults = 5) {
    const errors = [];

    // Backend 1: DuckDuckGo Lite via POST (most reliable for automated requests)
    try {
      const results = await this._searchDDGPost(query, maxResults);
      if (Array.isArray(results) && results.length > 0) return results;
      errors.push('DDG POST: no results');
    } catch (e) {
      errors.push(`DDG POST: ${e.message}`);
      console.log(`[WebSearch] DDG POST failed:`, e.message);
    }

    // Backend 2: DuckDuckGo Lite via GET
    try {
      const results = await this._searchDDGGet(query, maxResults);
      if (Array.isArray(results) && results.length > 0) return results;
      errors.push('DDG GET: no results');
    } catch (e) {
      errors.push(`DDG GET: ${e.message}`);
      console.log(`[WebSearch] DDG GET failed:`, e.message);
    }

    // Backend 3: Brave Search
    try {
      const results = await this._searchBrave(query, maxResults);
      if (Array.isArray(results) && results.length > 0) return results;
      errors.push('Brave: no results');
    } catch (e) {
      errors.push(`Brave: ${e.message}`);
      console.log(`[WebSearch] Brave failed:`, e.message);
    }

    // Backend 4: Bing
    try {
      const results = await this._searchBing(query, maxResults);
      if (Array.isArray(results) && results.length > 0) return results;
      errors.push('Bing: no results');
    } catch (e) {
      errors.push(`Bing: ${e.message}`);
      console.log(`[WebSearch] Bing failed:`, e.message);
    }

    console.error(`[WebSearch] All backends failed:`, errors.join(' | '));
    return { error: `Web search failed. Backends: ${errors.join('; ')}` };
  }

  /**
   * DuckDuckGo Lite via POST.
   */
  async _searchDDGPost(query, maxResults) {
    const body = `q=${encodeURIComponent(query)}`;
    const resp = await this._postFetch('https://lite.duckduckgo.com/lite/', body, {
      'Accept': 'text/html',
      'Referer': 'https://lite.duckduckgo.com/',
      'Origin': 'https://lite.duckduckgo.com',
    });
    if (resp.status === 202 || resp.body.includes('cc=botnet') || resp.body.includes('anomaly.js')) {
      throw new Error('Bot detection triggered');
    }
    return this._parseDDGLite(resp.body, maxResults);
  }

  /**
   * DuckDuckGo Lite via GET.
   */
  async _searchDDGGet(query, maxResults) {
    const resp = await this._fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { 'Referer': 'https://lite.duckduckgo.com/' },
    });
    if (resp.status === 202 || resp.body.includes('cc=botnet') || resp.body.includes('anomaly.js')) {
      throw new Error('Bot detection triggered');
    }
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    return this._parseDDGLite(resp.body, maxResults);
  }

  /**
   * Brave Search HTML scraping.
   */
  async _searchBrave(query, maxResults) {
    const resp = await this._fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
      headers: {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    return this._parseBrave(resp.body, maxResults);
  }

  /**
   * Bing Search HTML scraping.
   */
  async _searchBing(query, maxResults) {
    const resp = await this._fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
      headers: { 'Referer': 'https://www.bing.com/' },
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
   */
  async fetchPage(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false, error: 'Only http and https URLs are supported' };
      }
      const resp = await this._fetch(url);
      const html = resp.body;
      const title = this._extractTitle(html);
      const content = this._extractTextContent(html);
      const maxLen = 15000;
      const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[Content truncated]' : content;
      return { success: true, title, url, content: truncated };
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
