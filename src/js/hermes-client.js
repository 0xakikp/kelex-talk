// Hermes Gateway JSON-RPC 2.0 WebSocket client with automatic login.
//
// The Hermes backend requires session-cookie auth for /api/ws.
// This client:
//  1. POSTs to /login with username:password to get a session cookie
//  2. Uses the cookie for WebSocket connection
//  3. Reuses the cookie across reconnects

const DEFAULT_TIMEOUT_MS = 120_000;

export class HermesClient {
  constructor() {
    this._socket = null;
    this._state = 'idle'; // idle | connecting | open | closed | error
    this._nextId = 0;
    this._pending = new Map();
    this._handlers = new Map();
    this._stateHandlers = new Set();
    this._sessionCookie = null;
    this._baseUrl = '';
  }

  get state() { return this._state; }

  // ── Login ─────────────────────────────────────────────────────────────

  /**
   * Authenticate with the Hermes backend and get a session cookie.
   * POSTs to /login with JSON {username, password}.
   * Returns true on success.
   */
  async login(gatewayUrl, username, password) {
    const base = gatewayUrl.replace(/\/+$/, '');
    this._baseUrl = base;

    try {
      // The Hermes dashboard login endpoint: POST /auth/password-login
      const resp = await fetch(`${base}/auth/password-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider: 'basic',
          username,
          password,
          next: '',
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        const msg = resp.status === 401 ? 'Invalid credentials' 
                 : `Login failed (${resp.status}): ${body.slice(0, 100)}`;
        throw new Error(msg);
      }

      // On success, the backend sets a session cookie.
      // Since we used credentials: 'include', the browser should store it
      // and include it in subsequent requests (including WebSocket).
      const data = await resp.json().catch(() => ({}));
      console.log('[hermes] Login successful, session established');
      return true;
    } catch (e) {
      console.error('[hermes] Login error:', e.message);
      throw e;
    }
  }

  // ── Connection ──────────────────────────────────────────────────────

  connect(wsUrl) {
    this._url = wsUrl;

    if (this._socket?.readyState === WebSocket.OPEN || this._state === 'connecting') {
      return;
    }

    this._setState('connecting');

    const socket = new WebSocket(wsUrl);
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
            reject(new Error(`Request timed out: ${method}`));
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

  on(eventType, handler) {
    let set = this._handlers.get(eventType);
    if (!set) {
      set = new Set();
      this._handlers.set(eventType, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  onAny(handler) {
    return this.on('*', handler);
  }

  onState(handler) {
    this._stateHandlers.add(handler);
    handler(this._state);
    return () => this._stateHandlers.delete(handler);
  }

  // ── Convenience ──────────────────────────────────────────────────────

  async chat(message, sessionId) {
    return this.request('chat.send', { message, session_id: sessionId || null });
  }

  // ── Internal ────────────────────────────────────────────────────────

  _onMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch { return; }

    if (frame.id !== undefined && frame.id !== null) {
      const call = this._pending.get(frame.id);
      if (!call) return;
      this._clearPending(frame.id);
      if (frame.error) {
        call.reject(new Error(frame.error.message || 'RPC failed'));
      } else {
        call.resolve(frame.result);
      }
      return;
    }

    if (frame.method === 'event' && frame.params?.type) {
      const evt = frame.params;
      const specific = this._handlers.get(evt.type);
      if (specific) for (const fn of specific) fn(evt);
      const wild = this._handlers.get('*');
      if (wild) for (const fn of wild) fn(evt);
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

export const hermes = new HermesClient();
