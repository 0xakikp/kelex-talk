// UI helpers: drive the orb + chrome from a logical state, and render
// transcript / response text. Single owner of those DOM nodes so the voice
// modules (ws/mic/tts) and the host app stay in sync.

const dom = {};
const LABELS = {
    standby: 'ACTIVATE', listening: 'LISTENING',
    processing: 'PROCESSING', speaking: 'SPEAKING',
};

let streamed = '';

export function initUI() {
    dom.statusText = document.getElementById('statusText');
    dom.coreLabel = document.getElementById('coreLabel');
    dom.response = document.getElementById('response');
    dom.transcript = document.getElementById('transcript');
    dom.sysInfo = document.getElementById('sysInfo');
}

// Drive the orb (blob.js) + chrome from one logical state name.
export function setState(name) {
    if (window.blobAPI) window.blobAPI.setState(name);
    if (dom.statusText) dom.statusText.textContent = name.toUpperCase();
    if (dom.coreLabel) dom.coreLabel.textContent = LABELS[name] || name.toUpperCase();
    document.body.classList.toggle('is-speaking', name === 'speaking');
}

// User's transcribed speech — also marks the start of a fresh reply.
export function showTranscript(text) {
    if (!dom.transcript) return;
    dom.transcript.textContent = text;
    dom.transcript.classList.toggle('visible', !!text);
    streamed = '';
}

// Replace the whole reply.
export function showResponse(text) {
    streamed = text || '';
    if (!dom.response) return;
    dom.response.textContent = streamed;
    dom.response.classList.remove('hidden');
}

// Append a streamed token (text_delta) — gives the typewriter feel.
export function appendResponseText(text) {
    streamed += (text || '');
    if (!dom.response) return;
    dom.response.textContent = streamed;
    dom.response.classList.remove('hidden');
}

// Bottom-left UPLINK indicator. kind ∈ online | reconnecting | offline.
export function setUplink(kind, text) {
    if (!dom.sysInfo) return;
    dom.sysInfo.textContent = text;
    dom.sysInfo.className = kind;
}
