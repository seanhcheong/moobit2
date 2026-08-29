/**
 * Session summary: the structured output of one test session.
 *
 * Pure and platform-free, so the same builder produces summaries on device and in the offline
 * replay CLI — which means a session recorded on a phone and re-run against changed thresholds
 * yields a summary directly comparable with the original.
 *
 * The shape is deliberately stable and self-describing: these files are meant to be diffed across
 * sessions and across devices to answer "did that change actually help?", and a summary whose
 * fields move around cannot answer that.
 */

import { latencyReport, type LatencyReport, type LatencyTracker } from './latency';
import type { Baseline } from './calibration';
import type { ExerciseId, ExerciseLabel, Side } from './types';

export const SESSION_SUMMARY_VERSION = 2;

/** Accumulates per-frame statistics over a session. */
export interface SessionStats {
  frames: number;
  /** Frames on which an exercise was recognised. */
  recognisedFrames: number;
  /** Frames reported as `unknown` — the dropout count the brief asks for. */
  unknownFrames: number;
  /** Sum of confidence over recognised frames, for the mean. */
  confidenceSum: number;
  /** Frames per reported label. */
  labelFrames: Record<string, number>;
  /** Times the active label changed. */
  labelSwitches: number;
  /** Deepest depth reached. */
  peakDepth: number;
  /** Per-rep peak depths, so form can be reviewed after the fact. */
  repPeakDepths: number[];
  /** Front-leg label per completed lunge rep, in order. */
  frontLegs: Side[];
  startedAtMs: number;
  endedAtMs: number;
}

export function createSessionStats(startedAtMs: number): SessionStats {
  return {
    frames: 0,
    recognisedFrames: 0,
    unknownFrames: 0,
    confidenceSum: 0,
    labelFrames: {},
    labelSwitches: 0,
    peakDepth: 0,
    repPeakDepths: [],
    frontLegs: [],
    startedAtMs,
    endedAtMs: startedAtMs,
  };
}

export function accumulateSessionStats(
  s: SessionStats,
  label: ExerciseLabel,
  confidence: number,
  depth: number,
  timestampMs: number,
  repCompleted: boolean,
  repPeakDepth: number,
  frontLeg: Side | null,
): void {
  s.frames++;
  s.endedAtMs = timestampMs;
  s.labelFrames[label] = (s.labelFrames[label] ?? 0) + 1;

  if (label === 'unknown') {
    s.unknownFrames++;
  } else {
    s.recognisedFrames++;
    s.confidenceSum += confidence;
  }

  if (depth > s.peakDepth) s.peakDepth = depth;

  if (repCompleted) {
    s.repPeakDepths.push(repPeakDepth);
    if (label === 'lunge' && frontLeg) s.frontLegs.push(frontLeg);
  }
}

/** Per-exercise diagnostics carried into the summary. */
export interface ExerciseSummary {
  id: string;
  repCount: number;
  partialReps: number;
  abandonedReps: number;
  flickers: number;
  trackingLosses: number;
}

export interface GroundTruth {
  /** What the tester said they were about to do. */
  declaredExercise: ExerciseId | null;
  /** How many reps they intended. */
  plannedReps: number | null;
  /** How many they say they actually completed, entered afterwards. */
  actualReps: number | null;
}

export interface DeviceInfo {
  platform: string;
  osVersion: string;
  model: string;
  /** Which MediaPipe delegate was actually in use: 'GPU' or 'CPU'. */
  delegate: string;
  /** Inference input size, longest edge in px. */
  targetLongEdge: number;
  /** Camera format actually selected. */
  cameraWidth: number;
  cameraHeight: number;
  cameraFps: number;
}

export interface SessionSummary {
  version: number;
  sessionId: string;
  startedAtIso: string;
  durationSec: number;

  /** The exercise this session was about, declared or, failing that, the most-seen label. */
  exercise: string;

  reps: {
    /** What the pipeline counted for the declared exercise. */
    detected: number | null;
    /** What the tester entered afterwards. */
    actual: number | null;
    /** detected - actual. Positive means over-counting. */
    error: number | null;
    /** 1 - |error|/actual, clamped at 0. The headline accuracy figure. */
    accuracy: number | null;
  };

  latency: LatencyReport;

  quality: {
    meanConfidence: number;
    unknownFrames: number;
    unknownFraction: number;
    labelSwitches: number;
    peakDepth: number;
    meanRepPeakDepth: number;
    /** Phase-transition chatter, summed across exercises. */
    flickers: number;
    partialReps: number;
    abandonedReps: number;
    trackingLosses: number;
  };

