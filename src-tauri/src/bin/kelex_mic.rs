// kelex-mic — standalone mic capture helper.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::io::Write;
use std::sync::mpsc;

fn main() {
    let host = cpal::default_host();
    let device = host.default_input_device().expect("No input device");
    let config = device.default_input_config().expect("No default config");
    let sr = config.sample_rate();
    let channels = config.channels() as usize;
    let fmt = config.sample_format();
    let cfg: cpal::StreamConfig = config.into();

    let stdout = std::io::stdout();
    {
        let mut out = stdout.lock();
        out.write_all(&sr.to_le_bytes()).unwrap();
        out.write_all(&1u16.to_le_bytes()).unwrap();
        out.flush().unwrap();
    }

    let (tx, rx) = mpsc::channel::<Vec<f32>>();

    let writer = std::thread::spawn(move || {
        let mut out = std::io::BufWriter::new(stdout.lock());
        while let Ok(chunk) = rx.recv() {
            for &s in &chunk {
                if out.write_all(&s.to_le_bytes()).is_err() {
                    return;
                }
            }
            if out.flush().is_err() {
                return;
            }
        }
    });

    let tx2 = tx.clone();
    let err_fn = |e: cpal::Error| eprintln!("[kelex-mic] stream error: {e}");

    let stream = match fmt {
        cpal::SampleFormat::F32 => {
            device.build_input_stream(
                cfg.clone(),
                move |data: &[f32], _| {
                    let mono = mono_mix(data, channels);
                    let _ = tx2.send(mono);
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            device.build_input_stream(
                cfg.clone(),
                move |data: &[i16], _| {
                    let floats: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    let mono = mono_mix(&floats, channels);
                    let _ = tx2.send(mono);
                },
                err_fn,
                None,
            )
        }
        other => {
            eprintln!("[kelex-mic] unsupported sample format: {other:?}");
            std::process::exit(1);
        }
    }
    .expect("Failed to build input stream");

    stream.play().expect("Failed to play stream");
    eprintln!("[kelex-mic] capturing sr={sr} ch={channels} fmt={fmt:?}");

    drop(tx);
    let _ = writer.join();
}

fn mono_mix(data: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    let mut mono = Vec::with_capacity(data.len() / channels);
    for frame in data.chunks_exact(channels) {
        let sum: f32 = frame.iter().sum();
        mono.push(sum / channels as f32);
    }
    mono
}
