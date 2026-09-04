/**
 * Landmark-health report for a recorded session.
 *
 *   npm run diag -- sessions/raw/<id>.jsonl
 *
 * ## Why this is separate from `npm run replay`
 * The replay CLI answers "what did the classifiers conclude" — reps, labels, phases. That
 * presupposes the landmarks are sane. This answers the question underneath it: did MediaPipe find
 * a body at all, was it inside the frame, and are the coordinates in the geometry the pipeline
 * thinks they are.
 *
 * Those failures all present identically on the phone ("it isn't tracking me") while having
 * completely different causes — no detection, detection but out of frame, detection but rotated
 * or mirrored — and nothing in the app or the replay output separated them. Output is deliberately
 * compact enough to paste into a conversation, because a 30-second raw log is about a megabyte.
 *
 * Reads only the log. No classifier, no thresholds, so its verdicts cannot be wrong for the same
 * reason a classifier is wrong.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LM } from '../core/landmarks';
import type { ReplayFrameRecord, ReplayHeader } from '../core/replayFormat';

const LM_STRIDE = 4;
const VIS_MIN = 0.5;

/** Landmarks that must be present for any of the three exercises to be classifiable. */
const CORE_JOINTS: Array<[string, number]> = [
  ['nose', LM.NOSE],
  ['l.shoulder', LM.LEFT_SHOULDER],
  ['r.shoulder', LM.RIGHT_SHOULDER],
  ['l.hip', LM.LEFT_HIP],
  ['r.hip', LM.RIGHT_HIP],
  ['l.knee', LM.LEFT_KNEE],
  ['r.knee', LM.RIGHT_KNEE],
  ['l.ankle', LM.LEFT_ANKLE],
  ['r.ankle', LM.RIGHT_ANKLE],
];

