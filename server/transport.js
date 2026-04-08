/**
 * WebSocket Transport — Manages WebSocket connections between the Node.js
 * backend and frontend clients (browser or Tauri webview).
 *
 * Responsibilities:
 *   1. Accept WebSocket connections from frontend clients
 *   2. Route incoming messages to the IPC bridge (invoke handlers)
 *   3. Route outgoing events from the pipeline to connected clients
 *   4. Handle connection lifecycle (connect, disconnect, reconnect)
 *   5. Message serialization/deserialization
 *
 * Protocol:
 *   Client → Server:
 *     { type: 'invoke', id: 'uuid', channel: 'ai-chat', args: [...] }
 *     { type: 'send', channel: 'some-event', args: [...] }
 *
 *   Server → Client:
 *     { type: 'response', id: 'uuid', result: {...}, error: null }
 *     { type: 'event', event: 'llm-token', data: '...' }
 *     { type: 'error', id: 'uuid', error: 'message' }
 */
'use strict';

const WebSocket = require('ws');

class Transport {
  /**
   * @param {object} options
   * @param {object} options.ipcMain — IpcMainBridge instance
   * @param {object} options.mainWindow — MainWindowBridge instance
   * @param {object} options.server — HTTP server to attach WebSocket to
   */
  constructor(options) {
    this._ipcMain = options.ipcMain;
    this._mainWindow = options.mainWindow;
    this._httpServer = options.server;
    this._wss = null;
    this._clients = new Set();
    this._activeClient = null;
  }

  /**
   * Start the WebSocket server.
   */
  start() {
    // Use noServer mode so we don't register an automatic upgrade handler
    // that would reject non-matching paths (like /ws/terminal) with HTTP 400.
    // Upgrade routing is handled centrally in server/main.js.
    this._wss = new WebSocket.Server({
      noServer: true,
      maxPayload: 50 * 1024 * 1024, // 50MB — large tool results, file contents
    });

    this._wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      console.log(`[Transport] Client connected from ${clientIp}`);

      this._clients.add(ws);
      this._activeClient = ws;

      // Wire the MainWindowBridge to send events to this client
      this._mainWindow.setSender((event, data) => {
        this._sendToClient(ws, { type: 'event', event, data });
      });

      ws.on('message', (raw) => {
        this._handleMessage(ws, raw);
      });

      ws.on('close', (code, reason) => {
        console.log(`[Transport] Client disconnected (code=${code})`);
        this._clients.delete(ws);
        if (this._activeClient === ws) {
          this._activeClient = null;
          this._mainWindow.clearSender();

          // If another client is connected, make it active
          for (const client of this._clients) {
            if (client.readyState === WebSocket.OPEN) {
              this._activeClient = client;
              this._mainWindow.setSender((event, data) => {
                this._sendToClient(client, { type: 'event', event, data });
              });
              break;
            }
          }
        }
      });

      ws.on('error', (err) => {
        console.error(`[Transport] WebSocket error: ${err.message}`);
      });

      // Send initial connection acknowledgment
      this._sendToClient(ws, {
        type: 'event',
        event: 'connection-ready',
        data: { timestamp: Date.now() },
      });
    });

    this._wss.on('error', (err) => {
      console.error(`[Transport] WebSocket server error: ${err.message}`);
    });

    console.log('[Transport] WebSocket server started on /ws');
  }

  /**
   * Handle an incoming WebSocket message from a client.
   */
  async _handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      this._sendToClient(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'invoke') {
      // Invoke an IPC handler and return the result
      const { id, channel, args } = msg;
      console.log(`[Transport] Invoke: channel='${channel}', id=${id}, argsLen=${JSON.stringify(args || []).length}`);
      try {
        const result = await this._ipcMain.invoke(channel, ...(args || []));
        console.log(`[Transport] Invoke '${channel}' completed, sending response`);
        this._sendToClient(ws, { type: 'response', id, result, error: null });
      } catch (err) {
        console.error(`[Transport] Handler error for '${channel}':`, err.message);
        this._sendToClient(ws, { type: 'response', id, result: null, error: err.message });
      }
    } else if (msg.type === 'send') {
      // Fire-and-forget message to ipcMain.on() listeners
      const { channel, args } = msg;
      this._ipcMain.send(channel, ...(args || []));
    } else if (msg.type === 'ping') {
      this._sendToClient(ws, { type: 'pong', timestamp: Date.now() });
    } else {
      console.warn(`[Transport] Unknown message type: ${msg.type}`);
    }
  }

  /**
   * Send a message to a specific WebSocket client.
   * Handles serialization and closed-connection safety.
   */
  _sendToClient(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const payload = JSON.stringify(message);
      ws.send(payload);
    } catch (e) {
      // Serialization errors for large payloads — try truncated
      if (e.message?.includes('circular') || e.message?.includes('Converting')) {
        try {
          const truncated = JSON.stringify({
            ...message,
            data: typeof message.data === 'string'
              ? message.data.substring(0, 100000)
              : '[truncated — too large to serialize]',
          });
          ws.send(truncated);
        } catch (_) {
          console.error(`[Transport] Failed to send message: ${e.message}`);
        }
      }
    }
  }

  /**
   * Broadcast an event to ALL connected clients.
   */
  broadcast(event, data) {
    const message = { type: 'event', event, data };
    for (const ws of this._clients) {
      this._sendToClient(ws, message);
    }
  }

  /**
   * Get the number of connected clients.
   */
  getClientCount() {
    return this._clients.size;
  }

  /**
   * Check if any client is connected.
   */
  hasClients() {
    return this._clients.size > 0;
  }

  /**
   * Handle an HTTP upgrade request for the /ws path.
   * Called from the centralized upgrade handler in server/main.js.
   */
  handleUpgrade(request, socket, head) {
    this._wss.handleUpgrade(request, socket, head, (ws) => {
      this._wss.emit('connection', ws, request);
    });
  }

  /**
   * Shutdown the WebSocket server.
   */
  shutdown() {
    if (this._wss) {
      for (const ws of this._clients) {
        try { ws.close(1000, 'Server shutting down'); } catch (_) {}
      }
      this._clients.clear();
      this._wss.close();
      this._wss = null;
    }
  }
}

module.exports = { Transport };
