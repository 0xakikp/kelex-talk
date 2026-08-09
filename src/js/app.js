// kelex-talk entry point.
//
// M1: orb. M2: text chat -> /api/chat. M3: voice — mic -> /ws/voice -> TTS.
// Orb click toggles a hands-free voice conversation; Ctrl/Cmd+K is text chat;
// Esc interrupts kelex mid-speech (or closes the chat panel).

import { health, loadSettings, isWindowed } from './config.js';
import { initUI, setState, showResponse, setUplink } from './hud/ui.js';
import { state } from './hud/state.js';
import { initVoiceWS } from './hud/ws.js';
import { toggleConversation, activateConversation } from './hud/mic.js';
import { interruptResponse } from './hud/tts.js';
import {
    initTextChat, toggleTextChat, closeTextChat, isTextChatOpen,
} from './hud/text-chat.js';
import {
    initSettings, openSettings, closeSettings, isSettingsOpen,
} from './hud/settings.js';

const clockEl = document.getElementById('clock');
const reactorCore = document.getElementById('reactorCore');

initUI();

// ── Text chat (HTTP /api/chat) ──────────────────────────────────────────
let chatRevert = null;
initTextChat({
    onState: (s) => { if (!state.conversationActive) setState(s); },
    onReply: (reply) => {
        showResponse(reply);
        if (!state.conversationActive) {
            setState('speaking');
            clearTimeout(chatRevert);
            chatRevert = setTimeout(() => setState('standby'), 1600);
        }
    },
});

// ── Orb click = toggle voice conversation ───────────────────────────────
reactorCore.addEventListener('click', () => {
    if (isTextChatOpen() || isSettingsOpen()) return; // don't start voice while busy
    toggleConversation();
});

// ── Settings panel — reconnect voice WS if the backend URL changed ──────
initSettings({
    onSaved: async (prev, next) => {
        if (prev.backend_url !== next.backend_url) {
            await loadSettings();
            if (state.voiceWS) { try { state.voiceWS.close(); } catch (_) {} } // onclose reconnects
        }
    },
});

// ── Keyboard ────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyK' && (e.ctrlKey || e.metaKey) && !e.repeat) {
        e.preventDefault();
        toggleTextChat();
        return;
    }
    if (e.key === 'Escape') {
        if (isSettingsOpen()) { e.preventDefault(); closeSettings(); return; }
        if (isTextChatOpen()) { e.preventDefault(); closeTextChat(); return; }
        if (state.isSpeaking || state.isProcessing || state.ttsQueue.length > 0) {
            e.preventDefault();
            interruptResponse();
        }
    }
});

// ── UPLINK indicator — health poll, but let the live WS own the label ────
async function pollHealth() {
    if (state.voiceWS && state.voiceWS.readyState === WebSocket.OPEN) return;
    const ok = await health();
    setUplink(ok ? 'online' : 'offline', ok ? 'online · localhost:7777' : 'offline');
}

// ── Clock ─────────────────────────────────────────────────────────────
function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
}
setInterval(tickClock, 1000);
tickClock();

// ── Boot ─────────────────────────────────────────────────────────────
// Global summon hotkey (registered in Rust) emits "summon" → push-to-talk.
const TAURI = window.__TAURI__;
if (TAURI?.event?.listen) {
    TAURI.event.listen('summon', () => {
        if (!state.conversationActive) activateConversation();
    });
    // Tray "Switch to window/orb mode" — toggle the opaque windowed look.
    TAURI.event.listen('mode', (e) => {
        document.body.classList.toggle('windowed', e.payload === 'window');
    });
    // Tray "Settings…" / ⚙ button.
    TAURI.event.listen('open-settings', () => openSettings());
}

(async () => {
    await loadSettings();   // cache backend URL so voiceWsUrl() resolves
    // Restore windowed/orb look in case the webview re-initialized.
    document.body.classList.toggle('windowed', await isWindowed());
    initVoiceWS();          // open /ws/voice
    pollHealth();
    setInterval(pollHealth, 5000);
    setState('standby');
    console.log('[kelex-talk] M4 online — floating orb, tray, global hotkey (Cmd/Ctrl+Shift+J).');
})();
