/**
 * Install Cursor sticky key pool (multiple crsr_ keys).
 * Usage: node scripts/save-cursor-pool.js <key1> <key2> <key3> ...
 * Never prints full keys.
 */
'use strict';
const path = require('path');

const keys = process.argv.slice(2).map((k) => String(k || '').trim()).filter((k) => k.startsWith('crsr_'));
if (keys.length < 1) {
  console.error('FAIL need one or more crsr_ keys as argv');
  process.exit(1);
}

const root = path.join(__dirname, '..');
process.chdir(root);

const userData =
  process.env.GUIDE_USER_DATA ||
  path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'guide-ide');

const { SettingsManager } = require('../settingsManager');
const { CloudLLMService } = require('../cloudLLMService');
const { CursorKeyPool, maskKey } = require('../cursorKeyPool');

const sm = new SettingsManager(userData);
const cloudLLM = new CloudLLMService();
const pool = new CursorKeyPool({ settingsManager: sm, cloudLLM });
cloudLLM._cursorKeyPool = pool;

const st = pool.setKeys(keys);
console.log(
  `saved_cursor_pool n=${st.count} activeIndex=${st.activeIndex} masks=${keys.map(maskKey).join(',')}`
);

(async () => {
  const { Cursor } = require('@cursor/sdk');
  for (let i = 0; i < keys.length; i++) {
    try {
      const me = await Cursor.me({ apiKey: keys[i] });
      console.log(
        `key[${i}] ${maskKey(keys[i])} email=${me.userEmail || '?'} name=${me.apiKeyName || '?'}`
      );
    } catch (e) {
      console.log(`key[${i}] ${maskKey(keys[i])} me_err=${String(e.message).slice(0, 120)}`);
    }
  }
  console.log('POOL_OK');
})().catch((e) => {
  console.error('POOL_PARTIAL ' + e.message);
  process.exit(2);
});
