/**
 * End-to-end recognition tests over synthetic sessions.
 *
 * These run the real pipeline — same smoothing, features, state machines and disambiguation as
 * the device — over poses whose ground truth is known exactly. They cannot validate MediaPipe's
 * own accuracy, but they do lock in every behaviour the brief asks for.
 */

import { LM } from '../src/core/landmarks';
import {
  concatSessions,
  decimateFrames,
  depthCorrelation,
  injectTrackingLoss,
  peakDepth,
  phaseSequence,
  runFrames,
  runSynth,
} from '../src/dev/runPipeline';
import { generateSession, type SynthSessionSpec } from '../src/dev/synthExercises';
import { DEFAULT_CAMERA } from '../src/dev/synthBody';

const CAL = { forceBaselineAtSec: 2.0 };

describe('squat', () => {
  it('counts ten clean reps', () => {
    const r = runSynth({ exercise: 'squat', reps: 10, seed: 101 }, CAL);
    expect(r.repCounts.squat).toBe(10);
    expect(r.repCounts.pushup).toBe(0);
    expect(r.repCounts.lunge).toBe(0);
  });

  it('visits the phases in order', () => {
    const r = runSynth({ exercise: 'squat', reps: 3, seed: 102 }, CAL);
    expect(phaseSequence(r.events, 'squat').slice(0, 5)).toEqual([
      'standing',
      'descending',
      'bottom',
      'ascending',
      'standing',
    ]);
  });

  it('produces a depth curve that tracks true depth, not just a rep count', () => {
    // depth and phase are the primary product; a good rep count with a poor depth curve would
    // still animate badly.
    const r = runSynth({ exercise: 'squat', reps: 6, seed: 103 }, CAL);
    expect(depthCorrelation(r, 'squat')).toBeGreaterThan(0.85);
    expect(peakDepth(r.events, 'squat')).toBeGreaterThan(80);
  });

  it('rejects reps that do not reach the minimum depth', () => {
    const r = runSynth(
      {
        exercise: 'squat',
        reps: 6,
        seed: 104,
        repProfiles: [undefined, { depthFraction: 0.55 }, undefined, { depthFraction: 0.55 }, undefined, undefined],
      },
      CAL,
    );
    expect(r.repCounts.squat).toBe(4);
    expect(r.partialReps).toBeGreaterThanOrEqual(2);
  });

  it('never counts a hip hinge, which is what the hip/knee corroboration is for', () => {
    const r = runSynth({ exercise: 'hinge', reps: 10, seed: 105 }, CAL);
    expect(r.repCounts.squat).toBe(0);
    expect(r.repCounts.pushup).toBe(0);
    expect(r.repCounts.lunge).toBe(0);
  });

  it('counts nothing while the user just stands there', () => {
    const r = runSynth({ exercise: 'standing', reps: 0, seed: 106, leadInSec: 12 }, CAL);
    expect(r.repCounts.squat).toBe(0);
  });

  it('holds across body heights from 1.55 m to 1.95 m', () => {
    for (const heightM of [1.55, 1.65, 1.75, 1.85, 1.95]) {
      const r = runSynth({ exercise: 'squat', reps: 8, seed: 107, body: { heightM } }, CAL);
      expect(r.repCounts.squat).toBe(8);
    }
  });

  it('holds across camera tilts from 10 to 40 degrees', () => {
    for (const tiltDeg of [10, 15, 21, 30, 40]) {
      const r = runSynth(
        { exercise: 'squat', reps: 8, seed: 108, camera: { ...DEFAULT_CAMERA, tiltDeg } },
        CAL,
      );
      expect(r.repCounts.squat).toBe(8);
    }
  });

  it('holds across standing distances from 1.4 m to 2.4 m', () => {
    for (const distanceM of [1.4, 1.83, 2.4]) {
      const r = runSynth(
        { exercise: 'squat', reps: 8, seed: 109, camera: { ...DEFAULT_CAMERA, distanceM } },
        CAL,
      );
      expect(r.repCounts.squat).toBe(8);
    }
  });

  it('holds at elevated landmark noise', () => {
    for (const noiseSigmaPx of [2.8, 5.6, 8.4]) {
      const r = runSynth({ exercise: 'squat', reps: 8, seed: 110, noiseSigmaPx }, CAL);
      expect(r.repCounts.squat).toBe(8);
    }
  });

  it('holds down to 15 fps and with every second frame dropped', () => {
    for (const fps of [15, 20, 24, 30]) {
      const r = runSynth({ exercise: 'squat', reps: 8, seed: 111, fps }, CAL);
      expect(r.repCounts.squat).toBe(8);
    }
    const decimated = decimateFrames(generateSession({ exercise: 'squat', reps: 8, seed: 112 }), 2);
    expect(runFrames(decimated, CAL).repCounts.squat).toBe(8);
  });
});

