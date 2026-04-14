/**
 * webSearch.js — Multi-backend web search (Brave Search + DuckDuckGo fallback).
 * No API key required. Local-first, offline-capable design.
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
    this.timeout = options.timeout || 12000;
    this._uaIndex = Math.floor(Math.random() * USER_AGENTS.length);
  }

  _getUA() {
    return USER_AGENTS[this._uaIndex++ % USER_AGENTS.length];
  }

  /**
   * Search the web. Tries Brave Search first, falls back to DuckDuckGo.
   * Returns [{title, url, snippet}] or {error: string}
   */
  async search(query, maxResults = 5) {
    // Backend 1: Brave Search
    try {
      const results = await this._searchBrave(query, maxResults);
      if (Array.isArray(results) && results.length > 0) return results;
    } catch (e) {
      console.log(`[WebSearch] Brave failed: ${e.message}`);
    }

    // Backend 2: DuckDuckGo Lite (POST)
    try {
      const results = await this._searchDDGPost(query, maxResults);
      if (Array.isArray(results) && results.length > 0) return results;
    } catch (e) {
      console.log(`[WebSearch] DDG POST failed: ${e.message}`);
    }

    // Backend 3: DuckDuckGo Lite (GET, with retry)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const results = await this._searchDDGGet(query, maxResults);
        if (Array.isArray(results) && results.length > 0) return results;
        if (attempt < 1) await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
      } catch (e) {
        console.log(`[WebSearch] DDG GET attempt ${attempt} failed: ${e.message}`);
        if (attempt < 1) await new Promise(r => setTimeout(r, 2000));
      }
    }

    return { error: 'Web search temporarily unavailable. All search backends failed.' };
  }

  /**
   * Brave Search — scrapes search.brave.com HTML results.
   */
  async _searchBrave(query, maxResults) {
    const encoded = encodeURIComponent(query);
    const url = `https://search.brave.com/search?q=${encoded}&source=web`;
    const html = await this._httpGet(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    });

    const results = [];
    // Brave uses <a class="heading-serpresult" or data attributes for result links
    // Primary pattern: <a ... class="result-header" href="URL">TITLE</a>
    const snippetBlocks = html.split(/class="snippet-description[^"]*"/);
    const headerBlocks = html.split(/class="result-header"/);

    // Try extracting from the structured result blocks
    const resultRe = /<a[^>]*class="[^"]*heading-serpresult[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = resultRe.exec(html)) !== null && results.length < maxResults) {
      const url = this._decodeHtmlEntities(m[1]);
      const title = this._stripTags(m[2]).trim();
      if (url && title && url.startsWith('http')) {
        results.push({ title, url, snippet: '' });
      }
    }

    // Fallback: look for <a ... href="URL" ... >TITLE</a> inside result containers
    if (results.length === 0) {
      const altRe = /data-type="web"[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = altRe.exec(html)) !== null && results.length < maxResults) {
        const url = this._decodeHtmlEntities(m[1]);
        const title = this._stripTags(m[2]).trim();
        if (url && title) results.push({ title, url, snippet: '' });
      }
    }

    // Extract snippets if we got results
    if (results.length > 0) {
      const snippetRe = /class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\//g;
      let si = 0;
      while ((m = snippetRe.exec(html)) !== null && si < results.length) {
        results[si].snippet = this._stripTags(m[1]).trim();
        si++;
      }
    }

    return results;
  }

  /**
   * DuckDuckGo Lite via POST (less likely to be rate-limited than GET).
   */
  async _searchDDGPost(query, maxResults) {
    const body = `q=${encodeURIComponent(query)}`;
    const html = await this._httpPost('https://lite.duckduckgo.com/lite/', body, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://lite.duckduckgo.com/',
      'Origin': 'https://lite.duckduckgo.com',
    });

    if (html.includes('cc=botnet') || html.includes('anomaly.js')) {
      throw new Error('DDG bot detection triggered');
    }
    return this._parseDDGLite(html, maxResults);
  }

  /**
   * DuckDuckGo Lite via GET (original method, fallback).
   */
  async _searchDDGGet(query, maxResults) {
    const encoded = encodeURIComponent(query);
    const resp = await this._httpGetWithStatus(`https://lite.duckduckgo.com/lite/?q=${encoded}`, {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://lite.duckduckgo.com/',
    });

    if (resp.status === 202 || resp.body.includes('cc=botnet') || resp.body.includes('anomaly.js')) {
      throw new Error('DDG rate limited');
    }
    return this._parseDDGLite(resp.body, maxResults);
  }

  /**
   * Parse DuckDuckGo Lite HTML results.
   */
  _parseDDGLite(html, maxResults) {
    const results = [];
    const blocks = html.split(/class=['"]result-link['"]/);
    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];
      const prevBlock = blocks[i - 1];
      const hrefMatch = prevBlock.match(/href="([^"]+)"\s*$/);
      if (!hrefMatch) continue;
      let resultUrl = hrefMatch[1];
      const uddgMatch = resultUrl.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) resultUrl = decodeURIComponent(uddgMatch[1]);
      const titleMatch = block.match(/^[^>]*>([^<]*(?:<[^>]*>[^<]*)*?)<\/a>/);
      const title = titleMatch ? this._stripTags(titleMatch[1]).trim() : '';
      const snippetMatch = block.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
      const snippet = snippetMatch ? this._stripTags(snippetMatch[1]).trim() : '';
      if (resultUrl && title) results.push({ title, url: resultUrl, snippet });
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
      const html = await this._httpGet(url);
      const title = this._extractTitle(html);
      const content = this._extractTextContent(html);
      const maxLen = 15000;
      const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[Content truncated]' : content;
      return { success: true, title, url, content: truncated };
    } catch (err) {
      return { success: false, error: `Fetch failed: ${err.message}` };
    }
  }

  // ─── HTTP helpers ────────────────────────────────────────

  _httpGet(url, extraHeaders = {}, maxRedirects = 5) {
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
          this._httpGet(redir, extraHeaders, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => { total += c.length; if (total > 2 * 1024 * 1024) { res.destroy(); reject(new Error('Response too large')); return; } chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  _httpGetWithStatus(url, extraHeaders = {}, maxRedirects = 5) {
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
          this._httpGetWithStatus(redir, extraHeaders, maxRedirects - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => { total += c.length; if (total > 2 * 1024 * 1024) { res.destroy(); reject(new Error('Response too large')); return; } chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  _httpPost(url, body, extraHeaders = {}, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const options = {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': this._getUA(),
          'Content-Length': Buffer.byteLength(body),
          ...extraHeaders,
        },
        timeout: this.timeout,
        rejectUnauthorized: false,
      };
      const req = transport.request(options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
          res.resume();
          this._httpGet(res.headers.location, extraHeaders, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => { total += c.length; if (total > 2 * 1024 * 1024) { res.destroy(); reject(new Error('Response too large')); return; } chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ─── HTML helpers ────────────────────────────────────────

  _stripTags(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }

  _decodeHtmlEntities(str) {
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
