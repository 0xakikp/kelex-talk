use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=macos/microphone_capture.m");

    let target = env::var("TARGET").expect("Cargo TARGET is set");
    if target.ends_with("apple-darwin") {
        let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let source = manifest.join("macos/microphone_capture.m");
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let object = out_dir.join("microphone_capture.o");
        let library = out_dir.join("libkelex_mic.a");

        let compile = Command::new("xcrun")
            .args([
                "clang",
                "-fobjc-arc",
                "-mmacosx-version-min=10.15",
                "-c",
            ])
            .arg(&source)
            .arg("-o")
            .arg(&object)
            .output()
            .expect("Xcode command-line tools are required to compile native microphone capture");
        if !compile.status.success() {
            panic!(
                "Objective-C microphone capture failed to compile:\n{}",
                String::from_utf8_lossy(&compile.stderr)
            );
        }

        let archive = Command::new("xcrun")
            .args(["libtool", "-static", "-o"])
            .arg(&library)
            .arg(&object)
            .output()
            .expect("Xcode libtool is required to archive native microphone capture");
        if !archive.status.success() {
            panic!(
                "Objective-C microphone capture failed to archive:\n{}",
                String::from_utf8_lossy(&archive.stderr)
            );
        }

        println!("cargo:rustc-link-search=native={}", out_dir.display());
        println!("cargo:rustc-link-lib=static=kelex_mic");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }

    tauri_build::build()
}
