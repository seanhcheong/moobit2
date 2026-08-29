/**
 * One Euro Filter over pose landmarks.
 *
 * Worklet-safe: no imports beyond sibling core modules, no allocation in the hot path.
 *
 * ## Why this filter
 * Raw landmarks jitter by a pixel or two every frame even when the subject is perfectly still.
 * Fed straight into angle maths that jitter becomes phase chatter and phantom reps. A plain
 * low-pass filter trades that away for lag, and lag is exactly what we cannot afford: this
 * stream is meant to drive character animation, where a smoothed-but-late limb reads as broken.
 *
 * The One Euro Filter (Casiez, Roussel & Vogel, CHI 2012) adapts its cutoff to the observed
 * speed: heavy smoothing while slow or still, opening up as motion gets fast. That is precisely
 * the shape of this problem — a still user should read rock-steady, and the bottom of a fast
 * squat should not arrive two frames late.
 *
 *     tau       = 1 / (2*pi*cutoff)
 *     alpha(c)  = 1 / (1 + tau/dt)
 *     dx        = (x - xPrev) / dt
 *     dxHat    <- alpha(dCutoff) applied to dx
 *     cutoff    = minCutoff + beta*|dxHat|
 *     xHat     <- alpha(cutoff) applied to x
 *
 * ## Where in the pipeline
 * Filtering happens AFTER the conversion to isotropic space (see `geometry.ts`) and BEFORE any
 * angle or distance maths. Filtering the raw normalised values instead would make one `beta`
 * mean two different physical speeds on a portrait frame, because `x` and `y` are normalised
 * against different pixel scales there. Doing it in isotropic units makes a single parameter
 * set correct on both axes.
 */

import { LANDMARK_COUNT } from './nativeContract';
import type { PoseView } from './geometry';

export interface OneEuroParams {
  /**
   * Cutoff frequency at zero speed, in Hz. Lower = steadier when still, but slower to respond.
   */
  minCutoff: number;
  /**
   * Speed coupling. Higher = opens the filter up more aggressively during fast motion, so less
   * lag at the cost of passing more jitter through.
   */
  beta: number;
  /** Cutoff for the derivative estimate itself, in Hz. Rarely needs tuning. */
  dCutoff: number;

  /**
   * Separate, deliberately heavier parameters for `z`.
   *
   * MediaPipe's monocular depth estimate is markedly noisier than `x`/`y`, so applying the
   * x/y parameters to it would let that extra noise straight through.
   */
  zMinCutoff: number;
  zBeta: number;

  /** Time constant for the visibility EMA, in seconds. Steadies the gating thresholds. */
  visTauSec: number;

  /**
   * A frame gap longer than this resets the filter instead of smoothing across it.
   *
   * After a pause, an app backgrounding or a tracking dropout, the previous sample says nothing
   * about the current one; blending them would drag a ghost limb across the frame.
   */
  resetGapSec: number;

  /** dt is clamped into this range so a bad timestamp cannot produce an absurd alpha. */
  minDtSec: number;
  maxDtSec: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = {
  // Starting points, to be tuned against recorded sessions via the replay CLI. minCutoff ~1 Hz
  // is a common baseline for human-scale motion at 30 fps; beta is the knob to reach for first
  // if fast reps feel laggy (raise it) or a still stance jitters (lower it).
  minCutoff: 1.0,
  beta: 0.02,
  dCutoff: 1.0,
  zMinCutoff: 0.4,
  zBeta: 0.005,
  visTauSec: 0.12,
  resetGapSec: 0.4,
  minDtSec: 1 / 240,
  maxDtSec: 0.2,
};

/**
 * Filter state for all 33 landmarks.
 *
 * Flat parallel arrays rather than per-landmark objects: 33 small objects re-read every frame
 * is exactly the allocation and pointer-chasing pattern worth avoiding on the thread that
 * decides our latency.
 */
export interface OneEuroBank {
  params: OneEuroParams;

  /** Previous raw values, per axis. */
  prevU: number[];
  prevV: number[];
  prevZ: number[];

  /** Filtered values, per axis. */
  hatU: number[];
  hatV: number[];
  hatZ: number[];

  /** Filtered derivative estimates, per axis. */
  dHatU: number[];
  dHatV: number[];
  dHatZ: number[];

  /** Smoothed visibility. */
  hatVis: number[];

  primed: boolean;
  lastTimeSec: number;

