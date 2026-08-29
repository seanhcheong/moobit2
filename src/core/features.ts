/**
 * Per-frame feature extraction: smoothed landmarks -> the scalar signals every classifier reads.
 *
 * Worklet-safe: no imports outside the core, no allocation once a {@link Features} object exists.
 *
 * ## Why ratios rather than angles
 * Measurements on the actual camera placement (see `src/dev/probeSignals.ts`, reproducible with
 * `npm run probe:signals`) showed that from a head-on floor camera the squat knee angle collapses
 * from a true 117-degree range to about 29 degrees of *observed* range: knee flexion happens
 * almost entirely along the camera's depth axis, which barely projects into the image. Worse, that
 * residual range varies by +/-17% with body height, so a knee-angle threshold calibrated on one
 * person does not transfer to another.
 *
 * Ratios of image-space distances behave far better, because dividing one apparent length by
 * another cancels the projective scale factor they share:
 *
 *   hipRatio           full excursion 0.192, varies +/-4% with body height, +/-2.4% with tilt
 *   knee angle         full excursion 29 deg, varies +/-17% with height, +/-7% with tilt
 *
 * So the ratios are the primary depth signals and the joint angles are corroborators — they must
 * move in the expected direction for a rep to count, but they do not define depth. Every field
 * below records which role it plays.
 */

import {
  angleFromVerticalDeg,
  clamp01,
  jointAngleDeg,
  lmDist,
  meanAngle,
  meanVisibility,
  midU,
  midV,
  midZ,
  minVisibility,
  type PoseView,
} from './geometry';
import { CORE_LANDMARKS, LM } from './landmarks';

/**
 * Minimum z spread across the core landmarks for z to be considered informative.
 *
 * A standing body spans roughly 0.1-0.3 in MediaPipe's z units from shoulders to hips, so a
 * spread below this means the channel is dead rather than the person being flat.
 */
export const Z_USABLE_MIN_SPREAD = 0.02;

export interface Features {
  /** Monotonic time of this sample, in seconds. */
  timeSec: number;
  /** Seconds since the previous feature computation; 0 on the first frame. */
  dtSec: number;
  /** False when the pose was unusable and every field below is stale. */
  valid: boolean;

  // ---- Midpoints, in isotropic image space -------------------------------------------------
  shoulderMidU: number;
  shoulderMidV: number;
  hipMidU: number;
  hipMidV: number;
  kneeMidU: number;
  kneeMidV: number;
  ankleMidU: number;
  ankleMidV: number;
  wristMidU: number;
  wristMidV: number;
  hipMidZ: number;

  // ---- Scale references --------------------------------------------------------------------
  /** Shoulder-to-shoulder distance. Nearly invariant to body pose, hence a good denominator. */
  shoulderWidth: number;
  /** Shoulder-midpoint to hip-midpoint distance. Shortens as the torso turns toward the lens. */
  torsoLen: number;
  /** A never-zero scale for normalising distances. */
  bodyScale: number;
  /** Apparent shoulder-to-ankle vertical span. */
  bodySpanV: number;

  // ---- PRIMARY depth signals ---------------------------------------------------------------
  /**
   * Where the hips sit between ankles and shoulders: `(ankleV - hipV) / (ankleV - shoulderV)`.
   *
   * Primary depth signal for squat and lunge. ~0.67 standing, ~0.48 at the bottom of a deep
   * squat. A pure ratio of image distances, so it is free of absolute scale and therefore of
   * the user's exact distance from the camera. Requires visible ankles, which standing
   * exercises have.
   */
  hipRatio: number;

  /**
   * Shoulder height above the planted wrists, in shoulder widths:
   * `(wristV - shoulderV) / shoulderWidth`.
   *
   * Primary depth signal for the push-up: ~1.32 at the top, ~0.86 at the bottom, a 35% relative
   * excursion. Uses only shoulders and wrists — the landmarks a floor-level camera sees best
   * during a push-up, since the hands are planted nearest the lens.
   */
  shoulderOverWrist: number;

  // ---- Shape / orientation signals ---------------------------------------------------------
  /**
   * `torsoLen / shoulderWidth`. Corroborating depth signal for the push-up and a strong
   * orientation cue: about 1.1 for an upright body seen side-on, but foreshortened to ~0.54 for
   * a head-on push-up, falling to ~0.34 at the bottom.
   */
  torsoOverShoulderWidth: number;

