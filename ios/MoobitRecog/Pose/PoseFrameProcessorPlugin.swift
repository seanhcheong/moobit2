import Foundation
import VisionCamera
import CoreMedia
import UIKit

/// VisionCamera frame processor plugin: camera frame -> MediaPipe Pose Landmarker -> landmarks.
///
/// Runs on VisionCamera's dedicated frame-processor thread and returns its result over JSI, so
/// no part of this path touches the React Native bridge or the JS thread.
///
/// ## Return shape (consumed by src/core/nativeContract.ts)
/// Landmarks come back as ONE flat array of `[x, y, z, visibility] * 33` rather than 33 objects.
/// Crossing JSI with 132 numbers in a single array is one conversion; 33 objects with four
/// properties each is 132 property writes plus 33 allocations, every frame. The shared core
/// indexes into the flat layout directly.
///
/// ## Orientation is an argument, not an assumption
/// `rotationDegrees` comes in from JS each frame rather than being inferred here. Getting
/// rotation wrong on a floor-mounted portrait phone is the easiest way to produce
/// plausible-looking but silently wrong joint angles, so it is deliberately a value the harness
/// can display, flip and verify against the overlay rather than a hidden native default.
@objc(PoseFrameProcessorPlugin)
public class PoseFrameProcessorPlugin: FrameProcessorPlugin {

    private let holder = PoseLandmarkerHolder()

    // Signature matched against VisionCamera's own header, which declares
    //   - (instancetype)initWithProxy:(VisionCameraProxyHolder*)proxy
    //                    withOptions:(NSDictionary* _Nullable)options NS_SWIFT_NAME(init(proxy:options:));
    // so `options` imports into Swift as an optional dictionary.
    public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]?) {
        super.init(proxy: proxy, options: options)
    }

    public override func callback(_ frame: Frame, withArguments arguments: [AnyHashable: Any]?) -> Any? {
        // iOS presentation timestamps and CACurrentMediaTime share the mach host clock, so
        // capture-to-now needs no clock probing here — unlike Android, where the camera
        // timestamp source varies by device.
        let nowMs = CACurrentMediaTime() * 1000.0

        guard holder.ensureStarted() else {
            return [
                "ok": false,
                "hasResult": false,
                "error": holder.lastError ?? "pose landmarker unavailable",
                "nowMs": nowMs,
            ]
        }

        let rotationDegrees = normaliseRotation((arguments?["rotationDegrees"] as? NSNumber)?.intValue ?? 0)
        // VisionCamera's `Frame.timestamp` is already the presentation timestamp in milliseconds
        // (CMTimeGetSeconds(pts) * 1000), so there is no reason to re-derive it from the buffer.
        let captureMs = frame.timestamp
        let captureUsable = captureMs.isFinite && captureMs > 0

        let submitted = holder.submit(
            sampleBuffer: frame.buffer,
            orientation: orientationFor(rotationDegrees),
            captureMs: captureUsable ? captureMs : nowMs
        )

        // liveStream is asynchronous, so this is the newest result available *now* — it is not
        // this frame's result. resultAgeMs quantifies exactly how stale it is.
        let snap = holder.latest()
        let stats = holder.statsSnapshot()

        // The upright image dimensions the normalised coordinates refer to. MediaPipe reports
        // coordinates against the *oriented* image, so the axes swap for quarter turns.
        let quarterTurn = rotationDegrees == 90 || rotationDegrees == 270
        let uprightW = quarterTurn ? frame.height : frame.width
        let uprightH = quarterTurn ? frame.width : frame.height

        var out: [String: Any] = [
            "ok": true,
            "nowMs": nowMs,
            "captureMs": captureUsable ? captureMs : nowMs,
            "captureClock": captureUsable ? "HOST_TIME" : "UNUSABLE",
            "rotationDegrees": Double(rotationDegrees),
            "frameMirrored": frame.isMirrored,
            // Downscaling is handled by camera-format selection plus MediaPipe's own GPU
            // resize on this platform, so there is no CPU decimation pass to report.
            "decimateMs": 0.0,
            "decimateStep": 1.0,
            "submitted": submitted,
            "delegate": stats.delegate,
            "framesSubmitted": Double(stats.submitted),
            "framesDropped": Double(stats.dropped),
        ]
        if let err = stats.error { out["warning"] = err }

        guard let snap = snap else {
            out["hasResult"] = false
            return out
        }

        out["hasResult"] = true
        out["personDetected"] = snap.personDetected
        out["landmarks"] = snap.flat
        out["landmarkCount"] = Double(snap.landmarkCount)
        out["imageWidth"] = Double(uprightW)
        out["imageHeight"] = Double(uprightH)
        out["frameId"] = Double(snap.frameId)
        out["resultCaptureMs"] = snap.frameCaptureMs
        out["resultAtMs"] = snap.resultAtMs
        out["inferenceMs"] = snap.inferenceMs
        out["resultAgeMs"] = nowMs - snap.resultAtMs
        return out
    }

    private func normaliseRotation(_ deg: Int) -> Int {
        let r = ((deg % 360) + 360) % 360
        // MediaPipe accepts only right-angle rotations.
        switch r {
        case ..<45: return 0
        case ..<135: return 90
        case ..<225: return 180
        case ..<315: return 270
        default: return 0
        }
    }

    /// Map "clockwise degrees needed to make the image upright" onto the EXIF-style orientation
    /// MediaPipe expects. `MPImage` applies the orientation itself, on the GPU, so we never pay
    /// for a CPU rotate.
    private func orientationFor(_ rotationDegrees: Int) -> UIImage.Orientation {
        switch rotationDegrees {
        case 90: return .right
        case 180: return .down
        case 270: return .left
        default: return .up
        }
    }
}
