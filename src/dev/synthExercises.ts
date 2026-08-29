/**
 * Kinematic animation of squat / push-up / lunge on the synthetic body.
 *
 * ## Inverse kinematics, not prescribed angles
 * Limb angles are *solved*, not dictated. Each exercise drives a small number of physically
 * meaningful parameters — pelvis height, stride length, shoulder height — and the knee and elbow
 * positions fall out of two-link IK. That ordering matters for verification: if we prescribed
 * "knee angle = 90 degrees at the bottom" and then measured the knee angle, the test would only
 * confirm that arithmetic is reversible. Driving pelvis height instead means the observed joint
 * angles are a genuine consequence of the geometry, and a classifier that recovers depth from
 * them is being tested against something it was not handed.
 *
 * It also guarantees a single consistent pelvis. Running FK up from both feet independently — the
 * obvious approach for a lunge, where the legs are in very different positions — produces two
 * disagreeing hip positions and a body that cannot exist.
 */

import { LM } from '../core/landmarks';
import {
  type BodySpec,
  type CameraSpec,
  type Segments,
  type Skeleton,
  type Vec3,
  DEFAULT_BODY,
  DEFAULT_CAMERA,
  emptySkeleton,
  fillAuxiliaryLandmarks,
  makeGaussian,
  makeProjector,
  makeRng,
  projectToFlat,
  segmentsFor,
} from './synthBody';

export type SynthExerciseId =
  | 'squat'
  | 'pushup'
  | 'lunge'
  | 'standing'
  /** Bend forward at the hips with straight knees. Must NOT register as a squat. */
  | 'hinge'
  /** Raise both arms overhead while standing. Must NOT register as a push-up. */
  | 'armRaise';

// ---------------------------------------------------------------------------------------------
// Two-link IK
// ---------------------------------------------------------------------------------------------

/**
 * Solve the middle joint of a two-link chain from `root` to `tip` in the sagittal (Y-Z) plane.
 *
 * @param anteriorSign +1 to bend the joint toward the camera, -1 away. Knees and elbows each
 *   bend one way only, so this encodes anatomy rather than being a free parameter.
 */
function solveMiddleJoint(
  root: Vec3,
  tip: Vec3,
  lenRoot: number,
  lenTip: number,
  anteriorSign: number,
): Vec3 {
  const dy = tip.y - root.y;
  const dz = tip.z - root.z;
  let d = Math.hypot(dy, dz);

  // A fully extended or fully folded chain is a degenerate triangle; nudge inside the reachable
  // annulus so the square root below stays real.
  const dMax = lenRoot + lenTip - 1e-6;
  const dMin = Math.abs(lenRoot - lenTip) + 1e-6;
  if (d > dMax) d = dMax;
  if (d < dMin) d = dMin;

  const uy = dy / Math.hypot(dy, dz || 1e-9);
  const uz = dz / Math.hypot(dy, dz || 1e-9);

  const t = (lenRoot * lenRoot - lenTip * lenTip + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, lenRoot * lenRoot - t * t));

  // Perpendicular to the root->tip axis, pointing anterior. For a chain running downward
  // (uy < 0), (uz, -uy) has a positive z component, i.e. toward the camera.
  const nY = uz * anteriorSign;
  const nZ = -uy * anteriorSign;

  return {
    x: root.x + (tip.x - root.x) * (t / d),
    y: root.y + uy * t + nY * h,
    z: root.z + uz * t + nZ * h,
  };
}

/** Smooth 0..1 ease, so synthetic motion has no instantaneous velocity steps. */
function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

// ---------------------------------------------------------------------------------------------
// Rep timing
// ---------------------------------------------------------------------------------------------

export interface RepProfile {
  /** Fraction of the rep spent descending. */
  descendFrac: number;
  /** Fraction held at the bottom. */
  holdFrac: number;
  /** How deep this rep actually goes, 0..1. Below ~0.7 it should be rejected as a partial. */
  depthFraction: number;
}

export const DEFAULT_REP: RepProfile = { descendFrac: 0.4, holdFrac: 0.1, depthFraction: 1.0 };