  /** `(ankleV - shoulderV) / torsoLen`. Large when standing, small when horizontal. */
  stanceRatio: number;

  /**
   * Mean apparent thigh length over mean apparent shank length.
   *
   * Squat corroborator with excellent body-height invariance (excursion varies by under 0.5%
   * across 1.55-1.95 m), though it is more tilt-sensitive than `hipRatio`.
   */
  thighShankRatio: number;

  /** Bounding-box aspect over the core landmarks: width / height. High when horizontal. */
  bboxAspect: number;

  // ---- Joint angles, in degrees (corroborators, not primary) --------------------------------
  kneeAngleL: number;
  kneeAngleR: number;
  kneeAngle: number;
  hipAngleL: number;
  hipAngleR: number;
  hipAngle: number;
  elbowAngleL: number;
  elbowAngleR: number;
  elbowAngle: number;

  /** Shoulder-hip vector away from vertical: 0 upright, 90 horizontal. */
  torsoLeanDeg: number;

  /** Shoulder-hip-knee interior angle, averaged over both sides. ~180 for a rigid plank. */
  shoulderHipKneeDeg: number;

  /** Shoulder-hip-ankle interior angle. Only meaningful when the ankles are visible. */
  shoulderHipAnkleDeg: number;

  /**
   * Signed deviation of the hips from the straight shoulder-to-knee line, in shoulder widths.
   *
   * Positive means the hips hang below the line. This is the push-up rigidity signal: a hinging
   * "cheat" rep sweeps the shoulders through a full range while the hips collapse independently.
   */
  plankSag: number;

  // ---- Left/right separations --------------------------------------------------------------
  /** Ankle separation along image vertical, in body scales. */
  ankleSepV: number;
  /** Ankle separation along image horizontal (lateral stance width), in body scales. */
  ankleSepU: number;
  /** Ankle separation in MediaPipe z. Separates a lunge from a squat from the very first frame. */
  ankleSepZ: number;

  /** Signed left-minus-right ankle z. Negative means the LEFT ankle is nearer the camera. */
  ankleDz: number;
  /** Signed left-minus-right knee image-v. Negative means the LEFT knee is higher in frame. */
  kneeDv: number;
  /** Apparent left shank length minus right, in body scales. Positive means left is longer. */
  shankLenDiff: number;
  /** Ratio of apparent shank lengths, left over right. */
  shankLenRatio: number;

  // ---- Velocities (per second) --------------------------------------------------------------
  hipRatioVel: number;
  shoulderOverWristVel: number;
  kneeAngleVel: number;
  elbowAngleVel: number;
  /** Mean absolute landmark speed over the core set, in body scales per second. */
  meanLandmarkSpeed: number;

  // ---- Signal availability -----------------------------------------------------------------
  /** Spread of MediaPipe z across the core landmarks: `max(z) - min(z)`. */
  zSpread: number;
  /**
   * Whether z carries usable information this frame.
   *
   * Critical to get right, and easy to get wrong. Absent or collapsed z leaves every z-derived
   * separation reading exactly zero — and "ankle separation in z is zero" is precisely the
   * evidence that says *squat* rather than *lunge*. Treated naively, missing data therefore votes
   * confidently for the wrong answer instead of abstaining. Classifiers must check this flag and
   * withhold their z terms when it is false, so the decision falls back to the z-free signals.
   */
  zUsable: boolean;

  // ---- Visibility aggregates ---------------------------------------------------------------
  visCore: number;
  visAnkles: number;
  visKnees: number;
  visWrists: number;
  visElbows: number;

  // ---- Framing -----------------------------------------------------------------------------
  /** Topmost and bottommost image-v over the framing landmarks. */
  topV: number;
  bottomV: number;
  leftU: number;
  rightU: number;
}

