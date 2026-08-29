package com.moobitrecog.pose

import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Owns the MediaPipe Pose Landmarker and the single "latest result" slot the frame processor
 * reads from.
 *
 * ## The central asynchrony fact
 * We run in `RunningMode.LIVE_STREAM`, so `detectAsync()` returns immediately and results
 * arrive later on MediaPipe's own callback thread. A frame processor invocation therefore can
 * **never** return landmarks for its own frame — it returns the most recent result available,
 * which came from some earlier frame. This is deliberate: the product wants *current state*,
 * not a backlog. [latest] exposes how stale that result is so the JS side can report latency
 * honestly rather than pretending the pipeline is synchronous.
 *
 * ## Frame dropping
 * A single in-flight guard means that while inference is running, arriving frames are dropped
 * on the floor and counted, rather than queued. MediaPipe's task graph also has its own flow
 * limiter, but relying on that would leave us unable to *report* the drop rate, which is one of
 * the numbers we actually need.
 */
class PoseLandmarkerHolder(
    private val context: Context,
    private val modelAsset: String = DEFAULT_MODEL,
    private val preferGpu: Boolean = true,
) {

    /** An immutable snapshot of one inference result, safe to hand across threads. */
    class Snapshot(
        /** Flat [x, y, z, visibility] * 33, normalised to the upright (rotated) image. */
        val flat: DoubleArray,
        val landmarkCount: Int,
        /** `SystemClock.elapsedRealtime()` when this result was delivered to us. */
        val resultAtMs: Long,
        /** The capture-clock timestamp of the frame this result came from. */
        val frameCaptureMs: Long,
        /** Wall time inside MediaPipe for this frame, measured submit -> callback. */
        val inferenceMs: Double,
        /** Upright image dimensions the coordinates are normalised against. */
        val imageWidth: Int,
        val imageHeight: Int,
        val frameId: Long,
        val personDetected: Boolean,
    )

    private val latestRef = AtomicReference<Snapshot?>(null)
    private val inFlight = AtomicBoolean(false)
    private val droppedFrames = AtomicLong(0)
    private val submittedFrames = AtomicLong(0)
    private val frameIdSeq = AtomicLong(0)

    /** Guards MediaPipe's requirement that LIVE_STREAM timestamps strictly increase. */
    private var lastSubmittedTsMs = 0L

    /** Per-frame bookkeeping for the frame currently in flight, read by the result callback. */
    @Volatile private var inFlightSubmitAtMs = 0L
    @Volatile private var inFlightCaptureMs = 0L
    @Volatile private var inFlightWidth = 0
    @Volatile private var inFlightHeight = 0
    @Volatile private var inFlightFrameId = 0L

    @Volatile var delegateInUse: String = "none"
        private set

    @Volatile var lastError: String? = null
        private set

    private var landmarker: PoseLandmarker? = null

    val stats: Stats
        get() = Stats(
            submitted = submittedFrames.get(),
            dropped = droppedFrames.get(),
            delegate = delegateInUse,
            lastError = lastError,
        )

    data class Stats(val submitted: Long, val dropped: Long, val delegate: String, val lastError: String?)

    @Synchronized
    fun ensureStarted(): Boolean {
        if (landmarker != null) return true

        // GPU first, CPU as a fallback. A device where GPU delegate creation fails would
        // otherwise present as "camera works, no skeleton ever appears", which is a miserable
        // thing to debug on a phone.
        val order = if (preferGpu) listOf(Delegate.GPU, Delegate.CPU) else listOf(Delegate.CPU)
        for (delegate in order) {
            try {
                val base = BaseOptions.builder()
                    .setModelAssetPath(modelAsset)
                    .setDelegate(delegate)
                    .build()

                val options = PoseLandmarker.PoseLandmarkerOptions.builder()
                    .setBaseOptions(base)
                    .setRunningMode(RunningMode.LIVE_STREAM)
                    .setNumPoses(1)
                    .setMinPoseDetectionConfidence(MIN_POSE_DETECTION_CONFIDENCE)
                    .setMinPosePresenceConfidence(MIN_POSE_PRESENCE_CONFIDENCE)
                    .setMinTrackingConfidence(MIN_TRACKING_CONFIDENCE)
                    .setOutputSegmentationMasks(false)
                    .setResultListener { result, input -> onResult(result, input.width, input.height) }
                    .setErrorListener { err ->
                        lastError = err.message
                        Log.e(TAG, "pose landmarker error", err)
                        // A failed inference never calls the result listener, so the in-flight
                        // guard must be released here or the pipeline wedges permanently.
                        inFlight.set(false)
                    }
                    .build()

                landmarker = PoseLandmarker.createFromOptions(context, options)
                delegateInUse = delegate.name
                Log.i(TAG, "pose landmarker started: model=$modelAsset delegate=${delegate.name}")
                return true
            } catch (t: Throwable) {
                lastError = "createFromOptions(${delegate.name}) failed: ${t.message}"
                Log.w(TAG, "delegate ${delegate.name} unavailable", t)
            }
        }
        return false
    }

    @Synchronized
    fun close() {
        try {
            landmarker?.close()
        } catch (t: Throwable) {
            Log.w(TAG, "close failed", t)
        }
        landmarker = null
        latestRef.set(null)
        inFlight.set(false)
    }

    /**
     * Submit a frame, unless inference is already busy.
     *
     * @param bitmap already decimated to inference size, in the source's own orientation.
     * @param rotationDegrees clockwise rotation needed to make the image upright. Handed to
     *   MediaPipe so the rotation happens on the GPU rather than costing us a CPU pass; note
     *   the returned coordinates are then normalised against the *rotated* image.
     * @param captureMs capture-clock timestamp of this frame, carried through to the result.
     * @return true if the frame was submitted, false if it was dropped.
     */
    fun submit(bitmap: Bitmap, rotationDegrees: Int, captureMs: Long): Boolean {
        val lm = landmarker ?: return false

        if (!inFlight.compareAndSet(false, true)) {
            droppedFrames.incrementAndGet()
            return false
        }

        val now = SystemClock.elapsedRealtime()
        // MediaPipe rejects non-monotonic LIVE_STREAM timestamps outright.
        var ts = captureMs
        if (ts <= lastSubmittedTsMs) ts = lastSubmittedTsMs + 1
        lastSubmittedTsMs = ts

        val upright = if (rotationDegrees == 90 || rotationDegrees == 270) {
            bitmap.height to bitmap.width
        } else {
            bitmap.width to bitmap.height
        }

        inFlightSubmitAtMs = now
        inFlightCaptureMs = captureMs
        inFlightWidth = upright.first
        inFlightHeight = upright.second
        inFlightFrameId = frameIdSeq.incrementAndGet()

        return try {
            val mpImage = BitmapImageBuilder(bitmap).build()
            val ipo = ImageProcessingOptions.builder()
                .setRotationDegrees(rotationDegrees)
                .build()
            lm.detectAsync(mpImage, ipo, ts)
            submittedFrames.incrementAndGet()
            true
        } catch (t: Throwable) {
            lastError = "detectAsync failed: ${t.message}"
            Log.e(TAG, "detectAsync failed", t)
            inFlight.set(false)
            false
        }
    }

    fun latest(): Snapshot? = latestRef.get()

    private fun onResult(result: PoseLandmarkerResult, imageWidth: Int, imageHeight: Int) {
        val resultAt = SystemClock.elapsedRealtime()
        val inferenceMs = (resultAt - inFlightSubmitAtMs).toDouble()

        val poses = result.landmarks()
        val flat = DoubleArray(LANDMARK_COUNT * STRIDE)
        var detected = false
        var count = 0

        if (poses.isNotEmpty()) {
            val lms = poses[0]
            detected = lms.isNotEmpty()
            count = minOf(lms.size, LANDMARK_COUNT)
            for (i in 0 until count) {
                val l = lms[i]
                val o = i * STRIDE
                flat[o] = l.x().toDouble()
                flat[o + 1] = l.y().toDouble()
                flat[o + 2] = l.z().toDouble()
                // Absent visibility is treated as fully visible, matching MediaPipe's own
                // convention; the classifier gates on this so a wrong default here would
                // silently disable the visibility checks.
                flat[o + 3] = if (l.visibility().isPresent) l.visibility().get().toDouble() else 1.0
            }
        }

        latestRef.set(
            Snapshot(
                flat = flat,
                landmarkCount = count,
                resultAtMs = resultAt,
                frameCaptureMs = inFlightCaptureMs,
                inferenceMs = inferenceMs,
                // MediaPipe reports the image size it actually worked on; prefer it over our
                // own arithmetic, falling back if the task ever reports zeroes.
                imageWidth = if (imageWidth > 0) imageWidth else inFlightWidth,
                imageHeight = if (imageHeight > 0) imageHeight else inFlightHeight,
                frameId = inFlightFrameId,
                personDetected = detected,
            ),
        )

        inFlight.set(false)
    }

    companion object {
        private const val TAG = "PoseLandmarkerHolder"

        const val DEFAULT_MODEL = "pose_landmarker_lite.task"
        const val LANDMARK_COUNT = 33
        const val STRIDE = 4

        // Deliberately permissive. The classifier does its own visibility and confidence
        // gating in shared TypeScript, where it is tunable without a rebuild; filtering
        // aggressively here would only hide signal from it.
        private const val MIN_POSE_DETECTION_CONFIDENCE = 0.5f
        private const val MIN_POSE_PRESENCE_CONFIDENCE = 0.5f
        private const val MIN_TRACKING_CONFIDENCE = 0.5f
    }
}
