/**
 * Adversarial probe: the cases most likely to make the recogniser look stupid.
 *
 * `probeRun.ts` shows the pipeline works on clean input. This one attacks it: movements that must
 * NOT be counted, bodies and cameras it was not tuned on, tracking dropouts, low frame rates, and
 * mixed sessions where the label has to change without corrupting a rep count.
 *
 * Run with `npm run probe:stress`.
 */

import { LM } from '../core/landmarks';
import {
  concatSessions,
  decimateFrames,
  depthCorrelation,
  injectTrackingLoss,
  runFrames,
  runSynth,
} from './runPipeline';
import { generateSession, type SynthSessionSpec } from './synthExercises';
import { DEFAULT_CAMERA } from './synthBody';

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'nan');
const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
}

// =============================================================================================
console.log('\n[1] MOVEMENTS THAT MUST NOT COUNT');
console.log('    The brief requires secondary validation to reject these.\n');

{
  // A hip hinge sweeps the torso a long way forward with straight knees. A classifier keying on
  // torso movement would count these as squats.
  const r = runSynth({ exercise: 'hinge', reps: 10, seed: 21 }, { forceBaselineAtSec: 2.0 });
  const total = Object.values(r.repCounts).reduce((a, b) => a + b, 0);
  check(
    'hip hinge x10 -> no reps counted',
    total === 0,
    `counts ${JSON.stringify(r.repCounts)} partials ${r.partialReps} flickers ${r.flickers}`,
  );
}

{
  // Standing arm raises sweep the elbow through a wide range — the trap for a push-up classifier
  // keyed on elbow angle.
  const r = runSynth({ exercise: 'armRaise', reps: 10, seed: 22 }, { forceBaselineAtSec: 2.0 });
  check(
    'standing arm raises x10 -> no push-ups counted',
    (r.repCounts.pushup ?? 0) === 0,
    `counts ${JSON.stringify(r.repCounts)}`,
  );
}

{
  const r = runSynth({ exercise: 'standing', reps: 0, seed: 23, leadInSec: 12 }, { forceBaselineAtSec: 2.0 });
  const total = Object.values(r.repCounts).reduce((a, b) => a + b, 0);
  check('12 s of standing still -> no reps', total === 0, `counts ${JSON.stringify(r.repCounts)}`);
}

{
  // Every rep only 55% deep. All should be rejected, and reported as partials rather than as
  // flicker, since flicker count is the signal-quality metric.
  const spec: SynthSessionSpec = {
    exercise: 'squat',
    reps: 8,
    seed: 24,
    repProfiles: new Array(8).fill({ depthFraction: 0.55 }),
  };
  const r = runSynth(spec, { forceBaselineAtSec: 2.0 });
  check(
    'squat x8 all 55% deep -> 0 counted, reported as partials',
    (r.repCounts.squat ?? 0) === 0 && r.partialReps >= 6,
    `counted ${r.repCounts.squat} partials ${r.partialReps} flickers ${r.flickers}`,
  );
}

// =============================================================================================
console.log('\n[2] BODIES AND CAMERAS THE THRESHOLDS WERE NOT TUNED ON');
console.log('    Thresholds were measured on a 1.75 m body at 21 degrees of tilt.\n');

for (const heightM of [1.55, 1.65, 1.85, 1.95]) {
  const r = runSynth(
    { exercise: 'squat', reps: 10, seed: 31, body: { heightM } },
    { forceBaselineAtSec: 2.0 },
  );
  check(
    `squat x10, body ${heightM} m`,
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat} depthCorr ${f(depthCorrelation(r, 'squat'), 3)}`,
  );
}

for (const tiltDeg of [10, 15, 30, 40]) {
  const r = runSynth(
    { exercise: 'squat', reps: 10, seed: 32, camera: { ...DEFAULT_CAMERA, tiltDeg } },
    { forceBaselineAtSec: 2.0 },
  );
  check(
    `squat x10, camera tilt ${tiltDeg} deg`,
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat} depthCorr ${f(depthCorrelation(r, 'squat'), 3)}`,
  );
}

