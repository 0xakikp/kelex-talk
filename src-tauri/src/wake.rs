// Phase 2 — always-on, Rust-side wake word.
//
// Captures the mic continuously via cpal (works while the window is hidden),
// runs a cheap energy-based VAD, and on each detected utterance ships a
// 16 kHz mono WAV to the backend's /api/wake-detect. If the backend reports
// the wake phrase ("jarvis", per its WAKE_PHRASES), we summon the window and
// kick off a conversation. It pauses while a conversation is already active so
// it doesn't fight the webview's getUserMedia.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::{summon, AppState};

// VAD tuning (RMS on -1..1 samples). Generous start threshold so a spoken
// "jarvis" reliably trips it; the backend Whisper pass is the real filter.
const RMS_START: f32 = 0.018;
const RMS_SILENCE: f32 = 0.010;
const SILENCE_HANG_SECS: f32 = 0.6;
const MIN_UTTERANCE_SECS: f32 = 0.3;
const MAX_UTTERANCE_SECS: f32 = 2.5;
const COOLDOWN_MS: u64 = 2500;

// Wake word is "kelex". The backend only matches "jarvis" phrases, so we
// ignore its `wake_detected` and match the returned `transcript` ourselves —
// including the spellings Whisper tends to produce for "kelex".
const WAKE_WORDS: [&str; 16] = [
    "kelex", "kelix", "kellex", "kellix", "kalex", "kalix", "kelecks", "kelleks", "kelleck",
    "callex", "kalex", "kelx", "kel ex", "kell ex", "kell x", "kel ix",
];

/// Shared flags, cloneable into the audio thread + Tauri state.
#[derive(Clone)]
pub struct WakeFlags {
    pub running: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    /// Set by the wake thread AFTER the CPAL stream is fully dropped.
    pub stopped: Arc<AtomicBool>,
    /// When Some, the next VAD utterance is routed to /api/audio/transcribe
    /// and the transcript is sent through this oneshot.  Used by
    /// capture_and_transcribe to piggyback on the wake stream.
    pub conversation_capture: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>>,
}

