'use strict';

/**
 * teamSharing — export/import rules + memory bundle for team sync.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function _deriveKey(passphrase) {
  return crypto.scryptSync(passphrase || 'guide-team-share', 'guide-team-bundle', 32);
}

function _encrypt(plain, passphrase) {
  const key = _deriveKey(passphrase);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function _decrypt(bundle, passphrase) {
  const key = _deriveKey(passphrase);
  const iv = Buffer.from(bundle.iv, 'base64');
  const tag = Buffer.from(bundle.tag, 'base64');
  const data = Buffer.from(bundle.data, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function exportTeamBundle({ rulesManager, memoryStore, longTermMemory, passphrase }) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: rulesManager.listRules?.() || [],
    memories: memoryStore.getAll?.() || memoryStore._memories || [],
    longTerm: longTermMemory.getAll?.() || longTermMemory._entries || [],
  };
  return {
    success: true,
    bundle: _encrypt(JSON.stringify(payload), passphrase),
    ruleCount: payload.rules.length,
    memoryCount: (payload.memories?.length || 0) + (payload.longTerm?.length || 0),
  };
}

function importTeamBundle({ rulesManager, memoryStore, longTermMemory, bundle, passphrase, merge = true }) {
  const plain = _decrypt(bundle, passphrase);
  const payload = JSON.parse(plain);

  let imported = { rules: 0, memories: 0 };

  if (Array.isArray(payload.rules)) {
    for (const rule of payload.rules) {
      const name = rule.name || rule.id;
      const content = rule.content || rule.body || '';
      if (name && content) {
        rulesManager.saveRule(name, content);
        imported.rules++;
      }
    }
  }

  if (Array.isArray(payload.memories) && memoryStore.importEntries) {
    memoryStore.importEntries(payload.memories, { merge });
    imported.memories += payload.memories.length;
  } else if (Array.isArray(payload.memories) && memoryStore.addMemory) {
    for (const m of payload.memories) {
      memoryStore.addMemory(m.key || m.id, m.value || m.content, m.category);
      imported.memories++;
    }
  }

  if (Array.isArray(payload.longTerm) && longTermMemory.importEntries) {
    longTermMemory.importEntries(payload.longTerm, { merge });
    imported.memories += payload.longTerm.length;
  }

  return { success: true, imported, exportedAt: payload.exportedAt };
}

module.exports = { exportTeamBundle, importTeamBundle };
