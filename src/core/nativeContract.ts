/**
 * The native -> JS contract for the pose frame processor.
 *
 * Implemented by:
 *   - android/app/src/main/java/com/moobitrecog/pose/PoseFrameProcessorPlugin.kt
 *   - ios/MoobitRecog/Pose/PoseFrameProcessorPlugin.swift
 *
 * Both platforms return exactly this shape. Keep the three in step: there is no compiler
 * checking the boundary, so a field renamed on one side and not the other fails silently at
 * runtime as an `undefined` that quietly poisons the maths downstream.
 *
 * This module is part of the worklet-safe core: no imports, no platform APIs, pure data.
 */

/** Number of landmarks MediaPipe Pose emits. */
export const LANDMARK_COUNT = 33;

/**
 * Stride of the flat landmark array: `[x, y, z, visibility]` per landmark.
 *
 * Landmarks cross JSI as one flat numeric array rather than 33 objects — one conversion
 * instead of 132 property writes plus 33 allocations, on every frame.
 */
export const LM_STRIDE = 4;

/** Offsets within one landmark's stride. */
export const LM_X = 0;
export const LM_Y = 1;
export const LM_Z = 2;
export const LM_VIS = 3;

/** Expected length of a well-formed flat landmark array. */
export const FLAT_LANDMARK_LENGTH = LANDMARK_COUNT * LM_STRIDE;

/**
 * Which clock the native side found the camera's frame timestamp to live in.
 *
 * `UNUSABLE` means the probe could not match the frame timestamp to any known clock and the
 * plugin fell back to the frame's *arrival* time at the plugin. Capture latency is then
 * under-reported by the sensor-to-plugin transport time (typically 5-15 ms) — a knowable
 * caveat rather than a silent lie, and the harness surfaces it.
 */
export type CaptureClock = 'UNKNOWN' | 'ELAPSED_REALTIME' | 'NANOTIME' | 'HOST_TIME' | 'UNUSABLE';

/** A frame processor invocation that failed before it could submit anything. */
export interface NativePoseError {
  ok: false;
  hasResult: false;
  error: string;
  nowMs: number;
}

/** A successful frame processor invocation. May or may not carry a landmark result yet. */
export interface NativePoseOk {
  ok: true;

  /** Native clock reading at the moment the frame processor was entered, in ms. */
  nowMs: number;

  /** Capture timestamp of *this* frame, in the same clock domain as `nowMs`. */
  captureMs: number;

  /** Which clock `captureMs` came from; see {@link CaptureClock}. */
  captureClock: CaptureClock;

  /** Clockwise rotation applied to make the image upright, as passed in from JS. */
  rotationDegrees: number;

  /** Whether the camera pipeline reports this frame as mirrored (front camera). */
  frameMirrored: boolean;

  /** Time spent in the CPU decimate/convert pass. Always 0 on iOS, which resizes on the GPU. */
  decimateMs: number;

  /** Decimation factor used (1 = none). Android only. */
  decimateStep: number;

  /** False when this frame was dropped because inference was already busy. */
  submitted: boolean;

  /** Which MediaPipe delegate is actually in use: 'GPU', 'CPU', or 'none'. */
  delegate: string;

  framesSubmitted: number;
  framesDropped: number;

  /** Non-fatal native warning, e.g. a delegate fallback or a transient detection error. */
  warning?: string;

  /**
   * Whether a landmark result exists yet.
   *
   * False for the first few frames of a session while the first inference is still in flight.
   */
  hasResult: boolean;

  // ---- Present only when hasResult is true -------------------------------------------------

  /** Whether the newest result actually contains a person. */
  personDetected?: boolean;

  /**
   * Flat `[x, y, z, visibility] * 33`.
   *
   * `x` is normalised to the upright image's WIDTH and `y` to its HEIGHT, so on a non-square
   * frame the two axes have different pixel scales. Angles computed directly on these values
   * are wrong; see `geometry.ts` for the correction that must be applied first.
   *
   * `z` is a monocular depth estimate, roughly in the same unit as `x`, with its origin near
   * the hip midpoint. It is markedly noisier than x/y — see the z ruling in docs/DESIGN.md.
   */
  landmarks?: number[];

  /** How many landmarks were actually populated (0 when no person was found). */
  landmarkCount?: number;

  /** Upright image dimensions the coordinates are normalised against, in pixels. */
  imageWidth?: number;
  imageHeight?: number;

  /** Monotonic id of the frame this result came from. */
  frameId?: number;

  /** Capture timestamp of the frame this result came from (NOT the current frame). */
  resultCaptureMs?: number;

  /** Native clock reading when this result was delivered by MediaPipe. */
  resultAtMs?: number;

  /** Wall time inside MediaPipe for this result, measured submit -> callback. */
  inferenceMs?: number;

  /**
   * How stale the result is: `nowMs - resultAtMs`.
   *
   * Under async LIVE_STREAM the newest available result is always from an earlier frame. This
   * is the honest measure of that gap and it belongs in the reported latency, not hidden.
   */
  resultAgeMs?: number;
}

export type NativePoseResult = NativePoseOk | NativePoseError;

/** Narrowing helper: did the invocation succeed *and* carry usable landmarks? */
export function hasLandmarks(
  r: NativePoseResult | null | undefined,
): r is NativePoseOk & { landmarks: number[] } {
  'worklet';
  return (
    !!r &&
    r.ok === true &&
    r.hasResult === true &&
    Array.isArray((r as NativePoseOk).landmarks) &&
    (r as NativePoseOk).landmarks!.length >= FLAT_LANDMARK_LENGTH
  );
}
