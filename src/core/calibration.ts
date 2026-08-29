/**
 * Per-session standing calibration.
 *
 * Worklet-safe.
 *
 * ## What this buys
 * Every phase threshold in the system is expressed relative to what *this* user looks like
 * standing still in front of *this* camera at *this* tilt and distance. Measurements on the
 * actual geometry (`npm run probe:signals`) showed the observed squat knee-angle range varying
 * from 24.5 to 34.5 degrees across bodies from 1.55 m to 1.95 m tall, and from 25.8 to 29.8
 * degrees as the phone's tilt moves between 10 and 40 degrees. Absolute thresholds cannot
 * survive that; a baseline plus relative thresholds can.
 *
 * ## Why the gates are strict
 * A baseline captured while the user was still settling is worse than no baseline at all,
 * because it silently biases every subsequent rep. So the capture demands genuine stillness,
 * adequate visibility, and correct framing for its full duration, and it reports *why* it is
 * failing so the harness can tell the user what to fix instead of just spinning.
 */

import { median } from './geometry';
import type { Features } from './features';

/** The captured neutral-standing reference for one session. */
export interface Baseline {
  /** Wall-clock ms at capture, for the session log. */
  capturedAtMs: number;
  /** How many frames contributed. */
  sampleCount: number;

  // ---- Primary depth-signal anchors --------------------------------------------------------
  /** Standing value of {@link Features.hipRatio}. Typically ~0.67 in this setup. */
  hipRatio: number;
  /** Standing value of {@link Features.shoulderOverWrist}, if the arms happened to be down. */
  shoulderOverWrist: number;

  // ---- Shape references --------------------------------------------------------------------
  torsoOverShoulderWidth: number;
  stanceRatio: number;
  thighShankRatio: number;
  bboxAspect: number;

  // ---- Angle references --------------------------------------------------------------------
  kneeAngle: number;
  hipAngle: number;
  elbowAngle: number;
  torsoLeanDeg: number;

  // ---- Scale references --------------------------------------------------------------------
  shoulderWidth: number;
  torsoLen: number;
  bodyScale: number;
  bodySpanV: number;

  /** Where the hips sit between shoulders and ankles as a fraction: `(hipV-shV)/(ankV-shV)`. */
  hipFrac: number;

  // ---- Framing references ------------------------------------------------------------------
  topV: number;
  bottomV: number;
  /** Apparent head-to-ankle height as a fraction of frame height. Drives "step closer/back". */
  bodyHeightFrac: number;

  /** Standing ankle separation, in body scales. Non-zero stance width is normal. */
  ankleSepU: number;
  ankleSepV: number;
  ankleSepZ: number;
}

export type CalibrationRejectReason =
  | 'no-pose'
  | 'low-visibility'
  | 'moving'
  | 'ankles-not-visible'
  | 'out-of-frame'
  | 'bad-geometry';

export interface CalibrationConfig {
  /** How long the user must hold still, in seconds. */
  durationSec: number;
  /** Minimum accepted samples; guards against calibrating off three frames. */
  minSamples: number;
  /** Max mean landmark speed, in body scales per second, to count as "still". */
  maxSpeed: number;
  /** Minimum visibility across the core landmarks. */
  minCoreVisibility: number;
  /** Minimum mean ankle visibility. Standing calibration needs the feet. */
  minAnkleVisibility: number;
  /**
   * A run of rejected frames this long resets progress.
   *
   * Without it a user who fidgets for 20 seconds would eventually accumulate enough scattered
   * "still" frames to pass, having never actually held a steady pose.
   */
  resetAfterRejectedFrames: number;
  /** Accepted head-to-ankle span, as a fraction of frame height. */
  minBodyHeightFrac: number;
  maxBodyHeightFrac: number;
  /** Required margin from the frame edges, in normalised units. */
  edgeMargin: number;
}

export const DEFAULT_CALIBRATION: CalibrationConfig = {
  durationSec: 2.0,
  minSamples: 30,
  // A person standing still still sways; measurements on the synthetic body put quiet sway at
  // well under 0.05 body scales/sec, while a deliberate movement is an order of magnitude more.
  maxSpeed: 0.12,
  minCoreVisibility: 0.6,
  minAnkleVisibility: 0.5,
  resetAfterRejectedFrames: 8,
  minBodyHeightFrac: 0.22,
  maxBodyHeightFrac: 0.85,
  edgeMargin: 0.02,
};

export interface CalibrationState {
  config: CalibrationConfig;
  active: boolean;
  startedAtSec: number;
  /** Time of the first accepted sample in the current unbroken run. */
  runStartSec: number;
  consecutiveRejects: number;
  lastReject: CalibrationRejectReason | null;

  // Accumulated samples, one array per metric so the median is cheap to take.
  hipRatio: number[];
  shoulderOverWrist: number[];
  torsoOverShoulderWidth: number[];
  stanceRatio: number[];
  thighShankRatio: number[];
  bboxAspect: number[];
  kneeAngle: number[];
  hipAngle: number[];
  elbowAngle: number[];
  torsoLeanDeg: number[];
  shoulderWidth: number[];
  torsoLen: number[];
  bodyScale: number[];
  bodySpanV: number[];
  hipFrac: number[];
  topV: number[];
  bottomV: number[];
  ankleSepU: number[];
  ankleSepV: number[];
  ankleSepZ: number[];
}

