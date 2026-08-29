/**
 * Geometry probe: answers the open questions about the fixed floor-camera setup with numbers
 * rather than intuition.
 *
 * Run with `npx tsx src/dev/probeGeometry.ts`.
 *
 * Every question below was an assumption in the product brief. Each is now measured against the
 * pinhole projection of an anthropometrically proportioned body at the exact camera placement
 * the product specifies.
 */

import { LM } from '../core/landmarks';
import { createPoseView, fillPoseView, jointAngleDeg, angleFromVerticalDeg, lmDist } from '../core/geometry';
import { LM_STRIDE } from '../core/nativeContract';
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

function project(skel: Skeleton, camera: CameraSpec) {
  const proj = makeProjector(camera);
  return projectToFlat(skel, proj, noNoise, { noiseSigmaPx: 0, zNoiseMultiplier: 0 });
}

function viewOf(skel: Skeleton, camera: CameraSpec) {
  const flat = project(skel, camera);
  const view = createPoseView();
  fillPoseView(view, flat, camera.imageWidth, camera.imageHeight, false);
  return { view, flat };
}

/** True 3D angle at joint b, for comparison against what the camera reports. */
function trueAngle3d(skel: Skeleton, a: number, b: number, c: number): number {
  const bax = skel[a].x - skel[b].x;
  const bay = skel[a].y - skel[b].y;
  const baz = skel[a].z - skel[b].z;
  const bcx = skel[c].x - skel[b].x;
  const bcy = skel[c].y - skel[b].y;
  const bcz = skel[c].z - skel[b].z;
  const dot = bax * bcx + bay * bcy + baz * bcz;
  const la = Math.hypot(bax, bay, baz);
  const lb = Math.hypot(bcx, bcy, bcz);
  return (Math.acos(Math.max(-1, Math.min(1, dot / (la * lb)))) * 180) / Math.PI;
}

function ny(flat: number[], i: number): number {
  return flat[i * LM_STRIDE + 1];
}
function nz(flat: number[], i: number): number {
  return flat[i * LM_STRIDE + 2];
}

const seg = segmentsFor(DEFAULT_BODY);
const f = (v: number, d = 1) => v.toFixed(d).padStart(7);

console.log('='.repeat(94));
console.log('FIXED FLOOR-CAMERA GEOMETRY PROBE');
console.log(
  `body ${DEFAULT_BODY.heightM} m | camera ${DEFAULT_CAMERA.distanceM.toFixed(2)} m away, ` +
    `${(DEFAULT_CAMERA.heightM * 100).toFixed(0)} cm high, tilt ${DEFAULT_CAMERA.tiltDeg} deg, ` +
    `hfov ${DEFAULT_CAMERA.hfovDeg} deg, ${DEFAULT_CAMERA.imageWidth}x${DEFAULT_CAMERA.imageHeight} portrait`,
);
console.log('='.repeat(94));

