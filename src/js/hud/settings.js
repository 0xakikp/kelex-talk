// Settings panel — configure Hermes Gateway connection + app prefs.
// Persisted via Rust get_settings/set_settings. Saving triggers a
// reconnect to the new gateway URL if it changed.

import { getSettings, setSettings, getAutostart, setAutostart, setWake, gatewayUrl } from '../config.js';

const els = {};
let onSaved = () => {};

function $(id) { return document.getElementById(id); }

export async function openSettings() {
    const s = await getSettings();
    els.gatewayUrl.value = s.gateway_url || '';
    els.username.value = s.username || '';
    els.password.value = ''; // never echo the stored hash
    els.hotkey.value = s.hotkey || '';
    els.autostart.checked = await getAutostart();
    els.wake.checked = !!s.wake_enabled;
    setStatus('');
    els.overlay.classList.add('visible');
    setTimeout(() => els.gatewayUrl.focus(), 30);
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
    const pwd = els.password.value.trim();

    const next = {
        gateway_url: els.gatewayUrl.value.trim(),
        username: els.username.value.trim(),
        // Only update password if the user typed something new.
        // Blank means "keep the existing one".
        password_hash: pwd || prev.password_hash,
        hotkey: els.hotkey.value.trim() || 'CmdOrCtrl+Shift+J',
        windowed: prev.windowed,
        wake_enabled: prev.wake_enabled,
    };

    if (!next.gateway_url) {
        setStatus('Gateway URL is required', 'error');
        return;
    }

    setStatus('Saving…');
    try {
        await setSettings(next);
        await setAutostart(els.autostart.checked);
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
    els.gatewayUrl = $('setGatewayUrl');
    els.username = $('setUsername');
    els.password = $('setPassword');
    els.hotkey = $('setHotkey');
    els.autostart = $('setAutostart');
    els.wake = $('setWake');
    els.status = $('settingsStatus');

    $('btnSettingsSave').onclick = save;
    $('btnSettingsCancel').onclick = closeSettings;
    $('btnSettingsGear').onclick = openSettings;

    els.overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closeSettings(); }
    });
}
