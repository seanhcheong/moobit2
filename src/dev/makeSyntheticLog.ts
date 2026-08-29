/**
 * Write a synthetic session as a replay log, so the record/parse/replay round trip can be
 * exercised without a device.
 *
 *   npx tsx src/dev/makeSyntheticLog.ts sessions/raw/synthetic-squat.jsonl squat 10
 *
 * Then:
 *   npm run replay -- sessions/raw/synthetic-squat.jsonl --actual 10 --compare
 */

import * as fs from 'fs';
import * as path from 'path';
import { createPipeline } from '../core/pipeline';
import {
  encodeFrameRecord,
  encodeRecord,
  REPLAY_FORMAT_VERSION,
  type ReplayHeader,
} from '../core/replayFormat';
import { DEFAULT_ONE_EURO } from '../core/oneEuro';
import { SQUAT_CONFIG, PUSHUP_CONFIG, LUNGE_CONFIG } from '../core/exercises';
import { generateSession, type SynthExerciseId } from './synthExercises';
import { toNativeResult } from './runPipeline';
import { DEFAULT_CAMERA } from './synthBody';

const [outPath, exerciseArg, repsArg] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: npx tsx src/dev/makeSyntheticLog.ts <out.jsonl> [exercise] [reps]');
  process.exit(2);
}

const exercise = (exerciseArg ?? 'squat') as SynthExerciseId;
const reps = Number(repsArg ?? 10);

const frames = generateSession({ exercise, reps, seed: 4242, leadInSec: 4 });
const pipeline = createPipeline({ clock: () => 0, autoCalibrate: true });

const lines: string[] = [];
const header: ReplayHeader = {
  kind: 'header',
  version: REPLAY_FORMAT_VERSION,
  sessionId: `synthetic-${exercise}`,
  startedAtIso: new Date(0).toISOString(),
  imageWidth: DEFAULT_CAMERA.imageWidth,
  imageHeight: DEFAULT_CAMERA.imageHeight,
  rotationDegrees: 0,
  // The generator projects an unmirrored frame, so the replay must not mirror it either.
  mirrorX: false,
  device: {
    platform: 'synthetic',
    osVersion: '0',
    model: 'synthetic-body-1.75m',
    delegate: 'none',
    targetLongEdge: DEFAULT_CAMERA.imageWidth,
  },
  config: { oneEuro: DEFAULT_ONE_EURO, squat: SQUAT_CONFIG, pushup: PUSHUP_CONFIG, lunge: LUNGE_CONFIG },
};
lines.push(encodeRecord(header));

let baselineWritten = false;
let repCount = 0;

for (const frame of frames) {
  const native = toNativeResult(
    frame.flat,
    frame.imageWidth,
    frame.imageHeight,
    frame.timeMs,
    { inferenceMs: 12 },
  );
  const out = pipeline.processFrame(native, frame.timeMs);

  if (!baselineWritten && pipeline.baseline) {
    lines.push(encodeRecord({ kind: 'baseline', baseline: pipeline.baseline }));
    baselineWritten = true;
  }

  lines.push(
    encodeFrameRecord(
      frame.timeMs,
      frame.flat,
      {
        nowMs: native.nowMs,
        resultAtMs: native.resultAtMs!,
        inferenceMs: native.inferenceMs!,
        decimateMs: native.decimateMs,
        framesDropped: native.framesDropped,
      },
      out.event,
    ),
  );

  if (out.repCompleted) {
    repCount++;
    lines.push(encodeRecord({ kind: 'marker', t: frame.timeMs, label: `rep ${repCount}` }));
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${lines.join('\n')}\n`);

const bytes = fs.statSync(outPath).size;
console.log(
  `wrote ${outPath}: ${frames.length} frames, ${repCount} reps detected, ` +
    `${(bytes / 1e6).toFixed(2)} MB (${(bytes / frames.length).toFixed(0)} bytes/frame)`,
);
console.log(`replay it with:  npm run replay -- ${outPath} --actual ${reps} --compare`);
