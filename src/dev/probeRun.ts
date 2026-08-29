/**
 * End-to-end probe: runs the real pipeline over synthetic sessions and prints what it detected.
 *
 * This is the fast feedback loop for tuning. Run `npm run probe:run` after changing any threshold
 * and read off whether rep counts, depth correlation, front-leg labelling and flicker counts moved
 * in the right direction.
 */

import { depthCorrelation, peakDepth, phaseSequence, runSynth } from './runPipeline';
import type { SynthSessionSpec } from './synthExercises';

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'nan');

function report(title: string, spec: SynthSessionSpec, expectReps: number) {
  const r = runSynth(spec, { forceBaselineAtSec: 2.0 });
  const ex = spec.exercise;
  const detected = r.repCounts[ex] ?? 0;
  const activeFrames = r.events.filter((e) => e.exercise === ex).length;
  const total = r.events.length;

  console.log(`\n${'-'.repeat(96)}`);
  console.log(`${title}`);
  console.log(`${'-'.repeat(96)}`);
  console.log(
    `  reps detected ${detected} / expected ${expectReps}` +
      `   ${detected === expectReps ? 'OK' : '<-- MISMATCH'}`,
  );
  console.log(`  all rep counts: ${JSON.stringify(r.repCounts)}`);
  console.log(
    `  label sequence: ${r.labelSequence.join(' -> ')}` +
      `   (active ${activeFrames}/${total} frames, unknown ${r.unknownFrames})`,
  );
  console.log(`  phases: ${phaseSequence(r.events, ex).slice(0, 14).join(' -> ')}`);
  console.log(
    `  depth: peak ${f(peakDepth(r.events, ex), 1)}` +
      `  correlation with truth ${f(depthCorrelation(r, ex), 3)}`,
  );
  console.log(`  flickers ${r.flickers}  partials ${r.partialReps}`);
  if (ex === 'lunge') {
    console.log(
      `  front legs: [${r.frontLegs.join(', ')}]  alternation ${f(r.alternation, 2)}`,
    );
  }
  const l = r.latency;
  console.log(
    `  latency (${l.definition}): p50 ${f(l.endToEnd.p50, 1)}  p95 ${f(l.endToEnd.p95, 1)}` +
      `  p99 ${f(l.endToEnd.p99, 1)} ms   [simulated inference, NOT a device measurement]`,
  );
  return { detected, expectReps, ok: detected === expectReps };
}

const results: { name: string; ok: boolean }[] = [];

results.push({
  name: 'squat x10',
  ...report('SQUAT — 10 clean reps', { exercise: 'squat', reps: 10, seed: 1 }, 10),
});

results.push({
  name: 'squat x8 partials',
  ...report(
    'SQUAT — 8 reps, #3 and #6 only 60% deep (should be rejected as partials)',
    {
      exercise: 'squat',
      reps: 8,
      seed: 2,
      repProfiles: [
        undefined,
        undefined,
        { depthFraction: 0.6 },
        undefined,
        undefined,
        { depthFraction: 0.6 },
        undefined,
        undefined,
      ],
    },
    6,
  ),
});

results.push({
  name: 'squat fast',
  ...report(
    'SQUAT — 10 fast reps (1.1 s each)',
    { exercise: 'squat', reps: 10, seed: 3, repDurationSec: 1.1, restBetweenRepsSec: 0.2 },
    10,
  ),
});

results.push({
  name: 'squat noisy',
  ...report(
    'SQUAT — 10 reps at 3x landmark noise',
    { exercise: 'squat', reps: 10, seed: 4, noiseSigmaPx: 4.2 },
    10,
  ),
});

results.push({
  name: 'pushup x10',
  ...report('PUSH-UP — 10 clean reps', { exercise: 'pushup', reps: 10, seed: 5 }, 10),
});

results.push({
  name: 'pushup sag',
  ...report(
    'PUSH-UP — 8 reps, #2/#5/#7 with 12 cm hip sag (rigidity should flag, not reject by default)',
    {
      exercise: 'pushup',
      reps: 8,
      seed: 6,
      hipSagPerRep: [0, 0.12, 0, 0, 0.12, 0, 0.12, 0],
    },
    8,
  ),
});

results.push({
  name: 'lunge x10 alt',
  ...report(
    'LUNGE — 10 alternating reps',
    { exercise: 'lunge', reps: 10, seed: 7, alternateFrontLeg: true, firstFrontLeg: 'left' },
    10,
  ),
});

results.push({
  name: 'lunge short stride',
  ...report(
    'LUNGE — 10 alternating reps, short 0.5 m stride',
    { exercise: 'lunge', reps: 10, seed: 8, alternateFrontLeg: true },
    10,
  ),
});

results.push({
  name: 'standing only',
  ...report('STANDING — no reps at all (must detect zero)', { exercise: 'standing', reps: 0, seed: 9, leadInSec: 8 }, 0),
});

console.log(`\n${'='.repeat(96)}`);
console.log('SUMMARY');
console.log('='.repeat(96));
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed}/${results.length} scenarios matched expected rep count`);
console.log('='.repeat(96));
