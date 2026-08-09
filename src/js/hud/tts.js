// TTS — browser SpeechSynthesis instead of backend audio chunks.
// Phase 2 rebuild: the Hermes Gateway doesn't stream TTS audio natively
// over JSON-RPC, so we use the browser's built-in speech synthesis.
//
// speak(text) → returns a Promise that resolves when speech finishes.
// interrupt() → cancels any ongoing speech immediately.

import { state } from './state.js';

let currentUtterance = null;
let resolveOnEnd = null;

export function speak(text) {
    return new Promise((resolve) => {
        // Cancel any previous speech
        interrupt();

        if (!text || !window.speechSynthesis) {
            resolve();
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.05;   // slightly faster than default
        utterance.pitch = 1.0;
        utterance.volume = state.ttsVolume;

        // Try to pick a good English voice
        const voices = window.speechSynthesis.getVoices();
        const preferred = voices.find(v =>
            v.lang.startsWith('en') && v.name.includes('Daniel')
        ) || voices.find(v =>
            v.lang.startsWith('en') && v.name.includes('Samantha')
        ) || voices.find(v =>
            v.lang.startsWith('en-')
        ) || voices[0];

        if (preferred) utterance.voice = preferred;

        currentUtterance = utterance;
        state.isSpeaking = true;
        state.currentAudio = { pause: () => window.speechSynthesis.cancel() }; // compat

        utterance.onend = () => {
            state.isSpeaking = false;
            currentUtterance = null;
            if (resolveOnEnd === resolve) resolveOnEnd = null;
            resolve();
        };

        utterance.onerror = (e) => {
            console.warn('[tts] error:', e.error);
            state.isSpeaking = false;
            currentUtterance = null;
            if (resolveOnEnd === resolve) resolveOnEnd = null;
            resolve();
        };

        resolveOnEnd = resolve;
        window.speechSynthesis.speak(utterance);
    });
}

export function interrupt() {
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }
    state.isSpeaking = false;
    currentUtterance = null;
    if (resolveOnEnd) {
        resolveOnEnd();
        resolveOnEnd = null;
    }
}

// Stop kelex mid-speech (Esc). Also tells Hermes nothing — the gateway
// doesn't support mid-stream cancellation yet; the response just gets
// discarded client-side.
export function interruptResponse() {
    if (!state.isSpeaking && !state.isProcessing) return;
    console.log('[interrupt] user-initiated');
    interrupt();
    state.isProcessing = false;
}
