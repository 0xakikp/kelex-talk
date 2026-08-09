// Voice WebSocket: connect to /ws/voice and dispatch messages. Trimmed port
// of the legacy ws.js — only the voice/TTS message types (widget, wake-word,
// and WS-streamed text-chat handlers are dropped; text chat uses HTTP here).

import { state } from './state.js';
import { setState, showTranscript, showResponse, appendResponseText, setUplink } from './ui.js';
import { processTTSQueue } from './tts.js';
import { startListening } from './mic.js';
import { voiceWsUrl, notify } from '../config.js';

export function initVoiceWS() {
    const url = voiceWsUrl();
    state.voiceWS = new WebSocket(url);

    state.voiceWS.onopen = () => setUplink('online', 'voice link · online');
    state.voiceWS.onerror = () => setUplink('reconnecting', 'link lost…');

    state.voiceWS.onmessage = (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }

        switch (data.type) {
            case 'transcript':
                showTranscript(data.text);
                if (data.text) setState('processing');
                break;

            case 'text_delta':
                appendResponseText(data.text || '');
                if (data.text) setState('processing');
                break;

            case 'chunk':
                // Proactive alert from kelex (Sentinel/notify) → OS notification.
                if (data.is_alert && data.text) notify('KELEX', data.text);
                if (data.text) showResponse(data.text);
                if (data.audio) { state.ttsQueue.push(data); processTTSQueue(); }
                break;

            case 'status':
                // Keep isProcessing in sync with the backend so startListening's
                // re-entry guard works during the gap before the first TTS chunk.
                if (data.status === 'idle') {
                    state.isProcessing = false;
                    setState('listening');
                    if (state.conversationActive) setTimeout(startListening, 300);
                } else if (data.status === 'analyzing') {
                    state.isProcessing = true;
                    setState('processing');
                } else if (data.status === 'speaking') {
                    state.isProcessing = false;
                    setState('speaking');
                }
                break;

            case 'error':
                showResponse(data.text || 'System error, sir.');
                setState('standby');
                if (state.conversationActive) setTimeout(startListening, 2000);
                break;

            case 'ignored':
                setState(state.conversationActive ? 'listening' : 'standby');
                if (state.conversationActive) setTimeout(startListening, 300);
                break;

            case 'interrupted':
                // Server ack of our interrupt — nothing to render.
                break;
        }
    };

    state.voiceWS.onclose = () => {
        setUplink('reconnecting', 'reconnecting…');
        setTimeout(initVoiceWS, 2000);
    };
}