/** Map normalised time within one rep to a 0..1 descent parameter. */
export function repDepthAt(tInRep: number, profile: RepProfile): number {
  const { descendFrac, holdFrac, depthFraction } = profile;
  const ascendStart = descendFrac + holdFrac;
  let d: number;
  if (tInRep < descendFrac) d = smoothstep(tInRep / descendFrac);
  else if (tInRep < ascendStart) d = 1;
  else d = 1 - smoothstep((tInRep - ascendStart) / Math.max(1e-6, 1 - ascendStart));
  return d * depthFraction;
}

// ---------------------------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------------------------

export interface PoseOptions {
  /** 0 = top of the movement, 1 = full depth. */
  depth: number;
  seg: Segments;
  /** Lateral/vertical sway in metres, to emulate a human not being a statue. */
  swayX?: number;
  swayY?: number;
  /** Push-up only: metres the hips sag below the plank line. Emulates a cheating rep. */
  hipSag?: number;
  /** Lunge only: which leg is forward. */
  frontLeg?: 'left' | 'right';
  /** Lunge only: forward/back foot separation in metres. */
  strideM?: number;
}

/** Standing, and the top of a squat: legs extended, torso upright. */
export function standingPose(seg: Segments, opts?: Partial<PoseOptions>): Skeleton {
  return squatPose({ depth: 0, seg, ...opts });
}

/**
 * Bodyweight squat.
 *
 * Driven by pelvis height. Both ankles stay planted under the hips — the feature that separates
 * a squat from a lunge — and the torso leans forward as depth increases, which from a head-on
 * camera shows up as torso foreshortening rather than as a change in apparent angle.
 */
export function squatPose(opts: PoseOptions): Skeleton {
  const { depth, seg } = opts;
  const s = emptySkeleton();
  const swayX = opts.swayX ?? 0;
  const swayY = opts.swayY ?? 0;

  const standHipY = seg.ankleHeight + seg.thigh + seg.shank;
  // A deep bodyweight squat drops the pelvis to roughly 55% of its standing height.
  const hipY = standHipY * (1 - 0.45 * depth) + swayY;
  // Hips travel backward as the knees travel forward; the pair is what keeps the centre of mass
  // over the feet.
  const hipZ = -0.05 * depth;

  const ankleY = seg.ankleHeight;
  set(s, LM.LEFT_ANKLE, seg.hipHalfWidth + swayX, ankleY, 0);
  set(s, LM.RIGHT_ANKLE, -seg.hipHalfWidth + swayX, ankleY, 0);

  set(s, LM.LEFT_HIP, seg.hipHalfWidth + swayX, hipY, hipZ);
  set(s, LM.RIGHT_HIP, -seg.hipHalfWidth + swayX, hipY, hipZ);

  s[LM.LEFT_KNEE] = solveMiddleJoint(s[LM.LEFT_HIP], s[LM.LEFT_ANKLE], seg.thigh, seg.shank, +1);
  s[LM.RIGHT_KNEE] = solveMiddleJoint(s[LM.RIGHT_HIP], s[LM.RIGHT_ANKLE], seg.thigh, seg.shank, +1);

  // Torso leans forward with depth: 5 degrees standing, 35 at the bottom.
  const lean = ((5 + 30 * depth) * Math.PI) / 180;
  const shoulderY = hipY + seg.torso * Math.cos(lean);
  const shoulderZ = hipZ + seg.torso * Math.sin(lean);
  set(s, LM.LEFT_SHOULDER, seg.shoulderHalfWidth + swayX, shoulderY, shoulderZ);
  set(s, LM.RIGHT_SHOULDER, -seg.shoulderHalfWidth + swayX, shoulderY, shoulderZ);

  set(
    s,
    LM.NOSE,
    swayX,
    shoulderY + seg.head * Math.cos(lean * 0.5),
    shoulderZ + seg.head * Math.sin(lean * 0.5) * 0.6,
  );

  // Arms counterbalance forward as the squat deepens.
  const reach = 0.25 + 0.55 * depth;
  for (const [shoulder, elbow, wrist, sign] of [
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, +1],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, -1],
  ] as [number, number, number, number][]) {
    const sh = s[shoulder];
    const armLen = (seg.upperArm + seg.forearm) * 0.94;
    const wristY = sh.y - armLen * Math.cos(reach);
    const wristZ = sh.z + armLen * Math.sin(reach);
    set(s, wrist, sh.x + sign * 0.02, wristY, wristZ);
    s[elbow] = solveMiddleJoint(sh, s[wrist], seg.upperArm, seg.forearm, -1);
  }

  fillAuxiliaryLandmarks(s, seg, +1);
  return s;
}