export function createFeatures(): Features {
  'worklet';
  return {
    timeSec: 0,
    dtSec: 0,
    valid: false,
    shoulderMidU: 0,
    shoulderMidV: 0,
    hipMidU: 0,
    hipMidV: 0,
    kneeMidU: 0,
    kneeMidV: 0,
    ankleMidU: 0,
    ankleMidV: 0,
    wristMidU: 0,
    wristMidV: 0,
    hipMidZ: 0,
    shoulderWidth: 0,
    torsoLen: 0,
    bodyScale: 1,
    bodySpanV: 0,
    hipRatio: NaN,
    shoulderOverWrist: NaN,
    torsoOverShoulderWidth: NaN,
    stanceRatio: NaN,
    thighShankRatio: NaN,
    bboxAspect: NaN,
    kneeAngleL: NaN,
    kneeAngleR: NaN,
    kneeAngle: NaN,
    hipAngleL: NaN,
    hipAngleR: NaN,
    hipAngle: NaN,
    elbowAngleL: NaN,
    elbowAngleR: NaN,
    elbowAngle: NaN,
    torsoLeanDeg: NaN,
    shoulderHipKneeDeg: NaN,
    shoulderHipAnkleDeg: NaN,
    plankSag: NaN,
    ankleSepV: NaN,
    ankleSepU: NaN,
    ankleSepZ: NaN,
    ankleDz: NaN,
    kneeDv: NaN,
    shankLenDiff: NaN,
    shankLenRatio: NaN,
    hipRatioVel: 0,
    shoulderOverWristVel: 0,
    kneeAngleVel: 0,
    elbowAngleVel: 0,
    meanLandmarkSpeed: 0,
    zSpread: 0,
    zUsable: false,
    visCore: 0,
    visAnkles: 0,
    visKnees: 0,
    visWrists: 0,
    visElbows: 0,
    topV: 0,
    bottomV: 0,
    leftU: 0,
    rightU: 0,
  };
}

/** Scratch state for velocity estimation, so features stay a pure function of view + history. */
export interface FeatureHistory {
  primed: boolean;
  lastTimeSec: number;
  lastHipRatio: number;
  lastShoulderOverWrist: number;
  lastKneeAngle: number;
  lastElbowAngle: number;
  lastU: number[];
  lastV: number[];
}

export function createFeatureHistory(): FeatureHistory {
  'worklet';
  const u: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < 33; i++) {
    u.push(0);
    v.push(0);
  }
  return {
    primed: false,
    lastTimeSec: 0,
    lastHipRatio: NaN,
    lastShoulderOverWrist: NaN,
    lastKneeAngle: NaN,
    lastElbowAngle: NaN,
    lastU: u,
    lastV: v,
  };
}

export function resetFeatureHistory(h: FeatureHistory): void {
  'worklet';
  h.primed = false;
}

/** Rate of change, returning 0 rather than a spike when either sample is missing. */
function rate(now: number, before: number, dtSec: number): number {
  'worklet';
  if (dtSec <= 0 || now !== now || before !== before) return 0;
  return (now - before) / dtSec;
}

/**
 * Compute all features from a smoothed pose.
 *
 * @param out reused across frames; nothing is allocated here.
 * @returns `out.valid`, for convenience.
 */
