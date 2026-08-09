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

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
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
    running: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

impl WakeFlags {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
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

    let st = app.state::<AppState>();
    let (url, auth) = st.endpoint("/api/wake-detect");
    let http = st.http.clone();
    let app = app.clone();
    std::thread::spawn(move || run(app, flags, url, auth, http));
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

fn err_fn(e: cpal::StreamError) {
    eprintln!("[wake] stream error: {e}");
}

fn run(app: AppHandle, flags: WakeFlags, url: String, auth: String, http: reqwest::Client) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        eprintln!("[wake] no input device");
        flags.running.store(false, Ordering::SeqCst);
        return;
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[wake] default_input_config failed: {e}");
            flags.running.store(false, Ordering::SeqCst);
            return;
        }
    };
    let sr = config.sample_rate().0 as f32;
    let channels = config.channels() as usize;
    let (tx, rx) = mpsc::channel::<Vec<f32>>();

    // Consumer: resample → WAV → POST → summon on a hit.
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
                let hit = tauri::async_runtime::block_on(post(&http, &url, &auth, wav));
                if hit {
                    flags.paused.store(true, Ordering::SeqCst); // hush during the turn
                    let a = app.clone();
                    let _ = app.run_on_main_thread(move || summon(&a));
                    std::thread::sleep(Duration::from_millis(COOLDOWN_MS));
                }
            }
        });
    }

    let cfg: cpal::StreamConfig = config.clone().into();
    let mk = |paused: Arc<AtomicBool>, tx: mpsc::Sender<Vec<f32>>| Recorder {
        sr,
        channels,
        paused,
        tx,
        buf: Vec::new(),
        speech: false,
        silence: 0,
        diag_samples: 0,
        diag_max_rms: Arc::new(std::sync::Mutex::new(0.0f32)),
    };
    let stream = match config.sample_format() {
        SampleFormat::F32 => {
            let mut rec = mk(flags.paused.clone(), tx.clone());
            device.build_input_stream(&cfg, move |d: &[f32], _: &_| rec.feed_f32(d), err_fn, None)
        }
        SampleFormat::I16 => {
            let mut rec = mk(flags.paused.clone(), tx.clone());
            device.build_input_stream(&cfg, move |d: &[i16], _: &_| rec.feed_i16(d), err_fn, None)
        }
        SampleFormat::U16 => {
            let mut rec = mk(flags.paused.clone(), tx.clone());
            device.build_input_stream(&cfg, move |d: &[u16], _: &_| rec.feed_u16(d), err_fn, None)
        }
        other => {
            eprintln!("[wake] unsupported sample format: {other:?}");
            flags.running.store(false, Ordering::SeqCst);
            return;
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[wake] build_input_stream failed: {e}");
            flags.running.store(false, Ordering::SeqCst);
            return;
        }
    };
    drop(tx); // only the recorder's clone holds a sender now
    if let Err(e) = stream.play() {
        eprintln!("[wake] stream.play failed: {e}");
        flags.running.store(false, Ordering::SeqCst);
        return;
    }
    eprintln!("[wake] listening — say \"jarvis\"");

    while flags.running.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(150));
    }
    drop(stream);
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
    fn feed_i16(&mut self, data: &[i16]) {
        self.feed(data.iter().map(|&s| s as f32 / 32768.0));
    }
    fn feed_u16(&mut self, data: &[u16]) {
        self.feed(data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0));
    }

    fn feed(&mut self, samples: impl Iterator<Item = f32>) {
        // Log first callback so we know CPAL is delivering audio.
        if self.diag_samples == 0 {
            let dev = cpal::default_host()
                .default_input_device()
                .map(|d| d.name().unwrap_or_else(|_| "?".into()))
                .unwrap_or_else(|| "none".into());
            eprintln!("[capture] first callback — device={dev}");
        }

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

/// Capture one VAD-bounded utterance from the native microphone and return WAV.
/// This is deliberately native CPAL, not WKWebView getUserMedia: macOS WebKit
/// does not expose SpeechRecognition reliably to Tauri apps.
fn capture_utterance_wav() -> Result<Vec<u8>, String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("No microphone input device")?;
    let input = device.default_input_config().map_err(|e| format!("Microphone config: {e}"))?;
    let sr = input.sample_rate().0 as f32;
    let channels = input.channels() as usize;
    let fmt = input.sample_format();
    let cfg: cpal::StreamConfig = input.clone().into();
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let paused = Arc::new(AtomicBool::new(false));

    // Shared max-RMS for diagnostics — if mic permission is denied, macOS
    // CoreAudio returns silence (RMS 0.0).  We log every 2 s so the user
    // sees why speech isn't being detected.
    let max_rms = Arc::new(std::sync::Mutex::new(0.0f32));
    let max_rms_probe = max_rms.clone();

    let mk = |tx: mpsc::Sender<Vec<f32>>, max_rms: Arc<std::sync::Mutex<f32>>| Recorder {
        sr,
        channels,
        paused: paused.clone(),
        tx,
        buf: Vec::new(),
        speech: false,
        silence: 0,
        diag_samples: 0usize,
        diag_max_rms: max_rms,
    };

    let stream = match fmt {
        SampleFormat::F32 => {
            let mut rec = mk(tx.clone(), max_rms.clone());
            device.build_input_stream(&cfg, move |d: &[f32], _| rec.feed_f32(d), err_fn, None)
        }
        SampleFormat::I16 => {
            let mut rec = mk(tx.clone(), max_rms.clone());
            device.build_input_stream(&cfg, move |d: &[i16], _| rec.feed_i16(d), err_fn, None)
        }
        SampleFormat::U16 => {
            let mut rec = mk(tx.clone(), max_rms.clone());
            device.build_input_stream(&cfg, move |d: &[u16], _| rec.feed_u16(d), err_fn, None)
        }
        other => return Err(format!("Unsupported microphone sample format: {other:?}")),
    }.map_err(|e| format!("Open microphone: {e}"))?;

    eprintln!(
        "[capture] mic open — sr={sr:.0} ch={channels} fmt={fmt:?}.  Say something…"
    );

    // Probe the max RMS every 2 s to surface permission-denied silence.
    let diag_running = Arc::new(AtomicBool::new(true));
    let diag_flag = diag_running.clone();
    let _diag_handle = std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while diag_flag.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_secs(2));
            if !diag_flag.load(Ordering::Relaxed) { break; }
            let rms = *max_rms_probe.lock().unwrap();
            let elapsed = start.elapsed().as_secs();
            eprintln!(
                "[capture] diag {elapsed}s — max RMS seen: {rms:.6}  (threshold {RMS_START})"
            );
            if rms == 0.0 && elapsed > 4 {
                eprintln!(
                    "[capture] ⚠  ZERO audio for {elapsed}s — mic permission likely denied.  "
                );
                eprintln!(
                    "[capture]     Check System Settings → Privacy → Microphone → Kelex"
                );
            }
        }
    });

    drop(tx);
    stream.play().map_err(|e| format!("Start microphone: {e}"))?;
    let raw = rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "No speech detected within 15 seconds")?;
    drop(stream);
    diag_running.store(false, Ordering::Relaxed);

    eprintln!(
        "[capture] utterance captured — {} samples",
        raw.len()
    );
    Ok(encode_wav(&resample_to_16k(&raw, sr)))
}

