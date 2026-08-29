/**
 * Offline replay CLI.
 *
 * Re-runs a recorded session's landmarks through the current pipeline, so thresholds can be tuned
 * against real footage without re-testing live. Because the log stores landmarks rather than
 * conclusions, every stage from smoothing onward is genuinely re-executed.
 *
 *   npm run replay -- sessions/raw/<id>.jsonl
 *   npm run replay -- sessions/raw/<id>.jsonl --actual 10
 *   npm run replay -- sessions/raw/<id>.jsonl --compare
 *   npm run replay -- sessions/raw/*.jsonl --csv out.csv
 *
 * Flags:
 *   --actual N     ground-truth rep count, to compute accuracy
 *   --exercise ID  declared exercise, if the log did not record one
 *   --compare      show what the ORIGINAL run concluded next to this replay's conclusion
 *   --recalibrate  re-run the stillness capture instead of reusing the recorded baseline
 *   --csv PATH     append one summary row per file
 *   --json DIR     write a full summary JSON per file
 *   --verbose      per-rep detail
 */

import * as fs from 'fs';
import * as path from 'path';
import { createPipeline } from '../core/pipeline';
import { parseReplayLog, type ReplayFrameRecord } from '../core/replayFormat';
import {
  accumulateSessionStats,
  buildSessionSummary,
  createSessionStats,
  formatSessionSummary,
  SESSION_CSV_HEADER,
  sessionSummaryToCsvRow,
  type DeviceInfo,
  type ExerciseSummary,
} from '../core/session';
import { SQUAT_CONFIG, PUSHUP_CONFIG, LUNGE_CONFIG } from '../core/exercises';
import { DEFAULT_ONE_EURO } from '../core/oneEuro';
import type { ExerciseId, RecognitionEvent } from '../core/types';
import type { NativePoseOk } from '../core/nativeContract';

interface Args {
  files: string[];
  actual: number | null;
  exercise: ExerciseId | null;
  compare: boolean;
  recalibrate: boolean;
  csv: string | null;
  jsonDir: string | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    files: [],
    actual: null,
    exercise: null,
    compare: false,
    recalibrate: false,
    csv: null,
    jsonDir: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--actual':
        args.actual = Number(argv[++i]);
        break;
      case '--exercise':
        args.exercise = argv[++i] as ExerciseId;
        break;
      case '--compare':
        args.compare = true;
        break;
      case '--recalibrate':
        args.recalibrate = true;
        break;
      case '--csv':
        args.csv = argv[++i];
        break;
      case '--json':
        args.jsonDir = argv[++i];
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`unknown flag ${a}`);
          process.exit(2);
        }
        args.files.push(a);
    }
  }
  return args;
}

function toNative(rec: ReplayFrameRecord, imageWidth: number, imageHeight: number): NativePoseOk {
  return {
    ok: true,
    nowMs: rec.nowMs,
    captureMs: rec.t,
    captureClock: 'ELAPSED_REALTIME',
    rotationDegrees: 0,
    frameMirrored: true,
    decimateMs: rec.decimateMs,
    decimateStep: 1,
    submitted: true,
    delegate: 'GPU',
    framesSubmitted: 1,
    framesDropped: rec.framesDropped,
    hasResult: true,
    personDetected: true,
    landmarks: rec.lm,
    landmarkCount: 33,
    imageWidth,
    imageHeight,
    frameId: rec.t,
    resultCaptureMs: rec.t,
    resultAtMs: rec.resultAtMs,
    inferenceMs: rec.inferenceMs,
    resultAgeMs: Math.max(0, rec.nowMs - rec.resultAtMs),
  };
}