/**
 * Push-up, facing the camera head-on from a floor-level lens.
 *
 * Driven by elbow flexion: the shoulder height follows from how far the two-link arm can reach,
 * and the torso and legs form a straight plank line from the shoulders back to the toes.
 *
 * `hipSag` breaks that line deliberately, which is what the push-up classifier's rigidity check
 * has to catch — a hinging "cheat" rep moves the shoulders through a full range while the hips
 * collapse independently.
 */
export function pushupPose(opts: PoseOptions): Skeleton {
  const { depth, seg } = opts;
  const s = emptySkeleton();
  const sag = opts.hipSag ?? 0;

  // 170 degrees at the top down to 80 at the bottom.
  const elbowDeg = 170 - 90 * depth;
  const elbowRad = (elbowDeg * Math.PI) / 180;
  const a = seg.upperArm;
  const b = seg.forearm;
  const shoulderToWrist = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(elbowRad));

  // Hands are planted slightly wider than the shoulders and a little ahead of them.
  const handHalfWidth = seg.shoulderHalfWidth * 1.35;
  const wristY = 0.02;
  const wristZ = 0.0;

  // Arms angled ~18 degrees back from vertical, so the shoulders sit behind the hands.
  const armLean = (18 * Math.PI) / 180;
  const shoulderY = wristY + shoulderToWrist * Math.cos(armLean);
  const shoulderZ = wristZ - shoulderToWrist * Math.sin(armLean);

  set(s, LM.LEFT_WRIST, handHalfWidth, wristY, wristZ);
  set(s, LM.RIGHT_WRIST, -handHalfWidth, wristY, wristZ);
  set(s, LM.LEFT_SHOULDER, seg.shoulderHalfWidth, shoulderY, shoulderZ);
  set(s, LM.RIGHT_SHOULDER, -seg.shoulderHalfWidth, shoulderY, shoulderZ);

  // Elbows flare outward and backward.
  for (const [shoulder, elbow, wrist, sign] of [
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, +1],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, -1],
  ] as [number, number, number, number][]) {
    const joint = solveMiddleJoint(s[shoulder], s[wrist], seg.upperArm, seg.forearm, -1);
    // Nudge laterally so the elbows are visibly outside the torso silhouette.
    joint.x += sign * seg.shoulderHalfWidth * 0.45 * (0.4 + 0.6 * depth);
    s[elbow] = joint;
  }

  // The plank: one straight line from shoulders to toes.
  const bodyLen = seg.torso + seg.thigh + seg.shank;
  const toeY = 0.1; // on the toes, heels raised
  const dy = toeY - shoulderY;
  const dz = -Math.sqrt(Math.max(0.01, bodyLen * bodyLen - dy * dy));

  const along = (frac: number, lateral: number): Vec3 => ({
    x: lateral,
    y: shoulderY + dy * frac,
    z: shoulderZ + dz * frac,
  });

  const hipFrac = seg.torso / bodyLen;
  const kneeFrac = (seg.torso + seg.thigh) / bodyLen;

  const lHip = along(hipFrac, seg.hipHalfWidth);
  const rHip = along(hipFrac, -seg.hipHalfWidth);
  lHip.y -= sag;
  rHip.y -= sag;
  s[LM.LEFT_HIP] = lHip;
  s[LM.RIGHT_HIP] = rHip;

  s[LM.LEFT_ANKLE] = along(1, seg.hipHalfWidth);
  s[LM.RIGHT_ANKLE] = along(1, -seg.hipHalfWidth);

  // With the hips sagged the leg is no longer on the plank line, so solve the knees rather than
  // interpolating them — otherwise a cheat rep would still look perfectly straight.
  if (sag > 1e-6) {
    s[LM.LEFT_KNEE] = solveMiddleJoint(lHip, s[LM.LEFT_ANKLE], seg.thigh, seg.shank, +1);
    s[LM.RIGHT_KNEE] = solveMiddleJoint(rHip, s[LM.RIGHT_ANKLE], seg.thigh, seg.shank, +1);
  } else {
    s[LM.LEFT_KNEE] = along(kneeFrac, seg.hipHalfWidth);
    s[LM.RIGHT_KNEE] = along(kneeFrac, -seg.hipHalfWidth);
  }

  // Head reaches forward toward the camera, roughly at shoulder height.
  set(s, LM.NOSE, 0, shoulderY + seg.head * 0.1, shoulderZ + seg.head * 0.9);

  fillAuxiliaryLandmarks(s, seg, +1);
  return s;
}