impl WakeFlags {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            stopped: Arc::new(AtomicBool::new(true)),
            conversation_capture: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

/// Start the always-on listener (no-op if already running).
pub fn start(app: &AppHandle) {
    let flags = app.state::<WakeFlags>().inner().clone();
    if flags.running.swap(true, Ordering::SeqCst) {
        return;
    }
    flags.paused.store(false, Ordering::SeqCst);
    flags.stopped.store(false, Ordering::SeqCst);

    let st = app.state::<AppState>();
    let (wake_url, wake_auth) = st.endpoint("/api/wake-detect");
    let (transcribe_url, _) = st.endpoint("/api/audio/transcribe");
    // Transcription uses cookie auth (logged in via HTTP), not basic auth.
    let gateway_base = {
        let s = st.settings.lock().unwrap();
        s.gateway_url.trim_end_matches('/').to_string()
    };
    let gateway_user = {
        let s = st.settings.lock().unwrap();
        s.username.clone()
    };
    let gateway_pass = {
        let s = st.settings.lock().unwrap();
        s.password_hash.clone()
    };
    let http = st.http.clone();
    let app = app.clone();
    std::thread::spawn(move || run(app, flags, wake_url, wake_auth, transcribe_url, gateway_base, gateway_user, gateway_pass, http));
}

pub fn stop(app: &AppHandle) {
    app.state::<WakeFlags>().running.store(false, Ordering::SeqCst);
}

/// Hush/resume without tearing down the stream (used around conversations).
pub fn set_paused(app: &AppHandle, paused: bool) {
    app.state::<WakeFlags>()
        .paused
        .store(paused, Ordering::SeqCst);
}

fn run(
    app: AppHandle,
    flags: WakeFlags,
    wake_url: String,
    wake_auth: String,
    transcribe_url: String,
    gateway_base: String,
    gateway_user: String,
    gateway_pass: String,
    http: reqwest::Client,
) {
    // Cargo's build hook compiles the Swift AVAudioEngine helper to this
    // target-suffixed path for `tauri dev`. Tauri copies it alongside the
    // executable in an app bundle, so release resolves it next to us.
    let helper = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(format!("kelex_mic-{}", env!("KELEX_MIC_TARGET")))
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("kelex_mic")))
            .unwrap_or_else(|| std::path::PathBuf::from("kelex_mic"))
    };

    if !helper.exists() {
        eprintln!("[wake] kelex_mic helper not found at {}", helper.display());
        eprintln!("[wake] build it with: cargo build --bin kelex_mic");
        flags.running.store(false, Ordering::SeqCst);
        return;
    }

    let mut child = match std::process::Command::new(&helper)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[wake] failed to spawn kelex_mic: {e}");
            flags.running.store(false, Ordering::SeqCst);
            return;
        }
    };

    let mut stdout = match child.stdout.take() {
        Some(s) => std::io::BufReader::new(s),
        None => {
            eprintln!("[wake] kelex_mic has no stdout");
            flags.running.store(false, Ordering::SeqCst);
            return;
        }
    };

    use std::io::Read;
    let mut hdr = [0u8; 6];
    if stdout.read_exact(&mut hdr).is_err() {
        eprintln!("[wake] failed to read kelex_mic header");
        let _ = child.kill();
        flags.running.store(false, Ordering::SeqCst);
        return;
    }
    let sr = u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as f32;
    let _channels = u16::from_le_bytes([hdr[4], hdr[5]]) as usize;

    eprintln!("[wake] kelex_mic connected — sr={sr}");

    let (tx, rx) = mpsc::channel::<Vec<f32>>();

    {
        let flags = flags.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            while let Ok(raw) = rx.recv() {
                if !flags.running.load(Ordering::Relaxed) {
                    break;
                }
                let pcm = resample_to_16k(&raw, sr);
                let wav = encode_wav(&pcm);

                let cap_tx = flags.conversation_capture.lock().unwrap().take();
                if let Some(tx) = cap_tx {
                    let transcript = tauri::async_runtime::block_on(
                        transcribe_utterance(
                            &http, &transcribe_url,
                            &gateway_base, &gateway_user, &gateway_pass,
                            wav,
                        )
                    );
                    let _ = tx.send(transcript.unwrap_or_default());
                    continue;
                }

                let hit = tauri::async_runtime::block_on(post(&http, &wake_url, &wake_auth, wav));
                if hit {
                    flags.paused.store(true, Ordering::SeqCst);
                    let a = app.clone();
                    let _ = app.run_on_main_thread(move || summon(&a));
                    std::thread::sleep(Duration::from_millis(COOLDOWN_MS));
                }
            }
        });
    }

    let mut rec = Recorder {
        sr,
        channels: 1,
        paused: flags.paused.clone(),
        tx: tx.clone(),
        buf: Vec::new(),
        speech: false,
        silence: 0,
        diag_samples: 0,
        diag_max_rms: Arc::new(std::sync::Mutex::new(0.0f32)),
    };
    drop(tx);

    eprintln!("[wake] listening — say \"jarvis\"");

    let mut sample_buf = [0u8; 4 * 1024];
    let mut pending = Vec::<u8>::new();
    loop {
        if !flags.running.load(Ordering::Relaxed) {
            break;
        }
        match stdout.read(&mut sample_buf) {
            Ok(0) => {
                eprintln!("[wake] kelex_mic EOF");
                break;
            }
            Ok(n) => {
                pending.extend_from_slice(&sample_buf[..n]);
                let complete = pending.len() / 4;
                if complete == 0 {
                    continue;
                }
                let samples: Vec<f32> = pending[..complete * 4]
                    .chunks_exact(4)
                    .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                    .collect();
                pending.drain(..complete * 4);
                rec.feed_f32(&samples);
            }
            Err(e) => {
                eprintln!("[wake] kelex_mic read error: {e}");
                break;
            }
        }
    }

    let _ = child.kill();
    match child.wait() {
        Ok(status) if status.code() == Some(77) => {
            eprintln!("[wake] microphone permission was denied by macOS");
        }
        Ok(status) if !status.success() => {
            eprintln!("[wake] kelex_mic exited with {status}");
        }
        Ok(_) => {}
        Err(e) => eprintln!("[wake] kelex_mic wait failed: {e}"),
    }
    flags.stopped.store(true, Ordering::SeqCst);
    flags.running.store(false, Ordering::SeqCst);
    eprintln!("[wake] stopped");
}

