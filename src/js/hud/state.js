// Shared mutable state for the voice loop. Trimmed port of the legacy HUD's
// state.js — only the fields the conversation/TTS pipeline touches.

export const state = {
    // WebSocket
    voiceWS: null,

    // Conversation lifecycle
    conversationActive: false,
    isListening: false,
    isProcessing: false,
    isSpeaking: false,

    // Conversation mic analyser
    audioContext: null,
    analyser: null,
    dataArray: null,
    visualizerRequest: null,
    recordingVolumeSum: 0,
    recordingSamples: 0,
    instantVolume: 0,

    // Mic recording
    mediaRecorder: null,
    audioChunks: [],
    currentMicStream: null,

    // TTS playback
    ttsQueue: [],
    isTTSPlaying: false,
    currentAudio: null,
    ttsVolume: 1.0,
};
