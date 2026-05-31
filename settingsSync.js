'use strict';

/**
 * settingsSync — export/import settings as encrypted JSON.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function _deriveKey(passphrase) {
  return crypto.scryptSync(passphrase || 'guide-default-sync-key', 'guide-settings-sync', 32);
}

function exportSettings(settingsManager, passphrase) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: settingsManager.getAll(),
    apiKeys: settingsManager.getAllApiKeys?.() || {},
  };
  const plain = JSON.stringify(payload);
  const key = _deriveKey(passphrase);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    success: true,
    bundle: {
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    },
  };
}

function importSettings(settingsManager, bundle, passphrase) {
  if (!bundle?.data || !bundle?.iv || !bundle?.tag) {
    throw new Error('Invalid sync bundle');
  }
  const key = _deriveKey(passphrase);
  const iv = Buffer.from(bundle.iv, 'base64');
  const tag = Buffer.from(bundle.tag, 'base64');
  const data = Buffer.from(bundle.data, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  const payload = JSON.parse(plain);

  if (payload.settings && typeof payload.settings === 'object') {
    for (const [k, v] of Object.entries(payload.settings)) {
      if (k in settingsManager.getAll()) settingsManager.set(k, v);
    }
  }
  if (payload.apiKeys && typeof payload.apiKeys === 'object') {
    for (const [provider, keyVal] of Object.entries(payload.apiKeys)) {
      settingsManager.setApiKey?.(provider, keyVal || '');
    }
  }
  settingsManager.flush?.();
  return { success: true, importedAt: payload.exportedAt };
}

module.exports = { exportSettings, importSettings };
