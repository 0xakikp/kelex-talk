// Bridge to the Rust shell. Centralizes every call into Tauri so the rest
// of the frontend never touches window.__TAURI__ directly. HTTP to the kelex
// backend is proxied through Rust commands (CORS-free); see src-tauri/lib.rs.

const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke;

if (!invoke) {
    console.error('[config] window.__TAURI__ unavailable — running outside Tauri?');
}

// ── Settings (backend URL / token / hotkey) ─────────────────────────────
let _settings = null;

export async function getSettings() {
    return invoke('get_settings');
}
export async function setSettings(settings) {
    _settings = settings;
    return invoke('set_settings', { settings });
}
// Load once at startup and cache so sync helpers (voiceWsUrl) can build URLs.
export async function loadSettings() {
    _settings = await getSettings();
    return _settings;
}
export function backendUrl() {
    return (_settings && _settings.backend_url) || 'http://localhost:7777';
}
// ws://host:port/ws/voice derived from the configured backend URL.
export function voiceWsUrl() {
    const base = backendUrl().replace(/^http/i, 'ws').replace(/\/+$/, '');
    return base + '/ws/voice';
}

// Current window mode (true = decorated/opaque windowed, false = orb).
export async function isWindowed() {
    try { return await invoke('is_windowed'); } catch { return false; }
}

// Autostart-at-login.
export async function getAutostart() {
    try { return await invoke('get_autostart'); } catch { return false; }
}
export async function setAutostart(enabled) {
    return invoke('set_autostart', { enabled });
}

// Native OS notification (used for proactive kelex alerts).
export async function notify(title, body) {
    try { return await invoke('notify', { title, body }); } catch (e) { console.warn('[notify]', e); }
}

// Always-on wake word (Rust/cpal).
export async function setWake(enabled) {
    return invoke('set_wake', { enabled });
}
export async function wakePause() {
    try { await invoke('wake_pause'); } catch (_) {}
}
export async function wakeResume() {
    try { await invoke('wake_resume'); } catch (_) {}
}

// ── Backend calls (proxied through Rust) ────────────────────────────────
export async function health() {
    try { return await invoke('health'); } catch { return false; }
}

// POST /api/chat -> { reply, actions }
export async function chat(message) {
    return invoke('chat', { message, session: sessionId() });
}

// ── Session id ──────────────────────────────────────────────────────────
// Stable per-install id so the backend keeps conversation context across
// app restarts. The legacy HUD used "__default__"; we namespace the desktop
// client so it doesn't collide with browser sessions.
export function sessionId() {
    let id = localStorage.getItem('kelex_session');
    if (!id) {
        id = 'desktop-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('kelex_session', id);
    }
    return id;
}
