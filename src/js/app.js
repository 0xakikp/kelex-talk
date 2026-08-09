// Kelex — Hermes Agent Desktop Client.
//
// Tauri v2 orb app that connects to a Hermes Gateway backend.
// Ctrl/Cmd+K = text chat (Hermes JSON-RPC WebSocket).
// Esc = interrupt / close panels.
// Orb click placeholder (voice mode disabled until Phase 2).

import { loadSettings, isWindowed, gatewayWsUrl } from './config.js';
import { hermes } from './hermes-client.js';
import { initUI, setState, showResponse, setUplink } from './hud/ui.js';
import { state } from './hud/state.js';
import { initTextChat, toggleTextChat, closeTextChat, isTextChatOpen } from './hud/text-chat.js';
import { initSettings, openSettings, closeSettings, isSettingsOpen } from './hud/settings.js';

const clockEl = document.getElementById('clock');
const reactorCore = document.getElementById('reactorCore');

initUI();

// ── Hermes Gateway connection ─────────────────────────────────────────

let reconnectTimer = null;

async function connectGateway() {
    const url = gatewayWsUrl();
    if (!url) {
        setUplink('offline', 'No gateway configured — open Settings');
        return;
    }
    setUplink('connecting', 'connecting…');

    try {
        await hermes.connect(url);
        // Connected
        setUplink('online', 'online');
        console.log('[kelex] Gateway connected:', url);
    } catch (e) {
        setUplink('offline', `offline — ${e.message}`);
        console.warn('[kelex] Gateway connect failed:', e.message);
        // Auto-retry after 5s
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectGateway, 5000);
    }
}

// Reconnect when gateway URL changes (after settings save)
async function reconnectGateway() {
    hermes.disconnect();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    await connectGateway();
}

// Gateway state events
hermes.onState((s) => {
    if (s === 'closed' || s === 'error') {
        setUplink('offline', 'offline — reconnecting…');
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectGateway, 3000);
    }
});

// ── Text chat ─────────────────────────────────────────────────────────

let chatRevert = null;

initTextChat({
    onState: (s) => {
        if (!state.conversationActive) {
            if (s === 'processing') setState('processing');
            else if (s === 'standby') {
                setState('speaking');
                clearTimeout(chatRevert);
                chatRevert = setTimeout(() => setState('standby'), 1600);
            }
        }
    },
    onReply: (reply) => {
        if (reply) showResponse(reply);
    },
});

// ── Orb click — placeholder (voice mode coming in Phase 2) ─────────────

reactorCore.addEventListener('click', () => {
    if (isTextChatOpen() || isSettingsOpen()) return;
    // Voice mode disabled — open text chat as fallback for now
    toggleTextChat();
});

// ── Settings panel ────────────────────────────────────────────────────

initSettings({
    onSaved: async (prev, next) => {
        if (prev.gateway_url !== next.gateway_url ||
            prev.username !== next.username ||
            prev.password_hash !== next.password_hash) {
            await loadSettings();
            reconnectGateway();
        }
    },
});

// ── Keyboard ──────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyK' && (e.ctrlKey || e.metaKey) && !e.repeat) {
        e.preventDefault();
        toggleTextChat();
        return;
    }
    if (e.key === 'Escape') {
        if (isSettingsOpen()) { e.preventDefault(); closeSettings(); return; }
        if (isTextChatOpen()) { e.preventDefault(); closeTextChat(); return; }
    }
});

// ── Clock ─────────────────────────────────────────────────────────────

function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
}
setInterval(tickClock, 1000);
tickClock();

// ── Tauri events ──────────────────────────────────────────────────────

const TAURI = window.__TAURI__;
if (TAURI?.event?.listen) {
    TAURI.event.listen('summon', () => {
        toggleTextChat();
    });
    TAURI.event.listen('mode', (e) => {
        document.body.classList.toggle('windowed', e.payload === 'window');
    });
    TAURI.event.listen('open-settings', () => openSettings());
}

// ── Boot ──────────────────────────────────────────────────────────────

(async () => {
    await loadSettings();
    document.body.classList.toggle('windowed', await isWindowed());
    setState('standby');

    const gw = gatewayWsUrl();
    if (gw) {
        await connectGateway();
    } else {
        setUplink('offline', 'No gateway configured — open Settings (⚙)');
    }

    console.log('[kelex] Online — Hermes Agent Desktop Client.');
})();