  perExercise: ExerciseSummary[];

  lunge: {
    frontLegs: Side[];
    /** Fraction of consecutive reps whose front leg alternates. NaN with fewer than two reps. */
    alternationRate: number | null;
  };

  groundTruth: GroundTruth;
  device: DeviceInfo;

  /** The calibration baseline in force, so a session can be reproduced exactly. */
  baseline: Baseline | null;

  /**
   * The thresholds this session ran with.
   *
   * Recorded because the whole point of the summary is comparing sessions, and a comparison
   * between two runs whose thresholds differed in a way nobody wrote down is worthless.
   */
  config: Record<string, unknown>;

  /** Set when the raw landmark log was captured, naming the file. */
  rawLogFile: string | null;

  notes: string;
}

export interface BuildSummaryInput {
  sessionId: string;
  startedAtIso: string;
  stats: SessionStats;
  latencyTracker: LatencyTracker;
  perExercise: ExerciseSummary[];
  groundTruth: GroundTruth;
  device: DeviceInfo;
  baseline: Baseline | null;
  config: Record<string, unknown>;
  rawLogFile?: string | null;
  notes?: string;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function alternation(history: readonly Side[]): number | null {
  if (history.length < 2) return null;
  let alt = 0;
  for (let i = 1; i < history.length; i++) if (history[i] !== history[i - 1]) alt++;
  return alt / (history.length - 1);
}

export function buildSessionSummary(input: BuildSummaryInput): SessionSummary {
  const { stats, groundTruth } = input;

  // The declared exercise wins. Falling back to the most-seen label keeps a session usable when
  // the tester forgot to declare one, but a declared value is what makes the accuracy figure mean
  // anything, so it is never overridden.
  let exercise = groundTruth.declaredExercise as string | null;
  if (!exercise) {
    let bestLabel = 'unknown';
    let bestCount = -1;
    for (const key of Object.keys(stats.labelFrames)) {
      if (key === 'unknown') continue;
      const n = stats.labelFrames[key];
      if (n > bestCount) {
        bestCount = n;
        bestLabel = key;
      }
    }
    exercise = bestLabel;
  }

  const detected = input.perExercise.find((e) => e.id === exercise)?.repCount ?? null;
  const actual = groundTruth.actualReps;
  const error = detected !== null && actual !== null ? detected - actual : null;
  const accuracy =
    error !== null && actual !== null && actual > 0
      ? Math.max(0, 1 - Math.abs(error) / actual)
      : null;

  let flickers = 0;
  let partialReps = 0;
  let abandonedReps = 0;
  let trackingLosses = 0;
  for (const e of input.perExercise) {
    flickers += e.flickers;
    partialReps += e.partialReps;
    abandonedReps += e.abandonedReps;
    trackingLosses += e.trackingLosses;
  }

  const durationSec = Math.max(0, (stats.endedAtMs - stats.startedAtMs) / 1000);

  return {
    version: SESSION_SUMMARY_VERSION,
    sessionId: input.sessionId,
    startedAtIso: input.startedAtIso,
    durationSec,
    exercise,
    reps: { detected, actual, error, accuracy },
    latency: latencyReport(input.latencyTracker),
    quality: {
      meanConfidence: stats.recognisedFrames > 0 ? stats.confidenceSum / stats.recognisedFrames : 0,
      unknownFrames: stats.unknownFrames,
      unknownFraction: stats.frames > 0 ? stats.unknownFrames / stats.frames : 0,
      labelSwitches: stats.labelSwitches,
      peakDepth: stats.peakDepth,
      meanRepPeakDepth: mean(stats.repPeakDepths),
      flickers,
      partialReps,
      abandonedReps,
      trackingLosses,
    },
    perExercise: input.perExercise,
    lunge: {
      frontLegs: stats.frontLegs.slice(),
      alternationRate: alternation(stats.frontLegs),
    },
    groundTruth,
    device: input.device,
    baseline: input.baseline,
    config: input.config,
    rawLogFile: input.rawLogFile ?? null,
    notes: input.notes ?? '',
  };
}

/**
 * One-line CSV row, so sessions can be tracked in a spreadsheet without parsing JSON.
 *
 * Keep {@link SESSION_CSV_HEADER} in step with this.
 */
export function sessionSummaryToCsvRow(s: SessionSummary): string {
  const cells: (string | number)[] = [
    s.sessionId,
    s.startedAtIso,
    s.durationSec.toFixed(1),
    s.exercise,
    s.reps.detected ?? '',
    s.reps.actual ?? '',
    s.reps.error ?? '',
    s.reps.accuracy !== null ? s.reps.accuracy.toFixed(3) : '',
    s.latency.definition,
    fmt(s.latency.endToEnd.p50),
    fmt(s.latency.endToEnd.p95),
    fmt(s.latency.endToEnd.p99),
    fmt(s.latency.inference.p50),
    fmt(s.latency.resultAge.p50),
    s.latency.dropRate.toFixed(3),
    s.quality.meanConfidence.toFixed(3),
    s.quality.unknownFrames,
    s.quality.unknownFraction.toFixed(3),
    s.quality.flickers,
    s.quality.partialReps,
    s.quality.abandonedReps,
    s.quality.trackingLosses,
    fmt(s.quality.meanRepPeakDepth),
    s.lunge.alternationRate !== null ? s.lunge.alternationRate.toFixed(2) : '',
    s.device.platform,
    s.device.model,
    s.device.delegate,
    s.device.targetLongEdge,
    // Quoted last: free text must not be able to break the row.
    `"${s.notes.replace(/"/g, "'")}"`,
  ];
  return cells.join(',');
}

export const SESSION_CSV_HEADER = [
  'sessionId',
  'startedAt',
  'durationSec',
  'exercise',
  'detectedReps',
  'actualReps',
  'repError',
  'accuracy',
  'latencyDefinition',
  'e2e_p50',
  'e2e_p95',
  'e2e_p99',
  'inference_p50',
  'resultAge_p50',
  'dropRate',
  'meanConfidence',
  'unknownFrames',
  'unknownFraction',
  'flickers',
  'partialReps',
  'abandonedReps',
  'trackingLosses',
  'meanRepPeakDepth',
  'lungeAlternation',
  'platform',
  'model',
  'delegate',
  'targetLongEdge',
  'notes',
].join(',');

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '';
}

