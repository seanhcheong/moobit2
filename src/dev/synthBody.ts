/**
 * A 3D kinematic stick figure and a pinhole camera model for the fixed floor-camera setup.
 *
 * ## Why this exists
 * The recognition core has to be tuned and verified, and the only honest way to do that without
 * a phone in hand is to generate poses whose ground truth is known exactly. This module builds a
 * skeleton with real anthropometric proportions, drives it through squat / push-up / lunge
 * kinematics, and projects it through a camera placed exactly where the product puts it: on the
 * floor, ~6 ft away, tilted up, portrait, wide selfie lens.
 *
 * That makes it possible to ask questions the debug overlay cannot answer, e.g. "does the front
 * ankle really appear lower in frame?" — a projection question with a definite answer — and to
 * assert rep counts in CI.
 *
 * ## What it is NOT
 * It is not a substitute for real footage. It has no soft tissue, no clothing, no motion blur,
 * no MediaPipe failure modes, and its noise model is a crude Gaussian. It proves the *geometry
 * and logic* are right; only a real device can prove the *thresholds* are right.
 *
 * ## Coordinate conventions
 * World space is right-handed, in metres, with the user at the origin:
 *   +X = the user's left as seen by the camera (image-right), +Y = up, +Z = toward the camera.
 * The user's feet rest at Y = 0 and the camera sits at (0, cameraHeight, distance).
 */

import { LANDMARK_COUNT, LM_STRIDE } from '../core/nativeContract';
import { LM } from '../core/landmarks';

export type Vec3 = { x: number; y: number; z: number };

export interface CameraSpec {
  /** Horizontal distance from the user, in metres. 6 ft = 1.829 m. */
  distanceM: number;
  /** Lens height above the floor, in metres. A phone lying on its back is a few cm. */
  heightM: number;
  /** Upward tilt from horizontal, in degrees. */
  tiltDeg: number;
  /** Horizontal field of view, in degrees. Selfie cameras are wide. */
  hfovDeg: number;
  /** Portrait sensor, so height > width. */
  imageWidth: number;
  imageHeight: number;
}

export const DEFAULT_CAMERA: CameraSpec = {
  distanceM: 1.829, // 6 ft
  heightM: 0.05, // phone lying on its back
  tiltDeg: 21,
  hfovDeg: 60,
  imageWidth: 720,
  imageHeight: 1280,
};

export interface BodySpec {
  /** Standing height, in metres. */
  heightM: number;
}

export const DEFAULT_BODY: BodySpec = { heightM: 1.75 };

/**
 * Segment lengths as fractions of standing height, from Drillis & Contini's classic
 * anthropometric proportions. Using real ratios matters: several disambiguation features are
 * normalised by torso length, so a figure with invented proportions would validate the code
 * against a body that cannot exist.
 */
const SEG = {
  ankleHeight: 0.039,
  kneeHeight: 0.285,
  hipHeight: 0.53,
  shoulderHeight: 0.818,
  elbowHeight: 0.63,
  wristHeight: 0.485,
  shoulderWidth: 0.259,
  hipWidth: 0.191,
  footLength: 0.152,
  headAboveShoulder: 0.118,
};

export interface Segments {
  shank: number;
  thigh: number;
  torso: number;
  upperArm: number;
  forearm: number;
  head: number;
  shoulderHalfWidth: number;
  hipHalfWidth: number;
  ankleHeight: number;
  footLength: number;
}

export function segmentsFor(body: BodySpec): Segments {
  const h = body.heightM;
  return {
    shank: (SEG.kneeHeight - SEG.ankleHeight) * h,
    thigh: (SEG.hipHeight - SEG.kneeHeight) * h,
    torso: (SEG.shoulderHeight - SEG.hipHeight) * h,
    upperArm: (SEG.shoulderHeight - SEG.elbowHeight) * h,
    forearm: (SEG.elbowHeight - SEG.wristHeight) * h,
    head: SEG.headAboveShoulder * h,
    shoulderHalfWidth: (SEG.shoulderWidth * h) / 2,
    hipHalfWidth: (SEG.hipWidth * h) / 2,
    ankleHeight: SEG.ankleHeight * h,
    footLength: SEG.footLength * h,
  };
}

// ---------------------------------------------------------------------------------------------
// Camera projection
// ---------------------------------------------------------------------------------------------

export interface Projector {
  /** Project a world point to normalised image coords plus a MediaPipe-style z. */
  project(p: Vec3, hipMid: Vec3): { nx: number; ny: number; nz: number; depth: number };
  /** Camera-space depth of a world point (distance along the view axis). */
  depthOf(p: Vec3): number;
  spec: CameraSpec;
}