for (const distanceM of [1.4, 1.6, 2.1, 2.4]) {
  const r = runSynth(
    { exercise: 'squat', reps: 10, seed: 33, camera: { ...DEFAULT_CAMERA, distanceM } },
    { forceBaselineAtSec: 2.0 },
  );
  check(
    `squat x10, distance ${distanceM} m`,
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat} depthCorr ${f(depthCorrelation(r, 'squat'), 3)}`,
  );
}

// Squat style, which moves the apparent knee flexion at full depth by 5.4x. See probe:style.
for (const hipSetbackM of [0.05, 0.12, 0.22, 0.3, 0.38]) {
  const r = runSynth({ exercise: 'squat', reps: 10, seed: 37, hipSetbackM }, { forceBaselineAtSec: 2.0 });
  const active = r.events.filter((e) => e.exercise === 'squat' && e.depth > 60);
  const meanConf = active.length ? active.reduce((a, e) => a + e.confidence, 0) / active.length : 0;
  check(
    `squat x10, hip setback ${hipSetbackM.toFixed(2)} m (style)`,
    (r.repCounts.squat ?? 0) === 10 && meanConf > 0.8,
    `reps ${r.repCounts.squat} meanConf@depth ${f(meanConf)} depthCorr ${f(depthCorrelation(r, 'squat'), 3)}`,
  );
}

for (const hfovDeg of [50, 70, 80]) {
  const r = runSynth(
    { exercise: 'squat', reps: 10, seed: 34, camera: { ...DEFAULT_CAMERA, hfovDeg } },
    { forceBaselineAtSec: 2.0 },
  );
  check(
    `squat x10, hfov ${hfovDeg} deg`,
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat}`,
  );
}

for (const heightM of [1.6, 1.9]) {
  const r = runSynth(
    { exercise: 'pushup', reps: 10, seed: 35, body: { heightM } },
    { forceBaselineAtSec: 2.0 },
  );
  check(
    `push-up x10, body ${heightM} m`,
    (r.repCounts.pushup ?? 0) === 10,
    `reps ${r.repCounts.pushup}`,
  );
}

for (const heightM of [1.6, 1.9]) {
  const r = runSynth(
    { exercise: 'lunge', reps: 10, seed: 36, body: { heightM }, alternateFrontLeg: true },
    { forceBaselineAtSec: 2.0 },
  );
  check(
    `lunge x10, body ${heightM} m`,
    (r.repCounts.lunge ?? 0) === 10,
    `reps ${r.repCounts.lunge} alternation ${f(r.alternation, 2)}`,
  );
}

// =============================================================================================
console.log('\n[3] DEGRADED INPUT\n');

for (const sigma of [2.8, 5.6, 8.4]) {
  const r = runSynth(
    { exercise: 'squat', reps: 10, seed: 41, noiseSigmaPx: sigma },
    { forceBaselineAtSec: 2.0 },
  );
  check(
    `squat x10 at ${sigma} px landmark noise`,
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat} flickers ${r.flickers} depthCorr ${f(depthCorrelation(r, 'squat'), 3)}`,
  );
}

for (const fps of [24, 20, 15]) {
  const r = runSynth({ exercise: 'squat', reps: 10, seed: 42, fps }, { forceBaselineAtSec: 2.0 });
  check(
    `squat x10 at ${fps} fps`,
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat} flickers ${r.flickers}`,
  );
}

