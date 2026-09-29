/**
 * One-shot: save Cursor API key into guIDE encrypted key store + prove SDK auth.
 * Usage: node scripts/save-cursor-key.js <key>
 * Never logs the raw key.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const key = String(process.argv[2] || process.env.CURSOR_API_KEY || '').trim();
if (!key || !key.startsWith('crsr_')) {
  console.error('FAIL need crsr_… key as argv[1] or CURSOR_API_KEY');
  process.exit(1);
}

const root = path.join(__dirname, '..');
process.chdir(root);

const userData =
  process.env.GUIDE_USER_DATA ||
  path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'guide-ide');

const { SettingsManager } = require('../settingsManager');
const sm = new SettingsManager(userData);
sm.setApiKey('cursor', key);
if (sm._keysSaveTimer) clearTimeout(sm._keysSaveTimer);
sm._saveKeys();
console.log('saved_provider=cursor userData=' + userData + ' key_len=' + key.length + ' prefix=' + key.slice(0, 8));

(async () => {
  try {
    const { Cursor, Agent } = require('@cursor/sdk');
    let models = [];
    try {
      models = await Cursor.models.list({ apiKey: key });
      console.log('models_list_count=' + (models?.length || 0));
      console.log(
        'models_sample=' +
          (models || [])
            .slice(0, 8)
            .map((m) => m.id)
            .join(',')
      );
    } catch (e) {
      console.log('models_list_err=' + e.message);
    }

    const cwd = process.cwd();
    const result = await Agent.prompt('Reply with exactly: CURSOR_GUIDE_OK', {
      apiKey: key,
      model: { id: 'auto' },
      local: { cwd },
    });
    const text = String(result?.result || result?.text || '').trim();
    console.log('prompt_status=' + (result?.status || 'n/a'));
    console.log('prompt_text_head=' + text.slice(0, 120).replace(/\n/g, ' '));
    console.log(text.includes('CURSOR_GUIDE_OK') ? 'PROVE_OK' : 'PROVE_PARTIAL');
  } catch (e) {
    console.error('PROVE_FAIL ' + e.message);
    process.exit(2);
  }
})();