export function createCalibrationState(
  config: CalibrationConfig = DEFAULT_CALIBRATION,
): CalibrationState {
  'worklet';
  return {
    config,
    active: false,
    startedAtSec: 0,
    runStartSec: 0,
    consecutiveRejects: 0,
    lastReject: null,
    hipRatio: [],
    shoulderOverWrist: [],
    torsoOverShoulderWidth: [],
    stanceRatio: [],
    thighShankRatio: [],
    bboxAspect: [],
    kneeAngle: [],
    hipAngle: [],
    elbowAngle: [],
    torsoLeanDeg: [],
    shoulderWidth: [],
    torsoLen: [],
    bodyScale: [],
    bodySpanV: [],
    hipFrac: [],
    topV: [],
    bottomV: [],
    ankleSepU: [],
    ankleSepV: [],
    ankleSepZ: [],
  };
}

function clearSamples(s: CalibrationState): void {
  'worklet';
  s.hipRatio.length = 0;
  s.shoulderOverWrist.length = 0;
  s.torsoOverShoulderWidth.length = 0;
  s.stanceRatio.length = 0;
  s.thighShankRatio.length = 0;
  s.bboxAspect.length = 0;
  s.kneeAngle.length = 0;
  s.hipAngle.length = 0;
  s.elbowAngle.length = 0;
  s.torsoLeanDeg.length = 0;
  s.shoulderWidth.length = 0;
  s.torsoLen.length = 0;
  s.bodyScale.length = 0;
  s.bodySpanV.length = 0;
  s.hipFrac.length = 0;
  s.topV.length = 0;
  s.bottomV.length = 0;
  s.ankleSepU.length = 0;
  s.ankleSepV.length = 0;
  s.ankleSepZ.length = 0;
}

export function startCalibration(s: CalibrationState, nowSec: number): void {
  'worklet';
  clearSamples(s);
  s.active = true;
  s.startedAtSec = nowSec;
  s.runStartSec = nowSec;
  s.consecutiveRejects = 0;
  s.lastReject = null;
}

export function cancelCalibration(s: CalibrationState): void {
  'worklet';
  s.active = false;
  clearSamples(s);
}

export interface CalibrationProgress {
  active: boolean;
  /** 0..1 fraction of the required hold that has been achieved. */
  progress: number;
  samples: number;
  /** Non-null when the most recent frame was rejected, saying why. */
  reject: CalibrationRejectReason | null;
  /** Set on the frame the capture completes. */
  baseline: Baseline | null;
}

/**
 * Feed one frame into the calibration capture.
 *
 * @param nowMs wall-clock time, recorded on the baseline for the session log.
 */
export function stepCalibration(
  s: CalibrationState,
  f: Features,
  nowMs: number,
): CalibrationProgress {
  'worklet';
  const out: CalibrationProgress = {
    active: s.active,
    progress: 0,
    samples: s.hipRatio.length,
    reject: null,
    baseline: null,
  };
  if (!s.active) return out;

  const cfg = s.config;
  const reject = validateFrame(f, cfg);

  if (reject !== null) {
    s.lastReject = reject;
    s.consecutiveRejects++;
    if (s.consecutiveRejects >= cfg.resetAfterRejectedFrames) {
      clearSamples(s);
      s.runStartSec = f.timeSec;
    }
    out.reject = reject;
    out.samples = s.hipRatio.length;
    out.progress = progressOf(s, f.timeSec);
    return out;
  }

  s.consecutiveRejects = 0;
  s.lastReject = null;
  if (s.hipRatio.length === 0) s.runStartSec = f.timeSec;

  s.hipRatio.push(f.hipRatio);
  s.shoulderOverWrist.push(f.shoulderOverWrist);
  s.torsoOverShoulderWidth.push(f.torsoOverShoulderWidth);
  s.stanceRatio.push(f.stanceRatio);
  s.thighShankRatio.push(f.thighShankRatio);
  s.bboxAspect.push(f.bboxAspect);
  s.kneeAngle.push(f.kneeAngle);
  s.hipAngle.push(f.hipAngle);
  s.elbowAngle.push(f.elbowAngle);
  s.torsoLeanDeg.push(f.torsoLeanDeg);
  s.shoulderWidth.push(f.shoulderWidth);
  s.torsoLen.push(f.torsoLen);
  s.bodyScale.push(f.bodyScale);
  s.bodySpanV.push(f.bodySpanV);
  const span = f.ankleMidV - f.shoulderMidV;
  s.hipFrac.push(Math.abs(span) < 1e-5 ? NaN : (f.hipMidV - f.shoulderMidV) / span);
  s.topV.push(f.topV);
  s.bottomV.push(f.bottomV);
  s.ankleSepU.push(f.ankleSepU);
  s.ankleSepV.push(f.ankleSepV);
  s.ankleSepZ.push(f.ankleSepZ);

  out.samples = s.hipRatio.length;
  out.progress = progressOf(s, f.timeSec);

  const held = f.timeSec - s.runStartSec;
  if (held >= cfg.durationSec && s.hipRatio.length >= cfg.minSamples) {
    out.baseline = finalize(s, nowMs);
    s.active = false;
    out.active = false;
    out.progress = 1;
  }

  return out;
}

