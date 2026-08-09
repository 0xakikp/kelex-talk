// Hermes Gateway JSON-RPC 2.0 WebSocket client.
// Mirrors the official `apps/shared/src/json-rpc-gateway.ts` protocol
// but in plain ES module JavaScript for kelex's vanilla frontend.
//
// Protocol:
//   Send:    { jsonrpc: "2.0", id: "r1", method: "...", params: {...} }
//   Receive: { jsonrpc: "2.0", id: "r1", result: {...} }
//   Event:   { method: "event", params: { type: "message.delta", payload: {...} } }
//
// Auth is HTTP Basic Auth passed via the WebSocket URL:
//   wss://user:pass@host/rpc
// or via a custom header if the gateway supports it.

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export class HermesClient {
  constructor() {
    this._socket = null;
    this._state = 'idle'; // idle | connecting | open | closed | error
    this._nextId = 0;
    this._pending = new Map();
    this._handlers = new Map(); // eventType -> Set<fn>
    this._stateHandlers = new Set();
    this._url = '';
  }

  get state() { return this._state; }

  // ── Connection ──────────────────────────────────────────────────────

  connect(gatewayUrl) {
    // Accept https://host or wss://host — convert to WS URL + /rpc path.
    let url = gatewayUrl.replace(/\/+$/, '');
    if (url.startsWith('https://')) {
      url = 'wss://' + url.slice(8);
    } else if (url.startsWith('http://')) {
      url = 'ws://' + url.slice(7);
    } else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'wss://' + url;
    }
    if (!url.endsWith('/rpc')) {
      url += '/rpc';
    }
    this._url = url;

    if (this._socket?.readyState === WebSocket.OPEN || this._state === 'connecting') {
      return;
    }

    this._setState('connecting');

    const socket = new WebSocket(url);
    this._socket = socket;

    socket.addEventListener('message', (e) => this._onMessage(e.data));
    socket.addEventListener('close', () => {
      this._socket = null;
      this._setState('closed');
      this._rejectAll(new Error('WebSocket closed'));
    });
    socket.addEventListener('error', () => {
      this._socket = null;
      this._setState('error');
      this._rejectAll(new Error('WebSocket connection failed'));
    });

    return new Promise((resolve, reject) => {
      let settled = false;

      const onOpen = () => {
        if (settled) return;
        settled = true;
        socket.removeEventListener('error', onError);
        this._setState('open');
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        socket.removeEventListener('open', onOpen);
        this._setState('error');
        reject(new Error('WebSocket connection failed'));
      };

      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
  }

  disconnect() {
    if (!this._socket) return;
    try { this._socket.close(); } catch (_) {}
    this._socket = null;
    this._setState('closed');
    this._rejectAll(new Error('Disconnected'));
  }

  // ── RPC ─────────────────────────────────────────────────────────────

  /**
   * Call a gateway RPC method.
   * Returns a Promise that resolves with the result.
   */
  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const socket = this._socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Gateway not connected'));
    }

    const id = 'r' + (++this._nextId);
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this._pending.delete(id);
            reject(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${method}`));
          }, timeoutMs)
        : null;

      this._pending.set(id, { resolve, reject, timer });

      try {
        socket.send(payload);
      } catch (e) {
        this._clearPending(id);
        reject(e);
      }
    });
  }

  // ── Events ──────────────────────────────────────────────────────────

  /**
   * Subscribe to a gateway event type.
   * Supported events: message.delta, message.complete, message.start,
   *   thinking.delta, thinking.available, status.update,
   *   tool.start, tool.progress, tool.complete,
   *   clarify.request, approval.request, error,
   *   session.info, gateway.ready
   * Returns an unsubscribe function.
   */
  on(eventType, handler) {
    let set = this._handlers.get(eventType);
    if (!set) {
      set = new Set();
      this._handlers.set(eventType, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Subscribe to ALL gateway events. */
  onAny(handler) {
    return this.on('*', handler);
  }

  onState(handler) {
    this._stateHandlers.add(handler);
    handler(this._state); // fire immediately with current state
    return () => this._stateHandlers.delete(handler);
  }

  // ── Convenience wrappers ────────────────────────────────────────────

  /** Send a chat message. Returns a Promise of the full result. */
  async chat(message, sessionId) {
    return this.request('chat.send', { message, session_id: sessionId || null });
  }

  /** Create a new session. */
  async createSession(profile) {
    return this.request('session.create', { profile });
  }

  /** List available sessions. */
  async listSessions() {
    return this.request('session.list');
  }

  /** Get the active session info. */
  async sessionInfo() {
    return this.request('session.info');
  }

  // ── Internal ────────────────────────────────────────────────────────

  _onMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch { return; }

    // Response to a pending request
    if (frame.id !== undefined && frame.id !== null) {
      const call = this._pending.get(frame.id);
      if (!call) return;
      this._clearPending(frame.id);
      if (frame.error) {
        call.reject(new Error(frame.error.message || 'Hermes RPC failed'));
      } else {
        call.resolve(frame.result);
      }
      return;
    }

    // Server-pushed event
    if (frame.method === 'event' && frame.params?.type) {
      const evt = frame.params;
      // Dispatch to specific handlers
      const specific = this._handlers.get(evt.type);
      if (specific) {
        for (const fn of specific) fn(evt);
      }
      // Dispatch to wildcard handlers
      const wild = this._handlers.get('*');
      if (wild) {
        for (const fn of wild) fn(evt);
      }
    }
  }

  _clearPending(id) {
    const call = this._pending.get(id);
    if (call?.timer) clearTimeout(call.timer);
    this._pending.delete(id);
  }

  _rejectAll(err) {
    for (const [id, call] of this._pending) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(err);
      this._pending.delete(id);
    }
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    for (const fn of this._stateHandlers) fn(state);
  }
}

// Singleton — one client per app instance.
export const hermes = new HermesClient();