/// VAD + utterance buffering, fed from the cpal callback thread.
struct Recorder {
    sr: f32,
    channels: usize,
    paused: Arc<AtomicBool>,
    tx: mpsc::Sender<Vec<f32>>,
    buf: Vec<f32>,
    speech: bool,
    silence: usize,
    diag_samples: usize,
    diag_max_rms: Arc<std::sync::Mutex<f32>>,
}

impl Recorder {
    fn feed_f32(&mut self, data: &[f32]) {
        self.feed(data.iter().copied());
    }

    fn feed(&mut self, samples: impl Iterator<Item = f32>) {
        if self.paused.load(Ordering::Relaxed) {
            self.buf.clear();
            self.speech = false;
            self.silence = 0;
            return;
        }
        let ch = self.channels.max(1);
        let mut mono = Vec::new();
        let mut acc = 0.0f32;
        let mut cur = 0.0f32;
        let mut i = 0usize;
        for s in samples {
            cur += s;
            i += 1;
            if i == ch {
                let m = cur / ch as f32;
                mono.push(m);
                acc += m * m;
                cur = 0.0;
                i = 0;
            }
        }
        if mono.is_empty() {
            return;
        }
        let rms = (acc / mono.len() as f32).sqrt();

        // Diagnostic: track max RMS so we can detect permission-denied silence.
        self.diag_samples += mono.len();
        if self.diag_samples % 8000 < mono.len() {
            // ~every 0.5 s at 16 kHz
            let mut max = self.diag_max_rms.lock().unwrap();
            if rms > *max {
                *max = rms;
            }
        }
        // TEMPORARY DIAG: log RMS every ~2s so we can see if mic delivers real audio.
        if self.diag_samples % 96000 < mono.len() {
            let paused = self.paused.load(Ordering::Relaxed);
            eprintln!(
                "[wake-diag] samples={} rms={rms:.6} paused={paused} speech={}",
                self.diag_samples, self.speech
            );
        }

        if !self.speech {
            if rms > RMS_START {
                self.speech = true;
                self.silence = 0;
                self.buf.clear();
            } else {
                return;
            }
        }
        self.buf.extend_from_slice(&mono);
        if rms < RMS_SILENCE {
            self.silence += mono.len();
        } else {
            self.silence = 0;
        }
        let silence_secs = self.silence as f32 / self.sr;
        let rec_secs = self.buf.len() as f32 / self.sr;
        if silence_secs > SILENCE_HANG_SECS || rec_secs > MAX_UTTERANCE_SECS {
            if rec_secs > MIN_UTTERANCE_SECS {
                let _ = self.tx.send(std::mem::take(&mut self.buf));
            }
            self.buf.clear();
            self.speech = false;
            self.silence = 0;
        }
    }
}

/// Linear resample to 16 kHz mono i16.
fn resample_to_16k(input: &[f32], sr: f32) -> Vec<i16> {
    if input.is_empty() {
        return Vec::new();
    }
    let ratio = 16000.0 / sr;
    let out_len = (input.len() as f32 * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f32 / ratio;
        let idx = src as usize;
        let frac = src - idx as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        let s = a + (b - a) * frac;
        out.push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
    }
    out
}

fn encode_wav(samples: &[i16]) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut cursor, spec).expect("wav writer");
        for &s in samples {
            let _ = w.write_sample(s);
        }
        let _ = w.finalize();
    }
    cursor.into_inner()
}

