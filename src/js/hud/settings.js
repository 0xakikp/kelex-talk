// Settings panel — edit backend URL / token / global hotkey + autostart.
// Backed by the Rust get_settings/set_settings/get_autostart/set_autostart
// commands. Saving re-registers the global hotkey live (Rust side) and the
// host app reconnects the voice WS if the backend URL changed.

import { getSettings, setSettings, getAutostart, setAutostart, setWake } from '../config.js';

const els = {};
let onSaved = () => {};

function $(id) { return document.getElementById(id); }

export async function openSettings() {
    const s = await getSettings();
    els.backendUrl.value = s.backend_url || '';
    els.token.value = s.token || '';
    els.hotkey.value = s.hotkey || '';
    els.autostart.checked = await getAutostart();
    els.wake.checked = !!s.wake_enabled;
    setStatus('');
    els.overlay.classList.add('visible');
    setTimeout(() => els.backendUrl.focus(), 30);
}

export function closeSettings() {
    els.overlay.classList.remove('visible');
}

export function isSettingsOpen() {
    return els.overlay.classList.contains('visible');
}

function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = `settings-status ${cls || ''}`.trim();
}

async function save() {
    const prev = await getSettings();
    const next = {
        backend_url: els.backendUrl.value.trim() || 'http://localhost:7777',
        token: els.token.value,
        hotkey: els.hotkey.value.trim() || 'CmdOrCtrl+Shift+J',
        windowed: prev.windowed,          // preserve the remembered mode
        wake_enabled: prev.wake_enabled,  // preserve; setWake() owns changes
    };
    setStatus('Saving…');
    try {
        await setSettings(next);
        await setAutostart(els.autostart.checked);
        // Wake word start/stop is a side-effecting toggle — only fire on change.
        if (els.wake.checked !== prev.wake_enabled) await setWake(els.wake.checked);
        setStatus('Saved ✓', 'ok');
        onSaved(prev, next);
        setTimeout(closeSettings, 700);
    } catch (e) {
        setStatus(`Error: ${e}`, 'error');
    }
}

export function initSettings(hooks = {}) {
    onSaved = hooks.onSaved || onSaved;
    els.overlay = $('settingsOverlay');
    els.backendUrl = $('setBackendUrl');
    els.token = $('setToken');
    els.hotkey = $('setHotkey');
    els.autostart = $('setAutostart');
    els.wake = $('setWake');
    els.status = $('settingsStatus');

    $('btnSettingsSave').onclick = save;
    $('btnSettingsCancel').onclick = closeSettings;
    $('btnSettingsGear').onclick = openSettings;

    // Esc closes the panel when it's open.
    els.overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closeSettings(); }
    });
}
