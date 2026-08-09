// Shared mutable state for the voice loop + orb visualizer.

export const state = {
    // Conversation lifecycle
    conversationActive: false,
    isListening: false,
    isProcessing: false,
    isSpeaking: false,

    // Conversation mic analyser (orb visualizer)
    audioContext: null,
    analyser: null,
    dataArray: null,
    visualizerRequest: null,
    recordingVolumeSum: 0,
    recordingSamples: 0,
    instantVolume: 0,

    // Mic recording (kept for MediaRecorder ref in mic.js)
    mediaRecorder: null,
    audioChunks: [],
    currentMicStream: null,

    // TTS playback
    ttsVolume: 1.0,
    currentAudio: null,
};
