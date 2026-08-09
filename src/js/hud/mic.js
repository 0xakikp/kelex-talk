// Voice conversation: native CPAL capture → Hermes Gateway → SpeechSynthesis.
//
// No WebKit SpeechRecognition. No getUserMedia. The Rust backend captures
// the mic via CPAL, sends WAV to Hermes /api/audio/transcribe, and returns
// the transcript back to the webview. The transcript then goes to the
// Gateway chat over the existing WebSocket, and the response is spoken via
// browser SpeechSynthesis.

import { state } from './state.js';
import { setState, showResponse, showTranscript, appendResponseText } from './ui.js';
import { wakePause, wakeResume, captureAndTranscribe } from '../config.js';
import { hermes } from '../hermes-client.js';
import { speak, interrupt as ttsInterrupt } from './tts.js';

let hermesUnsub = null;

// No-op — we never hold a media stream from the webview side.
export function releaseMediaStream() {}

export function activateConversation() {
    if (state.conversationActive) return;
    state.conversationActive = true;

    // Release the native CPAL wake listener so capture_and_transcribe can
    // open its own stream without fighting for the input device.
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
                        startListening();
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

    // Brief delay for the wake CPAL stream to fully release before we open
    // our own capture stream.
    setTimeout(startListening, 300);
}

export function deactivateConversation(options = {}) {
    const { announce = true } = options;
    state.conversationActive = false;
    state.isListening = false;
    state.isProcessing = false;
    state.isSpeaking = false;

    releaseMediaStream();
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

export async function startListening() {
    if (!state.conversationActive || state.isListening || state.isProcessing || state.isSpeaking) return;

    if (hermes.state !== 'open') {
        showResponse('Gateway offline. Voice unavailable, sir.');
        if (state.conversationActive) setTimeout(startListening, 3000);
        return;
    }

    state.isListening = true;
    setState('listening');
    console.log('[conv] starting native capture_and_transcribe');

    try {
        const transcript = await captureAndTranscribe();
        state.isListening = false;

        const text = (transcript || '').trim();
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
            // Empty transcript — retry silently.
            setTimeout(startListening, 350);
        }
    } catch (e) {
        state.isListening = false;
        const msg = typeof e === 'string' ? e : (e?.message || String(e));
        console.error('[conv] capture_and_transcribe failed:', msg);

        // "No speech within 15 seconds" is a normal timeout — retry silently.
        if (msg.includes('No speech detected')) {
            if (state.conversationActive) {
                setState('listening');
                setTimeout(startListening, 500);
            }
            return;
        }

        showResponse(`Voice capture failed: ${msg}`);
        if (state.conversationActive) {
            setState('listening');
            setTimeout(startListening, 3000);
        }
    }
}
