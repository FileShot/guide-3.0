/**
 * WebSocket Client — Connects to the guIDE backend server.
 *
 * Handles:
 *   - Connection lifecycle (connect, reconnect, disconnect)
 *   - Invoking IPC handlers (request/response pattern)
 *   - Receiving streaming events (tokens, tool progress, etc.)
 *   - Routing events to the Zustand store
 */

let _ws = null;
let _pendingInvokes = new Map();
let _reconnectTimer = null;
let _reconnectAttempt = 0;
let _eventHandler = null;
let _connectionHandler = null;

const MAX_RECONNECT_DELAY = 10000;
const BASE_RECONNECT_DELAY = 1000;

/**
 * Connect to the WebSocket server.
 * @param {Function} onEvent — Called for every server-pushed event: (eventName, data) => void
 * @param {Function} onConnection — Called on connect/disconnect: (connected) => void
 */
export function connect(onEvent, onConnection) {
  _eventHandler = onEvent;
  _connectionHandler = onConnection;
  _doConnect();
}

function _doConnect() {
  if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const url = `${protocol}//${host}/ws`;

  try {
    _ws = new WebSocket(url);
  } catch (e) {
    console.error('[WS] Connection error:', e.message);
    _scheduleReconnect();
    return;
  }

  _ws.onopen = () => {
    console.log('[WS] Connected to', url);
    _reconnectAttempt = 0;
    if (_connectionHandler) _connectionHandler(true);
  };

  _ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.warn('[WS] Invalid message:', event.data?.substring(0, 200));
      return;
    }

    if (msg.type === 'response') {
      // Response to an invoke() call
      const pending = _pendingInvokes.get(msg.id);
      if (pending) {
        _pendingInvokes.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.type === 'event') {
      // Server-pushed event (streaming tokens, status updates, etc.)
      if (_eventHandler) {
        _eventHandler(msg.event, msg.data);
      }
    } else if (msg.type === 'pong') {
      // Heartbeat response — ignore
    }
  };

  _ws.onclose = (event) => {
    console.log(`[WS] Disconnected (code=${event.code})`);
    if (_connectionHandler) _connectionHandler(false);

    // Reject all pending invokes
    for (const [id, pending] of _pendingInvokes) {
      pending.reject(new Error('WebSocket disconnected'));
    }
    _pendingInvokes.clear();

    _scheduleReconnect();
  };

  _ws.onerror = (error) => {
    console.error('[WS] Error:', error);
  };
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, _reconnectAttempt), MAX_RECONNECT_DELAY);
  _reconnectAttempt++;
  console.log(`[WS] Reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _doConnect();
  }, delay);
}

/**
 * Invoke an IPC handler on the server and wait for the response.
 * This is the equivalent of Electron's ipcRenderer.invoke().
 *
 * @param {string} channel — IPC channel name (e.g. 'ai-chat')
 * @param  {...any} args — Arguments to pass to the handler
 * @returns {Promise<any>} — The handler's return value
 */
export function invoke(channel, ...args) {
  return new Promise((resolve, reject) => {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) {
      console.error(`[WS] invoke('${channel}') — WebSocket not connected (readyState=${_ws?.readyState})`);
      reject(new Error('WebSocket not connected'));
      return;
    }
    console.log(`[WS] invoke('${channel}') — sending`);

    const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    _pendingInvokes.set(id, { resolve, reject });

    try {
      _ws.send(JSON.stringify({ type: 'invoke', id, channel, args }));
    } catch (e) {
      _pendingInvokes.delete(id);
      reject(e);
    }
  });
}

/**
 * Send a fire-and-forget message to the server.
 * @param {string} channel
 * @param  {...any} args
 */
export function send(channel, ...args) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  try {
    _ws.send(JSON.stringify({ type: 'send', channel, args }));
  } catch (_) {}
}

/**
 * Check if the WebSocket is connected.
 */
export function isConnected() {
  return _ws && _ws.readyState === WebSocket.OPEN;
}

/**
 * Disconnect and stop reconnecting.
 */
export function disconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_ws) {
    _ws.onclose = null; // Prevent reconnect
    _ws.close();
    _ws = null;
  }
}