/** Compact human-readable summary for the in-app end-of-session screen and the console. */
export function formatSessionSummary(s: SessionSummary): string {
  const lines: string[] = [];
  const pct = (v: number | null) => (v === null ? '?' : `${(v * 100).toFixed(0)}%`);
  const ms = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)}ms` : '?');

  lines.push(`Session ${s.sessionId}  (${s.durationSec.toFixed(0)}s)`);
  lines.push(`Exercise: ${s.exercise}`);
  lines.push(
    `Reps: detected ${s.reps.detected ?? '?'} / actual ${s.reps.actual ?? '?'}` +
      (s.reps.error !== null ? `  error ${s.reps.error > 0 ? '+' : ''}${s.reps.error}` : '') +
      `  accuracy ${pct(s.reps.accuracy)}`,
  );
  lines.push(
    `Latency (${s.latency.definition}): p50 ${ms(s.latency.endToEnd.p50)}` +
      `  p95 ${ms(s.latency.endToEnd.p95)}  p99 ${ms(s.latency.endToEnd.p99)}`,
  );
  lines.push(
    `  of which inference p50 ${ms(s.latency.inference.p50)},` +
      ` result staleness p50 ${ms(s.latency.resultAge.p50)}`,
  );
  lines.push(
    `Frames: ${s.latency.processedFrames} processed, ${s.latency.droppedFrames} dropped` +
      ` (${(s.latency.dropRate * 100).toFixed(0)}%)`,
  );
  lines.push(
    `Quality: confidence ${s.quality.meanConfidence.toFixed(2)},` +
      ` unknown ${(s.quality.unknownFraction * 100).toFixed(0)}%,` +
      ` flickers ${s.quality.flickers}, partials ${s.quality.partialReps},` +
      ` abandoned ${s.quality.abandonedReps}, losses ${s.quality.trackingLosses}`,
  );
  if (s.lunge.frontLegs.length > 0) {
    lines.push(
      `Lunge front legs: ${s.lunge.frontLegs.join(',')}` +
        `  alternation ${s.lunge.alternationRate !== null ? pct(s.lunge.alternationRate) : '?'}`,
    );
  }
  lines.push(`Device: ${s.device.model} (${s.device.platform} ${s.device.osVersion}), ${s.device.delegate}`);
  return lines.join('\n');
}