/**
 * Forward lunge, one leg stepped toward the camera.
 *
 * The two ankles end up at genuinely different depths, which is the whole basis of the
 * front-leg identification signal — so this pose is what makes that claim testable rather than
 * assumed.
 */
export function lungePose(opts: PoseOptions): Skeleton {
  const { depth, seg } = opts;
  const s = emptySkeleton();
  const stride = opts.strideM ?? 0.75;
  const frontIsLeft = (opts.frontLeg ?? 'left') === 'left';
  const swayX = opts.swayX ?? 0;
  const swayY = opts.swayY ?? 0;

  const standHipY = seg.ankleHeight + seg.thigh + seg.shank;
  // A lunge drops the pelvis less than a deep squat does.
  const hipY = standHipY * (1 - 0.3 * depth) + swayY;
  // The pelvis sits between the two feet, drifting slightly forward as the lunge deepens.
  const hipZ = 0.06 * depth;

  const frontZ = +stride / 2;
  const backZ = -stride / 2;

  const leftZ = frontIsLeft ? frontZ : backZ;
  const rightZ = frontIsLeft ? backZ : frontZ;

  // The trailing foot is on its toes, so its ankle sits higher off the floor.
  const frontAnkleY = seg.ankleHeight;
  const backAnkleY = seg.ankleHeight + 0.05 * depth;

  set(s, LM.LEFT_ANKLE, seg.hipHalfWidth + swayX, frontIsLeft ? frontAnkleY : backAnkleY, leftZ);
  set(s, LM.RIGHT_ANKLE, -seg.hipHalfWidth + swayX, frontIsLeft ? backAnkleY : frontAnkleY, rightZ);

  set(s, LM.LEFT_HIP, seg.hipHalfWidth + swayX, hipY, hipZ);
  set(s, LM.RIGHT_HIP, -seg.hipHalfWidth + swayX, hipY, hipZ);

  // Knees bend anteriorly on both legs — the joint only goes one way, regardless of which foot
  // is in front.
  s[LM.LEFT_KNEE] = solveMiddleJoint(s[LM.LEFT_HIP], s[LM.LEFT_ANKLE], seg.thigh, seg.shank, +1);
  s[LM.RIGHT_KNEE] = solveMiddleJoint(s[LM.RIGHT_HIP], s[LM.RIGHT_ANKLE], seg.thigh, seg.shank, +1);

  // The torso stays much more upright than in a squat.
  const lean = ((4 + 8 * depth) * Math.PI) / 180;
  const shoulderY = hipY + seg.torso * Math.cos(lean);
  const shoulderZ = hipZ + seg.torso * Math.sin(lean);
  set(s, LM.LEFT_SHOULDER, seg.shoulderHalfWidth + swayX, shoulderY, shoulderZ);
  set(s, LM.RIGHT_SHOULDER, -seg.shoulderHalfWidth + swayX, shoulderY, shoulderZ);
  set(s, LM.NOSE, swayX, shoulderY + seg.head, shoulderZ + seg.head * 0.1);

  // Arms hang at the sides.
  for (const [shoulder, elbow, wrist, sign] of [
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, +1],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, -1],
  ] as [number, number, number, number][]) {
    const sh = s[shoulder];
    const armLen = (seg.upperArm + seg.forearm) * 0.96;
    set(s, wrist, sh.x + sign * 0.03, sh.y - armLen, sh.z + 0.03);
    s[elbow] = solveMiddleJoint(sh, s[wrist], seg.upperArm, seg.forearm, -1);
  }

  fillAuxiliaryLandmarks(s, seg, +1);
  return s;
}