function replayOne(file: string, args: Args) {
  const text = fs.readFileSync(file, 'utf8');
  const log = parseReplayLog(text);

  if (log.frames.length === 0) {
    console.error(`${file}: no usable frames (${log.skippedLines} lines skipped)`);
    return null;
  }

  const imageWidth = log.header?.imageWidth ?? 720;
  const imageHeight = log.header?.imageHeight ?? 1280;
  const mirrorX = log.header?.mirrorX ?? true;

  const pipeline = createPipeline({
    camera: { mirrorX, swapAnatomicalSides: false },
    // Deterministic: a replay's numbers must not depend on the host machine's load.
    clock: () => 0,
    autoCalibrate: args.recalibrate,
  });

  // Reuse the recorded baseline unless explicitly re-running calibration, so a replay isolates
  // the effect of a threshold change rather than mixing in a different baseline.
  if (log.baseline && !args.recalibrate) pipeline.setBaseline(log.baseline);

  const startedAtMs = log.frames[0].t;
  const stats = createSessionStats(startedAtMs);
  const events: RecognitionEvent[] = [];
  const originals: ReplayFrameRecord['out'][] = [];
  let lastLabel: string | null = null;
  let reps = 0;

  for (const rec of log.frames) {
    const out = pipeline.processFrame(toNative(rec, imageWidth, imageHeight), rec.t);
    const e = { ...out.event };
    events.push(e);
    originals.push(rec.out);

    if (lastLabel !== null && lastLabel !== e.exercise) stats.labelSwitches++;
    lastLabel = e.exercise;

    accumulateSessionStats(
      stats,
      e.exercise,
      e.confidence,
      e.depth,
      e.timestamp,
      out.repCompleted,
      out.repCompleted ? e.depth : NaN,
      e.frontLeg,
    );

    if (out.repCompleted) {
      reps++;
      if (args.verbose) {
        console.log(
          `  rep ${reps} at t=${((e.timestamp - startedAtMs) / 1000).toFixed(2)}s` +
            ` ${e.exercise}${e.frontLeg ? `/${e.frontLeg}` : ''} conf ${e.confidence.toFixed(2)}`,
        );
      }
    }
  }

  const perExercise: ExerciseSummary[] = pipeline.registry.map((mod, i) => {
    const d = mod.diagnostics(pipeline.exerciseState(i));
    return {
      id: mod.id,
      repCount: d.repCount,
      partialReps: d.partialReps,
      abandonedReps: d.abandonedReps,
      flickers: d.flickers,
      trackingLosses: d.trackingLosses,
    };
  });

  const device: DeviceInfo = {
    platform: `replay(${log.header?.device.platform ?? 'unknown'})`,
    osVersion: log.header?.device.osVersion ?? '',
    model: log.header?.device.model ?? '',
    delegate: log.header?.device.delegate ?? '',
    targetLongEdge: log.header?.device.targetLongEdge ?? 0,
    cameraWidth: imageWidth,
    cameraHeight: imageHeight,
    cameraFps: 0,
  };

  const summary = buildSessionSummary({
    sessionId: `${path.basename(file, '.jsonl')}-replay`,
    startedAtIso: log.header?.startedAtIso ?? new Date(startedAtMs).toISOString(),
    stats,
    latencyTracker: pipeline.latencyTracker,
    perExercise,
    groundTruth: {
      declaredExercise: args.exercise,
      plannedReps: null,
      actualReps: args.actual,
    },
    device,
    baseline: pipeline.baseline,
    // The CURRENT thresholds, which is the point: diff this against the header's recorded config
    // to see exactly what changed between the original run and this replay.
    config: {
      oneEuro: DEFAULT_ONE_EURO,
      squat: SQUAT_CONFIG,
      pushup: PUSHUP_CONFIG,
      lunge: LUNGE_CONFIG,
    },
    rawLogFile: file,
    notes: `replayed from ${file}${log.skippedLines ? ` (${log.skippedLines} bad lines skipped)` : ''}`,
  });

  console.log(`\n${'='.repeat(88)}`);
  console.log(`REPLAY ${file}`);
  console.log(`  ${log.frames.length} frames, ${log.markers.length} markers, ${log.skippedLines} skipped`);
  console.log('='.repeat(88));
  console.log(formatSessionSummary(summary));

  if (args.compare) {
    // Compare the replay's conclusions with what the device concluded live. Divergence is the
    // whole signal here: it says exactly what a threshold change did.
    let sameLabel = 0;
    let samePhase = 0;
    let depthDelta = 0;
    let maxDepthDelta = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].exercise === originals[i].exercise) sameLabel++;
      if (events[i].phase === originals[i].phase) samePhase++;
      const d = Math.abs(events[i].depth - originals[i].depth);
      depthDelta += d;
      if (d > maxDepthDelta) maxDepthDelta = d;
    }
    const n = events.length;
    const originalReps = originals.length > 0 ? originals[originals.length - 1].repCount : 0;
    console.log('\nCOMPARISON vs the original live run');
    console.log(`  reps        original ${originalReps}  ->  replay ${reps}`);
    console.log(`  same label  ${((sameLabel / n) * 100).toFixed(1)}% of frames`);
    console.log(`  same phase  ${((samePhase / n) * 100).toFixed(1)}% of frames`);
    console.log(
      `  depth       mean |delta| ${(depthDelta / n).toFixed(2)}  max ${maxDepthDelta.toFixed(1)}`,
    );
    if (log.header) {
      console.log(
        '  (diff the header\'s recorded `config` against this replay\'s to see what changed)',
      );
    }
  }

  if (log.markers.length > 0) {
    console.log('\nMARKERS');
    for (const m of log.markers) {
      console.log(`  t=${((m.t - startedAtMs) / 1000).toFixed(2)}s  ${m.label}`);
    }
  }

  return summary;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.files.length === 0) {
    console.error('usage: npm run replay -- <log.jsonl> [more.jsonl ...] [flags]');
    console.error('       see the header of src/dev/replayCli.ts for the flag list');
    process.exit(2);
  }

  const summaries = args.files.map((f) => replayOne(f, args)).filter((s) => s !== null);

  if (args.csv && summaries.length > 0) {
    const rows = summaries.map((s) => sessionSummaryToCsvRow(s!)).join('\n');
    const exists = fs.existsSync(args.csv);
    if (exists) fs.appendFileSync(args.csv, `${rows}\n`);
    else fs.writeFileSync(args.csv, `${SESSION_CSV_HEADER}\n${rows}\n`);
    console.log(`\nwrote ${summaries.length} row(s) to ${args.csv}`);
  }

  if (args.jsonDir && summaries.length > 0) {
    fs.mkdirSync(args.jsonDir, { recursive: true });
    for (const s of summaries) {
      const p = path.join(args.jsonDir, `${s!.sessionId}.json`);
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
    }
    console.log(`wrote ${summaries.length} summary file(s) to ${args.jsonDir}`);
  }

  if (summaries.length > 1) {
    console.log(`\n${'='.repeat(88)}`);
    console.log('ACROSS ALL REPLAYED SESSIONS');
    console.log('='.repeat(88));
    for (const s of summaries) {
      const acc = s!.reps.accuracy;
      console.log(
        `  ${s!.sessionId.padEnd(36)} ${s!.exercise.padEnd(8)}` +
          ` reps ${String(s!.reps.detected ?? '?').padStart(3)}/${String(s!.reps.actual ?? '?').padStart(3)}` +
          `  acc ${acc !== null ? `${(acc * 100).toFixed(0)}%` : '  ?'}` +
          `  p95 ${s!.latency.endToEnd.p95.toFixed(0)}ms` +
          `  flick ${s!.quality.flickers}`,
      );
    }
  }
}

main();