/// Cookie-auth login → POST WAV to /api/audio/transcribe → extract transcript.
/// Used by both the capture_and_transcribe command and the wake consumer piggyback.
async fn transcribe_utterance(
    http: &reqwest::Client,
    transcribe_url: &str,
    base: &str,
    username: &str,
    password: &str,
    wav: Vec<u8>,
) -> Result<String, String> {
    // Use the passed client for the login (cookie store is shared).
    let login = http.post(format!("{base}/auth/password-login"))
        .json(&serde_json::json!({"provider":"basic","username":username,"password":password,"next":""}))
        .send().await.map_err(|e| format!("Transcription login: {e}"))?;
    if !login.status().is_success() {
        return Err(format!("Transcription login failed: {}", login.status()));
    }

    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("kelex-utterance.wav")
        .mime_str("audio/wav").map_err(|e| format!("WAV mime: {e}"))?;
    let result = http.post(transcribe_url)
        .multipart(reqwest::multipart::Form::new().part("audio", part))
        .send().await.map_err(|e| format!("Transcription request: {e}"))?;
    if !result.status().is_success() {
        return Err(format!("Transcription failed: {}", result.status()));
    }
    let body: serde_json::Value = result.json().await
        .map_err(|e| format!("Transcription response: {e}"))?;
    Ok(body.get("transcript")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

/// Piggyback on the wake listener's CPAL stream — no second AudioUnit.
/// Sets a oneshot in WakeFlags; the next VAD utterance from the always-on
/// wake stream is routed to /api/audio/transcribe instead of wake-detect.
pub async fn capture_and_transcribe(app: AppHandle) -> Result<String, String> {
    // Verify gateway is configured.
    {
        let st = app.state::<AppState>();
        let s = st.settings.lock().map_err(|_| "Settings lock failed")?;
        if s.gateway_url.trim_end_matches('/').is_empty() {
            return Err("No gateway URL configured".into());
        }
    }

    let flags = app.state::<WakeFlags>().inner().clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();

    // Register interest: the wake consumer will route the next utterance here.
    *flags.conversation_capture.lock().unwrap() = Some(tx);

    // Unpause the wake VAD briefly so it picks up the user's speech.
    flags.paused.store(false, Ordering::SeqCst);
    eprintln!("[capture] waiting for utterance on wake stream…");

    // Wait for the wake consumer to send us the transcript (max 15 s).
    let transcript = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        rx,
    ).await
        .map_err(|_| "No speech detected within 15 seconds".to_string())
        .and_then(|r| r.map_err(|_| "Wake consumer dropped".to_string()))?;

    let text = transcript.trim().to_string();
    eprintln!("[capture] transcript: {text:?}");
    if text.is_empty() {
        Err("No speech detected".into())
    } else {
        Ok(text)
    }
}

/// POST the WAV to /api/wake-detect. Returns true on wake + voiceprint match.
async fn post(http: &reqwest::Client, url: &str, auth: &str, wav: Vec<u8>) -> bool {
    let part = match reqwest::multipart::Part::bytes(wav)
        .file_name("wake.wav")
        .mime_str("audio/wav")
    {
        Ok(p) => p,
        Err(_) => return false,
    };
    let form = reqwest::multipart::Form::new().part("audio", part);
    let mut req = http.post(url).multipart(form);
    if !auth.is_empty() {
        req = req.header("Authorization", format!("Basic {auth}"));
    }
    match req.send().await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(v) => {
                // Match "kelex" in the transcript ourselves (backend only knows
                // "jarvis"). Log every heard transcript so the variant list +
                // thresholds can be tuned from real data.
                let transcript = v
                    .get("transcript")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let vp = v.get("voiceprint_match").and_then(|b| b.as_bool()).unwrap_or(true);
                let hit = WAKE_WORDS.iter().any(|w| transcript.contains(w));
                eprintln!(
                    "[wake] heard {transcript:?} -> {}",
                    if hit && vp { "WAKE" } else { "ignored" }
                );
                hit && vp
            }
            Err(_) => false,
        },
        Err(e) => {
            eprintln!("[wake] /api/wake-detect failed: {e}");
            false
        }
    }
}