export function computeFeatures(
  view: PoseView,
  history: FeatureHistory,
  timeSec: number,
  out: Features,
): boolean {
  'worklet';
  out.timeSec = timeSec;

  if (!view.valid) {
    out.valid = false;
    out.dtSec = 0;
    return false;
  }

  const dtSec = history.primed ? Math.max(0, timeSec - history.lastTimeSec) : 0;
  out.dtSec = dtSec;

  // ---- Midpoints ---------------------------------------------------------------------------
  out.shoulderMidU = midU(view, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  out.shoulderMidV = midV(view, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  out.hipMidU = midU(view, LM.LEFT_HIP, LM.RIGHT_HIP);
  out.hipMidV = midV(view, LM.LEFT_HIP, LM.RIGHT_HIP);
  out.kneeMidU = midU(view, LM.LEFT_KNEE, LM.RIGHT_KNEE);
  out.kneeMidV = midV(view, LM.LEFT_KNEE, LM.RIGHT_KNEE);
  out.ankleMidU = midU(view, LM.LEFT_ANKLE, LM.RIGHT_ANKLE);
  out.ankleMidV = midV(view, LM.LEFT_ANKLE, LM.RIGHT_ANKLE);
  out.wristMidU = midU(view, LM.LEFT_WRIST, LM.RIGHT_WRIST);
  out.wristMidV = midV(view, LM.LEFT_WRIST, LM.RIGHT_WRIST);
  out.hipMidZ = midZ(view, LM.LEFT_HIP, LM.RIGHT_HIP);

  // ---- Scale -------------------------------------------------------------------------------
  const shoulderWidth = lmDist(view, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  const torsoLen = Math.sqrt(
    (out.shoulderMidU - out.hipMidU) * (out.shoulderMidU - out.hipMidU) +
      (out.shoulderMidV - out.hipMidV) * (out.shoulderMidV - out.hipMidV),
  );
  out.shoulderWidth = shoulderWidth;
  out.torsoLen = torsoLen;
  // Torso length is the natural scale but it foreshortens toward zero when the body points at
  // the lens, so fall back to shoulder width, which barely changes with pose.
  out.bodyScale = Math.max(torsoLen, shoulderWidth * 0.55, 1e-4);
  out.bodySpanV = out.ankleMidV - out.shoulderMidV;

  // ---- Primary depth signals ---------------------------------------------------------------
  const span = out.ankleMidV - out.shoulderMidV;
  out.hipRatio = Math.abs(span) < 1e-5 ? NaN : (out.ankleMidV - out.hipMidV) / span;
  out.shoulderOverWrist =
    shoulderWidth < 1e-5 ? NaN : (out.wristMidV - out.shoulderMidV) / shoulderWidth;

  // ---- Shape -------------------------------------------------------------------------------
  out.torsoOverShoulderWidth = shoulderWidth < 1e-5 ? NaN : torsoLen / shoulderWidth;
  out.stanceRatio = torsoLen < 1e-5 ? NaN : span / torsoLen;

  const thighL = lmDist(view, LM.LEFT_HIP, LM.LEFT_KNEE);
  const thighR = lmDist(view, LM.RIGHT_HIP, LM.RIGHT_KNEE);
  const shankL = lmDist(view, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const shankR = lmDist(view, LM.RIGHT_KNEE, LM.RIGHT_ANKLE);
  const thighMean = (thighL + thighR) * 0.5;
  const shankMean = (shankL + shankR) * 0.5;
  out.thighShankRatio = shankMean < 1e-5 ? NaN : thighMean / shankMean;

  // Bounding box over the core landmarks only: including hands and feet would make the box jump
  // whenever an extremity is briefly mis-tracked.
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < CORE_LANDMARKS.length; i++) {
    const k = CORE_LANDMARKS[i];
    const u = view.u[k];
    const v = view.v[k];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const boxH = maxV - minV;
  out.bboxAspect = boxH < 1e-5 ? NaN : (maxU - minU) / boxH;

  // ---- Angles ------------------------------------------------------------------------------
  out.kneeAngleL = jointAngleDeg(view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  out.kneeAngleR = jointAngleDeg(view, LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE);
  out.kneeAngle = meanAngle(out.kneeAngleL, out.kneeAngleR);

  out.hipAngleL = jointAngleDeg(view, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE);
  out.hipAngleR = jointAngleDeg(view, LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE);
  out.hipAngle = meanAngle(out.hipAngleL, out.hipAngleR);

  out.elbowAngleL = jointAngleDeg(view, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST);
  out.elbowAngleR = jointAngleDeg(view, LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST);
  out.elbowAngle = meanAngle(out.elbowAngleL, out.elbowAngleR);

  out.torsoLeanDeg = angleFromVerticalDeg(
    out.shoulderMidU - out.hipMidU,
    out.shoulderMidV - out.hipMidV,
  );

  out.shoulderHipKneeDeg = meanAngle(out.hipAngleL, out.hipAngleR);
  out.shoulderHipAnkleDeg = meanAngle(
    jointAngleDeg(view, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_ANKLE),
    jointAngleDeg(view, LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_ANKLE),
  );

  // Plank sag: how far the hips fall below the straight shoulder-to-knee line. Uses knees rather
  // than ankles because during a head-on push-up the feet are behind the body and unreliable.
  const shKneeSpanV = out.kneeMidV - out.shoulderMidV;
  const shKneeSpanU = out.kneeMidU - out.shoulderMidU;
  const shKneeLen = Math.sqrt(shKneeSpanV * shKneeSpanV + shKneeSpanU * shKneeSpanU);
  if (shKneeLen < 1e-5 || shoulderWidth < 1e-5) {
    out.plankSag = NaN;
  } else {
    // Perpendicular distance from the hip to the shoulder->knee segment, signed so that
    // "hips below the line" is positive.
    const t = clamp01(
      ((out.hipMidU - out.shoulderMidU) * shKneeSpanU + (out.hipMidV - out.shoulderMidV) * shKneeSpanV) /
        (shKneeLen * shKneeLen),
    );
    const projV = out.shoulderMidV + shKneeSpanV * t;
    out.plankSag = (out.hipMidV - projV) / shoulderWidth;
  }

  // ---- Separations -------------------------------------------------------------------------
  const scale = out.bodyScale;
  out.ankleSepV = Math.abs(view.v[LM.LEFT_ANKLE] - view.v[LM.RIGHT_ANKLE]) / scale;
  out.ankleSepU = Math.abs(view.u[LM.LEFT_ANKLE] - view.u[LM.RIGHT_ANKLE]) / scale;
  out.ankleSepZ = Math.abs(view.z[LM.LEFT_ANKLE] - view.z[LM.RIGHT_ANKLE]);

  out.ankleDz = view.z[LM.LEFT_ANKLE] - view.z[LM.RIGHT_ANKLE];
  out.kneeDv = view.v[LM.LEFT_KNEE] - view.v[LM.RIGHT_KNEE];
  out.shankLenDiff = (shankL - shankR) / scale;
  out.shankLenRatio = shankR < 1e-5 ? NaN : shankL / shankR;

  // ---- Velocities --------------------------------------------------------------------------
  if (history.primed && dtSec > 0) {
    out.hipRatioVel = rate(out.hipRatio, history.lastHipRatio, dtSec);
    out.shoulderOverWristVel = rate(out.shoulderOverWrist, history.lastShoulderOverWrist, dtSec);
    out.kneeAngleVel = rate(out.kneeAngle, history.lastKneeAngle, dtSec);
    out.elbowAngleVel = rate(out.elbowAngle, history.lastElbowAngle, dtSec);

    let speedSum = 0;
    for (let i = 0; i < CORE_LANDMARKS.length; i++) {
      const k = CORE_LANDMARKS[i];
      const du = view.u[k] - history.lastU[k];
      const dv = view.v[k] - history.lastV[k];
      speedSum += Math.sqrt(du * du + dv * dv);
    }
    out.meanLandmarkSpeed = speedSum / CORE_LANDMARKS.length / scale / dtSec;
  } else {
    out.hipRatioVel = 0;
    out.shoulderOverWristVel = 0;
    out.kneeAngleVel = 0;
    out.elbowAngleVel = 0;
    out.meanLandmarkSpeed = 0;
  }

  // ---- Signal availability -----------------------------------------------------------------
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < CORE_LANDMARKS.length; i++) {
    const z = view.z[CORE_LANDMARKS[i]];
    if (z !== z) continue;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  out.zSpread = minZ === Infinity ? 0 : maxZ - minZ;
  // A real body always spans some depth. A spread near zero means z was never populated or has
  // collapsed, not that the person is genuinely flat.
  out.zUsable = out.zSpread > Z_USABLE_MIN_SPREAD;

  // ---- Visibility --------------------------------------------------------------------------
  out.visCore = minVisibility(view, CORE_LANDMARKS);
  out.visAnkles = meanVisibility(view, [LM.LEFT_ANKLE, LM.RIGHT_ANKLE]);
  out.visKnees = meanVisibility(view, [LM.LEFT_KNEE, LM.RIGHT_KNEE]);
  out.visWrists = meanVisibility(view, [LM.LEFT_WRIST, LM.RIGHT_WRIST]);
  out.visElbows = meanVisibility(view, [LM.LEFT_ELBOW, LM.RIGHT_ELBOW]);

  // ---- Framing extents ---------------------------------------------------------------------
  out.topV = Math.min(view.v[LM.NOSE], minV);
  out.bottomV = Math.max(view.v[LM.LEFT_ANKLE], view.v[LM.RIGHT_ANKLE], maxV);
  out.leftU = minU;
  out.rightU = maxU;

  // ---- Roll history ------------------------------------------------------------------------
  history.lastTimeSec = timeSec;
  history.lastHipRatio = out.hipRatio;
  history.lastShoulderOverWrist = out.shoulderOverWrist;
  history.lastKneeAngle = out.kneeAngle;
  history.lastElbowAngle = out.elbowAngle;
  for (let i = 0; i < 33; i++) {
    history.lastU[i] = view.u[i];
    history.lastV[i] = view.v[i];
  }
  history.primed = true;

  out.valid = true;
  return true;
}