/// Native voice capture → authenticated Hermes transcription endpoint.
pub async fn capture_and_transcribe(app: AppHandle) -> Result<String, String> {
    let (base, username, password) = {
        let st = app.state::<AppState>();
        let s = st.settings.lock().map_err(|_| "Settings lock failed")?;
        (s.gateway_url.trim_end_matches('/').to_string(), s.username.clone(), s.password_hash.clone())
    };
    if base.is_empty() { return Err("No gateway URL configured".into()); }

    let wav = tauri::async_runtime::spawn_blocking(capture_utterance_wav)
        .await
        .map_err(|e| format!("Native capture task: {e}"))??;

    let jar = Arc::new(reqwest::cookie::Jar::default());
    let client = reqwest::Client::builder()
        .cookie_provider(jar)
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let login = client.post(format!("{base}/auth/password-login"))
        .json(&serde_json::json!({"provider":"basic","username":username,"password":password,"next":""}))
        .send().await.map_err(|e| format!("Transcription login: {e}"))?;
    if !login.status().is_success() { return Err(format!("Transcription login failed: {}", login.status())); }

    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("kelex-utterance.wav")
        .mime_str("audio/wav").map_err(|e| format!("WAV mime: {e}"))?;
    let result = client.post(format!("{base}/api/audio/transcribe"))
        .multipart(reqwest::multipart::Form::new().part("audio", part))
        .send().await.map_err(|e| format!("Transcription request: {e}"))?;
    if !result.status().is_success() {
        return Err(format!("Transcription failed: {}", result.status()));
    }
    let body: serde_json::Value = result.json().await.map_err(|e| format!("Transcription response: {e}"))?;
    Ok(body.get("transcript").and_then(|v| v.as_str()).unwrap_or("").trim().to_string())
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
