// Conversation mic: activate/deactivate + the VAD record-and-send loop.
// Trimmed port of the legacy mic.js — wake-word pausing removed (wake word
// is Phase 2, Rust-side). On silence it ships the recorded blob over the
// voice WebSocket as a binary frame; the server transcribes + replies.

import { state } from './state.js';
import { setState, showResponse } from './ui.js';
import { wakePause, wakeResume } from '../config.js';

export function releaseMediaStream() {
    if (state.currentMicStream) {
        try { state.currentMicStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        state.currentMicStream = null;
    }
}

export function activateConversation() {
    if (state.conversationActive) return;
    state.conversationActive = true;
    wakePause(); // free the mic from the always-on wake listener
    showResponse('Online and ready, sir.');
    setState('listening');
    setTimeout(startListening, 600);
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
    setState('standby');
    showResponse('System in standby mode.');
    wakeResume(); // resume always-on wake listening
}

export function toggleConversation() {
    state.conversationActive ? deactivateConversation() : activateConversation();
}

export async function startListening() {
    if (!state.conversationActive || state.isListening || state.isProcessing || state.isSpeaking) return;
    state.isListening = true;
    state.audioChunks = [];
    state.recordingVolumeSum = 0;
    state.recordingSamples = 0;
    setState('listening');
    console.log('[conv] startListening — requesting mic');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
        });
        state.currentMicStream = stream;
        state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        state.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) state.audioChunks.push(e.data); };
        state.mediaRecorder.start();

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
            state.recordingVolumeSum += state.instantVolume;
            state.recordingSamples++;
            if (window.blobAPI) window.blobAPI.setAudioLevel(Math.min(state.instantVolume / 60, 1.0));
        };
        draw();

        // Voice-activity detection: wait for speech, then 700ms of silence.
        let speechDetected = false, silenceStart = 0;
        const vadInterval = setInterval(() => {
            if (!state.isListening || !state.mediaRecorder || state.mediaRecorder.state !== 'recording') {
                clearInterval(vadInterval);
                return;
            }
            if (!speechDetected && state.instantVolume > 8) {
                speechDetected = true;
                silenceStart = 0;
            }
            if (speechDetected && state.instantVolume < 5) {
                if (!silenceStart) silenceStart = Date.now();
                else if (Date.now() - silenceStart > 700) {
                    clearInterval(vadInterval);
                    state.mediaRecorder.stop();
                }
            } else {
                silenceStart = 0;
            }
        }, 100);

        // Failsafe: never record longer than 10s.
        const maxRecTimeout = setTimeout(() => {
            if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
                clearInterval(vadInterval);
                state.mediaRecorder.stop();
            }
        }, 10000);

        state.mediaRecorder.onstop = () => {
            clearTimeout(maxRecTimeout);
            clearInterval(vadInterval);
            cancelAnimationFrame(state.visualizerRequest);
            if (window.blobAPI) window.blobAPI.setAudioLevel(0);
            stream.getTracks().forEach(t => t.stop());
            state.isListening = false;
            if (!state.conversationActive) return;

            const blob = new Blob(state.audioChunks, { type: 'audio/webm' });
            const avgVol = state.recordingVolumeSum / (state.recordingSamples || 1);
            console.log(`[conv] recorded ${blob.size}B, avg vol ${avgVol.toFixed(1)}`);
            if (blob.size < 1000 || avgVol < 5) {
                return setTimeout(startListening, 300); // too quiet — listen again
            }
            if (state.voiceWS && state.voiceWS.readyState === WebSocket.OPEN) {
                setState('processing');
                state.voiceWS.send(blob);
            } else {
                console.warn('[conv] WebSocket not open');
                showResponse('Voice link offline, sir.');
            }
        };
    } catch (e) {
        console.error('[conv] mic error:', e);
        state.isListening = false;
        deactivateConversation();
        showResponse(`Microphone unavailable, sir. (${e.name || e})`);
    }
}