function progressOf(s: CalibrationState, nowSec: number): number {
  'worklet';
  if (s.hipRatio.length === 0) return 0;
  const byTime = (nowSec - s.runStartSec) / s.config.durationSec;
  const bySamples = s.hipRatio.length / s.config.minSamples;
  // Whichever requirement is further from being met is the honest progress figure.
  const p = byTime < bySamples ? byTime : bySamples;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

function validateFrame(f: Features, cfg: CalibrationConfig): CalibrationRejectReason | null {
  'worklet';
  if (!f.valid) return 'no-pose';
  if (f.visCore < cfg.minCoreVisibility) return 'low-visibility';
  if (f.visAnkles < cfg.minAnkleVisibility) return 'ankles-not-visible';

  const height = f.bottomV - f.topV;
  if (
    f.topV < cfg.edgeMargin ||
    f.bottomV > 1 - cfg.edgeMargin ||
    height < cfg.minBodyHeightFrac ||
    height > cfg.maxBodyHeightFrac
  ) {
    return 'out-of-frame';
  }

  if (f.hipRatio !== f.hipRatio || f.kneeAngle !== f.kneeAngle || f.torsoLen <= 0) {
    return 'bad-geometry';
  }

  // Checked last so that a user who is out of frame is told *that*, rather than being told to
  // hold still while they are already still in the wrong place.
  if (f.meanLandmarkSpeed > cfg.maxSpeed) return 'moving';

  return null;
}

/**
 * Reduce the accumulated samples to a baseline.
 *
 * Median rather than mean throughout: a single frame of mis-tracking during the hold — a leg
 * landmark snapping to the other leg, say — would drag a mean by several degrees, and the whole
 * point of the baseline is that everything downstream trusts it.
 */
function finalize(s: CalibrationState, nowMs: number): Baseline {
  'worklet';
  const topV = median(s.topV);
  const bottomV = median(s.bottomV);
  return {
    capturedAtMs: nowMs,
    sampleCount: s.hipRatio.length,
    hipRatio: median(s.hipRatio),
    shoulderOverWrist: median(s.shoulderOverWrist),
    torsoOverShoulderWidth: median(s.torsoOverShoulderWidth),
    stanceRatio: median(s.stanceRatio),
    thighShankRatio: median(s.thighShankRatio),
    bboxAspect: median(s.bboxAspect),
    kneeAngle: median(s.kneeAngle),
    hipAngle: median(s.hipAngle),
    elbowAngle: median(s.elbowAngle),
    torsoLeanDeg: median(s.torsoLeanDeg),
    shoulderWidth: median(s.shoulderWidth),
    torsoLen: median(s.torsoLen),
    bodyScale: median(s.bodyScale),
    bodySpanV: median(s.bodySpanV),
    hipFrac: median(s.hipFrac),
    topV,
    bottomV,
    bodyHeightFrac: bottomV - topV,
    ankleSepU: median(s.ankleSepU),
    ankleSepV: median(s.ankleSepV),
    ankleSepZ: median(s.ankleSepZ),
  };
}

/**
 * A synthetic baseline for offline work, so the replay CLI and tests can exercise classifier
 * logic without first simulating a calibration hold. Not for use on device.
 */
export function baselineFromFeatures(f: Features, nowMs: number): Baseline {
  'worklet';
  const span = f.ankleMidV - f.shoulderMidV;
  return {
    capturedAtMs: nowMs,
    sampleCount: 1,
    hipRatio: f.hipRatio,
    shoulderOverWrist: f.shoulderOverWrist,
    torsoOverShoulderWidth: f.torsoOverShoulderWidth,
    stanceRatio: f.stanceRatio,
    thighShankRatio: f.thighShankRatio,
    bboxAspect: f.bboxAspect,
    kneeAngle: f.kneeAngle,
    hipAngle: f.hipAngle,
    elbowAngle: f.elbowAngle,
    torsoLeanDeg: f.torsoLeanDeg,
    shoulderWidth: f.shoulderWidth,
    torsoLen: f.torsoLen,
    bodyScale: f.bodyScale,
    bodySpanV: f.bodySpanV,
    hipFrac: Math.abs(span) < 1e-5 ? NaN : (f.hipMidV - f.shoulderMidV) / span,
    topV: f.topV,
    bottomV: f.bottomV,
    bodyHeightFrac: f.bottomV - f.topV,
    ankleSepU: f.ankleSepU,
    ankleSepV: f.ankleSepV,
    ankleSepZ: f.ankleSepZ,
  };
}
