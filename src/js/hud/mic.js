// Conversation mic: activate/deactivate + VAD → Web Speech API → Hermes.
// Phase 2 rebuild — instead of sending raw audio blobs to a custom voice
// WebSocket, we transcribe locally with the browser's SpeechRecognition API
// and send the text to Hermes Gateway via the JSON-RPC WebSocket client.
//
// Flow: Orb click → listening → speech detected → transcribe → Hermes chat
//       → stream text deltas → TTS speak → loop back to listening.

import { state } from './state.js';
import { setState, showResponse, showTranscript, appendResponseText } from './ui.js';
import { wakePause, wakeResume } from '../config.js';
import { hermes } from '../hermes-client.js';
import { speak, interrupt as ttsInterrupt } from './tts.js';

// ── Web Speech API recognition (lazy init) ────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function getRecognition() {
    if (!recognition) {
        if (!SpeechRecognition) {
            console.warn('[conv] SpeechRecognition not available in this browser');
            return null;
        }
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
    }
    return recognition;
}

// ── Stream management ─────────────────────────────────────────────────

export function releaseMediaStream() {
    if (state.currentMicStream) {
        try { state.currentMicStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        state.currentMicStream = null;
    }
}

// ── Conversation lifecycle ────────────────────────────────────────────

let hermesUnsub = null;

export function activateConversation() {
    if (state.conversationActive) return;
    state.conversationActive = true;
    wakePause();
    showResponse('Online and ready, sir.');
    setState('listening');
    // wakePause() stops the native CPAL stream; give macOS time to release
    // the hardware before WKWebView calls getUserMedia.
    setTimeout(startListening, 900);
    let streamed = '';
    hermesUnsub = hermes.onAny((evt) => {
        switch (evt.type) {
            case 'message.delta':
                if (evt.payload?.text) {
                    streamed += evt.payload.text;
                    appendResponseText(evt.payload.text);
                }
                break;
            case 'thinking.delta':
                setState('processing');
                break;
            case 'message.complete': {
                const final = evt.payload?.text || streamed;
                if (!streamed) showResponse(final);
                streamed = '';
                setState('speaking');
                // Speak the response, then loop back to listening
                speak(final).then(() => {
                    if (state.conversationActive && !state.isProcessing) {
                        setState('listening');
                        setTimeout(startListening, 400);
                    }
                });
                break;
            }
            case 'error':
                showResponse(evt.payload?.message || 'Gateway error, sir.');
                if (state.conversationActive) {
                    setState('listening');
                    setTimeout(startListening, 2000);
                }
                break;
        }
    });
}

export function deactivateConversation() {
    state.conversationActive = false;
    state.isListening = false;
    state.isProcessing = false;
    state.isSpeaking = false;

    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
    }
    releaseMediaStream();

    // Stop any active recognition
    if (recognition) {
        try { recognition.abort(); } catch (_) {}
    }

    // Unsubscribe from Hermes events
    if (hermesUnsub) { hermesUnsub(); hermesUnsub = null; }

    // Stop TTS
    ttsInterrupt();

    setState('standby');
    showResponse('System in standby mode.');
    wakeResume();
}

export function toggleConversation() {
    state.conversationActive ? deactivateConversation() : activateConversation();
}

export function isConversationActive() {
    return state.conversationActive;
}

// ── Listening loop ────────────────────────────────────────────────────

export async function startListening() {
    if (!state.conversationActive || state.isListening || state.isProcessing || state.isSpeaking) return;

    const rec = getRecognition();
    if (!rec) {
        // Fallback: no SpeechRecognition → just open text chat
        showResponse('Voice recognition not available. Use text chat (Cmd/Ctrl+K).');
        return;
    }

    if (hermes.state !== 'open') {
        showResponse('Gateway offline. Voice unavailable, sir.');
        if (state.conversationActive) setTimeout(startListening, 3000);
        return;
    }

    state.isListening = true;
    state.audioChunks = [];
    state.recordingVolumeSum = 0;
    state.recordingSamples = 0;
    setState('listening');

    console.log('[conv] startListening');

    // ── Mic stream for the orb visualizer ────────────────────────────

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
        });
        state.currentMicStream = stream;

        if (!state.audioContext) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (state.audioContext.state === 'suspended') await state.audioContext.resume();

        const source = state.audioContext.createMediaStreamSource(stream);
        state.analyser = state.audioContext.createAnalyser();
        state.analyser.fftSize = 256;
        source.connect(state.analyser);
        state.dataArray = new Uint8Array(state.analyser.frequencyBinCount);

        const draw = () => {
            state.visualizerRequest = requestAnimationFrame(draw);
            state.analyser.getByteFrequencyData(state.dataArray);
            state.instantVolume = state.dataArray.reduce((a, b) => a + b, 0) / state.dataArray.length;
            if (window.blobAPI) window.blobAPI.setAudioLevel(Math.min(state.instantVolume / 60, 1.0));
        };
        draw();

        // ── Speech recognition ────────────────────────────────────────

        let finalTranscript = '';
        let heardSomething = false;

        rec.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const r = event.results[i];
                if (r.isFinal) {
                    finalTranscript += r[0].transcript;
                    heardSomething = true;
                } else {
                    interim += r[0].transcript;
                }
            }
            // Show interim as transcript
            showTranscript(finalTranscript + interim);
        };

        rec.onerror = (event) => {
            console.warn('[conv] recognition error:', event.error);
            if (event.error === 'no-speech' || event.error === 'aborted') {
                // Normal — just restart
                done();
            } else if (event.error === 'not-allowed') {
                showResponse('Microphone access denied, sir.');
                deactivateConversation();
            } else {
                done();
            }
        };

        rec.onend = () => {
            done();
        };

        const done = () => {
            cancelAnimationFrame(state.visualizerRequest);
            if (window.blobAPI) window.blobAPI.setAudioLevel(0);
            stream.getTracks().forEach(t => t.stop());
            state.isListening = false;
            state.currentMicStream = null;

            const text = finalTranscript.trim();
            if (text && heardSomething) {
                console.log('[conv] heard:', text);
                state.isProcessing = true;
                setState('processing');

                hermes.chat(text).catch((e) => {
                    console.error('[conv] chat error:', e);
                    showResponse(`Error: ${e.message}`);
                    state.isProcessing = false;
                    if (state.conversationActive) {
                        setState('listening');
                        setTimeout(startListening, 2000);
                    }
                });
            } else {
                // Nothing heard — listen again
                if (state.conversationActive) setTimeout(startListening, 300);
            }
        };

        rec.start();
    } catch (e) {
        console.error('[conv] mic error:', e);
        state.isListening = false;
        deactivateConversation();
        showResponse(`Microphone unavailable, sir. (${e.name || e})`);
    }
}
