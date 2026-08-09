// Text chat overlay (Ctrl/Cmd+K). Talks to Hermes Gateway via the
// hermes-client.js singleton. Streaming: appends text deltas as they
// arrive, shows a thinking indicator while the agent works.

import { hermes } from '../hermes-client.js';
import { sessionId } from '../config.js';

const els = {};
let open = false;
let busy = false;
let currentStreamMsg = null; // DOM node being streamed into
let unsubscribe = null;     // event handler cleanup

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
        empty.textContent = 'Connected to Hermes Gateway. Type below, sir.';
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

    if (hermes.state !== 'open') {
        els.messages.appendChild(msgEl('Gateway offline. Check settings.', 'kelex error'));
        return;
    }

    clearEmpty();
    els.messages.appendChild(msgEl(text, 'user'));
    els.input.value = '';
    els.input.style.height = 'auto';
    scrollDown();

    busy = true;
    els.send.disabled = true;
    setStatus('◉ THINKING', 'thinking');
    onState('processing');

    // Create a placeholder for the streaming response
    currentStreamMsg = document.createElement('div');
    currentStreamMsg.className = 'text-chat-msg kelex';
    currentStreamMsg.textContent = '';
    els.messages.appendChild(currentStreamMsg);

    // Subscribe to streaming events for this response
    const done = () => {
        busy = false;
        els.send.disabled = false;
        setStatus('○ STANDBY');
        onState('standby');
        currentStreamMsg = null;
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        scrollDown();
        setTimeout(() => els.input.focus(), 0);
    };

    unsubscribe = hermes.onAny((evt) => {
        switch (evt.type) {
            case 'message.delta':
                if (evt.payload?.text && currentStreamMsg) {
                    currentStreamMsg.textContent += evt.payload.text;
                    scrollDown();
                }
                break;
            case 'thinking.delta':
                setStatus('◉ THINKING', 'thinking');
                break;
            case 'message.complete':
                if (currentStreamMsg && !currentStreamMsg.textContent) {
                    currentStreamMsg.textContent = evt.payload?.text || '(no reply)';
                }
                const finalText = currentStreamMsg?.textContent || evt.payload?.text || '';
                onReply(finalText);
                done();
                break;
            case 'error':
                currentStreamMsg.textContent = evt.payload?.message || 'Gateway error, sir.';
                currentStreamMsg.className = 'text-chat-msg kelex error';
                onReply('', null, true);
                done();
                break;
        }
    });

    // Fire the chat request
    try {
        await hermes.chat(text, sessionId());
    } catch (e) {
        if (currentStreamMsg) {
            currentStreamMsg.textContent = `Link error, sir: ${e.message}`;
            currentStreamMsg.className = 'text-chat-msg kelex error';
        }
        onReply('', null, true);
        setStatus('⚠ ERROR', 'error');
        done();
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
