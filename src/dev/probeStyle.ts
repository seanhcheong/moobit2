/**
 * Style-sensitivity probe.
 *
 * ## Why this exists
 * The other probes sweep things about the *setup* — body height, camera tilt, distance, noise. This
 * one sweeps something about the *user*: how they choose to move. That turned out to matter far
 * more, and it exposed a real defect.
 *
 * With the feet planted and the pelvis at a given height, a leg has one degree of freedom left, so
 * however far the hips fail to travel backward is forced into the knee travelling forward instead.
 * A knee-dominant squat therefore points the thigh almost straight down a head-on camera's view
 * axis, where it foreshortens to nearly nothing; a hip-dominant squat keeps the thigh closer to the
 * image plane. Across the realistic range that moves the apparent knee flexion at full depth from
 * about 29 degrees to about 156 degrees — a 5.4x swing on a quantity the classifier reads.
 *
 * The original corroborators matched each excursion against an expected magnitude calibrated at a
 * single style, so they scored 0.00 at every other style: silently dead for essentially every real
 * user, and quietly eating the confidence margin that separates a squat from a lunge. They now
 * check direction and a saturating minimum instead, which is what this probe guards.
 *
 * Run with `npm run probe:style`.
 */

import { LM } from '../core/landmarks';
import { computeFeatures, createFeatureHistory, createFeatures, type Features } from '../core/features';
import { createPoseView, fillPoseView, jointAngleDeg } from '../core/geometry';
import { DEFAULT_BODY, DEFAULT_CAMERA, makeProjector, projectToFlat, segmentsFor } from './synthBody';
import { squatPose, hingePose, type PoseOptions } from './synthExercises';
import { depthCorrelation, runSynth } from './runPipeline';
import { squatModule } from '../core/exercises';
import { createMeasurement, createScore } from '../core/exercise';
import { baselineFromFeatures } from '../core/calibration';

const seg = segmentsFor(DEFAULT_BODY);
const proj = makeProjector(DEFAULT_CAMERA);

/** Feed two frames a realistic dt apart so velocity-dependent fields are populated. */
function featuresAt(make: (d: number) => ReturnType<typeof squatPose>, depth: number): Features {
  const view = createPoseView();
  const hist = createFeatureHistory();
  const out = createFeatures();
  for (const [i, d] of [Math.max(0, depth - 0.03), depth].entries()) {
    const flat = projectToFlat(make(d), proj, () => 0, { noiseSigmaPx: 0, zNoiseMultiplier: 0 });
    fillPoseView(view, flat, DEFAULT_CAMERA.imageWidth, DEFAULT_CAMERA.imageHeight, false);
    computeFeatures(view, hist, i / 30, out);
  }
  return out;
}

const STYLES = [0.05, 0.12, 0.22, 0.3, 0.38];
const f2 = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'nan');

const baseline = baselineFromFeatures(
  featuresAt((d) => squatPose({ depth: d, seg, hipSetbackM: 0.22 }), 0),
  0,
);

console.log('='.repeat(102));
console.log('SQUAT STYLE SWEEP — hip setback at full depth, in metres. Realistic range is 0.15-0.30.');
console.log('='.repeat(102));
console.log(
  '\nsetback  kneeFwd  apparentKnee      kneeDrop  hipRatio         excursion  corroboration  conf   reps  depthCorr',
);

let minExcursion = Infinity;
let maxExcursion = -Infinity;
let minKneeDrop = Infinity;
let maxKneeDrop = -Infinity;
let minCorroboration = Infinity;
let allRepsOk = true;