/**
 * Hip hinge: fold forward at the hips with the knees essentially straight.
 *
 * This is the movement the brief's "hip angle must move with knee angle" rule exists to reject.
 * The hips travel backward and barely downward while the torso pitches a long way forward, so a
 * classifier keying on torso movement alone would happily count these as squats.
 */
export function hingePose(opts: PoseOptions): Skeleton {
  const { depth, seg } = opts;
  const s = emptySkeleton();
  const swayX = opts.swayX ?? 0;

  const standHipY = seg.ankleHeight + seg.thigh + seg.shank;
  // Hips drop only a little — this is the whole point of a hinge.
  const hipY = standHipY * (1 - 0.07 * depth);
  const hipZ = -0.16 * depth;

  set(s, LM.LEFT_ANKLE, seg.hipHalfWidth + swayX, seg.ankleHeight, 0);
  set(s, LM.RIGHT_ANKLE, -seg.hipHalfWidth + swayX, seg.ankleHeight, 0);
  set(s, LM.LEFT_HIP, seg.hipHalfWidth + swayX, hipY, hipZ);
  set(s, LM.RIGHT_HIP, -seg.hipHalfWidth + swayX, hipY, hipZ);

  s[LM.LEFT_KNEE] = solveMiddleJoint(s[LM.LEFT_HIP], s[LM.LEFT_ANKLE], seg.thigh, seg.shank, +1);
  s[LM.RIGHT_KNEE] = solveMiddleJoint(s[LM.RIGHT_HIP], s[LM.RIGHT_ANKLE], seg.thigh, seg.shank, +1);

  // The torso goes a long way over: up to 75 degrees from vertical.
  const lean = ((5 + 70 * depth) * Math.PI) / 180;
  const shoulderY = hipY + seg.torso * Math.cos(lean);
  const shoulderZ = hipZ + seg.torso * Math.sin(lean);
  set(s, LM.LEFT_SHOULDER, seg.shoulderHalfWidth + swayX, shoulderY, shoulderZ);
  set(s, LM.RIGHT_SHOULDER, -seg.shoulderHalfWidth + swayX, shoulderY, shoulderZ);
  set(s, LM.NOSE, swayX, shoulderY + seg.head * Math.cos(lean), shoulderZ + seg.head * Math.sin(lean));

  for (const [shoulder, elbow, wrist, sign] of [
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, +1],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, -1],
  ] as [number, number, number, number][]) {
    const sh = s[shoulder];
    const armLen = (seg.upperArm + seg.forearm) * 0.96;
    set(s, wrist, sh.x + sign * 0.03, sh.y - armLen, sh.z);
    s[elbow] = solveMiddleJoint(sh, s[wrist], seg.upperArm, seg.forearm, -1);
  }

  fillAuxiliaryLandmarks(s, seg, +1);
  return s;
}

/**
 * Standing arm raise: legs and torso still, both arms sweep from the sides to overhead.
 *
 * The brief requires push-up detection to reject standing arm movements. Elbow angle sweeps
 * through a wide range here, which is exactly what a push-up classifier keyed on elbow angle
 * alone would fall for.
 */