export function makeProjector(spec: CameraSpec): Projector {
  const tilt = (spec.tiltDeg * Math.PI) / 180;
  const C: Vec3 = { x: 0, y: spec.heightM, z: spec.distanceM };

  // The camera looks back toward the user (-Z) while tilted up by `tilt`.
  const fwd: Vec3 = { x: 0, y: Math.sin(tilt), z: -Math.cos(tilt) };
  const up: Vec3 = { x: 0, y: Math.cos(tilt), z: Math.sin(tilt) };
  const right: Vec3 = { x: 1, y: 0, z: 0 };

  const tanH = Math.tan((spec.hfovDeg * Math.PI) / 360);
  // A single lens has one focal length; the vertical half-angle follows from the sensor's
  // aspect ratio. Portrait therefore buys vertical coverage, exactly as the product intends.
  const tanV = (tanH * spec.imageHeight) / spec.imageWidth;

  const toCam = (p: Vec3) => {
    const dx = p.x - C.x;
    const dy = p.y - C.y;
    const dz = p.z - C.z;
    return {
      x: dx * right.x + dy * right.y + dz * right.z,
      y: dx * up.x + dy * up.y + dz * up.z,
      z: dx * fwd.x + dy * fwd.y + dz * fwd.z,
    };
  };

  return {
    spec,
    depthOf(p) {
      return toCam(p).z;
    },
    project(p, hipMid) {
      const c = toCam(p);
      const d = Math.max(c.z, 1e-4);
      const nx = 0.5 + (0.5 * (c.x / d)) / tanH;
      // Image y grows downward, so up in camera space maps to a smaller ny.
      const ny = 0.5 - (0.5 * (c.y / d)) / tanV;

      // Emulate MediaPipe's z: depth relative to the hip midpoint, scaled roughly like x.
      // x spans (2 * tanH * depth) metres across the full frame width at a given depth, so
      // dividing a metric depth offset by that same span puts z in x's units, which is what
      // MediaPipe documents.
      const hipDepth = Math.max(toCam(hipMid).z, 1e-4);
      const nz = (c.z - hipDepth) / (2 * tanH * hipDepth);

      return { nx, ny, nz, depth: c.z };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------------------------

/** Mulberry32: small, fast, and seedable so every test is reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the jitter is actually Gaussian rather than uniform. */
export function makeGaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

// ---------------------------------------------------------------------------------------------
// Skeleton assembly
// ---------------------------------------------------------------------------------------------

/** A full set of 33 world-space landmark positions. */
export type Skeleton = Vec3[];

export function emptySkeleton(): Skeleton {
  const s: Skeleton = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) s.push({ x: 0, y: 0, z: 0 });
  return s;
}

function set(s: Skeleton, i: number, x: number, y: number, z: number): void {
  s[i].x = x;
  s[i].y = y;
  s[i].z = z;
}

function copyOffset(s: Skeleton, from: number, to: number, dx: number, dy: number, dz: number): void {
  set(s, to, s[from].x + dx, s[from].y + dy, s[from].z + dz);
}

/**
 * Fill in the landmarks the recognition core never reads (eyes, mouth, fingers) by hanging them
 * off the joints that do matter. They exist only so the overlay looks like a person and so the
 * flat array has the shape the native contract promises.
 */
export function fillAuxiliaryLandmarks(s: Skeleton, seg: Segments, facingZ: number): void {
  const nose = s[LM.NOSE];
  const ear = seg.head * 0.25;
  set(s, LM.LEFT_EAR, nose.x + ear, nose.y + ear * 0.2, nose.z - ear * 0.6 * facingZ);
  set(s, LM.RIGHT_EAR, nose.x - ear, nose.y + ear * 0.2, nose.z - ear * 0.6 * facingZ);
  for (const [idx, dx, dy] of [
    [LM.LEFT_EYE, ear * 0.4, ear * 0.35],
    [LM.LEFT_EYE_INNER, ear * 0.2, ear * 0.35],
    [LM.LEFT_EYE_OUTER, ear * 0.6, ear * 0.35],
    [LM.RIGHT_EYE, -ear * 0.4, ear * 0.35],
    [LM.RIGHT_EYE_INNER, -ear * 0.2, ear * 0.35],
    [LM.RIGHT_EYE_OUTER, -ear * 0.6, ear * 0.35],
    [LM.MOUTH_LEFT, ear * 0.25, -ear * 0.3],
    [LM.MOUTH_RIGHT, -ear * 0.25, -ear * 0.3],
  ] as [number, number, number][]) {
    set(s, idx, nose.x + dx, nose.y + dy, nose.z + ear * 0.3 * facingZ);
  }

  // Hands: a short continuation of the forearm direction.
  for (const [wrist, elbow, pinky, index, thumb] of [
    [LM.LEFT_WRIST, LM.LEFT_ELBOW, LM.LEFT_PINKY, LM.LEFT_INDEX, LM.LEFT_THUMB],
    [LM.RIGHT_WRIST, LM.RIGHT_ELBOW, LM.RIGHT_PINKY, LM.RIGHT_INDEX, LM.RIGHT_THUMB],
  ] as [number, number, number, number, number][]) {
    const w = s[wrist];
    const e = s[elbow];
    let dx = w.x - e.x;
    let dy = w.y - e.y;
    let dz = w.z - e.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const hand = seg.forearm * 0.45;
    dx = (dx / len) * hand;
    dy = (dy / len) * hand;
    dz = (dz / len) * hand;
    copyOffset(s, wrist, index, dx, dy, dz);
    copyOffset(s, wrist, pinky, dx * 0.9, dy * 0.9, dz * 0.9);
    copyOffset(s, wrist, thumb, dx * 0.6, dy * 0.6, dz * 0.6);
  }

  // Feet: heel just behind the ankle, toes ahead of it, both at floor level.
  for (const [ankle, heel, toe] of [
    [LM.LEFT_ANKLE, LM.LEFT_HEEL, LM.LEFT_FOOT_INDEX],
    [LM.RIGHT_ANKLE, LM.RIGHT_HEEL, LM.RIGHT_FOOT_INDEX],
  ] as [number, number, number][]) {
    const a = s[ankle];
    set(s, heel, a.x, Math.max(0.01, a.y - seg.ankleHeight * 0.6), a.z - seg.footLength * 0.25);
    set(s, toe, a.x, Math.max(0.01, a.y - seg.ankleHeight * 0.8), a.z + seg.footLength * 0.6);
  }
}

// ---------------------------------------------------------------------------------------------
// Projection to the native flat contract
// ---------------------------------------------------------------------------------------------

export interface OcclusionModel {
  /**
   * Landmarks whose visibility is forced down, with the value to force it to.
   *
   * Graded rather than binary, because occlusion in this setup is: a head-on push-up hides the
   * feet almost completely behind the body, while the knees are merely partly obscured and
   * MediaPipe usually still tracks them. Collapsing both to one "hidden" value would either
   * make knee features unusable or make foot features look trustworthy.
   */
  suppressed?: readonly { index: number; visibility: number }[];
}

/**
 * Project a world skeleton into the flat `[x, y, z, visibility] * 33` array the native plugin
 * produces, adding pixel-space Gaussian jitter.
 *
 * Noise is specified in PIXELS and converted per axis, because that is how landmark error
 * actually behaves — it is a property of the detector's output resolution, not of the
 * normalised coordinate system. Applying one sigma to both normalised axes would silently make
 * vertical noise 1.78x larger than horizontal on a portrait frame.
 */
export function projectToFlat(
  skel: Skeleton,
  proj: Projector,
  gauss: () => number,
  opts: {
    noiseSigmaPx: number;
    zNoiseMultiplier: number;
    occlusion?: OcclusionModel;
    baseVisibility?: number;
  },
): number[] {
  const { imageWidth, imageHeight } = proj.spec;
  const flat: number[] = new Array(LANDMARK_COUNT * LM_STRIDE).fill(0);

  const hipMid: Vec3 = {
    x: (skel[LM.LEFT_HIP].x + skel[LM.RIGHT_HIP].x) / 2,
    y: (skel[LM.LEFT_HIP].y + skel[LM.RIGHT_HIP].y) / 2,
    z: (skel[LM.LEFT_HIP].z + skel[LM.RIGHT_HIP].z) / 2,
  };

  const sigmaX = opts.noiseSigmaPx / imageWidth;
  const sigmaY = opts.noiseSigmaPx / imageHeight;
  const base = opts.baseVisibility ?? 0.97;
  const suppressed = opts.occlusion?.suppressed ?? [];

  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = proj.project(skel[i], hipMid);
    const nx = p.nx + gauss() * sigmaX;
    const ny = p.ny + gauss() * sigmaY;
    const nz = p.nz + gauss() * sigmaX * opts.zNoiseMultiplier;

    let vis = base;
    for (let k = 0; k < suppressed.length; k++) {
      if (suppressed[k].index === i) {
        vis = suppressed[k].visibility;
        break;
      }
    }
    // Out-of-frame landmarks: MediaPipe keeps extrapolating coordinates but its confidence
    // collapses, and the core's gating depends on seeing that collapse.
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) vis = Math.min(vis, 0.15);

    const o = i * LM_STRIDE;
    flat[o] = nx;
    flat[o + 1] = ny;
    flat[o + 2] = nz;
    flat[o + 3] = vis;
  }

  return flat;
}
