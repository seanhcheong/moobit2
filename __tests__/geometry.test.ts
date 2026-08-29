import {
  angleAtDeg,
  angleFromVerticalDeg,
  clamp01,
  createPoseView,
  fillPoseView,
  jointAngleDeg,
  meanAngle,
  median,
  normalizeRange,
} from '../src/core/geometry';
import { LM_STRIDE, LANDMARK_COUNT } from '../src/core/nativeContract';

/** Build a flat landmark array with the given normalised positions. */
function flatWith(points: Record<number, [number, number, number?, number?]>): number[] {
  const flat = new Array(LANDMARK_COUNT * LM_STRIDE).fill(0);
  for (let i = 0; i < LANDMARK_COUNT; i++) flat[i * LM_STRIDE + 3] = 1;
  for (const key of Object.keys(points)) {
    const i = Number(key);
    const [x, y, z = 0, vis = 1] = points[i];
    flat[i * LM_STRIDE] = x;
    flat[i * LM_STRIDE + 1] = y;
    flat[i * LM_STRIDE + 2] = z;
    flat[i * LM_STRIDE + 3] = vis;
  }
  return flat;
}

describe('angleAtDeg', () => {
  it('reports 90 degrees for a right angle', () => {
    expect(angleAtDeg(0, 1, 0, 0, 1, 0)).toBeCloseTo(90, 6);
  });

  it('reports 180 degrees for a straight line', () => {
    expect(angleAtDeg(-1, 0, 0, 0, 1, 0)).toBeCloseTo(180, 6);
  });

  it('reports 0 degrees for a fully folded joint', () => {
    expect(angleAtDeg(1, 0, 0, 0, 1, 0)).toBeCloseTo(0, 6);
  });

  it('returns NaN for a degenerate triangle rather than a plausible number', () => {
    expect(angleAtDeg(0, 0, 0, 0, 1, 0)).toBeNaN();
  });
});

describe('angleFromVerticalDeg', () => {
  it('treats image-up (negative dy) as 0 degrees', () => {
    expect(angleFromVerticalDeg(0, -1)).toBeCloseTo(0, 6);
  });

  it('treats horizontal as 90 degrees, either way', () => {
    expect(angleFromVerticalDeg(1, 0)).toBeCloseTo(90, 6);
    expect(angleFromVerticalDeg(-1, 0)).toBeCloseTo(90, 6);
  });

  it('treats image-down as 180 degrees', () => {
    expect(angleFromVerticalDeg(0, 1)).toBeCloseTo(180, 6);
  });
});

describe('the aspect-ratio (anisotropy) correction', () => {
  // This is the correction that is easiest to omit and hardest to notice: MediaPipe normalises x
  // by image WIDTH and y by image HEIGHT, so on a portrait frame the axes have different pixel
  // scales and any angle taken straight from the normalised values is wrong — consistently, and
  // therefore invisibly.
  it('recovers a true right angle on a portrait frame', () => {
    // A right angle with both legs on a diagonal. Axis-aligned legs would be a useless test
    // case: they stay perpendicular under ANY per-axis scaling, so they cannot reveal the bug.
    const W = 720;
    const H = 1280;
    const flat = flatWith({
      0: [0.5 - 100 / W, 0.5 - 100 / H],
      1: [0.5, 0.5],
      2: [0.5 + 100 / W, 0.5 - 100 / H],
    });

    const corrected = createPoseView();
    fillPoseView(corrected, flat, W, H, false);
    expect(jointAngleDeg(corrected, 0, 1, 2)).toBeCloseTo(90, 4);

    // Treating the frame as square is the bug; it should measure something clearly wrong.
    const naive = createPoseView();
    fillPoseView(naive, flat, 1000, 1000, false);
    const wrong = jointAngleDeg(naive, 0, 1, 2);
    expect(Math.abs(wrong - 90)).toBeGreaterThan(10);
  });

  it('makes the isotropic space have equal pixel scale on both axes', () => {
    const W = 720;
    const H = 1280;
    const onePxX = flatWith({ 0: [0.5, 0.5], 1: [0.5 + 1 / W, 0.5] });
    const onePxY = flatWith({ 0: [0.5, 0.5], 1: [0.5, 0.5 + 1 / H] });

    const a = createPoseView();
    const b = createPoseView();
    fillPoseView(a, onePxX, W, H, false);
    fillPoseView(b, onePxY, W, H, false);

    const dx = Math.abs(a.u[1] - a.u[0]);
    const dy = Math.abs(b.v[1] - b.v[0]);
    expect(dx).toBeCloseTo(dy, 12);
  });
});

describe('fillPoseView mirroring', () => {
  const W = 720;
  const H = 1280;

  it('reflects u about the frame centre', () => {
    const flat = flatWith({ 0: [0.25, 0.4] });
    const plain = createPoseView();
    const mirrored = createPoseView();
    fillPoseView(plain, flat, W, H, false);
    fillPoseView(mirrored, flat, W, H, true);
    const aspect = W / H;
    expect(plain.u[0]).toBeCloseTo(0.25 * aspect, 9);
    expect(mirrored.u[0]).toBeCloseTo(0.75 * aspect, 9);
  });

  it('leaves angles unchanged, since reflection preserves them', () => {
    const flat = flatWith({ 0: [0.3, 0.3], 1: [0.5, 0.5], 2: [0.7, 0.4] });
    const plain = createPoseView();
    const mirrored = createPoseView();
    fillPoseView(plain, flat, W, H, false);
    fillPoseView(mirrored, flat, W, H, true);
    expect(jointAngleDeg(mirrored, 0, 1, 2)).toBeCloseTo(jointAngleDeg(plain, 0, 1, 2), 9);
  });

  it('rejects malformed input instead of producing a half-filled view', () => {
    const v = createPoseView();
    expect(fillPoseView(v, [1, 2, 3], W, H, false)).toBe(false);
    expect(v.valid).toBe(false);
    expect(fillPoseView(v, flatWith({}), 0, H, false)).toBe(false);
  });
});

describe('meanAngle', () => {
  it('averages two readable sides', () => {
    expect(meanAngle(100, 120)).toBeCloseTo(110, 9);
  });

  it('falls back to the single readable side rather than poisoning the result with NaN', () => {
    // One leg occluding the other mid-lunge is routine from a floor-level camera.
    expect(meanAngle(100, NaN)).toBeCloseTo(100, 9);
    expect(meanAngle(NaN, 120)).toBeCloseTo(120, 9);
  });

  it('returns NaN only when neither side is readable', () => {
    expect(meanAngle(NaN, NaN)).toBeNaN();
  });
});

describe('median', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('ignores NaN', () => {
    expect(median([1, NaN, 3])).toBe(2);
  });

  it('returns NaN when there is nothing usable', () => {
    expect(median([])).toBeNaN();
    expect(median([NaN, NaN])).toBeNaN();
  });

  it('resists a single outlier, which is why calibration uses it over a mean', () => {
    const withGlitch = [170, 171, 169, 170, 20];
    expect(median(withGlitch)).toBe(170);
  });
});

describe('scalar helpers', () => {
  it('clamps to the unit range', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });

  it('normalizes and clamps a range', () => {
    expect(normalizeRange(5, 0, 10)).toBeCloseTo(0.5, 9);
    expect(normalizeRange(-5, 0, 10)).toBe(0);
    expect(normalizeRange(15, 0, 10)).toBe(1);
  });

  it('returns 0 for a degenerate range rather than Infinity', () => {
    expect(normalizeRange(5, 3, 3)).toBe(0);
    expect(normalizeRange(5, 0, NaN)).toBe(0);
  });
});
