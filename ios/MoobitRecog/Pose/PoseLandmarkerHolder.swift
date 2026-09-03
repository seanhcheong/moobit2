import Foundation
import MediaPipeTasksVision
import CoreMedia
import CoreVideo

/// Renders an `OSType` as its four-character code, e.g. `BGRA` or `420f`.
///
/// Only used to make the pixel-format mismatch message below name what the camera actually sent.
/// Not every OSType is a character code — some are small integers — so this falls back to hex
/// rather than emitting control characters into a log line.
private func fourCC(_ value: OSType) -> String {
    let bytes = [
        UInt8((value >> 24) & 0xFF),
        UInt8((value >> 16) & 0xFF),
        UInt8((value >> 8) & 0xFF),
        UInt8(value & 0xFF),
    ]
    if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) {
        return String(decoding: bytes, as: UTF8.self)
    }
    return "0x" + String(value, radix: 16)
}

/// Owns the MediaPipe Pose Landmarker and the single "latest result" slot the frame processor
/// reads from. The iOS counterpart of `PoseLandmarkerHolder.kt`; the two are deliberately kept
/// behaviourally identical because the classifier that consumes them is shared TypeScript and
/// must not have to care which platform it is running on.
///
/// ## The central asynchrony fact
/// `.liveStream` mode means `detectAsync` returns immediately and results arrive later on the
/// delegate. A frame processor invocation therefore can **never** return landmarks for its own
/// frame — it returns the newest result available, from some earlier frame. That is the intent:
/// the product wants current state, not a backlog. `resultAgeMs` exposes exactly how stale the
/// result is so the harness can report latency honestly instead of implying a synchronous pipe.
///
/// ## Deliberate platform asymmetry vs Android
/// Android decimates the frame on the CPU before inference, because it has to do a YUV->RGB
/// conversion anyway and fusing a downscale into that pass is nearly free. iOS does **not**:
/// a `CVPixelBuffer` reaches MediaPipe as a Metal texture and is resized on the GPU, so an
/// extra CPU scaling pass here would cost time rather than save it. On iOS, resolution is
/// controlled by picking a smaller camera format from JS instead.
final class PoseLandmarkerHolder: NSObject {

    /// An immutable snapshot of one inference result.
    struct Snapshot {
        /// Flat `[x, y, z, visibility] * 33`, normalised to the upright (oriented) image.
        let flat: [Double]
        let landmarkCount: Int
        /// `CACurrentMediaTime() * 1000` when the result was delivered.
        let resultAtMs: Double
        /// Capture-clock timestamp of the frame this result came from.
        let frameCaptureMs: Double
        /// Wall time inside MediaPipe, measured submit -> delegate callback.
        let inferenceMs: Double
        let frameId: Int64
        let personDetected: Bool
    }

    static let landmarkCount = 33
    static let stride = 4

    private let lock = NSLock()
    private var latestSnapshot: Snapshot?

    private var landmarker: PoseLandmarker?
    private var inFlight = false
    private var lastSubmittedTsMs: Int = 0

    // Bookkeeping for the frame currently in flight, read by the delegate callback.
    private var inFlightSubmitAtMs: Double = 0
    private var inFlightCaptureMs: Double = 0
    private var inFlightFrameId: Int64 = 0
    private var frameIdSeq: Int64 = 0

    private(set) var delegateInUse = "none"
    private(set) var lastError: String?
    private(set) var framesSubmitted: Int64 = 0
    private(set) var framesDropped: Int64 = 0

    private let modelName: String
    private let preferGpu: Bool

    init(modelName: String = "pose_landmarker_lite", preferGpu: Bool = true) {
        self.modelName = modelName
        self.preferGpu = preferGpu
        super.init()
    }

    // MARK: - Lifecycle

    @discardableResult
    func ensureStarted() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if landmarker != nil { return true }

        guard let modelPath = Bundle.main.path(forResource: modelName, ofType: "task") else {
            lastError = "\(modelName).task is not in the app bundle. Run `npm run model:download`, "
                + "then drag the file into the Xcode target so it lands in Copy Bundle Resources."
            return false
        }

