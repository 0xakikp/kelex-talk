// Bridge to the Rust shell. Centralizes every call into Tauri so the rest
// of the frontend never touches window.__TAURI__ directly.
//
// Hermes Gateway settings are persisted via Rust (settings.json) and the
// WebSocket connection is made directly from the webview (no Rust proxy
// needed — Hermes Gateway ships proper CORS/WS support).

const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke;

if (!invoke) {
    console.error('[config] window.__TAURI__ unavailable — running outside Tauri?');
}

// ── Settings (Hermes Gateway) ─────────────────────────────────────────

let _settings = null;

export async function getSettings() {
    return invoke('get_settings');
}

export async function setSettings(settings) {
    _settings = settings;
    return invoke('set_settings', { settings });
}

/** Load once at startup and cache. */
export async function loadSettings() {
    _settings = await getSettings();
    return _settings;
}

/** Hermes Gateway backend URL (e.g. https://hermes-gateway.akikp.in). */
export function gatewayUrl() {
    return (_settings && _settings.gateway_url) || '';
}

/** Basic auth credentials for gateway. */
export function gatewayAuth() {
    return {
        username: (_settings && _settings.username) || '',
        password: (_settings && _settings.password_hash) || '',
    };
}

/** Full WebSocket URL with embedded basic auth. */
export function gatewayWsUrl() {
    const u = gatewayUrl();
    if (!u) return '';
    const auth = gatewayAuth();
    let base = u.replace(/\/+$/, '');
    // Build wss://user:pass@host/rpc
    let wsBase;
    if (base.startsWith('https://')) {
        wsBase = 'wss://' + base.slice(8);
    } else if (base.startsWith('http://')) {
        wsBase = 'ws://' + base.slice(7);
    } else {
        wsBase = 'wss://' + base;
    }
    if (auth.username && auth.password) {
        const host = wsBase.replace(/^wss?:\/\//, '');
        return 'wss://' + encodeURIComponent(auth.username) + ':' + encodeURIComponent(auth.password) + '@' + host + '/rpc';
    }
    return wsBase + '/rpc';
}

// ── Window mode ───────────────────────────────────────────────────────

export async function isWindowed() {
    try { return await invoke('is_windowed'); } catch { return false; }
}

// ── Autostart ─────────────────────────────────────────────────────────

export async function getAutostart() {
    try { return await invoke('get_autostart'); } catch { return false; }
}
export async function setAutostart(enabled) {
    return invoke('set_autostart', { enabled });
}

// ── Notifications ─────────────────────────────────────────────────────

export async function notify(title, body) {
    try { return await invoke('notify', { title, body }); } catch (e) { console.warn('[notify]', e); }
}

// ── Wake word ─────────────────────────────────────────────────────────

export async function setWake(enabled) {
    return invoke('set_wake', { enabled });
}
export async function wakePause() {
    try { await invoke('wake_pause'); } catch (_) {}
}
export async function wakeResume() {
    try { await invoke('wake_resume'); } catch (_) {}
}

// ── Session id ────────────────────────────────────────────────────────

export function sessionId() {
    let id = localStorage.getItem('kelex_session');
    if (!id) {
        id = 'kelex-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('kelex_session', id);
    }
    return id;
}
