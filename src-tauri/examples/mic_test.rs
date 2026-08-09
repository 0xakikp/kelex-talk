use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() {
    let host = cpal::default_host();
    let device = host.default_input_device().expect("No input device");
    let desc = device.description().expect("No device description");
    eprintln!("Device: {}", desc.name());

    let config = device.default_input_config().expect("No default config");
    eprintln!("Config: sample_rate={}, channels={}, format={:?}",
        config.sample_rate(), config.channels(), config.sample_format());

    let cfg: cpal::StreamConfig = config.into();
    let max_rms = Arc::new(Mutex::new(0.0f32));
    let max_rms2 = max_rms.clone();
    let sample_count = Arc::new(Mutex::new(0usize));
    let sample_count2 = sample_count.clone();
    let nonzero_count = Arc::new(Mutex::new(0usize));
    let nonzero_count2 = nonzero_count.clone();

    let stream = device.build_input_stream(
        cfg,
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            let mut sc = sample_count2.lock().unwrap();
            *sc += data.len();

            let mut nz = nonzero_count2.lock().unwrap();
            for &s in data {
                if s != 0.0 {
                    *nz += 1;
                }
            }

            let sum: f32 = data.iter().map(|s| s * s).sum();
            let rms = (sum / data.len() as f32).sqrt();
            let mut max = max_rms2.lock().unwrap();
            if rms > *max {
                *max = rms;
            }
        },
        |e| eprintln!("Error: {e}"),
        None,
    ).expect("Failed to build stream");

    stream.play().expect("Failed to play stream");
    eprintln!("Recording for 5 seconds... speak into the mic!");

    for i in 1..=5 {
        std::thread::sleep(Duration::from_secs(1));
        let rms = *max_rms.lock().unwrap();
        let sc = *sample_count.lock().unwrap();
        let nz = *nonzero_count.lock().unwrap();
        eprintln!("[{i}s] samples={sc} non_zero={nz} max_rms={rms:.6}");
    }

    drop(stream);
    let final_rms = *max_rms.lock().unwrap();
    let final_nz = *nonzero_count.lock().unwrap();
    let final_sc = *sample_count.lock().unwrap();
    eprintln!("\nResult: {final_sc} total samples, {final_nz} non-zero, max_rms={final_rms:.6}");
    if final_rms == 0.0 {
        eprintln!("⚠  ALL ZEROS — CPAL CoreAudio is not delivering real audio on this system.");
    } else {
        eprintln!("✅ Mic is working via CPAL!");
    }
}
