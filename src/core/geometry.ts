/**
 * Coordinate handling, angle maths and the per-frame pose view.
 *
 * Worklet-safe: no imports beyond types from sibling core modules, no platform APIs, and no
 * per-frame allocation once a {@link PoseView} has been created.
 *
 * ## The anisotropy correction — the one that quietly breaks everything
 * MediaPipe normalises `x` by the image WIDTH and `y` by the image HEIGHT. On a non-square
 * frame those two axes therefore have *different* pixel scales, and any angle computed directly
 * from the normalised values is wrong. On a 720x1280 portrait frame the vertical axis is
 * stretched by 1280/720 = 1.78x relative to the horizontal one, which is more than enough to
 * turn a genuinely 90-degree knee into a reported ~120 degrees — and to do it *consistently*,
 * so the numbers look plausible and nothing ever announces the error.
 *
 * The fix is to map into an isotropic space before any angle or distance maths:
 *
 *     aspect = imageWidth / imageHeight
 *     u = x * aspect        // horizontal, in units of image HEIGHT
 *     v = y                 // vertical,   in units of image HEIGHT
 *
 * One pixel of horizontal movement is `1/W` in `x`, hence `(1/W) * (W/H) = 1/H` in `u`; one
 * pixel of vertical movement is `1/H` in `v`. Equal — so the space is isotropic, and it is also
 * resolution-independent, which keeps distance features comparable across camera formats.
 */

import {
  FLAT_LANDMARK_LENGTH,
  LANDMARK_COUNT,
  LM_STRIDE,
  LM_VIS,
  LM_X,
  LM_Y,
  LM_Z,
} from './nativeContract';

export const RAD_TO_DEG = 57.29577951308232;

export function clamp(v: number, lo: number, hi: number): number {
  'worklet';
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  'worklet';
  return a + (b - a) * t;
}

/** Linear map of `v` from [inLo, inHi] onto [0, 1], clamped. Handles a degenerate range. */
export function normalizeRange(v: number, inLo: number, inHi: number): number {
  'worklet';
  const span = inHi - inLo;
  if (span === 0 || span !== span) return 0;
  return clamp01((v - inLo) / span);
}

/**
 * A mutable, reusable view of one pose in isotropic image space.
 *
 * Filled in place by {@link fillPoseView} so the hot path allocates nothing.
 */
export interface PoseView {
  /** Horizontal coordinate in units of image height (see the anisotropy note above). */
  u: number[];
  /** Vertical coordinate, 0 at the top of the frame, 1 at the bottom. */
  v: number[];
  /** MediaPipe's monocular depth estimate, passed through unscaled. */
  z: number[];
  /** Per-landmark visibility, 0..1. */
  vis: number[];

  /** imageWidth / imageHeight. */
  aspect: number;
  imageWidth: number;
  imageHeight: number;

  /** True when the last fill produced usable data. */
  valid: boolean;
  /** True when x was flipped to match a mirrored preview. */
  mirrored: boolean;
}

export function createPoseView(): PoseView {
  'worklet';
  const u: number[] = [];
  const v: number[] = [];
  const z: number[] = [];
  const vis: number[] = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    u.push(0);
    v.push(0);
    z.push(0);
    vis.push(0);
  }
  return {
    u,
    v,
    z,
    vis,
    aspect: 1,
    imageWidth: 0,
    imageHeight: 0,
    valid: false,
    mirrored: false,
  };
}

/**
 * Fill `view` from a flat `[x, y, z, visibility] * 33` array.
 *
 * @param mirrorX flip `u` about the frame centre. Affects *rendering alignment* with a mirrored
 *   front-camera preview, and is deliberately harmless to the maths: every angle here is
 *   computed from unsigned dot products and every distance from absolute differences, both of
 *   which are invariant under reflection. It does NOT swap anatomical left/right — MediaPipe's
 *   `LEFT_` and `RIGHT_` labels are already the subject's own sides.
 */
export function fillPoseView(
  view: PoseView,
  flat: number[],
  imageWidth: number,
  imageHeight: number,
  mirrorX: boolean,
): boolean {
  'worklet';
  if (!flat || flat.length < FLAT_LANDMARK_LENGTH || imageWidth <= 0 || imageHeight <= 0) {
    view.valid = false;
    return false;
  }

  const aspect = imageWidth / imageHeight;
  view.aspect = aspect;
  view.imageWidth = imageWidth;
  view.imageHeight = imageHeight;
  view.mirrored = mirrorX;

  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const o = i * LM_STRIDE;
    const x = flat[o + LM_X];
    view.u[i] = (mirrorX ? 1 - x : x) * aspect;
    view.v[i] = flat[o + LM_Y];
    view.z[i] = flat[o + LM_Z];
    view.vis[i] = flat[o + LM_VIS];
  }

  view.valid = true;
  return true;
}

