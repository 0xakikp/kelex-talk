use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=macos/kelex_mic.swift");

    let target = env::var("TARGET").expect("Cargo TARGET is set");
    println!("cargo:rustc-env=KELEX_MIC_TARGET={target}");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let output = manifest.join("bin").join(format!("kelex_mic-{target}"));
    if target.ends_with("apple-darwin") {
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        let source = manifest.join("macos/kelex_mic.swift");
        let swift_target = match target.as_str() {
            "aarch64-apple-darwin" => "arm64-apple-macosx10.15",
            "x86_64-apple-darwin" => "x86_64-apple-macosx10.15",
            other => panic!("unsupported macOS target for kelex_mic: {other}"),
        };

        let result = Command::new("xcrun")
            .args([
                "swiftc",
                "-O",
                "-whole-module-optimization",
                "-target",
                swift_target,
                "-framework",
                "AVFoundation",
                "-framework",
                "Foundation",
            ])
            .arg(&source)
            .arg("-o")
            .arg(&output)
            .output()
            .expect("Xcode command-line tools are required to build the native Kelex microphone helper");

        if !result.status.success() {
            panic!(
                "Swift AVAudioEngine helper failed to compile:\n{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    } else {
        // Tauri validates externalBin for every Cargo target.  This generated
        // stub exists only to let Linux CI/VPS checks run; Kelex does not ship
        // a Linux desktop microphone sidecar.
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        std::fs::write(&output, b"#!/bin/sh\necho 'kelex_mic is macOS-only' >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    tauri_build::build()
}