export function armRaisePose(opts: PoseOptions): Skeleton {
  const { depth, seg } = opts;
  const s = standingPose(seg, { ...opts, depth: 0 });

  // 0 = arms down at the sides, 1 = straight overhead.
  const sweep = (-80 + 250 * depth) * (Math.PI / 180);
  for (const [shoulder, elbow, wrist, sign] of [
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, +1],
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, -1],
  ] as [number, number, number, number][]) {
    const sh = s[shoulder];
    const armLen = (seg.upperArm + seg.forearm) * 0.93;
    // Sweep in the frontal plane, so the arms stay laterally visible rather than pointing at
    // the lens.
    set(
      s,
      wrist,
      sh.x + sign * armLen * Math.cos(sweep) * 0.85,
      sh.y + armLen * Math.sin(sweep),
      sh.z + 0.05,
    );
    s[elbow] = solveMiddleJoint(sh, s[wrist], seg.upperArm, seg.forearm, -1);
  }

  fillAuxiliaryLandmarks(s, seg, +1);
  return s;
}

function set(s: Skeleton, i: number, x: number, y: number, z: number): void {
  s[i].x = x;
  s[i].y = y;
  s[i].z = z;
}

// ---------------------------------------------------------------------------------------------
// Session generation
// ---------------------------------------------------------------------------------------------

export interface SynthFrame {
  timeMs: number;
  flat: number[];
  imageWidth: number;
  imageHeight: number;
  /** Ground truth, for assertions. */
  truth: {
    exercise: SynthExerciseId;
    /** 0..1 descent parameter driving the pose. */
    depth: number;
    repIndex: number;
    frontLeg: 'left' | 'right' | null;
    /** True while this frame belongs to a rep that reaches full depth. */
    fullDepthRep: boolean;
  };
}

export interface SynthSessionSpec {
  exercise: SynthExerciseId;
  reps: number;
  fps?: number;
  repDurationSec?: number;
  /** Quiet standing before the first rep — what the calibration step consumes. */
  leadInSec?: number;
  /** Quiet standing after the last rep. */
  leadOutSec?: number;
  /** Pause between reps, in seconds. */
  restBetweenRepsSec?: number;
  camera?: CameraSpec;
  body?: BodySpec;
  seed?: number;
  /** Landmark jitter in pixels (1 sigma). */
  noiseSigmaPx?: number;
  /** How much noisier MediaPipe's z is than x/y. */
  zNoiseMultiplier?: number;
  /** Per-rep overrides, e.g. to make rep 3 a partial. */
  repProfiles?: (Partial<RepProfile> | undefined)[];
  /** Push-up only: metres of hip sag per rep, to emulate cheating. */
  hipSagPerRep?: (number | undefined)[];
  /** Lunge only: alternate the front leg each rep (the product's actual case). */
  alternateFrontLeg?: boolean;
  /** Lunge only: which leg leads the first rep. */
  firstFrontLeg?: 'left' | 'right';
  /** Amplitude of idle sway in metres. */
  swayM?: number;
}

/**
 * Landmarks the camera cannot actually see for a given exercise.
 *
 * For a head-on push-up from floor level the feet are directly behind the body, so their
 * visibility collapses. Modelling that is the point: the push-up classifier is required to lean
 * on elbow/shoulder/hip signals precisely because these landmarks are unreliable, and a
 * generator that reported clean ankles would let a bad design pass.
 */
function occlusionFor(exercise: SynthExerciseId): readonly { index: number; visibility: number }[] {
  if (exercise === 'pushup') {
    return [
      // Feet are almost entirely behind the body along the view axis.
      { index: LM.LEFT_ANKLE, visibility: 0.22 },
      { index: LM.RIGHT_ANKLE, visibility: 0.22 },
      { index: LM.LEFT_HEEL, visibility: 0.15 },
      { index: LM.RIGHT_HEEL, visibility: 0.15 },
      { index: LM.LEFT_FOOT_INDEX, visibility: 0.15 },
      { index: LM.RIGHT_FOOT_INDEX, visibility: 0.15 },
      // Knees are only partly obscured; MediaPipe usually still tracks them.
      { index: LM.LEFT_KNEE, visibility: 0.55 },
      { index: LM.RIGHT_KNEE, visibility: 0.55 },
    ];
  }
  return [];
}

