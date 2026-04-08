/**
 * guIDE — Debug Service
 *
 * Manages debug sessions for Node.js and Python scripts.
 * - Node.js: spawns with --inspect-brk, connects via Chrome DevTools Protocol (CDP)
 * - Python: spawns with debugpy --wait-for-client, connects via DAP over socket
 *
 * Each session has an integer ID. Events are emitted for consumers to forward to the frontend.
 */
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const log = require('./logger');

let nextSessionId = 1;

class DebugService extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // id → DebugSession
  }

  /**
   * Start a new debug session.
   * @param {object} config - { type: 'node'|'python', program: string, cwd: string, args?: string[] }
   * @returns {{ success: boolean, id?: number, error?: string }}
   */
  async start(config) {
    const { type = 'node', program, cwd, args = [] } = config;
    if (!program) return { success: false, error: 'No program specified' };

    const id = nextSessionId++;
    try {
      let session;
      if (type === 'python') {
        session = await this._startPython(id, program, cwd, args);
      } else {
        session = await this._startNode(id, program, cwd, args);
      }
      this.sessions.set(id, session);
      this._emit(id, 'initialized');
      return { success: true, id, state: 'running' };
    } catch (err) {
      log.error(`[DebugService] Failed to start session: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /* ── Node.js via CDP ────────────────────────────────────────────── */

  async _startNode(id, program, cwd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--inspect-brk=0', program, ...args], {
        cwd: cwd || path.dirname(program),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let wsUrl = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error('Timed out waiting for debugger to start'));
        }
      }, 10000);

      // Capture stderr to find the WebSocket debug URL
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        this._emit(id, 'output', { output: text, category: 'stderr' });

        if (!wsUrl) {
          const match = text.match(/ws:\/\/[^\s]+/);
          if (match) {
            wsUrl = match[0];
            clearTimeout(timeout);
            this._connectCDP(id, wsUrl, child).then(session => {
              if (!settled) { settled = true; resolve(session); }
            }).catch(err => {
              if (!settled) { settled = true; child.kill(); reject(err); }
            });
          }
        }
      });

      child.stdout.on('data', (chunk) => {
        this._emit(id, 'output', { output: chunk.toString(), category: 'stdout' });
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        this._emit(id, 'terminated', { exitCode: code });
        this.sessions.delete(id);
        if (!settled) { settled = true; reject(new Error(`Process exited with code ${code}`)); }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        this._emit(id, 'output', { output: `Process error: ${err.message}\n`, category: 'stderr' });
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  async _connectCDP(id, wsUrl, child) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const pending = new Map(); // msgId → { resolve, reject }
      let msgId = 1;

      const session = {
        id, type: 'node', child, ws, pending,
        send: (method, params = {}) => {
          return new Promise((res, rej) => {
            const mid = msgId++;
            pending.set(mid, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        state: 'running',
      };

      ws.on('open', async () => {
        try {
          // Enable debugger domain
          await session.send('Debugger.enable');
          await session.send('Runtime.enable');
          // Run to hit breakpoints (since --inspect-brk pauses at first line)
          await session.send('Runtime.runIfWaitingForDebugger');
          resolve(session);
        } catch (err) {
          reject(err);
        }
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Response to a command
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
            return;
          }

          // CDP event
          if (msg.method) {
            this._handleCDPEvent(id, session, msg.method, msg.params);
          }
        } catch {}
      });

      ws.on('close', () => {
        session.state = 'stopped';
        for (const [, p] of pending) p.reject(new Error('WebSocket closed'));
        pending.clear();
      });

      ws.on('error', (err) => {
        log.error(`[DebugService] CDP WebSocket error: ${err.message}`);
        reject(err);
      });
    });
  }

  _handleCDPEvent(id, session, method, params) {
    switch (method) {
      case 'Debugger.paused':
        session.state = 'paused';
        session._pauseParams = params;
        this._emit(id, 'stopped', {
          reason: params.reason || 'breakpoint',
          callFrames: params.callFrames,
        });
        break;
      case 'Debugger.resumed':
        session.state = 'running';
        this._emit(id, 'continued');
        break;
      case 'Runtime.consoleAPICalled':
        if (params.args) {
          const text = params.args.map(a => a.value ?? a.description ?? '').join(' ');
          this._emit(id, 'output', { output: text + '\n', category: 'console' });
        }
        break;
      case 'Runtime.exceptionThrown':
        if (params.exceptionDetails) {
          const text = params.exceptionDetails.text || 'Exception';
          this._emit(id, 'output', { output: `Exception: ${text}\n`, category: 'stderr' });
        }
        break;
    }
  }

  /* ── Python via debugpy ─────────────────────────────────────────── */

  async _startPython(id, program, cwd, args) {
    // Find a free port for debugpy
    const port = await this._findFreePort();

    return new Promise((resolve, reject) => {
      // Spawn: python -m debugpy --listen 0.0.0.0:PORT --wait-for-client program.py
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawn(pythonCmd, [
        '-m', 'debugpy',
        '--listen', `127.0.0.1:${port}`,
        '--wait-for-client',
        program,
        ...args,
      ], {
        cwd: cwd || path.dirname(program),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error('Timed out waiting for debugpy'));
        }
      }, 15000);

      child.stdout.on('data', (chunk) => {
        this._emit(id, 'output', { output: chunk.toString(), category: 'stdout' });
      });

      child.stderr.on('data', (chunk) => {
        this._emit(id, 'output', { output: chunk.toString(), category: 'stderr' });
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        this._emit(id, 'terminated', { exitCode: code });
        this.sessions.delete(id);
        if (!settled) { settled = true; reject(new Error(`Python process exited with code ${code}`)); }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(err); }
      });

      // Wait for debugpy to be listening, then connect via DAP
      setTimeout(async () => {
        try {
          const session = await this._connectDAP(id, port, child);
          clearTimeout(timeout);
          if (!settled) { settled = true; resolve(session); }
        } catch (err) {
          clearTimeout(timeout);
          if (!settled) { settled = true; child.kill(); reject(err); }
        }
      }, 1000); // Give debugpy a moment to start listening
    });
  }

  async _connectDAP(id, port, child) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        // Connected to debugpy DAP server
      });

      const pending = new Map();
      let seq = 1;
      let buffer = '';

      const session = {
        id, type: 'python', child, socket, pending,
        send: (command, args = {}) => {
          return new Promise((res, rej) => {
            const s = seq++;
            pending.set(s, { resolve: res, reject: rej });
            const body = JSON.stringify({ seq: s, type: 'request', command, arguments: args });
            const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
            socket.write(header + body);
          });
        },
        state: 'running',
      };

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        // Parse DAP messages (Content-Length header + JSON body)
        while (true) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) break;
          const header = buffer.substring(0, headerEnd);
          const match = header.match(/Content-Length:\s*(\d+)/i);
          if (!match) { buffer = buffer.substring(headerEnd + 4); continue; }
          const len = parseInt(match[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + len) break; // incomplete body
          const bodyStr = buffer.substring(bodyStart, bodyStart + len);
          buffer = buffer.substring(bodyStart + len);

          try {
            const msg = JSON.parse(bodyStr);
            this._handleDAPMessage(id, session, msg);
          } catch {}
        }
      });

      socket.on('close', () => {
        session.state = 'stopped';
        for (const [, p] of pending) p.reject(new Error('DAP socket closed'));
        pending.clear();
      });

      socket.on('error', (err) => {
        log.error(`[DebugService] DAP socket error: ${err.message}`);
        reject(err);
      });

      // Initialize DAP session
      (async () => {
        try {
          await session.send('initialize', {
            clientID: 'guide-ide',
            clientName: 'guIDE',
            adapterID: 'debugpy',
            pathFormat: 'path',
            linesStartAt1: true,
            columnsStartAt1: true,
            supportsRunInTerminalRequest: false,
          });
          await session.send('attach', { justMyCode: true });
          await session.send('configurationDone');
          resolve(session);
        } catch (err) {
          reject(err);
        }
      })();
    });
  }

  _handleDAPMessage(id, session, msg) {
    // Response to a request
    if (msg.type === 'response' && session.pending.has(msg.request_seq)) {
      const p = session.pending.get(msg.request_seq);
      session.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body || {});
      else p.reject(new Error(msg.message || 'DAP request failed'));
      return;
    }

    // DAP event
    if (msg.type === 'event') {
      switch (msg.event) {
        case 'stopped':
          session.state = 'paused';
          session._threadId = msg.body?.threadId;
          this._emit(id, 'stopped', { reason: msg.body?.reason || 'breakpoint' });
          break;
        case 'continued':
          session.state = 'running';
          this._emit(id, 'continued');
          break;
        case 'terminated':
          session.state = 'stopped';
          this._emit(id, 'terminated', { exitCode: 0 });
          this.sessions.delete(id);
          break;
        case 'output':
          this._emit(id, 'output', {
            output: msg.body?.output || '',
            category: msg.body?.category || 'stdout',
          });
          break;
        case 'exited':
          this._emit(id, 'terminated', { exitCode: msg.body?.exitCode ?? 0 });
          this.sessions.delete(id);
          break;
      }
    }
  }

  /* ── Debug Actions (unified interface) ──────────────────────────── */

  async stop(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };
    try {
      if (s.child && !s.child.killed) s.child.kill();
      if (s.ws) s.ws.close();
      if (s.socket) s.socket.destroy();
    } catch {}
    this.sessions.delete(sessionId);
    this._emit(sessionId, 'terminated', { exitCode: -1 });
    return { success: true };
  }

  async resume(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };
    if (s.type === 'node') {
      await s.send('Debugger.resume');
    } else {
      await s.send('continue', { threadId: s._threadId || 1 });
    }
    return { success: true };
  }

  async stepOver(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };
    if (s.type === 'node') {
      await s.send('Debugger.stepOver');
    } else {
      await s.send('next', { threadId: s._threadId || 1 });
    }
    return { success: true };
  }

  async stepInto(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };
    if (s.type === 'node') {
      await s.send('Debugger.stepInto');
    } else {
      await s.send('stepIn', { threadId: s._threadId || 1 });
    }
    return { success: true };
  }

  async stepOut(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };
    if (s.type === 'node') {
      await s.send('Debugger.stepOut');
    } else {
      await s.send('stepOut', { threadId: s._threadId || 1 });
    }
    return { success: true };
  }

  async pause(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };
    if (s.type === 'node') {
      await s.send('Debugger.pause');
    } else {
      await s.send('pause', { threadId: s._threadId || 1 });
    }
    return { success: true };
  }

  async getStackTrace(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };

    if (s.type === 'node') {
      // Use the cached pause params which have callFrames
      const frames = s._pauseParams?.callFrames || [];
      return {
        success: true,
        stackFrames: frames.map((f, i) => ({
          id: i,
          name: f.functionName || '(anonymous)',
          source: f.url ? {
            name: path.basename(f.url.replace('file://', '')),
            path: f.url.replace('file:///', '').replace('file://', ''),
          } : null,
          line: (f.location?.lineNumber ?? 0) + 1, // CDP uses 0-based
          column: (f.location?.columnNumber ?? 0) + 1,
          _scopeChain: f.scopeChain,
        })),
      };
    } else {
      // DAP stackTrace
      const result = await s.send('stackTrace', { threadId: s._threadId || 1 });
      return {
        success: true,
        stackFrames: (result.stackFrames || []).map(f => ({
          id: f.id,
          name: f.name,
          source: f.source ? { name: f.source.name, path: f.source.path } : null,
          line: f.line,
          column: f.column,
        })),
      };
    }
  }

  async getScopes(sessionId, frameId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };

    if (s.type === 'node') {
      // Get scope chain from cached call frames
      const frames = s._pauseParams?.callFrames || [];
      const frame = frames[frameId];
      if (!frame) return { success: true, scopes: [] };

      const scopes = (frame.scopeChain || []).map((sc, i) => ({
        name: sc.type === 'local' ? 'Local' : sc.type === 'closure' ? 'Closure' : sc.type === 'global' ? 'Global' : sc.type,
        variablesReference: sc.object?.objectId || `scope_${i}`,
        expensive: sc.type === 'global',
        _objectId: sc.object?.objectId,
      }));

      // Cache the scope objects for variable fetching
      if (!s._scopeObjects) s._scopeObjects = {};
      scopes.forEach(sc => {
        if (sc._objectId) s._scopeObjects[sc.variablesReference] = sc._objectId;
      });

      return { success: true, scopes };
    } else {
      // DAP scopes
      const result = await s.send('scopes', { frameId });
      return {
        success: true,
        scopes: (result.scopes || []).map(sc => ({
          name: sc.name,
          variablesReference: sc.variablesReference,
          expensive: sc.expensive || false,
        })),
      };
    }
  }

  async getVariables(sessionId, variablesReference) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };

    if (s.type === 'node') {
      // CDP: get properties of the scope object
      const objectId = s._scopeObjects?.[variablesReference] || variablesReference;
      if (!objectId || typeof objectId !== 'string') {
        return { success: true, variables: [] };
      }

      const result = await s.send('Runtime.getProperties', {
        objectId,
        ownProperties: true,
        generatePreview: true,
      });

      const variables = (result.result || [])
        .filter(p => !p.name.startsWith('__'))
        .map(p => ({
          name: p.name,
          value: p.value?.description || p.value?.value?.toString() || p.value?.type || 'undefined',
          type: p.value?.type || 'unknown',
          variablesReference: p.value?.objectId || 0,
        }));

      // Cache object IDs for expandable variables
      variables.forEach(v => {
        if (v.variablesReference && typeof v.variablesReference === 'string') {
          if (!s._scopeObjects) s._scopeObjects = {};
          s._scopeObjects[v.variablesReference] = v.variablesReference;
        }
      });

      return { success: true, variables };
    } else {
      // DAP variables
      const result = await s.send('variables', { variablesReference });
      return {
        success: true,
        variables: (result.variables || []).map(v => ({
          name: v.name,
          value: v.value,
          type: v.type || 'unknown',
          variablesReference: v.variablesReference || 0,
        })),
      };
    }
  }

  async evaluate(sessionId, expression, frameId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };

    try {
      if (s.type === 'node') {
        // CDP: evaluate on the specific call frame
        const frames = s._pauseParams?.callFrames || [];
        const frame = frames[frameId ?? 0];
        let result;
        if (frame) {
          result = await s.send('Debugger.evaluateOnCallFrame', {
            callFrameId: frame.callFrameId,
            expression,
            returnByValue: true,
          });
        } else {
          result = await s.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
          });
        }
        return {
          success: true,
          result: result.result?.description || result.result?.value?.toString() || 'undefined',
        };
      } else {
        // DAP evaluate
        const result = await s.send('evaluate', {
          expression,
          frameId,
          context: 'watch',
        });
        return { success: true, result: result.result || 'undefined' };
      }
    } catch (err) {
      return { success: true, result: `Error: ${err.message}` };
    }
  }

  async setBreakpoints(sessionId, filePath, breakpoints) {
    const s = this.sessions.get(sessionId);
    if (!s) return { success: false, error: 'Session not found' };

    if (s.type === 'node') {
      // CDP: set breakpoints by URL
      const url = filePath.startsWith('/') ? `file://${filePath}` : `file:///${filePath.replace(/\\/g, '/')}`;
      // Remove existing breakpoints for this file first (simplification — set all at once)
      for (const bp of breakpoints) {
        await s.send('Debugger.setBreakpointByUrl', {
          lineNumber: bp.line - 1, // CDP uses 0-based
          url,
        });
      }
      return { success: true };
    } else {
      // DAP set breakpoints
      await s.send('setBreakpoints', {
        source: { path: filePath },
        breakpoints: breakpoints.map(bp => ({ line: bp.line })),
      });
      return { success: true };
    }
  }

  /* ── Utilities ──────────────────────────────────────────────────── */

  _emit(sessionId, event, data = {}) {
    this.emit('debug-event', { sessionId, event, ...data });
  }

  _findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      type: s.type,
      state: s.state,
    }));
  }

  async dispose() {
    for (const [id] of this.sessions) {
      await this.stop(id);
    }
  }
}

module.exports = { DebugService };