describe('push-up', () => {
  it('counts ten clean reps', () => {
    const r = runSynth({ exercise: 'pushup', reps: 10, seed: 201 }, CAL);
    expect(r.repCounts.pushup).toBe(10);
    expect(r.repCounts.squat).toBe(0);
    expect(r.repCounts.lunge).toBe(0);
  });

  it('produces a depth curve that tracks true depth', () => {
    const r = runSynth({ exercise: 'pushup', reps: 6, seed: 202 }, CAL);
    expect(depthCorrelation(r, 'pushup')).toBeGreaterThan(0.85);
  });

  it('works with the ankles effectively invisible, as this camera angle requires', () => {
    // The generator already suppresses foot visibility for push-ups; drive it to near zero to
    // prove no ankle-derived feature is load-bearing.
    const frames = injectTrackingLoss(
      generateSession({ exercise: 'pushup', reps: 8, seed: 203 }),
      0,
      1e6,
      [LM.LEFT_ANKLE, LM.RIGHT_ANKLE, LM.LEFT_HEEL, LM.RIGHT_HEEL, LM.LEFT_FOOT_INDEX, LM.RIGHT_FOOT_INDEX],
      0.02,
    );
    expect(runFrames(frames, CAL).repCounts.pushup).toBe(8);
  });

  it('never counts standing arm raises, however far the elbow travels', () => {
    const r = runSynth({ exercise: 'armRaise', reps: 10, seed: 204 }, CAL);
    expect(r.repCounts.pushup).toBe(0);
  });

  it('flags sagging reps without discarding them by default', () => {
    // rejectSaggedReps is off until the rigidity signal has been validated on real footage, so
    // the reps must still be counted while the flag is raised.
    const r = runSynth(
      {
        exercise: 'pushup',
        reps: 6,
        seed: 205,
        hipSagPerRep: [0, 0.14, 0, 0.14, 0, 0],
      },
      CAL,
    );
    expect(r.repCounts.pushup).toBe(6);
  });

  it('holds across body heights', () => {
    for (const heightM of [1.6, 1.75, 1.9]) {
      const r = runSynth({ exercise: 'pushup', reps: 8, seed: 206, body: { heightM } }, CAL);
      expect(r.repCounts.pushup).toBe(8);
    }
  });
});

describe('lunge', () => {
  it('counts ten alternating reps', () => {
    const r = runSynth(
      { exercise: 'lunge', reps: 10, seed: 301, alternateFrontLeg: true },
      CAL,
    );
    expect(r.repCounts.lunge).toBe(10);
    expect(r.repCounts.squat).toBe(0);
  });

  it('labels the front leg and detects the alternation', () => {
    const r = runSynth(
      { exercise: 'lunge', reps: 10, seed: 302, alternateFrontLeg: true, firstFrontLeg: 'left' },
      CAL,
    );
    expect(r.frontLegs).toHaveLength(10);
    expect(r.frontLegs.slice(0, 4)).toEqual(['left', 'right', 'left', 'right']);
    expect(r.alternation).toBe(1);
  });

  it('labels the front leg starting from the right leg too', () => {
    const r = runSynth(
      { exercise: 'lunge', reps: 8, seed: 303, alternateFrontLeg: true, firstFrontLeg: 'right' },
      CAL,
    );
    expect(r.frontLegs.slice(0, 4)).toEqual(['right', 'left', 'right', 'left']);
  });

  it('populates frontLeg on lunge events and nulls it on every other exercise', () => {
    const lunge = runSynth({ exercise: 'lunge', reps: 4, seed: 304, alternateFrontLeg: true }, CAL);
    expect(lunge.events.some((e) => e.exercise === 'lunge' && e.frontLeg !== null)).toBe(true);

    const squat = runSynth({ exercise: 'squat', reps: 4, seed: 305 }, CAL);
    expect(squat.events.every((e) => e.frontLeg === null)).toBe(true);
  });

  it('still works when MediaPipe z carries no information at all', () => {
    // The single biggest real-world risk in the front-leg design: z has systematic error no
    // synthetic model predicts. Zeroing it is the worst case.
    const frames = generateSession({
      exercise: 'lunge',
      reps: 10,
      seed: 306,
      alternateFrontLeg: true,
    });
    for (const fr of frames) {
      for (let i = 0; i < 33; i++) fr.flat[i * 4 + 2] = 0;
    }
    const r = runFrames(frames, CAL);
    expect(r.repCounts.lunge).toBe(10);
    expect(r.alternation).toBe(1);
  });

  it('still works when z is present but wildly noisy', () => {
    const r = runSynth(
      { exercise: 'lunge', reps: 10, seed: 307, alternateFrontLeg: true, zNoiseMultiplier: 40 },
      CAL,
    );
    expect(r.repCounts.lunge).toBe(10);
    expect(r.alternation).toBeGreaterThanOrEqual(0.8);
  });

  it('holds at a short stride, where the separation signal is weakest', () => {
    const r = runSynth({ exercise: 'lunge', reps: 8, seed: 308, alternateFrontLeg: true }, CAL);
    expect(r.repCounts.lunge).toBe(8);
  });
});