// -------------------------------------------------------------------------------------------
console.log('\n[Q1] Does the whole standing body fit in frame, and what tilt is actually needed?');
console.log('     ny < 0 = above the top edge, ny > 1 = below the bottom edge.\n');
console.log('  tilt   nose_ny  ankle_ny   body_height_frac   verdict');
for (const tiltDeg of [0, 10, 15, 21, 30, 40, 50]) {
  const cam = { ...DEFAULT_CAMERA, tiltDeg };
  const { flat } = viewOf(squatPose({ depth: 0, seg }), cam);
  const noseY = ny(flat, LM.NOSE);
  const ankleY = Math.max(ny(flat, LM.LEFT_ANKLE), ny(flat, LM.RIGHT_ANKLE));
  const frac = ankleY - noseY;
  const ok = noseY > 0.02 && ankleY < 0.98;
  console.log(
    `  ${String(tiltDeg).padStart(4)}  ${f(noseY, 3)}   ${f(ankleY, 3)}       ${f(frac, 3)}        ${
      ok ? 'FITS' : noseY <= 0.02 ? 'head cropped' : 'feet cropped'
    }`,
  );
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q2] Foreshortening: apparent (image-plane) vs true (3D) knee angle in a squat.');
console.log('     This is the claim that eye-level thresholds do not transfer. Delta = error.\n');
console.log('  depth   true_knee  apparent_knee   delta    true_hip  apparent_hip   delta');
for (const depth of [0, 0.25, 0.5, 0.75, 1.0]) {
  const skel = squatPose({ depth, seg });
  const { view } = viewOf(skel, DEFAULT_CAMERA);
  const trueKnee = trueAngle3d(skel, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const appKnee = jointAngleDeg(view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const trueHip = trueAngle3d(skel, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE);
  const appHip = jointAngleDeg(view, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE);
  console.log(
    `  ${f(depth, 2)}   ${f(trueKnee)}    ${f(appKnee)}    ${f(appKnee - trueKnee)}   ` +
      `${f(trueHip)}    ${f(appHip)}    ${f(appHip - trueHip)}`,
  );
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q2b] Same squat, but WITHOUT the aspect-ratio correction (raw normalised coords).');
console.log('      Shows what the anisotropy bug costs if the correction is skipped.\n');
console.log('  depth   corrected_knee   uncorrected_knee   error');
for (const depth of [0, 0.5, 1.0]) {
  const skel = squatPose({ depth, seg });
  const flat = project(skel, DEFAULT_CAMERA);
  const corrected = createPoseView();
  fillPoseView(corrected, flat, DEFAULT_CAMERA.imageWidth, DEFAULT_CAMERA.imageHeight, false);
  // Passing a square frame reproduces the naive "normalised coords are isotropic" mistake.
  const naive = createPoseView();
  fillPoseView(naive, flat, 1000, 1000, false);
  const a = jointAngleDeg(corrected, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const b = jointAngleDeg(naive, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  console.log(`  ${f(depth, 2)}   ${f(a)}          ${f(b)}       ${f(b - a)}`);
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q3] LUNGE front-leg signal. Brief claims the leg stepped TOWARD the camera');
console.log('     appears LOWER in frame (greater ny) and larger. Testing that claim.\n');
console.log('  frontLeg depth   front_ankle_ny  back_ankle_ny   dy(front-back)  front_z  back_z   dz');
for (const frontLeg of ['left', 'right'] as const) {
  for (const depth of [0, 0.5, 1.0]) {
    const skel = lungePose({ depth, seg, frontLeg, strideM: 0.75 });
    const flat = project(skel, DEFAULT_CAMERA);
    const frontIdx = frontLeg === 'left' ? LM.LEFT_ANKLE : LM.RIGHT_ANKLE;
    const backIdx = frontLeg === 'left' ? LM.RIGHT_ANKLE : LM.LEFT_ANKLE;
    const dy = ny(flat, frontIdx) - ny(flat, backIdx);
    const dz = nz(flat, frontIdx) - nz(flat, backIdx);
    console.log(
      `  ${frontLeg.padEnd(6)} ${f(depth, 2)}   ${f(ny(flat, frontIdx), 4)}       ` +
        `${f(ny(flat, backIdx), 4)}        ${f(dy, 4)}      ${f(nz(flat, frontIdx), 3)}  ` +
        `${f(nz(flat, backIdx), 3)}  ${f(dz, 3)}`,
    );
  }
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q3b] Is the front-leg dy signal bigger than landmark noise? sigma = 1.4 px');
{
  const sigmaNy = 1.4 / DEFAULT_CAMERA.imageHeight;
  const skel = lungePose({ depth: 1, seg, frontLeg: 'left', strideM: 0.75 });
  const flat = project(skel, DEFAULT_CAMERA);
  const dy = Math.abs(ny(flat, LM.LEFT_ANKLE) - ny(flat, LM.RIGHT_ANKLE));
  // Difference of two independent samples, so the noise on dy has sqrt(2) times one sigma.
  console.log(
    `      dy at full depth = ${dy.toFixed(4)} (${(dy * DEFAULT_CAMERA.imageHeight).toFixed(1)} px), ` +
      `noise on dy = ${(sigmaNy * Math.SQRT2 * DEFAULT_CAMERA.imageHeight).toFixed(2)} px ` +
      `-> SNR ~ ${(dy / (sigmaNy * Math.SQRT2)).toFixed(1)}x`,
  );
  for (const stride of [0.4, 0.55, 0.75, 1.0]) {
    const s2 = lungePose({ depth: 1, seg, frontLeg: 'left', strideM: stride });
    const fl = project(s2, DEFAULT_CAMERA);
    const d = Math.abs(ny(fl, LM.LEFT_ANKLE) - ny(fl, LM.RIGHT_ANKLE));
    console.log(
      `      stride ${stride.toFixed(2)} m -> dy ${(d * DEFAULT_CAMERA.imageHeight).toFixed(1)} px, ` +
        `SNR ${(d / (sigmaNy * Math.SQRT2)).toFixed(1)}x`,
    );
  }
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q4] PUSH-UP head-on from the floor. Is elbow angle measurable in the image plane?\n');
console.log('  depth  true_elbow  apparent_elbow  delta   shoulder_ny  hip_ny  torso_len  vis(ankle)');
for (const depth of [0, 0.25, 0.5, 0.75, 1.0]) {
  const skel = pushupPose({ depth, seg });
  const { view, flat } = viewOf(skel, DEFAULT_CAMERA);
  const trueEl = trueAngle3d(skel, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST);
  const appEl = jointAngleDeg(view, LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST);
  const shY = (ny(flat, LM.LEFT_SHOULDER) + ny(flat, LM.RIGHT_SHOULDER)) / 2;
  const hipY = (ny(flat, LM.LEFT_HIP) + ny(flat, LM.RIGHT_HIP)) / 2;
  const torsoLen = lmDist(view, LM.LEFT_SHOULDER, LM.LEFT_HIP);
  console.log(
    `  ${f(depth, 2)}  ${f(trueEl)}     ${f(appEl)}   ${f(appEl - trueEl)}   ` +
      `${f(shY, 3)}      ${f(hipY, 3)}   ${f(torsoLen, 4)}     -`,
  );
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q5] Disambiguation separability: are the three exercises far apart in feature space?\n');
console.log('  exercise  depth   torsoLean  ankleSep_dy/torso  hipY   shoulderY  torsoLen/standing');
{
  const standing = viewOf(squatPose({ depth: 0, seg }), DEFAULT_CAMERA);
  const standingTorso = lmDist(standing.view, LM.LEFT_SHOULDER, LM.LEFT_HIP);

  const rows: [string, Skeleton][] = [
    ['squat', squatPose({ depth: 0, seg })],
    ['squat', squatPose({ depth: 1, seg })],
    ['pushup', pushupPose({ depth: 0, seg })],
    ['pushup', pushupPose({ depth: 1, seg })],
    ['lunge', lungePose({ depth: 0, seg, frontLeg: 'left' })],
    ['lunge', lungePose({ depth: 1, seg, frontLeg: 'left' })],
  ];
  for (const [name, skel] of rows) {
    const { view, flat } = viewOf(skel, DEFAULT_CAMERA);
    const shU = (view.u[LM.LEFT_SHOULDER] + view.u[LM.RIGHT_SHOULDER]) / 2;
    const shV = (view.v[LM.LEFT_SHOULDER] + view.v[LM.RIGHT_SHOULDER]) / 2;
    const hipU = (view.u[LM.LEFT_HIP] + view.u[LM.RIGHT_HIP]) / 2;
    const hipV = (view.v[LM.LEFT_HIP] + view.v[LM.RIGHT_HIP]) / 2;
    const lean = angleFromVerticalDeg(shU - hipU, shV - hipV);
    const torsoLen = Math.hypot(shU - hipU, shV - hipV);
    const ankleDy = Math.abs(ny(flat, LM.LEFT_ANKLE) - ny(flat, LM.RIGHT_ANKLE));
    console.log(
      `  ${name.padEnd(8)}  ${f(skel === rows[0][1] ? 0 : 0, 2).trim().padStart(5)}   ` +
        `${f(lean)}    ${f(ankleDy / torsoLen, 3)}            ${f(hipV, 3)}  ${f(shV, 3)}    ` +
        `${f(torsoLen / standingTorso, 3)}`,
    );
  }
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q6] Body-height sensitivity: does one calibration transfer across body sizes?\n');
console.log('  height   standing_knee  bottom_knee  range   standing_hip  nose_ny  ankle_ny');
for (const heightM of [1.55, 1.65, 1.75, 1.85, 1.95]) {
  const s2 = segmentsFor({ heightM });
  const top = viewOf(squatPose({ depth: 0, seg: s2 }), DEFAULT_CAMERA);
  const bot = viewOf(squatPose({ depth: 1, seg: s2 }), DEFAULT_CAMERA);
  const kTop = jointAngleDeg(top.view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const kBot = jointAngleDeg(bot.view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const hTop = jointAngleDeg(top.view, LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE);
  console.log(
    `  ${f(heightM, 2)}   ${f(kTop)}       ${f(kBot)}    ${f(kTop - kBot)}   ${f(hTop)}      ` +
      `${f(ny(top.flat, LM.NOSE), 3)}   ${f(ny(top.flat, LM.LEFT_ANKLE), 3)}`,
  );
}

// -------------------------------------------------------------------------------------------
console.log('\n[Q7] Camera-tilt sensitivity of the squat knee-angle range (the calibration target).\n');
console.log('  tilt   standing_knee  bottom_knee  observed_range');
for (const tiltDeg of [10, 15, 21, 30, 40]) {
  const cam = { ...DEFAULT_CAMERA, tiltDeg };
  const kTop = jointAngleDeg(viewOf(squatPose({ depth: 0, seg }), cam).view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const kBot = jointAngleDeg(viewOf(squatPose({ depth: 1, seg }), cam).view, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  console.log(`  ${String(tiltDeg).padStart(4)}   ${f(kTop)}       ${f(kBot)}    ${f(kTop - kBot)}`);
}

console.log('\n' + '='.repeat(94));
