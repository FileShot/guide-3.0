'use strict';

const assert = require('assert');
const WebSearch = require('../webSearch');
const { parseProxyList } = WebSearch;

assert.deepStrictEqual(parseProxyList(''), []);
assert.deepStrictEqual(parseProxyList('http://a:1\nhttp://b:2'), ['http://a:1', 'http://b:2']);
assert.deepStrictEqual(parseProxyList('http://a:1, http://b:2'), ['http://a:1', 'http://b:2']);

const ws = new WebSearch({
  braveApiKey: 'test-brave',
  tavilyApiKey: 'test-tavily',
  serpApiKey: '',
  proxyUrls: 'http://127.0.0.1:9\nhttp://127.0.0.1:10',
});
const st = ws.status();
assert.strictEqual(st.braveApi, true);
assert.strictEqual(st.tavilyApi, true);
assert.strictEqual(st.serpApi, false);
assert.strictEqual(st.proxyCount, 2);

ws.configure({ braveApiKey: '', proxyUrls: [] });
assert.strictEqual(ws.status().braveApi, false);
assert.strictEqual(ws.status().proxyCount, 0);

// Parser smoke (no network)
const braveHits = ws._parseBrave(
  '<a class="heading-serpresult" href="https://example.com/a">Alpha</a>'
  + '<a class="heading-serpresult" href="https://example.com/b">Beta</a>',
  5,
);
assert.strictEqual(braveHits.length, 2);
assert.strictEqual(braveHits[0].url, 'https://example.com/a');

console.log('webSearchResilience.test.js OK');