        // GPU first, CPU as a fallback: a device where GPU delegate creation fails would
        // otherwise present as "camera works, skeleton never appears", which is a miserable
        // thing to diagnose on a phone.
        let order: [MediaPipeTasksVision.Delegate] = preferGpu ? [.GPU, .CPU] : [.CPU]
        for delegate in order {
            let options = PoseLandmarkerOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.baseOptions.delegate = delegate
            options.runningMode = .liveStream
            options.numPoses = 1
            options.minPoseDetectionConfidence = 0.5
            options.minPosePresenceConfidence = 0.5
            options.minTrackingConfidence = 0.5
            options.shouldOutputSegmentationMasks = false
            options.poseLandmarkerLiveStreamDelegate = self

            do {
                landmarker = try PoseLandmarker(options: options)
                delegateInUse = delegate == .GPU ? "GPU" : "CPU"
                NSLog("[PoseLandmarkerHolder] started model=\(modelName) delegate=\(delegateInUse)")
                return true
            } catch {
                lastError = "PoseLandmarker(\(delegate == .GPU ? "GPU" : "CPU")) failed: \(error.localizedDescription)"
                NSLog("[PoseLandmarkerHolder] %@", lastError ?? "")
            }
        }
        return false
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        landmarker = nil
        latestSnapshot = nil
        inFlight = false
    }

    // MARK: - Submission

    /// Submit a frame unless inference is already busy.
    ///
    /// A single in-flight guard means frames arriving mid-inference are dropped and counted
    /// rather than queued. MediaPipe's graph has its own flow limiter, but relying on that
    /// would leave us unable to *report* the drop rate, which is one of the numbers we need.
    ///
    /// - Returns: `true` if submitted, `false` if dropped.
    func submit(sampleBuffer: CMSampleBuffer, orientation: UIImage.Orientation, captureMs: Double) -> Bool {
        lock.lock()
        guard let lm = landmarker else { lock.unlock(); return false }

        // MediaPipe accepts only 32BGRA from a CVPixelBuffer, and its own rejection
        // ("Unsupported pixel format for CVPixelBuffer") names the format it wanted but not the
        // knob that selects it — which is in JS, in a different language and file, on the
        // <Camera> component. Worse, it fires per frame and only into the Xcode console, so the
        // app presents as healthy and merely never produces a landmark. Checking first turns that
        // into one message that names the fix.
        if let pb = CMSampleBufferGetImageBuffer(sampleBuffer) {
            let fmt = CVPixelBufferGetPixelFormatType(pb)
            if fmt != kCVPixelFormatType_32BGRA && fmt != kCVPixelFormatType_Lossy_32BGRA {
                if lastError == nil {
                    lastError =
                        "camera is delivering \(fourCC(fmt)), MediaPipe requires 32BGRA on iOS — " +
                        "set pixelFormat=\"rgb\" on <Camera> (Android needs \"yuv\")"
                    NSLog("[PoseLandmarkerHolder] %@", lastError ?? "")
                }
                lock.unlock()
                return false
            }
        }

        if inFlight {
            framesDropped += 1
            lock.unlock()
            return false
        }
        inFlight = true

        // MediaPipe rejects non-monotonic liveStream timestamps outright.
        var ts = Int(captureMs.rounded())
        if ts <= lastSubmittedTsMs { ts = lastSubmittedTsMs + 1 }
        lastSubmittedTsMs = ts

        frameIdSeq += 1
        inFlightFrameId = frameIdSeq
        inFlightSubmitAtMs = CACurrentMediaTime() * 1000.0
        inFlightCaptureMs = captureMs
        lock.unlock()

        do {
            let image = try MPImage(sampleBuffer: sampleBuffer, orientation: orientation)
            try lm.detectAsync(image: image, timestampInMilliseconds: ts)
            lock.lock(); framesSubmitted += 1; lock.unlock()
            return true
        } catch {
            lock.lock()
            lastError = "detectAsync failed: \(error.localizedDescription)"
            inFlight = false
            lock.unlock()
            NSLog("[PoseLandmarkerHolder] detectAsync failed: %@", error.localizedDescription)
            return false
        }
    }

    func latest() -> Snapshot? {
        lock.lock()
        defer { lock.unlock() }
        return latestSnapshot
    }

    func statsSnapshot() -> (submitted: Int64, dropped: Int64, delegate: String, error: String?) {
        lock.lock()
        defer { lock.unlock() }
        return (framesSubmitted, framesDropped, delegateInUse, lastError)
    }
}

// MARK: - PoseLandmarkerLiveStreamDelegate

extension PoseLandmarkerHolder: PoseLandmarkerLiveStreamDelegate {
    func poseLandmarker(
        _ poseLandmarker: PoseLandmarker,
        didFinishDetection result: PoseLandmarkerResult?,
        timestampInMilliseconds: Int,
        error: Error?
    ) {
        let resultAt = CACurrentMediaTime() * 1000.0

        lock.lock()
        let submitAt = inFlightSubmitAtMs
        let captureMs = inFlightCaptureMs
        let frameId = inFlightFrameId
        // A failed inference still lands here; the guard must be released either way or the
        // pipeline wedges permanently.
        inFlight = false
        if let error = error {
            lastError = "detection failed: \(error.localizedDescription)"
            lock.unlock()
            return
        }
        lock.unlock()

        var flat = [Double](repeating: 0, count: Self.landmarkCount * Self.stride)
        var count = 0
        var detected = false

        if let poses = result?.landmarks, let first = poses.first {
            detected = !first.isEmpty
            count = min(first.count, Self.landmarkCount)
            for i in 0..<count {
                let l = first[i]
                let o = i * Self.stride
                flat[o] = Double(l.x)
                flat[o + 1] = Double(l.y)
                flat[o + 2] = Double(l.z)
                // Absent visibility means "fully visible", matching MediaPipe's convention.
                // The classifier gates on this, so a wrong default would silently disable
                // its visibility checks.
                flat[o + 3] = l.visibility?.doubleValue ?? 1.0
            }
        }

        let snap = Snapshot(
            flat: flat,
            landmarkCount: count,
            resultAtMs: resultAt,
            frameCaptureMs: captureMs,
            inferenceMs: resultAt - submitAt,
            frameId: frameId,
            personDetected: detected
        )

        lock.lock()
        latestSnapshot = snap
        lock.unlock()
    }
}
