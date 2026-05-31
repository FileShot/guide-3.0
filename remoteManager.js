'use strict';

/**
 * remoteManager — SSH file read/write (ssh2 if available, else child_process ssh).
 */
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');

const execFileAsync = promisify(execFile);

class RemoteManager {
  constructor() {
    this._connections = new Map(); // id -> { host, user, port, keyPath }
    this._ssh2 = null;
    try { this._ssh2 = require('ssh2'); } catch { this._ssh2 = null; }
  }

  _connKey(host, user, port) {
    return `${user}@${host}:${port || 22}`;
  }

  connect({ host, user, port = 22, password, keyPath, id }) {
    if (!host || !user) throw new Error('host and user required');
    const connId = id || this._connKey(host, user, port);
    this._connections.set(connId, { host, user, port, password, keyPath });
    return { success: true, id: connId };
  }

  listConnections() {
    return [...this._connections.entries()].map(([id, c]) => ({
      id, host: c.host, user: c.user, port: c.port,
    }));
  }

  async _withSsh2(conn, fn) {
    if (!this._ssh2) return null;
    const Client = this._ssh2.Client;
    return new Promise((resolve, reject) => {
      const client = new Client();
      const cfg = {
        host: conn.host,
        port: conn.port || 22,
        username: conn.user,
      };
      if (conn.keyPath && fs.existsSync(conn.keyPath)) {
        cfg.privateKey = fs.readFileSync(conn.keyPath);
      } else if (conn.password) {
        cfg.password = conn.password;
      }
      client.on('ready', () => {
        fn(client).then(resolve).catch(reject).finally(() => client.end());
      });
      client.on('error', reject);
      client.connect(cfg);
    });
  }

  async readFile(connId, remotePath) {
    const conn = this._connections.get(connId);
    if (!conn) throw new Error('Connection not found');

    const ssh2Result = await this._withSsh2(conn, (client) => new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        const chunks = [];
        const stream = sftp.createReadStream(remotePath);
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve({ success: true, content: Buffer.concat(chunks).toString('utf8'), path: remotePath }));
        stream.on('error', reject);
      });
    }));
    if (ssh2Result) return ssh2Result;

    const sshArgs = ['-p', String(conn.port || 22), `${conn.user}@${conn.host}`, `cat "${remotePath.replace(/"/g, '\\"')}"`];
    if (conn.keyPath) sshArgs.unshift('-i', conn.keyPath);
    const { stdout } = await execFileAsync('ssh', sshArgs, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return { success: true, content: stdout, path: remotePath };
  }

  async writeFile(connId, remotePath, content) {
    const conn = this._connections.get(connId);
    if (!conn) throw new Error('Connection not found');

    const ssh2Result = await this._withSsh2(conn, (client) => new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath);
        stream.on('close', () => resolve({ success: true, path: remotePath }));
        stream.on('error', reject);
        stream.end(content || '', 'utf8');
      });
    }));
    if (ssh2Result) return ssh2Result;

    const tmp = path.join(os.tmpdir(), `guide-remote-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, content || '', 'utf8');
    try {
      const scpArgs = ['-P', String(conn.port || 22)];
      if (conn.keyPath) scpArgs.push('-i', conn.keyPath);
      scpArgs.push(tmp, `${conn.user}@${conn.host}:${remotePath}`);
      await execFileAsync('scp', scpArgs, { timeout: 60000 });
      return { success: true, path: remotePath };
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  async listDir(connId, remotePath) {
    const conn = this._connections.get(connId);
    if (!conn) throw new Error('Connection not found');

    const ssh2Result = await this._withSsh2(conn, (client) => new Promise((resolve, reject) => {
      client.exec(`ls -la "${remotePath.replace(/"/g, '\\"')}"`, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        stream.on('data', (d) => { out += d; });
        stream.stderr.on('data', (d) => { out += d; });
        stream.on('close', () => resolve({ success: true, listing: out, path: remotePath }));
      });
    }));
    if (ssh2Result) return ssh2Result;

    const sshArgs = ['-p', String(conn.port || 22), `${conn.user}@${conn.host}`, `ls -la "${remotePath.replace(/"/g, '\\"')}"`];
    if (conn.keyPath) sshArgs.unshift('-i', conn.keyPath);
    const { stdout } = await execFileAsync('ssh', sshArgs, { timeout: 30000 });
    return { success: true, listing: stdout, path: remotePath };
  }

  disconnect(connId) {
    this._connections.delete(connId);
    return { success: true };
  }
}

module.exports = { RemoteManager };
