/**
 * Framing check for the fixed camera.
 *
 * Worklet-safe.
 *
 * The camera does not move, so the user has to position themselves relative to it. This module
 * decides whether they have, and — more usefully — says exactly what is wrong, so the harness
 * can render one specific instruction instead of a generic "not detected".
 *
 * Distance is inferred from apparent body height rather than from any depth estimate: at the
 * reference geometry a standing body spans about 0.37 of the frame height, and that figure is
 * insensitive to camera tilt (measured 0.366-0.415 across 0-40 degrees) while being strongly
 * sensitive to distance, which is exactly the right sensitivity profile for this job.
 */

import type { Features } from './features';

export type FramingIssue =
  | 'no-person'
  | 'low-visibility'
  | 'head-cropped'
  | 'feet-cropped'
  | 'too-close'
  | 'too-far'
  | 'off-center'
  | 'near-edge';

export interface FramingConfig {
  /** Required clear margin from the top and bottom edges, in normalised units. */
  vEdgeMargin: number;
  /** Required clear margin from the left and right edges, in units of image height. */
  uEdgeMargin: number;
  /** Accepted apparent body height, as a fraction of frame height. */
  minBodyHeightFrac: number;
  maxBodyHeightFrac: number;
  /** Accepted horizontal offset of the body centre from the frame centre, in image heights. */
  maxCenterOffset: number;
  /** Minimum core visibility to consider a person present at all. */
  minVisibility: number;
}

export const DEFAULT_FRAMING: FramingConfig = {
  vEdgeMargin: 0.03,
  // Front cameras are wide-angle and a low upward tilt introduces keystoning at the edges, so
  // the guide keeps limbs away from the extreme sides rather than relying on lens correction.
  uEdgeMargin: 0.05,
  // Reference geometry puts a standing body at ~0.37 of frame height; this band is roughly
  // 5-8.5 ft of standing distance.
  minBodyHeightFrac: 0.26,
  maxBodyHeightFrac: 0.62,
  maxCenterOffset: 0.14,
  minVisibility: 0.4,
};

export interface FramingStatus {
  inFrame: boolean;
  /** All issues found, most actionable first. Empty when `inFrame`. */
  issues: FramingIssue[];
  /** One short instruction for the user, or the empty string when framing is fine. */
  hint: string;
  /** Apparent body height as a fraction of frame height. */
  bodyHeightFrac: number;
  /** Horizontal offset of the body centre from the frame centre, in image heights. */
  centerOffset: number;
}

export function createFramingStatus(): FramingStatus {
  'worklet';
  return { inFrame: false, issues: [], hint: 'Stand in front of the camera', bodyHeightFrac: 0, centerOffset: 0 };
}

const HINTS: Record<FramingIssue, string> = {
  'no-person': 'Stand in front of the camera',
  'low-visibility': 'Move into better light',
  'head-cropped': 'Step back — your head is cut off',
  'feet-cropped': 'Step back — your feet are cut off',
  'too-close': 'Step back',
  'too-far': 'Step closer',
  'off-center': 'Move to the middle of the frame',
  'near-edge': 'Move away from the edge of the frame',
};

/**
 * Evaluate framing for the current frame.
 *
 * @param out reused across frames.
 * @param aspect imageWidth / imageHeight, so horizontal limits are expressed in the same
 *   isotropic units the features use.
 */
export function checkFraming(
  f: Features,
  cfg: FramingConfig,
  aspect: number,
  out: FramingStatus,
): FramingStatus {
  'worklet';
  out.issues.length = 0;

  if (!f.valid) {
    out.inFrame = false;
    out.bodyHeightFrac = 0;
    out.centerOffset = 0;
    out.issues.push('no-person');
    out.hint = HINTS['no-person'];
    return out;
  }

  if (f.visCore < cfg.minVisibility) {
    out.inFrame = false;
    out.bodyHeightFrac = f.bottomV - f.topV;
    out.centerOffset = 0;
    out.issues.push('low-visibility');
    out.hint = HINTS['low-visibility'];
    return out;
  }

  const height = f.bottomV - f.topV;
  out.bodyHeightFrac = height;

  const centerU = (f.leftU + f.rightU) * 0.5;
  const frameCenterU = aspect * 0.5;
  const offset = centerU - frameCenterU;
  out.centerOffset = offset;

  // Cropping is checked before distance: telling someone to step back because their head is out
  // of frame is more actionable than telling them their apparent height is out of range.
  if (f.topV < cfg.vEdgeMargin) out.issues.push('head-cropped');
  if (f.bottomV > 1 - cfg.vEdgeMargin) out.issues.push('feet-cropped');

  if (out.issues.length === 0) {
    if (height > cfg.maxBodyHeightFrac) out.issues.push('too-close');
    else if (height < cfg.minBodyHeightFrac) out.issues.push('too-far');
  }

  if (Math.abs(offset) > cfg.maxCenterOffset) out.issues.push('off-center');
  if (f.leftU < cfg.uEdgeMargin || f.rightU > aspect - cfg.uEdgeMargin) out.issues.push('near-edge');

  out.inFrame = out.issues.length === 0;
  out.hint = out.inFrame ? '' : HINTS[out.issues[0]];
  return out;
}

/**
 * The silhouette guide the overlay draws, as a normalised rectangle.
 *
 * Derived from the accepted framing band rather than hand-drawn, so the on-screen guide and the
 * in-frame test can never disagree — a guide the user can satisfy while still being told they
 * are out of frame would be worse than no guide.
 */
export interface FramingGuide {
  /** Normalised [0,1] rectangle: x and width are fractions of frame width. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function framingGuide(cfg: FramingConfig, aspect: number): FramingGuide {
  'worklet';
  const targetHeight = (cfg.minBodyHeightFrac + cfg.maxBodyHeightFrac) * 0.5;
  // Vertically centred within the usable band.
  const y = (1 - targetHeight) * 0.5;
  // A standing body is roughly 0.26 of its height wide across the shoulders; widen it a little
  // so the guide does not look impossibly narrow to stand inside.
  const widthInHeights = targetHeight * 0.38;
  const widthFrac = widthInHeights / aspect;
  return { x: 0.5 - widthFrac * 0.5, y, width: widthFrac, height: targetHeight };
}
