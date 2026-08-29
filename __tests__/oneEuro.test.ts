import {
  DEFAULT_ONE_EURO,
  applyOneEuro,
  createOneEuroBank,
  resetOneEuroBank,
} from '../src/core/oneEuro';
import { createPoseView, type PoseView } from '../src/core/geometry';

function viewAt(u: number, v: number, z = 0, vis = 1): PoseView {
  const view = createPoseView();
  for (let i = 0; i < 33; i++) {
    view.u[i] = u;
    view.v[i] = v;
    view.z[i] = z;
    view.vis[i] = vis;
  }
  view.aspect = 720 / 1280;
  view.imageWidth = 720;
  view.imageHeight = 1280;
  view.valid = true;
  return view;
}

describe('One Euro filter', () => {
  it('passes the first sample straight through', () => {
    const bank = createOneEuroBank();
    const src = viewAt(0.3, 0.4, 0.1);
    const dst = createPoseView();
    expect(applyOneEuro(bank, src, dst, 0)).toBe(true);
    expect(dst.u[0]).toBeCloseTo(0.3, 12);
    expect(dst.v[0]).toBeCloseTo(0.4, 12);
  });

  it('suppresses jitter around a stationary value', () => {
    const bank = createOneEuroBank();
    const dst = createPoseView();
    const dt = 1 / 30;

    // Prime, then feed 200 frames of noise around 0.5.
    applyOneEuro(bank, viewAt(0.5, 0.5), dst, 0);
    let sumSqIn = 0;
    let sumSqOut = 0;
    for (let i = 1; i < 200; i++) {
      // Deterministic pseudo-noise, so the assertion is stable.
      const noise = 0.004 * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
      const src = viewAt(0.5 + noise, 0.5 + noise);
      applyOneEuro(bank, src, dst, i * dt);
      if (i > 30) {
        // `viewAt` writes u directly, so it is already in isotropic space — no aspect factor
        // belongs in this comparison.
        sumSqIn += noise * noise;
        sumSqOut += (dst.u[0] - 0.5) * (dst.u[0] - 0.5);
      }
    }
    // The whole point of the filter: far less output variance than input variance when still.
    expect(sumSqOut).toBeLessThan(sumSqIn * 0.5);
  });

  it('tracks a fast ramp with modest lag, which is the reason for the adaptive cutoff', () => {
    const bank = createOneEuroBank();
    const dst = createPoseView();
    const dt = 1 / 30;

    applyOneEuro(bank, viewAt(0, 0), dst, 0);
    // Sweep v from 0 to 1 over half a second, roughly a fast squat descent.
    const frames = 15;
    for (let i = 1; i <= frames; i++) {
      applyOneEuro(bank, viewAt(0, i / frames), dst, i * dt);
    }
    // Some lag is expected and acceptable; being stuck near the start would not be.
    expect(dst.v[0]).toBeGreaterThan(0.55);
    expect(dst.v[0]).toBeLessThanOrEqual(1.0);
  });

  it('resets across a long gap rather than dragging a ghost across the frame', () => {
    const bank = createOneEuroBank();
    const dst = createPoseView();
    applyOneEuro(bank, viewAt(0.1, 0.1), dst, 0);
    applyOneEuro(bank, viewAt(0.1, 0.1), dst, 1 / 30);

    // A gap longer than resetGapSec: the previous sample says nothing about this one.
    applyOneEuro(bank, viewAt(0.9, 0.9), dst, 5.0);
    expect(dst.v[0]).toBeCloseTo(0.9, 9);
    expect(bank.resetCount).toBeGreaterThanOrEqual(1);
  });

  it('smooths z more heavily than x and y, since z is the noisier channel', () => {
    const bank = createOneEuroBank();
    const dst = createPoseView();
    const dt = 1 / 30;

    applyOneEuro(bank, viewAt(0, 0, 0), dst, 0);
    for (let i = 1; i <= 5; i++) {
      // Identical step change applied to v and to z.
      applyOneEuro(bank, viewAt(0, 1, 1), dst, i * dt);
    }
    // z should have travelled less of the way to the new value.
    expect(dst.z[0]).toBeLessThan(dst.v[0]);
  });

  it('clamps an absurd dt instead of producing a degenerate alpha', () => {
    const bank = createOneEuroBank();
    const dst = createPoseView();
    applyOneEuro(bank, viewAt(0.5, 0.5), dst, 0);
    // A backwards timestamp must not produce NaN or a wild value.
    applyOneEuro(bank, viewAt(0.6, 0.6), dst, -1);
    expect(Number.isFinite(dst.u[0])).toBe(true);
    expect(Number.isFinite(dst.v[0])).toBe(true);
  });

  it('reports invalid input rather than filtering garbage', () => {
    const bank = createOneEuroBank();
    const dst = createPoseView();
    const src = viewAt(0.5, 0.5);
    src.valid = false;
    expect(applyOneEuro(bank, src, dst, 0)).toBe(false);
    expect(dst.valid).toBe(false);
  });

  it('honours an explicit reset', () => {
    const bank = createOneEuroBank();
    const dst = createPoseView();
    applyOneEuro(bank, viewAt(0.1, 0.1), dst, 0);
    resetOneEuroBank(bank);
    expect(bank.primed).toBe(false);
    applyOneEuro(bank, viewAt(0.9, 0.9), dst, 1 / 30);
    expect(dst.v[0]).toBeCloseTo(0.9, 9);
  });

  it('exposes tunable parameters, as the brief requires', () => {
    expect(DEFAULT_ONE_EURO.minCutoff).toBeGreaterThan(0);
    expect(DEFAULT_ONE_EURO.beta).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_ONE_EURO.dCutoff).toBeGreaterThan(0);
    // z gets its own, heavier parameters.
    expect(DEFAULT_ONE_EURO.zMinCutoff).toBeLessThan(DEFAULT_ONE_EURO.minCutoff);
  });

  it('smooths less when beta is raised, trading jitter for responsiveness', () => {
    const dt = 1 / 30;
    const run = (beta: number): number => {
      const bank = createOneEuroBank({ ...DEFAULT_ONE_EURO, beta });
      const dst = createPoseView();
      applyOneEuro(bank, viewAt(0, 0), dst, 0);
      for (let i = 1; i <= 10; i++) applyOneEuro(bank, viewAt(0, i / 10), dst, i * dt);
      return dst.v[0];
    };
    expect(run(0.4)).toBeGreaterThan(run(0.0));
  });
});
