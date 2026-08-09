// TTS queue + playback + interrupt. Trimmed port of the legacy tts.js —
// widget dispatch and the music queue are dropped; each chunk's base64 mp3
// is played serially, then the conversation resumes listening.

import { state } from './state.js';
import { setState } from './ui.js';
import { startListening } from './mic.js';

export async function processTTSQueue() {
    if (state.isTTSPlaying || state.ttsQueue.length === 0) return;
    state.isTTSPlaying = true;
    const chunk = state.ttsQueue.shift();

    await playAudioAndWait(`data:audio/mp3;base64,${chunk.audio}`);

    state.isTTSPlaying = false;
    if (state.ttsQueue.length > 0) {
        processTTSQueue();
    } else {
        state.isSpeaking = false;
        if (state.conversationActive) setTimeout(startListening, 400);
    }
}

function playAudioAndWait(dataUri) {
    return new Promise((resolve) => {
        state.isSpeaking = true;
        setState('speaking');
        const a = new Audio(dataUri);
        a.volume = state.ttsVolume;
        state.currentAudio = a;
        a.onended = a.onerror = () => {
            state.isSpeaking = false;
            if (state.currentAudio === a) state.currentAudio = null;
            resolve();
        };
        a.play().catch(() => {
            state.isSpeaking = false;
            if (state.currentAudio === a) state.currentAudio = null;
            resolve();
        });
    });
}

// Stop kelex mid-speech (Esc). Tells the server to cancel too.
export function interruptResponse() {
    if (!state.isSpeaking && !state.isProcessing && state.ttsQueue.length === 0) return;
    console.log('[interrupt] user-initiated');

    if (state.currentAudio) {
        try { state.currentAudio.pause(); } catch (_) {}
        try { state.currentAudio.src = ''; } catch (_) {}
        state.currentAudio = null;
    }
    state.ttsQueue.length = 0;
    state.isTTSPlaying = false;
    state.isSpeaking = false;
    state.isProcessing = false;

    if (state.voiceWS && state.voiceWS.readyState === WebSocket.OPEN) {
        try { state.voiceWS.send(JSON.stringify({ type: 'interrupt' })); } catch (_) {}
    }

    setState(state.conversationActive ? 'listening' : 'standby');
    if (state.conversationActive) setTimeout(startListening, 300);
}
