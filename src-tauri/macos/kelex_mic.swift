import AVFoundation
import Darwin
import Foundation

// kelex_mic — native macOS microphone sidecar.
//
// Protocol on stdout:
//   u32 little-endian sample rate, u16 little-endian channel count (= 1),
//   then mono Float32 little-endian PCM frames.
// Diagnostics only ever go to stderr.

private let stdout = FileHandle.standardOutput
private let stderr = FileHandle.standardError
private let outputQueue = DispatchQueue(label: "in.akikp.kelex.mic-output", qos: .userInitiated)

private func diagnostic(_ message: String) {
    guard let data = message.data(using: .utf8) else { return }
    try? stderr.write(contentsOf: data)
}

private func requireMicrophoneAccess() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .notDetermined:
        let done = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { allowed in
            granted = allowed
            done.signal()
        }
        done.wait()
        return granted
    case .denied, .restricted:
        return false
    @unknown default:
        return false
    }
}

private func writeHeader(sampleRate: Double) {
    var rate = UInt32(sampleRate.rounded()).littleEndian
    var channels = UInt16(1).littleEndian
    var data = Data()
    withUnsafeBytes(of: &rate) { data.append(contentsOf: $0) }
    withUnsafeBytes(of: &channels) { data.append(contentsOf: $0) }
    try? stdout.write(contentsOf: data)
}

private func monoData(_ buffer: AVAudioPCMBuffer) -> Data? {
    guard let channelData = buffer.floatChannelData else { return nil }
    let frames = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    guard frames > 0, channels > 0 else { return nil }

    var mono = [Float](repeating: 0, count: frames)
    for channel in 0..<channels {
        let samples = channelData[channel]
        for frame in 0..<frames {
            mono[frame] += samples[frame]
        }
    }
    if channels > 1 {
        let divisor = Float(channels)
        for frame in 0..<frames { mono[frame] /= divisor }
    }

    return mono.withUnsafeBufferPointer { samples in
        guard let base = samples.baseAddress else { return nil }
        return Data(bytes: base, count: samples.count * MemoryLayout<Float>.size)
    }
}

guard requireMicrophoneAccess() else {
    diagnostic("[kelex-mic] microphone access denied; enable Kelex in System Settings → Privacy & Security → Microphone\n")
    exit(77)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let hardware = input.outputFormat(forBus: 0)
guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
    diagnostic("[kelex-mic] invalid microphone input format\n")
    exit(1)
}

guard let tapFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: hardware.sampleRate,
    channels: hardware.channelCount,
    interleaved: false
) else {
    diagnostic("[kelex-mic] could not create Float32 microphone format\n")
    exit(1)
}

input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat) { buffer, _ in
    // AVAudioPCMBuffer is valid only during this callback. Copy before
    // dispatching so pipe backpressure can never retain CoreAudio memory.
    guard let pcm = monoData(buffer) else { return }
    outputQueue.async {
        try? stdout.write(contentsOf: pcm)
    }
}

engine.prepare()
do {
    try engine.start()
} catch {
    diagnostic("[kelex-mic] AVAudioEngine start failed: \(error)\n")
    exit(1)
}

writeHeader(sampleRate: tapFormat.sampleRate)
diagnostic("[kelex-mic] AVAudioEngine capturing sr=\(Int(tapFormat.sampleRate)) ch=\(hardware.channelCount)\n")
dispatchMain()