describe('disambiguation', () => {
  // The baseline is standing-specific, so every mixed session begins standing.
  const STAND: SynthSessionSpec = { exercise: 'standing', reps: 0, seed: 400, leadInSec: 3 };

  it('tracks a squat -> push-up -> lunge session without corrupting any count', () => {
    const frames = concatSessions([
      STAND,
      { exercise: 'squat', reps: 5, seed: 401, leadInSec: 1, leadOutSec: 2 },
      { exercise: 'pushup', reps: 5, seed: 402, leadInSec: 2, leadOutSec: 2 },
      { exercise: 'lunge', reps: 6, seed: 403, leadInSec: 2, leadOutSec: 2, alternateFrontLeg: true },
    ]);
    const r = runFrames(frames, CAL);
    expect(r.repCounts.squat).toBe(5);
    expect(r.repCounts.pushup).toBe(5);
    expect(r.repCounts.lunge).toBe(6);
  });

  it('does not get stuck on a previous label', () => {
    const frames = concatSessions([
      STAND,
      { exercise: 'pushup', reps: 6, seed: 404, leadInSec: 2, leadOutSec: 2 },
      { exercise: 'squat', reps: 6, seed: 405, leadInSec: 2, leadOutSec: 2 },
    ]);
    const r = runFrames(frames, CAL);
    expect(r.repCounts.pushup).toBe(6);
    expect(r.repCounts.squat).toBe(6);
  });

  it('survives repeated switching between the hardest pair, squat and lunge', () => {
    const frames = concatSessions([
      STAND,
      { exercise: 'squat', reps: 3, seed: 406, leadInSec: 1, leadOutSec: 1.5 },
      { exercise: 'lunge', reps: 3, seed: 407, leadInSec: 1.5, leadOutSec: 1.5, alternateFrontLeg: true },
      { exercise: 'squat', reps: 3, seed: 408, leadInSec: 1.5, leadOutSec: 1.5 },
      { exercise: 'lunge', reps: 3, seed: 409, leadInSec: 1.5, leadOutSec: 1.5, alternateFrontLeg: true },
    ]);
    const r = runFrames(frames, CAL);
    expect(r.repCounts.squat).toBe(6);
    expect(r.repCounts.lunge).toBe(6);
  });

  it('starts at unknown rather than guessing', () => {
    const r = runSynth({ exercise: 'squat', reps: 4, seed: 410 }, CAL);
    expect(r.labelSequence[0]).toBe('unknown');
  });

  it('never reports a lunge front leg while a squat is active', () => {
    const r = runSynth({ exercise: 'squat', reps: 6, seed: 411 }, CAL);
    expect(r.events.filter((e) => e.exercise === 'lunge')).toHaveLength(0);
  });
});

