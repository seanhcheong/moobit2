/**
 * Signal-selection probe: which measurable quantity should actually drive `depth`, and which
 * should identify the lunge's front leg.
 *
 * `probeGeometry.ts` established that from a head-on camera the squat knee angle collapses from
 * a true 117-degree range down to ~29 degrees of *observed* range, because knee flexion happens
 * almost entirely along the camera's depth axis. That makes joint angle a poor primary signal
 * and forces the question this probe answers: what is a better one?
 *
 * A good candidate must be
 *   1. monotonic in true depth,
 *   2. large compared with landmark noise,
 *   3. stable across body heights (so calibration transfers between users), and
 *   4. stable across camera tilt (so a phone propped at a slightly different angle still works).
 *
 * Run with `npx tsx src/dev/probeSignals.ts`.
 */

import { LM } from '../core/landmarks';
import { createPoseView, fillPoseView, jointAngleDeg, lmDist } from '../core/geometry';
import {
  DEFAULT_BODY,
  DEFAULT_CAMERA,
  makeProjector,
  projectToFlat,
  segmentsFor,
  type CameraSpec,
  type Skeleton,
} from './synthBody';
import { lungePose, pushupPose, squatPose } from './synthExercises';

const noNoise = () => 0;

function viewOf(skel: Skeleton, camera: CameraSpec) {
  const proj = makeProjector(camera);
  const flat = projectToFlat(skel, proj, noNoise, { noiseSigmaPx: 0, zNoiseMultiplier: 0 });
  const view = createPoseView();
  fillPoseView(view, flat, camera.imageWidth, camera.imageHeight, false);
  return view;
}

const midV = (v: ReturnType<typeof viewOf>, a: number, b: number) => (v.v[a] + v.v[b]) / 2;
const midU = (v: ReturnType<typeof viewOf>, a: number, b: number) => (v.u[a] + v.u[b]) / 2;

// ---------------------------------------------------------------------------------------------
// Candidate depth metrics. All are ratios of image-space distances, hence free of absolute
// scale, so a user standing slightly nearer or farther does not shift them.
// ---------------------------------------------------------------------------------------------

/** Where the hips sit between the ankles and the shoulders. Standing ~0.63, deep squat lower. */
function hipRatio(v: ReturnType<typeof viewOf>): number {
  const ankle = midV(v, LM.LEFT_ANKLE, LM.RIGHT_ANKLE);
  const hip = midV(v, LM.LEFT_HIP, LM.RIGHT_HIP);
  const shoulder = midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  const span = ankle - shoulder;
  return span <= 1e-6 ? NaN : (ankle - hip) / span;
}

/** Apparent standing height (shoulders to ankles) in units of torso length. */
function stanceRatio(v: ReturnType<typeof viewOf>): number {
  const torso = Math.hypot(
    midU(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER) - midU(v, LM.LEFT_HIP, LM.RIGHT_HIP),
    midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER) - midV(v, LM.LEFT_HIP, LM.RIGHT_HIP),
  );
  const ankle = midV(v, LM.LEFT_ANKLE, LM.RIGHT_ANKLE);
  const shoulder = midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  return torso <= 1e-6 ? NaN : (ankle - shoulder) / torso;
}

/** Thigh length in the image, relative to the shank. Collapses as the thigh points at the lens. */
function thighShankRatio(v: ReturnType<typeof viewOf>): number {
  const thigh = (lmDist(v, LM.LEFT_HIP, LM.LEFT_KNEE) + lmDist(v, LM.RIGHT_HIP, LM.RIGHT_KNEE)) / 2;
  const shank = (lmDist(v, LM.LEFT_KNEE, LM.LEFT_ANKLE) + lmDist(v, LM.RIGHT_KNEE, LM.RIGHT_ANKLE)) / 2;
  return shank <= 1e-6 ? NaN : thigh / shank;
}

/** Torso length in units of shoulder width — the push-up foreshortening signal. */
function torsoOverShoulderWidth(v: ReturnType<typeof viewOf>): number {
  const torso = Math.hypot(
    midU(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER) - midU(v, LM.LEFT_HIP, LM.RIGHT_HIP),
    midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER) - midV(v, LM.LEFT_HIP, LM.RIGHT_HIP),
  );
  const sw = lmDist(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  return sw <= 1e-6 ? NaN : torso / sw;
}

/** Shoulder height above the wrists, in units of shoulder width. Push-up vertical travel. */
function shoulderOverWrist(v: ReturnType<typeof viewOf>): number {
  const sw = lmDist(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  const wrist = midV(v, LM.LEFT_WRIST, LM.RIGHT_WRIST);
  const shoulder = midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER);
  return sw <= 1e-6 ? NaN : (wrist - shoulder) / sw;
}

const f = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'NaN').padStart(8);
const seg = segmentsFor(DEFAULT_BODY);

console.log('='.repeat(100));
console.log('SIGNAL-SELECTION PROBE');
console.log('='.repeat(100));

