/**
 * webSearch.js — DuckDuckGo HTML search + page fetch.
 * No API key required. Local-first, offline-capable design.
 * R33-Phase5: Created for guIDE web search tool support.
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

class WebSearch {
  constructor(options = {}) {
    this.timeout = options.timeout || 10000;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }

  /**
   * Search DuckDuckGo for the given query.
   * Returns [{title, url, snippet}] or {error: string}
   * R53-Fix: Switched from html.duckduckgo.com (now bot-blocked with 202 + JS challenge)
   * to lite.duckduckgo.com which still returns HTML results without JS execution.
   */
  async search(query, maxResults = 5) {
    try {
      const encoded = encodeURIComponent(query);
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encoded}`;
      const response = await this._fetchWithStatus(searchUrl);
      // R53-Fix: Detect bot-detection pages (HTTP 202 + anomaly/botnet challenge)
      if (response.status === 202 || response.body.includes('cc=botnet') || response.body.includes('anomaly.js')) {
        return { error: 'Search temporarily unavailable (rate limited). Try again in a few seconds.' };
      }
      return this._parseLiteResults(response.body, maxResults);
    } catch (err) {
      return { error: `Search failed: ${err.message}` };
    }
  }

  /**
   * Fetch a webpage and extract readable text content.
   * Returns {success, title, url, content} or {success:false, error}
   */
  async fetchPage(url) {
    try {
      // Basic URL validation
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false, error: 'Only http and https URLs are supported' };
      }
      const html = await this._fetch(url);
      const title = this._extractTitle(html);
      const content = this._extractTextContent(html);
      // Truncate to avoid overwhelming context
      const maxLen = 15000;
      const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n[Content truncated]' : content;
      return { success: true, title, url, content: truncated };
    } catch (err) {
      return { success: false, error: `Fetch failed: ${err.message}` };
    }
  }

  /**
   * Parse DuckDuckGo Lite search results page.
   * R53-Fix: Lite uses <a class='result-link'> for URLs/titles
   * and <td class="result-snippet"> for snippets, in a table layout.
   */
  _parseLiteResults(html, maxResults) {
    const results = [];
    // Split on result-link anchors — each is a search result
    const blocks = html.split(/class=['"]result-link['"]/);
    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];
      // Extract URL from href attribute (immediately before the class we split on)
      // The preceding block has the href: ...href="URL" class='result-link'...
      // So we need to look at the END of the previous block for href
      const prevBlock = blocks[i - 1];
      const hrefMatch = prevBlock.match(/href="([^"]+)"\s*$/);
      if (!hrefMatch) continue;
      let resultUrl = hrefMatch[1];
      // DuckDuckGo lite also wraps URLs in redirects — extract actual URL from uddg param
      const uddgMatch = resultUrl.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        resultUrl = decodeURIComponent(uddgMatch[1]);
      }
      // Extract title text from the anchor content (everything before </a>)
      const titleMatch = block.match(/^[^>]*>([^<]*(?:<[^>]*>[^<]*)*?)<\/a>/);
      const title = titleMatch ? this._stripTags(titleMatch[1]).trim() : '';
      // Extract snippet from result-snippet class in the same table section
      const snippetMatch = block.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/);
      const snippet = snippetMatch ? this._stripTags(snippetMatch[1]).trim() : '';

      if (resultUrl && title) {
        results.push({ title, url: resultUrl, snippet });
      }
    }
    return results;
  }

  /**
   * HTTP(S) GET with redirect following, timeout, and basic safety.
   * R53-Fix: Added _fetchWithStatus variant that returns {status, body}
   * so callers can detect bot-detection (HTTP 202) responses.
   */
  _fetchWithStatus(url, maxRedirects = 3) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(url, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: this.timeout,
        rejectUnauthorized: false,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (maxRedirects <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          let redirectUrl = res.headers.location;
          if (redirectUrl.startsWith('/')) {
            redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
          }
          res.resume();
          this._fetchWithStatus(redirectUrl, maxRedirects - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        let totalBytes = 0;
        const maxBytes = 2 * 1024 * 1024;
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            res.destroy();
            reject(new Error('Response too large (>2MB)'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  /**
   * HTTP(S) GET with redirect following, timeout, and basic safety.
   */
  _fetch(url, maxRedirects = 3) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(url, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: this.timeout,
        rejectUnauthorized: false, // Electron's bundled CA store may be incomplete
      }, (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (maxRedirects <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          let redirectUrl = res.headers.location;
          if (redirectUrl.startsWith('/')) {
            redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
          }
          res.resume();
          this._fetch(redirectUrl, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let totalBytes = 0;
        const maxBytes = 2 * 1024 * 1024; // 2MB max
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            res.destroy();
            reject(new Error('Response too large (>2MB)'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  /** Strip HTML tags from a string */
  _stripTags(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  }

  /** Extract <title> from HTML */
  _extractTitle(html) {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? this._stripTags(match[1]).trim() : '';
  }

  /** Extract readable text from HTML body, stripping scripts/styles/tags */
  _extractTextContent(html) {
    let body = html;
    // Extract body if present
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) body = bodyMatch[1];
    // Remove script, style, svg, noscript blocks
    body = body.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
    // Remove HTML comments
    body = body.replace(/<!--[\s\S]*?-->/g, '');
    // Strip tags
    body = this._stripTags(body);
    // Collapse whitespace
    body = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return body;
  }
}

module.exports = WebSearch;
