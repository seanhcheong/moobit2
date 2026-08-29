package com.moobitrecog.pose

import android.graphics.Bitmap
import android.media.Image

/**
 * Fused YUV_420_888 -> ARGB conversion **and** downscale in a single decimating pass.
 *
 * Why fused: the camera hands us ~1280x720 (921k px) but Pose Landmarker only needs a
 * ~256-320 px long edge. Converting the full frame and *then* calling
 * `Bitmap.createScaledBitmap` costs a full-resolution colour conversion plus a full-resolution
 * allocation and resample — several milliseconds of pure waste on every frame, on the thread
 * that decides our end-to-end latency. Instead we walk only the *output* pixels and sample the
 * source planes directly, so the work is proportional to the small target size
 * (320x180 = 57.6k px) rather than the source size.
 *
 * RenderScript is deprecated and a JVM loop over a full-res frame is far too slow, which is
 * what makes decimate-while-converting the right call here rather than merely a nice one.
 *
 * No rotation is applied. Rotation is handed to MediaPipe via `ImageProcessingOptions`
 * so it happens on the GPU alongside inference instead of costing us another CPU pass.
 */
object YuvDecimator {

    /** Sampling strategy for the decimating pass. */
    enum class Sampling {
        /** One source pixel per output pixel. Cheapest; aliases on high-frequency detail. */
        NEAREST,

        /** Average a 2x2 luma neighbourhood. ~1.7x the luma reads, noticeably less aliasing. */
        BOX_2X2,
    }

    /**
     * Convert and downscale so that the longer edge of the result is at most [targetLongEdge].
     *
     * @param reuse a bitmap from a previous call to draw into, to avoid a per-frame allocation.
     *   Reused only if its dimensions match exactly; otherwise a new one is created.
     * @return an ARGB_8888 bitmap in the source's own orientation (i.e. NOT rotated upright).
     */
    fun decimate(
        image: Image,
        targetLongEdge: Int,
        sampling: Sampling = Sampling.BOX_2X2,
        reuse: Bitmap? = null,
        scratch: IntArray? = null,
    ): Result {
        require(image.format == android.graphics.ImageFormat.YUV_420_888) {
            "expected YUV_420_888, got format ${image.format}"
        }

        val srcW = image.width
        val srcH = image.height

        // Integer step keeps the inner loop free of float accumulation and guarantees we never
        // read past a plane. A step of 1 means "no downscale needed".
        val longEdge = maxOf(srcW, srcH)
        val step = maxOf(1, longEdge / maxOf(1, targetLongEdge))
        val outW = srcW / step
        val outH = srcH / step

        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]

        val yBuf = yPlane.buffer
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer

        val yRowStride = yPlane.rowStride
        val yPixStride = yPlane.pixelStride
        val uRowStride = uPlane.rowStride
        val uPixStride = uPlane.pixelStride
        val vRowStride = vPlane.rowStride
        val vPixStride = vPlane.pixelStride

        val pixels = if (scratch != null && scratch.size >= outW * outH) scratch else IntArray(outW * outH)

        var out = 0
        for (oy in 0 until outH) {
            val sy = oy * step
            val yRow = sy * yRowStride
            val cy = sy / 2
            val uRow = cy * uRowStride
            val vRow = cy * vRowStride

            // Second luma row for BOX_2X2, clamped to stay inside the plane.
            val sy2 = if (sy + 1 < srcH) sy + 1 else sy
            val yRow2 = sy2 * yRowStride

            for (ox in 0 until outW) {
                val sx = ox * step

                val luma: Int = when (sampling) {
                    Sampling.NEAREST -> yBuf.get(yRow + sx * yPixStride).toInt() and 0xFF
                    Sampling.BOX_2X2 -> {
                        val sx2 = if (sx + 1 < srcW) sx + 1 else sx
                        val a = yBuf.get(yRow + sx * yPixStride).toInt() and 0xFF
                        val b = yBuf.get(yRow + sx2 * yPixStride).toInt() and 0xFF
                        val c = yBuf.get(yRow2 + sx * yPixStride).toInt() and 0xFF
                        val d = yBuf.get(yRow2 + sx2 * yPixStride).toInt() and 0xFF
                        (a + b + c + d) shr 2
                    }
                }

                // Chroma is 2x2 subsampled, so it is always sampled nearest.
                val cx = sx / 2
                val u = (uBuf.get(uRow + cx * uPixStride).toInt() and 0xFF) - 128
                val v = (vBuf.get(vRow + cx * vPixStride).toInt() and 0xFF) - 128

                // Full-range BT.601, in fixed point (<<10). Camera2 YUV_420_888 output is
                // full-range on essentially all devices; a small colour error here is
                // irrelevant to landmark detection, whereas a float multiply per channel per
                // pixel is not irrelevant to latency.
                val r = luma + ((1436 * v) shr 10)
                val g = luma - ((352 * u + 731 * v) shr 10)
                val b = luma + ((1815 * u) shr 10)

                pixels[out++] = (0xFF shl 24) or
                    (clamp8(r) shl 16) or
                    (clamp8(g) shl 8) or
                    clamp8(b)
            }
        }

        val bmp = if (reuse != null && !reuse.isRecycled && reuse.width == outW && reuse.height == outH) {
            reuse
        } else {
            Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
        }
        bmp.setPixels(pixels, 0, outW, 0, 0, outW, outH)

        return Result(bitmap = bmp, scratch = pixels, sourceWidth = srcW, sourceHeight = srcH, step = step)
    }

    private fun clamp8(v: Int): Int = if (v < 0) 0 else if (v > 255) 255 else v

    data class Result(
        val bitmap: Bitmap,
        /** The pixel buffer, handed back so the caller can pass it in again next frame. */
        val scratch: IntArray,
        val sourceWidth: Int,
        val sourceHeight: Int,
        /** Decimation factor actually used (1 = no downscale). */
        val step: Int,
    )
}