{
  // Half the frames thrown away, emulating inference falling behind the camera.
  const frames = decimateFrames(generateSession({ exercise: 'squat', reps: 10, seed: 43 }), 2);
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  check(
    'squat x10 with every 2nd frame dropped',
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat} flickers ${r.flickers}`,
  );
}

{
  // Ankles lost for 4 s in the middle of the set: the squat gates require them, so the label
  // should drop and recover without inventing or losing reps beyond the interrupted ones.
  const frames = injectTrackingLoss(
    generateSession({ exercise: 'squat', reps: 10, seed: 44 }),
    8,
    12,
    [LM.LEFT_ANKLE, LM.RIGHT_ANKLE],
  );
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  const reps = r.repCounts.squat ?? 0;
  check(
    'squat x10 with ankles lost 8-12 s',
    reps >= 7 && reps <= 10,
    `reps ${reps} (7-10 acceptable) unknownFrames ${r.unknownFrames}`,
  );
}

{
  // Everything lost for 3 s: the machine must recover rather than emit a bogus rep on return.
  const frames = injectTrackingLoss(
    generateSession({ exercise: 'squat', reps: 10, seed: 45 }),
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
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  const reps = r.repCounts.squat ?? 0;
  check(
    'squat x10 with total tracking loss 9-12 s',
    reps >= 7 && reps <= 10,
    `reps ${reps} (7-10 acceptable, none invented) unknown ${r.unknownFrames}`,
  );
}

// =============================================================================================
console.log('\n[4] MIXED SESSION — the label has to change without corrupting counts\n');

// Every mixed session starts with a standing block. The baseline is standing-specific by
// design, and calibrating during a plank would poison it — see check [4d], which proves the real
// calibration gates refuse that pose rather than silently accepting it.
const STAND_FIRST: SynthSessionSpec = { exercise: 'standing', reps: 0, seed: 50, leadInSec: 3 };

{
  const frames = concatSessions([
    STAND_FIRST,
    { exercise: 'squat', reps: 5, seed: 51, leadInSec: 1, leadOutSec: 2 },
    { exercise: 'pushup', reps: 5, seed: 52, leadInSec: 2, leadOutSec: 2 },
    { exercise: 'lunge', reps: 6, seed: 53, leadInSec: 2, leadOutSec: 2, alternateFrontLeg: true },
  ]);
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  const ok =
    (r.repCounts.squat ?? 0) === 5 &&
    (r.repCounts.pushup ?? 0) === 5 &&
    (r.repCounts.lunge ?? 0) === 6;
  check(
    'squat x5 -> push-up x5 -> lunge x6',
    ok,
    `counts ${JSON.stringify(r.repCounts)} labels ${r.labelSequence.join('>')}`,
  );
}

{
  // Push-ups first, so a "sticky" label would show as a shortfall on the squats.
  const frames = concatSessions([
    STAND_FIRST,
    { exercise: 'pushup', reps: 6, seed: 54, leadInSec: 2, leadOutSec: 2 },
    { exercise: 'squat', reps: 6, seed: 55, leadInSec: 2, leadOutSec: 2 },
  ]);
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  check(
    'push-up x6 -> squat x6',
    (r.repCounts.pushup ?? 0) === 6 && (r.repCounts.squat ?? 0) === 6,
    `counts ${JSON.stringify(r.repCounts)}`,
  );
}

{
  // Alternating between two exercises repeatedly is the worst case for switch hysteresis, and
  // squat-vs-lunge is the hardest pair: they share the upright torso, the visible ankles, and
  // most of the corroboration signal.
  const frames = concatSessions([
    STAND_FIRST,
    { exercise: 'squat', reps: 3, seed: 56, leadInSec: 1, leadOutSec: 1.5 },
    { exercise: 'lunge', reps: 3, seed: 57, leadInSec: 1.5, leadOutSec: 1.5, alternateFrontLeg: true },
    { exercise: 'squat', reps: 3, seed: 58, leadInSec: 1.5, leadOutSec: 1.5 },
    { exercise: 'lunge', reps: 3, seed: 59, leadInSec: 1.5, leadOutSec: 1.5, alternateFrontLeg: true },
  ]);
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  check(
    'squat/lunge alternating blocks (3 each, twice)',
    (r.repCounts.squat ?? 0) === 6 && (r.repCounts.lunge ?? 0) === 6,
    `counts ${JSON.stringify(r.repCounts)}`,
  );
}

{
  // [4d] The baseline is standing-specific, so calibrating in a plank would silently invalidate
  // every threshold for the rest of the session. Prove the gates refuse it: a horizontal body
  // fails both the ankle-visibility and the apparent-body-height checks.
  const r = runSynth({ exercise: 'pushup', reps: 4, seed: 60, leadInSec: 6 });
  check(
    'calibration REFUSES a push-up plank as a standing baseline',
    r.pipeline.baseline === null,
    r.pipeline.baseline ? 'accepted it (BAD: thresholds would be poisoned)' : 'refused, as it must',
  );
}

// =============================================================================================
console.log('\n[5] REAL CALIBRATION PATH (no forced baseline)\n');

{
  const r = runSynth({ exercise: 'squat', reps: 10, seed: 61, leadInSec: 4 });
  check(
    'squat x10 via the actual 2 s stillness capture',
    (r.repCounts.squat ?? 0) === 10,
    `reps ${r.repCounts.squat} baseline ${r.pipeline.baseline ? 'captured' : 'MISSING'}`,
  );
}

{
  // Only 1 s of stillness before the set starts: calibration should not complete, so nothing is
  // recognised. Failing closed is correct here.
  const r = runSynth({ exercise: 'squat', reps: 10, seed: 62, leadInSec: 1.0 });
  check(
    'squat x10 with only 1 s lead-in -> calibration incomplete',
    r.pipeline.baseline === null || (r.repCounts.squat ?? 0) < 10,
    `baseline ${r.pipeline.baseline ? 'captured' : 'none'} reps ${r.repCounts.squat}`,
  );
}

// =============================================================================================
console.log('\n[6] LUNGE FRONT-LEG ROBUSTNESS — including z made useless\n');

{
  const r = runSynth(
    { exercise: 'lunge', reps: 12, seed: 71, alternateFrontLeg: true, firstFrontLeg: 'right' },
    { forceBaselineAtSec: 2.0 },
  );
  const expected = ['right', 'left', 'right', 'left', 'right', 'left'];
  const got = r.frontLegs.slice(0, 6).join(',');
  check(
    'lunge x12 alternating from the right leg',
    got === expected.join(','),
    `first six [${got}] alternation ${f(r.alternation, 2)}`,
  );
}

{
  // MediaPipe's z is the one signal a synthetic model cannot predict, so prove the module still
  // works when z carries no information at all.
  const frames = generateSession({
    exercise: 'lunge',
    reps: 10,
    seed: 72,
    alternateFrontLeg: true,
  });
  for (const fr of frames) {
    for (let i = 0; i < 33; i++) fr.flat[i * 4 + 2] = 0;
  }
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  check(
    'lunge x10 with z zeroed out entirely',
    (r.repCounts.lunge ?? 0) === 10 && r.alternation === 1,
    `reps ${r.repCounts.lunge} alternation ${f(r.alternation, 2)} legs [${r.frontLegs.slice(0, 6).join(',')}]`,
  );
}

{
  // z present but heavily corrupted, which is the realistic bad case rather than the absent case.
  const frames = generateSession({
    exercise: 'lunge',
    reps: 10,
    seed: 73,
    alternateFrontLeg: true,
    zNoiseMultiplier: 40,
  });
  const r = runFrames(frames, { forceBaselineAtSec: 2.0 });
  check(
    'lunge x10 with z noise 40x x/y noise',
    (r.repCounts.lunge ?? 0) === 10 && r.alternation >= 0.8,
    `reps ${r.repCounts.lunge} alternation ${f(r.alternation, 2)}`,
  );
}

// =============================================================================================
console.log(`\n${'='.repeat(96)}`);
const failed = checks.filter((c) => !c.ok);
console.log(`STRESS SUMMARY: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const c of failed) console.log(`  FAIL  ${c.name}  ${c.detail}`);
}
console.log('='.repeat(96));