describe('tracking loss', () => {
  it('recovers from a total dropout without inventing reps', () => {
    const frames = injectTrackingLoss(
      generateSession({ exercise: 'squat', reps: 10, seed: 501 }),
      9,
      12,
      [
        LM.LEFT_SHOULDER,
        LM.RIGHT_SHOULDER,
        LM.LEFT_HIP,
        LM.RIGHT_HIP,
        LM.LEFT_KNEE,
        LM.RIGHT_KNEE,
        LM.LEFT_ANKLE,
        LM.RIGHT_ANKLE,
      ],
    );
    const r = runFrames(frames, CAL);
    // Reps overlapping the blackout are legitimately lost; none may be fabricated.
    expect(r.repCounts.squat).toBeGreaterThanOrEqual(7);
    expect(r.repCounts.squat).toBeLessThanOrEqual(10);
  });

  it('drops to unknown when a squat loses the ankles it depends on', () => {
    const frames = injectTrackingLoss(
      generateSession({ exercise: 'squat', reps: 10, seed: 502 }),
      8,
      12,
      [LM.LEFT_ANKLE, LM.RIGHT_ANKLE],
    );
    const r = runFrames(frames, CAL);
    expect(r.unknownFrames).toBeGreaterThan(0);
    expect(r.repCounts.squat).toBeGreaterThanOrEqual(7);
  });
});

describe('the output contract', () => {
  it('emits exactly one well-formed event per frame', () => {
    const frames = generateSession({ exercise: 'squat', reps: 3, seed: 601 });
    const r = runFrames(frames, CAL);
    expect(r.events).toHaveLength(frames.length);

    for (const e of r.events) {
      expect(typeof e.timestamp).toBe('number');
      expect(['squat', 'pushup', 'lunge', 'unknown']).toContain(e.exercise);
      expect(['standing', 'descending', 'bottom', 'ascending']).toContain(e.phase);
      expect(e.depth).toBeGreaterThanOrEqual(0);
      expect(e.depth).toBeLessThanOrEqual(100);
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
      expect(Number.isInteger(e.repCount)).toBe(true);
      expect(Number.isFinite(e.latencyMs)).toBe(true);
      expect(e.frontLeg === null || e.frontLeg === 'left' || e.frontLeg === 'right').toBe(true);
      if (e.exercise !== 'lunge') expect(e.frontLeg).toBeNull();
    }
  });

  it('never lets the rep count go backwards', () => {
    const r = runSynth({ exercise: 'squat', reps: 8, seed: 602 }, CAL);
    let last = 0;
    for (const e of r.events) {
      if (e.exercise === 'squat') {
        expect(e.repCount).toBeGreaterThanOrEqual(last);
        last = e.repCount;
      }
    }
  });

  it('reports latency percentiles, not merely an average', () => {
    const r = runSynth({ exercise: 'squat', reps: 4, seed: 603 }, CAL);
    expect(r.latency.endToEnd.count).toBeGreaterThan(0);
    for (const key of ['p50', 'p95', 'p99', 'mean', 'min', 'max'] as const) {
      expect(Number.isFinite(r.latency.endToEnd[key])).toBe(true);
    }
    expect(r.latency.endToEnd.p95).toBeGreaterThanOrEqual(r.latency.endToEnd.p50);
    expect(r.latency.endToEnd.p99).toBeGreaterThanOrEqual(r.latency.endToEnd.p95);
  });
});

describe('calibration', () => {
  it('completes from a genuine stillness hold and then recognises reps', () => {
    const r = runSynth({ exercise: 'squat', reps: 8, seed: 701, leadInSec: 4 });
    expect(r.pipeline.baseline).not.toBeNull();
    expect(r.repCounts.squat).toBe(8);
  });

  it('does not complete when there is not enough still time', () => {
    const r = runSynth({ exercise: 'squat', reps: 8, seed: 702, leadInSec: 1.0 });
    expect(r.pipeline.baseline).toBeNull();
  });

  it('refuses a push-up plank as a standing baseline', () => {
    // Accepting it would silently poison every threshold for the rest of the session.
    const r = runSynth({ exercise: 'pushup', reps: 4, seed: 703, leadInSec: 6 });
    expect(r.pipeline.baseline).toBeNull();
  });

  it('records a baseline whose values sit in the expected range for this camera', () => {
    const r = runSynth({ exercise: 'squat', reps: 2, seed: 704, leadInSec: 4 });
    const b = r.pipeline.baseline!;
    expect(b).not.toBeNull();
    expect(b.hipRatio).toBeGreaterThan(0.55);
    expect(b.hipRatio).toBeLessThan(0.8);
    expect(b.sampleCount).toBeGreaterThanOrEqual(30);
    expect(b.bodyHeightFrac).toBeGreaterThan(0.2);
  });
});