for (const setback of STYLES) {
  const mk = (d: number) => squatPose({ depth: d, seg, hipSetbackM: setback } as PoseOptions);
  const top = featuresAt(mk, 0);
  const bot = featuresAt(mk, 1);

  const view = createPoseView();
  const flatTop = projectToFlat(mk(0), proj, () => 0, { noiseSigmaPx: 0, zNoiseMultiplier: 0 });
  fillPoseView(view, flatTop, DEFAULT_CAMERA.imageWidth, DEFAULT_CAMERA.imageHeight, false);
  const kTop = jointAngleDeg(view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const flatBot = projectToFlat(mk(1), proj, () => 0, { noiseSigmaPx: 0, zNoiseMultiplier: 0 });
  fillPoseView(view, flatBot, DEFAULT_CAMERA.imageWidth, DEFAULT_CAMERA.imageHeight, false);
  const kBot = jointAngleDeg(view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);

  const skel = mk(1);
  const kneeFwd = skel[LM.LEFT_KNEE].z - skel[LM.LEFT_ANKLE].z;
  const excursion = top.hipRatio - bot.hipRatio;

  // Run the real classifier at the bottom of the movement.
  const state = squatModule.createState();
  const m = createMeasurement();
  const score = createScore();
  squatModule.measure(state, bot, baseline, m);
  squatModule.score(state, bot, baseline, m, score);

  const run = runSynth(
    { exercise: 'squat', reps: 8, seed: 8080, hipSetbackM: setback },
    { forceBaselineAtSec: 2.0 },
  );
  const reps = run.repCounts.squat ?? 0;
  if (reps !== 8) allRepsOk = false;

  minExcursion = Math.min(minExcursion, excursion);
  maxExcursion = Math.max(maxExcursion, excursion);
  minKneeDrop = Math.min(minKneeDrop, kTop - kBot);
  maxKneeDrop = Math.max(maxKneeDrop, kTop - kBot);
  minCorroboration = Math.min(minCorroboration, m.corroboration);

  console.log(
    `  ${f2(setback)}    ${f2(kneeFwd, 3)}   ${f2(kTop, 1).padStart(5)} -> ${f2(kBot, 1).padStart(5)}` +
      `    ${f2(kTop - kBot, 1).padStart(6)}   ${f2(top.hipRatio, 3)} -> ${f2(bot.hipRatio, 3)}` +
      `    ${f2(excursion, 3)}       ${f2(m.corroboration)}       ${f2(score.confidence)}   ` +
      `${String(reps).padStart(2)}/8   ${f2(depthCorrelation(run, 'squat'), 3)}`,
  );
}

console.log('\nSPREAD ACROSS STYLE');
console.log(
  `  hipRatio excursion   ${f2(minExcursion, 3)} .. ${f2(maxExcursion, 3)}` +
    `   (${f2((100 * (maxExcursion - minExcursion)) / maxExcursion, 1)}% spread)  <- the primary signal`,
);
console.log(
  `  apparent knee drop   ${f2(minKneeDrop, 1)} .. ${f2(maxKneeDrop, 1)} deg` +
    `   (${f2(maxKneeDrop / Math.max(1e-6, minKneeDrop), 1)}x swing)  <- why magnitude-matching fails`,
);
console.log(`  worst corroboration  ${f2(minCorroboration)}  (was 0.00 at 4 of 5 styles before the fix)`);
console.log(`  rep counts           ${allRepsOk ? 'ALL 8/8' : 'MISMATCH — investigate'}`);

// ---------------------------------------------------------------------------------------------
console.log('\nCONTROL — the hip hinge must still be rejected at every style threshold');
{
  const hinge = featuresAt((d) => hingePose({ depth: d, seg }), 1);
  const state = squatModule.createState();
  const m = createMeasurement();
  squatModule.measure(state, hinge, baseline, m);
  const kneeDrop = baseline.kneeAngle - hinge.kneeAngle;
  console.log(
    `  hinge at full fold: squat depth reads ${f2(m.depth, 1)}, knee drop ${f2(kneeDrop, 1)} deg,` +
      ` corroboration ${f2(m.corroboration)}`,
  );
  console.log(
    '  The depth metric rejects it on its own — the hips barely drop in a hinge, so hipRatio',
  );
  console.log(
    '  hardly moves. That is why the hinge test kept passing even while corroboration was dead.',
  );
  const run = runSynth({ exercise: 'hinge', reps: 10, seed: 8081 }, { forceBaselineAtSec: 2.0 });
  const total = Object.values(run.repCounts).reduce((a, b) => a + b, 0);
  console.log(`  full hinge session: ${total} reps counted ${total === 0 ? '(correct)' : '<-- BAD'}`);
}

console.log('\n' + '='.repeat(102));