// ---------------------------------------------------------------------------------------------
console.log('\n[S1] SQUAT — candidate depth signals vs true depth (monotonicity & dynamic range)\n');
console.log('  depth  kneeAngle  hipRatio  stanceRatio  thigh/shank   hipV     shoulderV');
{
  const rows: number[][] = [];
  for (const depth of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const v = viewOf(squatPose({ depth, seg }), DEFAULT_CAMERA);
    const knee = jointAngleDeg(v, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
    const row = [
      depth,
      knee,
      hipRatio(v),
      stanceRatio(v),
      thighShankRatio(v),
      midV(v, LM.LEFT_HIP, LM.RIGHT_HIP),
      midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER),
    ];
    rows.push(row);
    console.log(
      `  ${f(depth, 2)} ${f(knee, 1)}  ${f(row[2])} ${f(row[3])}  ${f(row[4])}  ${f(row[5])} ${f(row[6])}`,
    );
  }
  const span = (i: number) => Math.abs(rows[rows.length - 1][i] - rows[0][i]);
  console.log(
    `\n  full-range excursion:  knee ${span(1).toFixed(1)} deg | hipRatio ${span(2).toFixed(3)}` +
      ` | stanceRatio ${span(3).toFixed(3)} | thigh/shank ${span(4).toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------------------------
console.log('\n[S2] SQUAT — do the candidates survive a change of body height?');
console.log('     A signal whose full-range excursion moves with height cannot share one');
console.log('     calibration across users.\n');
console.log('  height  knee_range  hipRatio_range  stanceRatio_range  thigh/shank_range');
for (const heightM of [1.55, 1.65, 1.75, 1.85, 1.95]) {
  const s2 = segmentsFor({ heightM });
  const top = viewOf(squatPose({ depth: 0, seg: s2 }), DEFAULT_CAMERA);
  const bot = viewOf(squatPose({ depth: 1, seg: s2 }), DEFAULT_CAMERA);
  const kneeRange =
    jointAngleDeg(top, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE) -
    jointAngleDeg(bot, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  console.log(
    `  ${f(heightM, 2)}  ${f(kneeRange, 1)}    ${f(hipRatio(top) - hipRatio(bot))}       ` +
      `${f(stanceRatio(top) - stanceRatio(bot))}         ${f(thighShankRatio(top) - thighShankRatio(bot))}`,
  );
}

// ---------------------------------------------------------------------------------------------
console.log('\n[S3] SQUAT — do the candidates survive a change of camera tilt?\n');
console.log('  tilt   knee_range  hipRatio_range  stanceRatio_range  thigh/shank_range');
for (const tiltDeg of [10, 15, 21, 30, 40]) {
  const cam = { ...DEFAULT_CAMERA, tiltDeg };
  const top = viewOf(squatPose({ depth: 0, seg }), cam);
  const bot = viewOf(squatPose({ depth: 1, seg }), cam);
  const kneeRange =
    jointAngleDeg(top, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE) -
    jointAngleDeg(bot, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  console.log(
    `  ${String(tiltDeg).padStart(4)}   ${f(kneeRange, 1)}    ${f(hipRatio(top) - hipRatio(bot))}       ` +
      `${f(stanceRatio(top) - stanceRatio(bot))}         ${f(thighShankRatio(top) - thighShankRatio(bot))}`,
  );
}

// ---------------------------------------------------------------------------------------------
console.log('\n[S4] PUSH-UP — candidate depth signals\n');
console.log('  depth  elbowAngle  torso/shoulderW  shoulderOverWrist  shoulderV   hipV');
{
  const rows: number[][] = [];
  for (const depth of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const v = viewOf(pushupPose({ depth, seg }), DEFAULT_CAMERA);
    const elbow = jointAngleDeg(v, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST);
    const row = [
      depth,
      elbow,
      torsoOverShoulderWidth(v),
      shoulderOverWrist(v),
      midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER),
      midV(v, LM.LEFT_HIP, LM.RIGHT_HIP),
    ];
    rows.push(row);
    console.log(`  ${f(depth, 2)} ${f(elbow, 1)}   ${f(row[2])}        ${f(row[3])}      ${f(row[4])} ${f(row[5])}`);
  }
  const span = (i: number) => Math.abs(rows[rows.length - 1][i] - rows[0][i]);
  console.log(
    `\n  full-range excursion: elbow ${span(1).toFixed(1)} deg | torso/shoulderW ${span(2).toFixed(3)}` +
      ` | shoulderOverWrist ${span(3).toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------------------------
console.log('\n[S5] PUSH-UP — does a hip-sag cheat rep look different from a clean one?');
console.log('     The rigidity check has to separate these two.\n');
console.log('  depth  sag(m)  elbowAngle  shoulder-hip-knee  torso/shoulderW  hipV-shoulderV');
for (const sag of [0, 0.08, 0.16]) {
  for (const depth of [0, 1]) {
    const v = viewOf(pushupPose({ depth, seg, hipSag: sag }), DEFAULT_CAMERA);
    const elbow = jointAngleDeg(v, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST);
    const collinear = jointAngleDeg(v, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE);
    console.log(
      `  ${f(depth, 2)} ${f(sag, 2)}  ${f(elbow, 1)}    ${f(collinear, 1)}          ` +
        `${f(torsoOverShoulderWidth(v))}       ` +
        `${f(midV(v, LM.LEFT_HIP, LM.RIGHT_HIP) - midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER))}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
console.log('\n[S6] LUNGE FRONT LEG — every candidate signal, with SNR at sigma = 1.4 px.');
console.log('     The brief proposed ankle image-y as primary and z as secondary.');
console.log('     Positive dy means the FRONT leg appears LOWER in frame.\n');
const sigmaPx = 1.4;
const sigmaV = sigmaPx / DEFAULT_CAMERA.imageHeight;
const sigmaU = sigmaPx / DEFAULT_CAMERA.imageWidth;
// MediaPipe's z is markedly noisier than x/y; 3.5x is the generator's assumption and is
// optimistic, so treat SNR figures for z as an upper bound.
const sigmaZ = sigmaU * 3.5;

console.log('  depth  ankle_dy   knee_dy    hip? n/a   shank_len_ratio  ankle_dz   knee_dz');
for (const depth of [0, 0.25, 0.5, 0.75, 1.0]) {
  const v = viewOf(lungePose({ depth, seg, frontLeg: 'left', strideM: 0.75 }), DEFAULT_CAMERA);
  const ankleDy = v.v[LM.LEFT_ANKLE] - v.v[LM.RIGHT_ANKLE];
  const kneeDy = v.v[LM.LEFT_KNEE] - v.v[LM.RIGHT_KNEE];
  const shankL = lmDist(v, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const shankR = lmDist(v, LM.RIGHT_KNEE, LM.RIGHT_ANKLE);
  const ankleDz = v.z[LM.LEFT_ANKLE] - v.z[LM.RIGHT_ANKLE];
  const kneeDz = v.z[LM.LEFT_KNEE] - v.z[LM.RIGHT_KNEE];
  console.log(
    `  ${f(depth, 2)} ${f(ankleDy, 4)} ${f(kneeDy, 4)}      -      ${f(shankL / shankR, 4)}   ` +
      `${f(ankleDz, 3)} ${f(kneeDz, 3)}`,
  );
}
console.log('\n  SNR at full depth (signal / (sqrt(2) * sigma), front leg = left):');
{
  const v = viewOf(lungePose({ depth: 1, seg, frontLeg: 'left', strideM: 0.75 }), DEFAULT_CAMERA);
  const report = (name: string, signal: number, sigma: number) =>
    console.log(
      `    ${name.padEnd(18)} ${signal >= 0 ? '+' : '-'}${Math.abs(signal).toFixed(4)}` +
        `   SNR ${(Math.abs(signal) / (sigma * Math.SQRT2)).toFixed(1)}x`,
    );
  report('ankle dy', v.v[LM.LEFT_ANKLE] - v.v[LM.RIGHT_ANKLE], sigmaV);
  report('knee dy', v.v[LM.LEFT_KNEE] - v.v[LM.RIGHT_KNEE], sigmaV);
  report('ankle dz', v.z[LM.LEFT_ANKLE] - v.z[LM.RIGHT_ANKLE], sigmaZ);
  report('knee dz', v.z[LM.LEFT_KNEE] - v.z[LM.RIGHT_KNEE], sigmaZ);
  const shankL = lmDist(v, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const shankR = lmDist(v, LM.RIGHT_KNEE, LM.RIGHT_ANKLE);
  report('shank len diff', shankL - shankR, sigmaV);
}

console.log('\n[S7] LUNGE — squat-vs-lunge separability: ankle separation in the image.\n');
console.log('  pose            depth   ankle_sep_v  ankle_sep_u  ankle_sep_v/torso  ankle_sep_z');
for (const [name, mk] of [
  ['squat', (d: number) => squatPose({ depth: d, seg })],
  ['lunge stride .55', (d: number) => lungePose({ depth: d, seg, frontLeg: 'left', strideM: 0.55 })],
  ['lunge stride .75', (d: number) => lungePose({ depth: d, seg, frontLeg: 'left', strideM: 0.75 })],
] as [string, (d: number) => Skeleton][]) {
  for (const depth of [0, 1]) {
    const v = viewOf(mk(depth), DEFAULT_CAMERA);
    const torso = Math.hypot(
      midU(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER) - midU(v, LM.LEFT_HIP, LM.RIGHT_HIP),
      midV(v, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER) - midV(v, LM.LEFT_HIP, LM.RIGHT_HIP),
    );
    const sepV = Math.abs(v.v[LM.LEFT_ANKLE] - v.v[LM.RIGHT_ANKLE]);
    const sepU = Math.abs(v.u[LM.LEFT_ANKLE] - v.u[LM.RIGHT_ANKLE]);
    const sepZ = Math.abs(v.z[LM.LEFT_ANKLE] - v.z[LM.RIGHT_ANKLE]);
    console.log(
      `  ${name.padEnd(16)} ${f(depth, 2)}  ${f(sepV, 4)}   ${f(sepU, 4)}     ${f(sepV / torso, 4)}       ${f(sepZ, 3)}`,
    );
  }
}

console.log('\n' + '='.repeat(100));
