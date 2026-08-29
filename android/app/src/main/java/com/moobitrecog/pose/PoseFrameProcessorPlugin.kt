package com.moobitrecog.pose

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.VisionCameraProxy
import kotlin.math.abs

/**
 * VisionCamera frame processor plugin: camera frame -> MediaPipe Pose Landmarker -> landmarks.
 *
 * Runs on VisionCamera's dedicated frame-processor thread and returns its result straight over
 * JSI, so no part of this path touches the React Native bridge or the JS thread.
 *
 * ## Return shape (consumed by src/core/nativeContract.ts)
 * Landmarks come back as ONE flat list of `[x, y, z, visibility] * 33` rather than 33 objects.
 * Crossing JSI with 132 numbers in a single array costs one conversion; 33 objects with four
 * properties each costs 132 property writes plus 33 object allocations, every frame. The core
 * indexes into the flat layout directly.
 *
 * ## Rotation and mirroring are arguments, not assumptions
 * `rotationDegrees` is passed in from JS each frame rather than inferred here. Getting rotation
 * wrong on a floor-mounted portrait phone is the single easiest way to produce plausible-looking
 * but silently wrong joint angles, so it is deliberately a value the harness can display, flip
 * and verify against the overlay rather than a hidden native default.
 */
class PoseFrameProcessorPlugin(
    proxy: VisionCameraProxy,
    @Suppress("UNUSED_PARAMETER") options: Map<String, Any>?,
) : FrameProcessorPlugin() {

    private val holder = PoseLandmarkerHolder(proxy.context.applicationContext)

    private var reusableBitmap: Bitmap? = null
    private var scratch: IntArray? = null

    /** Which clock `Frame.timestamp` lives in. Probed once; see [captureMsFor]. */
    private var clockDomain = ClockDomain.UNKNOWN

    private var framesSeen = 0L

    private enum class ClockDomain { UNKNOWN, ELAPSED_REALTIME, NANOTIME, UNUSABLE }

    override fun callback(frame: Frame, arguments: Map<String, Any>?): Any? {
        val arrivalMs = SystemClock.elapsedRealtime()
        framesSeen++

        if (!holder.ensureStarted()) {
            return errorResult("pose landmarker unavailable: ${holder.lastError ?: "unknown"}", arrivalMs)
        }

        val rotationDegrees = normaliseRotation((arguments?.get("rotationDegrees") as? Number)?.toInt() ?: 0)
        val targetLongEdge = (arguments?.get("targetLongEdge") as? Number)?.toInt() ?: DEFAULT_TARGET_LONG_EDGE

        val captureMs = captureMsFor(frame, arrivalMs)

        var submitted = false
        var decimateMs = 0.0
        var step = 1

        try {
            val image = frame.image
            val t0 = SystemClock.elapsedRealtimeNanos()
            val dec = YuvDecimator.decimate(
                image = image,
                targetLongEdge = targetLongEdge,
                sampling = YuvDecimator.Sampling.BOX_2X2,
                reuse = reusableBitmap,
                scratch = scratch,
            )
            decimateMs = (SystemClock.elapsedRealtimeNanos() - t0) / 1e6
            reusableBitmap = dec.bitmap
            scratch = dec.scratch
            step = dec.step

            submitted = holder.submit(dec.bitmap, rotationDegrees, captureMs)
        } catch (t: Throwable) {
            Log.e(TAG, "frame conversion failed", t)
            return errorResult("frame conversion failed: ${t.message}", arrivalMs)
        }

        // LIVE_STREAM is asynchronous, so this is the newest result available *now* — it is not
        // this frame's result. resultAgeMs quantifies exactly how stale it is.
        val snap = holder.latest()
        val stats = holder.stats

        val out = HashMap<String, Any>(16)
        out["ok"] = true
        out["nowMs"] = arrivalMs.toDouble()
        out["captureMs"] = captureMs.toDouble()
        out["captureClock"] = clockDomain.name
        out["rotationDegrees"] = rotationDegrees.toDouble()
        out["frameMirrored"] = frame.isMirrored
        out["decimateMs"] = decimateMs
        out["decimateStep"] = step.toDouble()
        out["submitted"] = submitted
        out["delegate"] = stats.delegate
        out["framesSubmitted"] = stats.submitted.toDouble()
        out["framesDropped"] = stats.dropped.toDouble()
        stats.lastError?.let { out["warning"] = it }

        if (snap == null) {
            out["hasResult"] = false
            return out
        }

        val flat = ArrayList<Double>(snap.flat.size)
        for (v in snap.flat) flat.add(v)

        out["hasResult"] = true
        out["personDetected"] = snap.personDetected
        out["landmarks"] = flat
        out["landmarkCount"] = snap.landmarkCount.toDouble()
        out["imageWidth"] = snap.imageWidth.toDouble()
        out["imageHeight"] = snap.imageHeight.toDouble()
        out["frameId"] = snap.frameId.toDouble()
        out["resultCaptureMs"] = snap.frameCaptureMs.toDouble()
        out["resultAtMs"] = snap.resultAtMs.toDouble()
        out["inferenceMs"] = snap.inferenceMs
        out["resultAgeMs"] = (arrivalMs - snap.resultAtMs).toDouble()
        return out
    }

    private fun errorResult(message: String, nowMs: Long): Map<String, Any> = mapOf(
        "ok" to false,
        "hasResult" to false,
        "error" to message,
        "nowMs" to nowMs.toDouble(),
    )

    private fun normaliseRotation(deg: Int): Int {
        val r = ((deg % 360) + 360) % 360
        // MediaPipe accepts only right-angle rotations.
        return when {
            r < 45 || r >= 315 -> 0
            r < 135 -> 90
            r < 225 -> 180
            else -> 270
        }
    }

    /**
     * Convert `Frame.timestamp` (nanoseconds) into the `elapsedRealtime()` millisecond domain.
     *
     * Camera2 presentation timestamps come from either `elapsedRealtimeNanos` or `nanoTime`
     * depending on the device's `SENSOR_INFO_TIMESTAMP_SOURCE`, and silently mixing the two
     * produces latency figures that are wrong by however long the device has been asleep —
     * i.e. arbitrarily, and in a way that looks like a real measurement. So probe once, on the
     * first frame, by asking which clock the timestamp is actually near.
     *
     * If neither matches, fall back to the frame's arrival time and say so via `captureClock`:
     * that under-reports true end-to-end latency by the sensor-to-plugin transport time, which
     * is a knowable caveat rather than a silent lie.
     */
    private fun captureMsFor(frame: Frame, arrivalMs: Long): Long {
        val tsNs = try {
            frame.timestamp
        } catch (t: Throwable) {
            clockDomain = ClockDomain.UNUSABLE
            return arrivalMs
        }

        if (clockDomain == ClockDomain.UNKNOWN) {
            val erNs = SystemClock.elapsedRealtimeNanos()
            val ntNs = System.nanoTime()
            val dEr = abs(erNs - tsNs)
            val dNt = abs(ntNs - tsNs)
            clockDomain = when {
                dEr <= dNt && dEr < CLOCK_PROBE_TOLERANCE_NS -> ClockDomain.ELAPSED_REALTIME
                dNt < dEr && dNt < CLOCK_PROBE_TOLERANCE_NS -> ClockDomain.NANOTIME
                else -> ClockDomain.UNUSABLE
            }
            Log.i(
                TAG,
                "frame timestamp clock probe: domain=$clockDomain " +
                    "dElapsedRealtime=${dEr / 1_000_000}ms dNanoTime=${dNt / 1_000_000}ms",
            )
        }

        return when (clockDomain) {
            ClockDomain.ELAPSED_REALTIME -> tsNs / 1_000_000
            ClockDomain.NANOTIME -> arrivalMs - (System.nanoTime() - tsNs) / 1_000_000
            else -> arrivalMs
        }
    }

    companion object {
        private const val TAG = "PoseFrameProcessor"
        private const val DEFAULT_TARGET_LONG_EDGE = 320
        private const val CLOCK_PROBE_TOLERANCE_NS = 1_000_000_000L // 1s
    }
}