/** Lowest visibility across a set of landmark indices — i.e. the weakest link. */
export function minVisibility(view: PoseView, indices: readonly number[]): number {
  'worklet';
  let lo = 1;
  for (let i = 0; i < indices.length; i++) {
    const vis = view.vis[indices[i]];
    if (vis < lo) lo = vis;
  }
  return lo;
}

/** Mean visibility across a set of landmark indices. */
export function meanVisibility(view: PoseView, indices: readonly number[]): number {
  'worklet';
  if (indices.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < indices.length; i++) sum += view.vis[indices[i]];
  return sum / indices.length;
}

/**
 * Interior angle at `b` in the path a -> b -> c, in degrees (0..180).
 *
 * Straight limb = 180, fully folded = 0. Returns NaN for a degenerate triangle so callers must
 * decide what a missing angle means rather than silently receiving a plausible number.
 */
export function angleAtDeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  'worklet';
  const bax = ax - bx;
  const bay = ay - by;
  const bcx = cx - bx;
  const bcy = cy - by;

  const lenBa = Math.sqrt(bax * bax + bay * bay);
  const lenBc = Math.sqrt(bcx * bcx + bcy * bcy);
  if (lenBa < 1e-9 || lenBc < 1e-9) return NaN;

  const cosine = (bax * bcx + bay * bcy) / (lenBa * lenBc);
  return Math.acos(clamp(cosine, -1, 1)) * RAD_TO_DEG;
}

/** {@link angleAtDeg} for three landmark indices in a {@link PoseView}. */
export function jointAngleDeg(view: PoseView, a: number, b: number, c: number): number {
  'worklet';
  return angleAtDeg(view.u[a], view.v[a], view.u[b], view.v[b], view.u[c], view.v[c]);
}

/**
 * Angle of the vector (dx, dy) away from straight up, in degrees (0..180).
 *
 * Image `y` grows downward, so "up" is (0, -1): an upright torso gives 0, a horizontal one 90,
 * fully inverted 180. Unsigned, because from a head-on camera the *sign* of a forward lean is
 * not observable in the image plane anyway — forward lean shows up as foreshortening instead
 * (see `torsoForeshortening` in `features.ts`).
 */
export function angleFromVerticalDeg(dx: number, dy: number): number {
  'worklet';
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return NaN;
  return Math.acos(clamp(-dy / len, -1, 1)) * RAD_TO_DEG;
}

/** Euclidean distance between two landmarks in isotropic space. */
export function lmDist(view: PoseView, a: number, b: number): number {
  'worklet';
  const du = view.u[a] - view.u[b];
  const dv = view.v[a] - view.v[b];
  return Math.sqrt(du * du + dv * dv);
}

/** Midpoint `u` of two landmarks. */
export function midU(view: PoseView, a: number, b: number): number {
  'worklet';
  return (view.u[a] + view.u[b]) * 0.5;
}

/** Midpoint `v` of two landmarks. */
export function midV(view: PoseView, a: number, b: number): number {
  'worklet';
  return (view.v[a] + view.v[b]) * 0.5;
}

/** Midpoint `z` of two landmarks. */
export function midZ(view: PoseView, a: number, b: number): number {
  'worklet';
  return (view.z[a] + view.z[b]) * 0.5;
}

/**
 * Average of two angles, tolerating one being NaN.
 *
 * Both legs are usually visible, but from a floor-level camera one can be occluded by the
 * other mid-lunge. Falling back to the single readable side keeps the signal alive instead of
 * poisoning the average with NaN; returns NaN only when neither side is readable.
 */
export function meanAngle(a: number, b: number): number {
  'worklet';
  const aOk = a === a;
  const bOk = b === b;
  if (aOk && bOk) return (a + b) * 0.5;
  if (aOk) return a;
  if (bOk) return b;
  return NaN;
}

/** Median of a numeric array, ignoring NaN. Returns NaN if nothing usable is present. */
export function median(values: readonly number[]): number {
  'worklet';
  const clean: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v) clean.push(v);
  }
  if (clean.length === 0) return NaN;
  clean.sort((x, y) => x - y);
  const mid = clean.length >> 1;
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) * 0.5;
}
