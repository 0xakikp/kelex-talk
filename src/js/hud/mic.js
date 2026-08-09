// Voice conversation: browser SpeechRecognition → Hermes Gateway → SpeechSynthesis.
//
// Important macOS/WKWebView constraint: do NOT call getUserMedia just to draw
// an audio analyser. That optional capture request is denied from the custom
// Tauri origin on some WebKit versions, even when macOS has granted Kelex mic
// access. SpeechRecognition owns the microphone capture for transcription.

import { state } from './state.js';
import { setState, showResponse, showTranscript, appendResponseText } from './ui.js';
import { wakePause, wakeResume } from '../config.js';
import { hermes } from '../hermes-client.js';
import { speak, interrupt as ttsInterrupt } from './tts.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let hermesUnsub = null;

function getRecognition() {
    if (!recognition) {
        if (!SpeechRecognition) return null;
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
    }
    return recognition;
}

export function releaseMediaStream() {
    if (state.currentMicStream) {
        try { state.currentMicStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        state.currentMicStream = null;
    }
}

export function activateConversation() {
    if (state.conversationActive) return;
    state.conversationActive = true;

    // Fully releases native CPAL wake capture before SpeechRecognition starts.
    wakePause();
    showResponse('Online and ready, sir.');
    setState('listening');

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
                state.isProcessing = false;
                const final = evt.payload?.text || streamed;
                if (!streamed) showResponse(final);
                streamed = '';
                setState('speaking');
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

    // Let CPAL release the input device before WebKit begins recognition.
    setTimeout(startListening, 900);
}

export function deactivateConversation(options = {}) {
    const { announce = true } = options;
    state.conversationActive = false;
    state.isListening = false;
    state.isProcessing = false;
    state.isSpeaking = false;

    releaseMediaStream();
    if (recognition) {
        try { recognition.abort(); } catch (_) {}
    }
    if (hermesUnsub) { hermesUnsub(); hermesUnsub = null; }
    ttsInterrupt();

    setState('standby');
    if (announce) showResponse('System in standby mode.');
    wakeResume();
}

export function toggleConversation() {
    state.conversationActive ? deactivateConversation() : activateConversation();
}

export function isConversationActive() {
    return state.conversationActive;
}

export function startListening() {
    if (!state.conversationActive || state.isListening || state.isProcessing || state.isSpeaking) return;

    const rec = getRecognition();
    if (!rec) {
        showResponse('Speech recognition is unavailable. Use text chat (Cmd/Ctrl+K).');
        return;
    }
    if (hermes.state !== 'open') {
        showResponse('Gateway offline. Voice unavailable, sir.');
        if (state.conversationActive) setTimeout(startListening, 3000);
        return;
    }

    state.isListening = true;
    setState('listening');
    console.log('[conv] starting SpeechRecognition');

    let finalTranscript = '';
    let settled = false;

    const finish = () => {
        if (settled) return;
        settled = true;
        state.isListening = false;

        const text = finalTranscript.trim();
        if (text) {
            showTranscript(text);
            state.isProcessing = true;
            setState('processing');
            hermes.chat(text).catch((e) => {
                console.error('[conv] Hermes chat error:', e);
                showResponse(`Gateway error: ${e.message || e}`);
                state.isProcessing = false;
                if (state.conversationActive) {
                    setState('listening');
                    setTimeout(startListening, 2000);
                }
            });
        } else if (state.conversationActive) {
            setTimeout(startListening, 350);
        }
    };

    rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) finalTranscript += result[0].transcript;
            else interim += result[0].transcript;
        }
        showTranscript(finalTranscript + interim);
    };

    rec.onerror = (event) => {
        console.warn('[conv] SpeechRecognition error:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            const reason = `Speech recognition denied (${event.error}). macOS grants Microphone and Speech Recognition separately — enable Kelex under System Settings → Privacy & Security → Speech Recognition.`;
            console.error('[conv]', reason);
            deactivateConversation({ announce: false });
            showResponse(reason);
            return;
        }
        // no-speech / aborted are normal loop conditions
        finish();
    };

    rec.onend = finish;

    try {
        rec.start();
    } catch (e) {
        state.isListening = false;
        console.error('[conv] recognition start failed:', e);
        showResponse(`Speech recognition unavailable, sir. (${e.name || e})`);
        if (state.conversationActive) setTimeout(startListening, 2000);
    }
}