  /** Diagnostics for the debug readout and session summary. */
  resetCount: number;
  lastDtSec: number;
}

export function createOneEuroBank(params: OneEuroParams = DEFAULT_ONE_EURO): OneEuroBank {
  'worklet';
  const zeros = (): number[] => {
    const a: number[] = [];
    for (let i = 0; i < LANDMARK_COUNT; i++) a.push(0);
    return a;
  };
  return {
    params,
    prevU: zeros(),
    prevV: zeros(),
    prevZ: zeros(),
    hatU: zeros(),
    hatV: zeros(),
    hatZ: zeros(),
    dHatU: zeros(),
    dHatV: zeros(),
    dHatZ: zeros(),
    hatVis: zeros(),
    primed: false,
    lastTimeSec: 0,
    resetCount: 0,
    lastDtSec: 0,
  };
}

/** Drop all history. The next sample is passed through untouched. */
export function resetOneEuroBank(bank: OneEuroBank): void {
  'worklet';
  bank.primed = false;
  bank.lastTimeSec = 0;
  bank.resetCount++;
}

/** Replace the tuning parameters without losing filter history. */
export function setOneEuroParams(bank: OneEuroBank, params: OneEuroParams): void {
  'worklet';
  bank.params = params;
}

function alphaFor(cutoffHz: number, dtSec: number): number {
  'worklet';
  // tau = 1/(2*pi*fc);  alpha = 1/(1 + tau/dt)
  const tau = 1 / (6.283185307179586 * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

/**
 * Filter `src` into `dst`.
 *
 * `src` and `dst` must be distinct views: keeping the unfiltered pose available is what lets the
 * debug overlay draw raw and smoothed skeletons together, which is the only practical way to
 * tune `minCutoff`/`beta` by eye.
 *
 * @param timeSec monotonic timestamp of this sample, in seconds.
 * @returns true if `dst` now holds usable filtered data.
 */
export function applyOneEuro(
  bank: OneEuroBank,
  src: PoseView,
  dst: PoseView,
  timeSec: number,
): boolean {
  'worklet';
  if (!src.valid) {
    dst.valid = false;
    return false;
  }

  const p = bank.params;

  dst.aspect = src.aspect;
  dst.imageWidth = src.imageWidth;
  dst.imageHeight = src.imageHeight;
  dst.mirrored = src.mirrored;

  let dt = timeSec - bank.lastTimeSec;
  if (!bank.primed || dt <= 0 || dt > p.resetGapSec || dt !== dt) {
    if (bank.primed) bank.resetCount++;
    // Prime: the first sample after a reset is the filter's own starting estimate. Seeding
    // derivatives to zero rather than guessing avoids a spurious first-frame velocity spike
    // that would briefly widen the cutoff for no reason.
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      bank.prevU[i] = src.u[i];
      bank.prevV[i] = src.v[i];
      bank.prevZ[i] = src.z[i];
      bank.hatU[i] = src.u[i];
      bank.hatV[i] = src.v[i];
      bank.hatZ[i] = src.z[i];
      bank.dHatU[i] = 0;
      bank.dHatV[i] = 0;
      bank.dHatZ[i] = 0;
      bank.hatVis[i] = src.vis[i];

      dst.u[i] = src.u[i];
      dst.v[i] = src.v[i];
      dst.z[i] = src.z[i];
      dst.vis[i] = src.vis[i];
    }
    bank.primed = true;
    bank.lastTimeSec = timeSec;
    bank.lastDtSec = 0;
    dst.valid = true;
    return true;
  }

  if (dt < p.minDtSec) dt = p.minDtSec;
  else if (dt > p.maxDtSec) dt = p.maxDtSec;
  bank.lastDtSec = dt;

  const aD = alphaFor(p.dCutoff, dt);
  const aVis = dt / (p.visTauSec + dt);

  for (let i = 0; i < LANDMARK_COUNT; i++) {
    // ---- u ----
    const rawU = src.u[i];
    const dU = (rawU - bank.prevU[i]) / dt;
    const dHatU = bank.dHatU[i] + aD * (dU - bank.dHatU[i]);
    const aU = alphaFor(p.minCutoff + p.beta * (dHatU < 0 ? -dHatU : dHatU), dt);
    const hatU = bank.hatU[i] + aU * (rawU - bank.hatU[i]);

    // ---- v ----
    const rawV = src.v[i];
    const dV = (rawV - bank.prevV[i]) / dt;
    const dHatV = bank.dHatV[i] + aD * (dV - bank.dHatV[i]);
    const aV = alphaFor(p.minCutoff + p.beta * (dHatV < 0 ? -dHatV : dHatV), dt);
    const hatV = bank.hatV[i] + aV * (rawV - bank.hatV[i]);

    // ---- z (heavier parameters; noisier signal) ----
    const rawZ = src.z[i];
    const dZ = (rawZ - bank.prevZ[i]) / dt;
    const dHatZ = bank.dHatZ[i] + aD * (dZ - bank.dHatZ[i]);
    const aZ = alphaFor(p.zMinCutoff + p.zBeta * (dHatZ < 0 ? -dHatZ : dHatZ), dt);
    const hatZ = bank.hatZ[i] + aZ * (rawZ - bank.hatZ[i]);

    // ---- visibility (plain EMA; it only gates, it is not measured) ----
    const hatVis = bank.hatVis[i] + aVis * (src.vis[i] - bank.hatVis[i]);

    bank.prevU[i] = rawU;
    bank.prevV[i] = rawV;
    bank.prevZ[i] = rawZ;
    bank.dHatU[i] = dHatU;
    bank.dHatV[i] = dHatV;
    bank.dHatZ[i] = dHatZ;
    bank.hatU[i] = hatU;
    bank.hatV[i] = hatV;
    bank.hatZ[i] = hatZ;
    bank.hatVis[i] = hatVis;

    dst.u[i] = hatU;
    dst.v[i] = hatV;
    dst.z[i] = hatZ;
    dst.vis[i] = hatVis;
  }

  bank.lastTimeSec = timeSec;
  dst.valid = true;
  return true;
}
