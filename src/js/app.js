// Kelex — Hermes Agent Desktop Client.
//
// Rust proxy handles login + WS ticket → seamless connection.

import { loadSettings, isWindowed, gatewayUrl, gatewayAuth, startProxy } from './config.js';
import { hermes } from './hermes-client.js';
import { initUI, setState, showResponse, setUplink, showAction, clearAction } from './hud/ui.js';
import { state } from './hud/state.js';
import { toggleConversation } from './hud/mic.js';
import { interruptResponse } from './hud/tts.js';
import { initTextChat, toggleTextChat, closeTextChat, isTextChatOpen } from './hud/text-chat.js';
import { initSettings, openSettings, closeSettings, isSettingsOpen } from './hud/settings.js';

const clockEl = document.getElementById('clock');
const reactorCore = document.getElementById('reactorCore');
initUI();

let reconnectTimer = null;

async function connectGateway() {
    const gw = gatewayUrl();
    const auth = gatewayAuth();
    if (!gw) { setUplink('offline', 'No gateway configured'); return; }
    if (!auth.username || !auth.password) { setUplink('offline', 'Set username & password in Settings'); return; }

    try {
        setUplink('connecting', 'logging in…');
        const localUrl = await startProxy();
        setUplink('connecting', 'connecting…');
        await hermes.connect(localUrl);
        setUplink('online', 'online');
        document.getElementById('response').textContent = 'Neural link online, sir.';
    } catch (e) {
        const msg = typeof e === 'string' ? e : (e.message || String(e));
        setUplink('offline', `offline — ${msg}`);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectGateway, 5000);
    }
}

async function reconnectGateway() { hermes.disconnect(); if (reconnectTimer) clearTimeout(reconnectTimer); await connectGateway(); }

hermes.onState((s) => { if (s === 'closed' || s === 'error') { setUplink('offline', 'reconnecting…'); reconnectTimer = setTimeout(connectGateway, 3000); } });

hermes.onAny((evt) => {
    switch (evt.type) {
        case 'thinking.delta': showAction('THINKING…'); break;
        case 'message.delta': showAction('TYPING…'); break;
        case 'tool.start': showAction((evt.payload?.tool || evt.payload?.name || 'tool').toUpperCase()); break;
        case 'tool.complete': case 'message.complete': case 'message.interim': clearAction(); break;
    }
});

let chatRevert = null;
initTextChat({
    onState: (s) => { if (!state.conversationActive) { if (s === 'processing') setState('processing'); else if (s === 'standby') { setState('speaking'); clearTimeout(chatRevert); chatRevert = setTimeout(() => setState('standby'), 1600); } } },
    onReply: (reply) => { if (reply) showResponse(reply); },
});

reactorCore.addEventListener('click', () => { if (!isTextChatOpen() && !isSettingsOpen()) toggleConversation(); });

initSettings({ onSaved: async () => { await loadSettings(); reconnectGateway(); } });

document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyK' && (e.ctrlKey || e.metaKey) && !e.repeat) { e.preventDefault(); toggleTextChat(); return; }
    if (e.code === 'Comma' && (e.ctrlKey || e.metaKey) && !e.repeat) { e.preventDefault(); isSettingsOpen() ? closeSettings() : openSettings(); return; }
    if (e.key === 'Escape') { if (isSettingsOpen()) { closeSettings(); return; } if (isTextChatOpen()) { closeTextChat(); return; } if (state.isSpeaking || state.isProcessing) interruptResponse(); }
});

function tickClock() { clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
setInterval(tickClock, 1000); tickClock();

const TAURI = window.__TAURI__;
if (TAURI?.event?.listen) {
    TAURI.event.listen('summon', () => { if (!state.conversationActive) toggleConversation(); });
    TAURI.event.listen('mode', (e) => document.body.classList.toggle('windowed', e.payload === 'window'));
    TAURI.event.listen('open-settings', () => openSettings());
}

(async () => {
    await loadSettings();
    document.body.classList.toggle('windowed', await isWindowed());
    setState('standby');
    const rl = document.getElementById('responseSettingsLink');
    if (rl) rl.onclick = (e) => { e.preventDefault(); openSettings(); };
    if (gatewayUrl()) await connectGateway();
    else setUplink('offline', 'No gateway configured');
    console.log('[kelex] Online');
})();
