// Text chat overlay (Ctrl/Cmd+K). Milestone 2: POSTs to /api/chat via the
// Rust proxy and renders the reply. No streaming/TTS yet — the WS streaming
// path (text_chat_delta) lands with the voice work in M3.

import { chat } from '../config.js';

const els = {};
let open = false;
let busy = false;

// Optional hooks the host app wires in so the orb + center response mirror
// chat activity. Set via initTextChat({ onState, onReply }).
let onState = () => {};
let onReply = () => {};

function $(id) { return document.getElementById(id); }

function msgEl(text, who) {
    const el = document.createElement('div');
    el.className = `text-chat-msg ${who}`;
    el.textContent = text;
    return el;
}

function clearEmpty() {
    const e = els.messages.querySelector('.text-chat-empty');
    if (e) e.remove();
}

function scrollDown() {
    els.messages.scrollTop = els.messages.scrollHeight;
}

export function isTextChatOpen() { return open; }

export function openTextChat() {
    if (open) return;
    open = true;
    els.overlay.classList.add('visible');
    if (!els.messages.querySelector('.text-chat-msg')) {
        clearEmpty();
        const empty = document.createElement('div');
        empty.className = 'text-chat-empty';
        empty.textContent = 'Type below to begin, sir.';
        els.messages.appendChild(empty);
    }
    setTimeout(() => els.input.focus(), 30);
}

export function closeTextChat() {
    if (!open) return;
    open = false;
    els.overlay.classList.remove('visible');
}

export function toggleTextChat() { open ? closeTextChat() : openTextChat(); }

async function send() {
    const text = els.input.value.trim();
    if (!text || busy) return;

    clearEmpty();
    els.messages.appendChild(msgEl(text, 'user'));
    els.input.value = '';
    els.input.style.height = 'auto';
    scrollDown();

    busy = true;
    els.send.disabled = true;
    setStatus('◉ THINKING', 'thinking');
    onState('processing');

    try {
        const data = await chat(text);
        const reply = (data && data.reply) || '(no reply)';
        els.messages.appendChild(msgEl(reply, 'kelex'));
        onReply(reply, data && data.actions);
        setStatus('○ STANDBY');
    } catch (e) {
        const errText = `Link error, sir: ${e}`;
        els.messages.appendChild(msgEl(errText, 'kelex error'));
        onReply(errText, null, true);
        setStatus('⚠ ERROR', 'error');
    } finally {
        busy = false;
        els.send.disabled = false;
        scrollDown();
        onState('standby');
        setTimeout(() => els.input.focus(), 0);
    }
}

function setStatus(label, cls) {
    els.status.textContent = label;
    els.status.className = `text-chat-status ${cls || ''}`.trim();
}

export function initTextChat(hooks = {}) {
    onState = hooks.onState || onState;
    onReply = hooks.onReply || onReply;

    els.overlay = $('textChatOverlay');
    els.messages = $('textChatMessages');
    els.input = $('textChatInput');
    els.send = $('btnTextChatSend');
    els.status = $('textChatStatus');
    els.close = $('btnTextChatClose');
    els.clear = $('btnTextChatClear');

    els.send.onclick = send;
    els.close.onclick = closeTextChat;
    els.clear.onclick = () => {
        els.messages.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'text-chat-empty';
        empty.textContent = 'Cleared, sir.';
        els.messages.appendChild(empty);
    };

    // Auto-grow textarea + Enter to send (Shift+Enter = newline).
    els.input.addEventListener('input', () => {
        els.input.style.height = 'auto';
        els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
    });
    els.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });
}