export function generateSession(spec: SynthSessionSpec): SynthFrame[] {
  const fps = spec.fps ?? 30;
  const camera = spec.camera ?? DEFAULT_CAMERA;
  const body = spec.body ?? DEFAULT_BODY;
  const seg = segmentsFor(body);
  const proj = makeProjector(camera);
  const rng = makeRng(spec.seed ?? 12345);
  const gauss = makeGaussian(rng);

  const repDur = spec.repDurationSec ?? 2.2;
  const leadIn = spec.leadInSec ?? 3.0;
  const leadOut = spec.leadOutSec ?? 1.5;
  const rest = spec.restBetweenRepsSec ?? 0.4;
  const sway = spec.swayM ?? 0.006;
  const noiseSigmaPx = spec.noiseSigmaPx ?? 1.4;
  const zNoiseMultiplier = spec.zNoiseMultiplier ?? 3.5;
  const suppressed = occlusionFor(spec.exercise);

  const frames: SynthFrame[] = [];
  const dt = 1 / fps;

  const totalSec = leadIn + spec.reps * (repDur + rest) + leadOut;
  const frameCount = Math.round(totalSec * fps);

  let frontLeg: 'left' | 'right' = spec.firstFrontLeg ?? 'left';

  for (let f = 0; f < frameCount; f++) {
    const t = f * dt;

    let depth = 0;
    let repIndex = -1;
    let fullDepth = false;
    let hipSag = 0;

    if (t >= leadIn && spec.reps > 0) {
      const sinceStart = t - leadIn;
      const cycle = repDur + rest;
      const idx = Math.floor(sinceStart / cycle);
      if (idx < spec.reps) {
        repIndex = idx;
        const tInCycle = sinceStart - idx * cycle;
        const profile: RepProfile = { ...DEFAULT_REP, ...(spec.repProfiles?.[idx] ?? {}) };
        fullDepth = (profile.depthFraction ?? 1) >= 0.9;
        hipSag = spec.hipSagPerRep?.[idx] ?? 0;
        if (tInCycle < repDur) depth = repDepthAt(tInCycle / repDur, profile);

        if (spec.alternateFrontLeg !== false) {
          frontLeg = (spec.firstFrontLeg ?? 'left') === 'left'
            ? idx % 2 === 0
              ? 'left'
              : 'right'
            : idx % 2 === 0
              ? 'right'
              : 'left';
        }
      }
    }

    // Slow idle sway, so the stillness gate in calibration is exercised by something realistic
    // rather than by a perfectly frozen mannequin.
    const swayX = Math.sin(t * 1.1) * sway;
    const swayY = Math.sin(t * 0.7 + 1.3) * sway * 0.5;

    const poseOpts: PoseOptions = { depth, seg, swayX, swayY, hipSag, frontLeg };

    let skel: Skeleton;
    switch (spec.exercise) {
      case 'pushup':
        skel = pushupPose(poseOpts);
        break;
      case 'lunge':
        skel = lungePose(poseOpts);
        break;
      case 'standing':
        skel = standingPose(seg, poseOpts);
        break;
      case 'hinge':
        skel = hingePose(poseOpts);
        break;
      case 'armRaise':
        skel = armRaisePose(poseOpts);
        break;
      case 'squat':
      default:
        skel = squatPose(poseOpts);
        break;
    }

    frames.push({
      timeMs: t * 1000,
      flat: projectToFlat(skel, proj, gauss, {
        noiseSigmaPx,
        zNoiseMultiplier,
        occlusion: { suppressed },
      }),
      imageWidth: camera.imageWidth,
      imageHeight: camera.imageHeight,
      truth: {
        exercise: spec.exercise,
        depth,
        repIndex,
        frontLeg: spec.exercise === 'lunge' && repIndex >= 0 ? frontLeg : null,
        fullDepthRep: fullDepth,
      },
    });
  }

  return frames;
}

export { segmentsFor, makeProjector, DEFAULT_CAMERA, DEFAULT_BODY };
export type { Segments, CameraSpec, BodySpec, Skeleton };
