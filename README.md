# kelex-talk

A standalone native desktop client for **kelex** — the floating "Jarvis"
voice/HUD orb, extracted out of the `kelex-ai` web HUD into a Tauri v2 app.

kelex-talk contains **no AI logic**. All intelligence (LLM brain, memory,
tools, STT, TTS, wake-word scoring) lives in the Python backend (`kelex`,
default `http://localhost:7777`). This app only renders the HUD and pipes
audio/text to/from that backend.

## Stack

- **Tauri v2** (Rust shell) + the OS webview.
- **Vanilla JS/HTML/CSS** frontend — ES modules, no bundler. Tauri serves
  `src/` directly (`frontendDist: "../src"`).
- The orb ([src/orb/blob.js](src/orb/blob.js)) is **Canvas 2D**, not WebGL —
  ported verbatim from the legacy HUD. The starfield
  ([src/orb/starfield.js](src/orb/starfield.js)) is also Canvas 2D.

## Layout

```
src/                     frontend (the ported HUD)
  index.html             HUD shell
  css/main.css           visual identity (orb + chrome)
  orb/blob.js            reactive orb — exposes window.blobAPI
  orb/starfield.js       background
  js/app.js              wiring
  js/config.js           backend URL + token (added M2)
  js/hud/*.js            ws / mic / tts / wake / text-chat / state / ui (M2+)
  assets/*.mp3           yes_sir / what_is_it / bgm
src-tauri/               Rust shell, config, plugins, native features
```

## Backend API (all on the configured base URL, default localhost:7777)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/chat` | POST | `{message, session_id}` → `{reply, actions}` |
| `/api/transcribe` | POST | raw audio bytes → `{text}` (STT) |
| `/ws/voice` | WS | streaming voice + text chat (protocol below) |
| `/api/wake-detect` | POST | multipart audio (+voiceprint) → wake + voiceprint match |
| `/api/voiceprint-enroll` | POST | multipart audio → `{voiceprint, dimensions}` |

**Auth:** the backend's channels send an `X-Internal-Token` header
(`BIGFLIX_INTERNAL_KEY`, default `bigflix_internal_secret_2026`). As of this
writing the HUD-facing endpoints above do **not** enforce it (CORS is open;
the referenced `mc_auth_middleware` exists only in comments). kelex-talk
sends the token anyway for forward-compat — configurable, may be left blank.

### `/ws/voice` protocol (reverse-engineered from the legacy HUD)

**Client → server**
- Binary frames: raw `audio/webm;codecs=opus` chunks. Server buffers and
  auto-transcribes ~0.8s after the last frame. Send `{type:"audio_end"}` to
  flush immediately.
- `{type:"user_input", text}` — voice-style turn (streams TTS back).
- `{type:"text_input", text, speak}` — Ctrl/Cmd+K text chat. TTS only if `speak`.
- `{type:"interrupt"}` — stop the in-flight response.
- `{type:"session_id", session_id}` — set per-connection session.

**Server → client (JSON)**
- `transcript` `{text}` — STT result of the user's audio.
- `text_delta` `{text}` — streamed reply tokens (voice path).
- `chunk` `{audio(base64 mp3), text?, agent_logs?, _meta?, <widget keys>}` —
  one TTS sentence + side-effects. Played serially.
- `status` `{status: analyzing|speaking|idle}` — drives orb state.
- `text_chat_delta` / `text_chat_done` / `text_chat_status` — Ctrl+K path.
- `meta {model_switched}`, `plan_step`, `skill_match`, `interrupted`,
  `error`, `ignored`.

## Develop

```bash
npm install
npm run tauri dev      # compiles Rust + opens the window
npm run tauri build    # release bundle (.app / .dmg on macOS)
```

## Milestones

1. ✅ Scaffold Tauri v2 + render the ported orb.
2. ⬜ Text chat → `/api/chat`.
3. ⬜ Voice: mic → `/ws/voice` (or `/api/transcribe`) → TTS playback.
4. ⬜ Tray + global hotkey + borderless/transparent/always-on-top window.
5. ⬜ Autostart + settings panel (backend URL, token, hotkey).
6. ⬜ (Phase 2) Rust-side always-on wake word via `cpal`.
