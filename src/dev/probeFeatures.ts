/**
 * Feature-table probe: runs the real `computeFeatures` over synthetic poses and prints the
 * feature vector for each exercise at each depth.
 *
 * This is the table the disambiguation weights and every threshold in the exercise configs are
 * set from. Guessing them would be guessing; reading them off measured separations is not.
 *
 * Run with `npm run probe:features`.
 */

import { createFeatures, createFeatureHistory, computeFeatures, type Features } from '../core/features';
import { createPoseView, fillPoseView } from '../core/geometry';
import { DEFAULT_CAMERA, makeProjector, projectToFlat, segmentsFor, DEFAULT_BODY } from './synthBody';
import { lungePose, pushupPose, squatPose } from './synthExercises';
import { LM } from '../core/landmarks';

const seg = segmentsFor(DEFAULT_BODY);
const proj = makeProjector(DEFAULT_CAMERA);
const noNoise = () => 0;

const pushupOcclusion = {
  suppressed: [
    { index: LM.LEFT_ANKLE, visibility: 0.22 },
    { index: LM.RIGHT_ANKLE, visibility: 0.22 },
    { index: LM.LEFT_KNEE, visibility: 0.55 },
    { index: LM.RIGHT_KNEE, visibility: 0.55 },
  ],
};

/** Feed two frames a realistic dt apart so velocity fields are populated rather than zero. */
function featuresFor(
  make: (d: number) => ReturnType<typeof squatPose>,
  depth: number,
  occluded: boolean,
): Features {
  const view = createPoseView();
  const hist = createFeatureHistory();
  const out = createFeatures();
  const dt = 1 / 30;
  // A hair before the target depth, then the target itself.
  for (const [i, d] of [Math.max(0, depth - 0.03), depth].entries()) {
    const flat = projectToFlat(make(d), proj, noNoise, {
      noiseSigmaPx: 0,
      zNoiseMultiplier: 0,
      occlusion: occluded ? pushupOcclusion : undefined,
    });
    fillPoseView(view, flat, DEFAULT_CAMERA.imageWidth, DEFAULT_CAMERA.imageHeight, false);
    computeFeatures(view, hist, i * dt, out);
  }
  return out;
}

const FIELDS: (keyof Features)[] = [
  'hipRatio',
  'shoulderOverWrist',
  'torsoOverShoulderWidth',
  'stanceRatio',
  'thighShankRatio',
  'bboxAspect',
  'kneeAngle',
  'hipAngle',
  'elbowAngle',
  'torsoLeanDeg',
  'plankSag',
  'ankleSepV',
  'ankleSepU',
  'ankleSepZ',
  'ankleDz',
  'kneeDv',
  'shankLenRatio',
  'hipMidV',
  'shoulderMidV',
  'visAnkles',
  'visKnees',
];

interface Col {
  label: string;
  f: Features;
}

const cols: Col[] = [
  { label: 'squat@0', f: featuresFor((d) => squatPose({ depth: d, seg }), 0, false) },
  { label: 'squat@.5', f: featuresFor((d) => squatPose({ depth: d, seg }), 0.5, false) },
  { label: 'squat@1', f: featuresFor((d) => squatPose({ depth: d, seg }), 1, false) },
  { label: 'push@0', f: featuresFor((d) => pushupPose({ depth: d, seg }), 0, true) },
  { label: 'push@.5', f: featuresFor((d) => pushupPose({ depth: d, seg }), 0.5, true) },
  { label: 'push@1', f: featuresFor((d) => pushupPose({ depth: d, seg }), 1, true) },
  {
    label: 'lungeL@0',
    f: featuresFor((d) => lungePose({ depth: d, seg, frontLeg: 'left', strideM: 0.75 }), 0, false),
  },
  {
    label: 'lungeL@1',
    f: featuresFor((d) => lungePose({ depth: d, seg, frontLeg: 'left', strideM: 0.75 }), 1, false),
  },
  {
    label: 'lungeR@1',
    f: featuresFor((d) => lungePose({ depth: d, seg, frontLeg: 'right', strideM: 0.75 }), 1, false),
  },
];

const fmt = (v: unknown) => {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return '     nan';
  const a = Math.abs(n);
  return (a >= 100 ? n.toFixed(1) : a >= 10 ? n.toFixed(2) : n.toFixed(4)).padStart(8);
};

console.log('='.repeat(6 + 23 + cols.length * 9));
console.log('FEATURE TABLE — real computeFeatures() over synthetic poses, no noise');
console.log('='.repeat(6 + 23 + cols.length * 9));
console.log('field'.padEnd(23) + cols.map((c) => c.label.padStart(9)).join(''));
console.log('-'.repeat(23 + cols.length * 9));
for (const field of FIELDS) {
  console.log(String(field).padEnd(23) + cols.map((c) => ' ' + fmt(c.f[field])).join(''));
}

// -------------------------------------------------------------------------------------------
console.log('\nSEPARATION SUMMARY — how far apart are the classes on each candidate feature?\n');

function range(labels: string[], field: keyof Features): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of cols) {
    if (!labels.some((l) => c.label.startsWith(l))) continue;
    const v = c.f[field] as number;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

for (const field of [
  'torsoOverShoulderWidth',
  'bboxAspect',
  'stanceRatio',
  'hipMidV',
  'ankleSepZ',
  'ankleSepV',
  'visAnkles',
  'shoulderOverWrist',
] as (keyof Features)[]) {
  const [sqLo, sqHi] = range(['squat'], field);
  const [puLo, puHi] = range(['push'], field);
  const [luLo, luHi] = range(['lunge'], field);
  const gapSqPu =
    sqLo > puHi ? sqLo - puHi : puLo > sqHi ? puLo - sqHi : -Math.min(sqHi - puLo, puHi - sqLo);
  const gapSqLu =
    sqLo > luHi ? sqLo - luHi : luLo > sqHi ? luLo - sqHi : -Math.min(sqHi - luLo, luHi - sqLo);
  console.log(
    `${String(field).padEnd(23)} squat[${fmt(sqLo)},${fmt(sqHi)}] push[${fmt(puLo)},${fmt(puHi)}]` +
      ` lunge[${fmt(luLo)},${fmt(luHi)}]  gap(sq|pu)=${fmt(gapSqPu)} gap(sq|lu)=${fmt(gapSqLu)}`,
  );
}
console.log('\n  positive gap = the classes are cleanly separated; negative = they overlap.');
console.log('='.repeat(6 + 23 + cols.length * 9));