interface Acc {
  frames: number;
  withLandmarks: number;
  visibleCore: number;
  sumVis: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  outOfUnit: number;
  zSpreadSum: number;
  labels: Map<string, number>;
  phases: Map<string, number>;
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`;
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run diag -- sessions/raw/<id>.jsonl');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`no such file: ${file}`);
    process.exit(2);
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);

  let header: ReplayHeader | null = null;
  let baselineSeen = false;
  let skipped = 0;
  const markers: string[] = [];

  const a: Acc = {
    frames: 0,
    withLandmarks: 0,
    visibleCore: 0,
    sumVis: new Array(CORE_JOINTS.length).fill(0),
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    outOfUnit: 0,
    zSpreadSum: 0,
    labels: new Map(),
    phases: new Map(),
  };

  for (const line of lines) {
    let rec: { kind?: string };
    try {
      rec = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }

    if (rec.kind === 'header') {
      header = rec as unknown as ReplayHeader;
      continue;
    }
    if (rec.kind === 'baseline') {
      baselineSeen = true;
      continue;
    }
    if (rec.kind === 'marker') {
      markers.push((rec as { label?: string }).label ?? '?');
      continue;
    }
    if (rec.kind !== 'frame') continue;

    const f = rec as unknown as ReplayFrameRecord;
    a.frames++;
    bump(a.labels, f.out?.exercise ?? '?');
    bump(a.phases, f.out?.phase ?? '?');

    if (!Array.isArray(f.lm) || f.lm.length < 33 * LM_STRIDE) continue;
    a.withLandmarks++;

    let allCoreVisible = true;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < CORE_JOINTS.length; i++) {
      const o = CORE_JOINTS[i][1] * LM_STRIDE;
      const vis = f.lm[o + 3];
      a.sumVis[i] += vis;
      if (vis < VIS_MIN) allCoreVisible = false;
    }
    if (allCoreVisible) a.visibleCore++;

    for (let j = 0; j < 33; j++) {
      const o = j * LM_STRIDE;
      const x = f.lm[o];
      const y = f.lm[o + 1];
      const z = f.lm[o + 2];
      if (f.lm[o + 3] < VIS_MIN) continue;
      if (x < a.minX) a.minX = x;
      if (x > a.maxX) a.maxX = x;
      if (y < a.minY) a.minY = y;
      if (y > a.maxY) a.maxY = y;
      // MediaPipe normalises into 0..1; anything well outside means the body is partly out of
      // frame, which it reports by extrapolating rather than by dropping the landmark.
      if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) a.outOfUnit++;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (minZ !== Infinity) a.zSpreadSum += maxZ - minZ;
  }

  const W = 92;
  console.log('='.repeat(W));
  console.log(`SESSION DIAGNOSTIC  ${path.basename(file)}`);
  console.log('='.repeat(W));

  if (header) {
    const d = header.device;
    console.log(`device        ${d.platform} ${d.osVersion} ${d.model}`);
    console.log(`delegate      ${d.delegate}   inference long edge ${d.targetLongEdge}px`);
    console.log(
      `frame         ${header.imageWidth}x${header.imageHeight} ` +
        `(aspect ${(header.imageWidth / header.imageHeight).toFixed(3)})   ` +
        `rotation ${header.rotationDegrees}deg   mirrorX ${header.mirrorX}`
    );
    // The single most common cause of "it isn't tracking me": a portrait phone reporting a
    // landscape frame means the rotation never got applied.
    if (header.imageWidth > header.imageHeight) {
      console.log('  !! frame is LANDSCAPE. For a phone held upright this should be portrait');
      console.log('     (e.g. 720x1280). Rotation is not being applied — check rotationDegrees.');
    }
  } else {
    console.log('no header record — log is truncated or from an older format');
  }
  console.log(`calibrated    ${baselineSeen ? 'yes (baseline recorded)' : 'NO baseline in log'}`);
  console.log(`frames        ${a.frames}   with landmarks ${a.withLandmarks}   skipped lines ${skipped}`);
  if (markers.length) console.log(`markers       ${markers.join(', ')}`);

  if (a.frames === 0) {
    console.log('\nNo frame records at all. The pipeline never produced output — check the');
    console.log('on-screen warning, and that "Record raw landmark log" was on.');
    return;
  }

  console.log('');
  console.log(`landmarks present     ${pct(a.withLandmarks, a.frames)} of frames`);
  console.log(`all core joints >=${VIS_MIN}  ${pct(a.visibleCore, a.frames)} of frames  <- must be high to classify`);

  if (a.withLandmarks > 0) {
    console.log('');
    console.log('mean visibility per joint');
    for (let i = 0; i < CORE_JOINTS.length; i++) {
      const mean = a.sumVis[i] / a.withLandmarks;
      const bar = '#'.repeat(Math.max(0, Math.round(mean * 30)));
      console.log(`  ${CORE_JOINTS[i][0].padEnd(11)} ${mean.toFixed(3)}  ${bar}`);
    }

    const bw = a.maxX - a.minX;
    const bh = a.maxY - a.minY;
    console.log('');
    console.log('body extent across the session, in normalised frame units');
    console.log(`  x ${a.minX.toFixed(3)} .. ${a.maxX.toFixed(3)}   (width  ${bw.toFixed(3)})`);
    console.log(`  y ${a.minY.toFixed(3)} .. ${a.maxY.toFixed(3)}   (height ${bh.toFixed(3)})`);
    console.log(`  landmark samples outside 0..1: ${a.outOfUnit}`);
    console.log(`  mean z spread: ${(a.zSpreadSum / a.withLandmarks).toFixed(4)}`);

    // A standing body six feet from a portrait camera should be tall and narrow. Wider than tall
    // is the signature of coordinates in a transposed frame.
    if (bh > 0 && bw > bh) {
      console.log('  !! body is WIDER than TALL. Either the frame is transposed (rotation) or');
      console.log('     you were lying down/pushing up for most of the log.');
    }
    if (bh > 0 && bh < 0.35) {
      console.log('  !! body occupies under 35% of frame height — too far away, or only part of');
      console.log('     the body is being found.');
    }
  }

  const show = (name: string, m: Map<string, number>) => {
    const parts = [...m.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${pct(v, a.frames).trim()}`);
    console.log(`${name.padEnd(14)}${parts.join('  ')}`);
  };
  console.log('');
  show('exercise', a.labels);
  show('phase', a.phases);
  console.log('='.repeat(W));
}

main();
