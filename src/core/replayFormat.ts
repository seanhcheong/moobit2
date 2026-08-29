/**
 * The raw replay log format: one JSON object per line (JSONL).
 *
 * Purpose: tune thresholds offline against real footage instead of re-running a live test for
 * every change. A recorded session can be replayed through a modified pipeline as many times as
 * needed, and — because the log stores the *landmarks*, not the classifier's conclusions — the
 * replay exercises every stage from smoothing onward.
 *
 * JSONL rather than one big JSON array so the writer can append and flush incrementally. A
 * ten-minute session at 30 fps is 18,000 records; holding them all in memory to serialise one
 * array at the end is both a memory spike and a guarantee that a crash loses the whole session.
 */

import { FLAT_LANDMARK_LENGTH } from './nativeContract';
import type { Baseline } from './calibration';
import type { RecognitionEvent } from './types';

export const REPLAY_FORMAT_VERSION = 2;

/** The first line of every log: enough context to reproduce the run. */
export interface ReplayHeader {
  kind: 'header';
  version: number;
  sessionId: string;
  startedAtIso: string;
  imageWidth: number;
  imageHeight: number;
  /** Rotation passed to the native plugin, so a replay can reproduce the coordinate frame. */
  rotationDegrees: number;
  mirrorX: boolean;
  device: {
    platform: string;
    osVersion: string;
    model: string;
    delegate: string;
    targetLongEdge: number;
  };
  /** Snapshot of the thresholds in force, for comparison against a later replay. */
  config: Record<string, unknown>;
}

/** Emitted once when calibration completes, so a replay starts from the same baseline. */
export interface ReplayBaselineRecord {
  kind: 'baseline';
  baseline: Baseline;
}

/**
 * One frame.
 *
 * Landmark coordinates are rounded to four decimals on write. At a 720x1280 frame that is finer
 * than a twentieth of a pixel — far below MediaPipe's own precision — and it roughly halves the
 * file size, which matters when the log is being pushed over a phone's WiFi.
 */
export interface ReplayFrameRecord {
  kind: 'frame';
  /** Capture timestamp of the frame these landmarks came from. */
  t: number;
  /** Flat [x, y, z, visibility] * 33, exactly as the native plugin produced it. */
  lm: number[];
  /** Native timing, so latency can be recomputed rather than merely re-read. */
  nowMs: number;
  resultAtMs: number;
  inferenceMs: number;
  decimateMs: number;
  framesDropped: number;
  /** What the pipeline concluded at record time, for comparison against a replay's conclusion. */
  out: {
    exercise: string;
    phase: string;
    depth: number;
    confidence: number;
    repCount: number;
    latencyMs: number;
    frontLeg: string | null;
  };
}

/** A marker the tester dropped, e.g. "rep 5 was sloppy". */
export interface ReplayMarkerRecord {
  kind: 'marker';
  t: number;
  label: string;
}

export type ReplayRecord =
  | ReplayHeader
  | ReplayBaselineRecord
  | ReplayFrameRecord
  | ReplayMarkerRecord;

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function encodeFrameRecord(
  captureMs: number,
  landmarks: readonly number[],
  native: { nowMs: number; resultAtMs: number; inferenceMs: number; decimateMs: number; framesDropped: number },
  event: RecognitionEvent,
): string {
  const lm: number[] = [];
  for (let i = 0; i < FLAT_LANDMARK_LENGTH && i < landmarks.length; i++) lm.push(round4(landmarks[i]));

  const rec: ReplayFrameRecord = {
    kind: 'frame',
    t: Math.round(captureMs),
    lm,
    nowMs: Math.round(native.nowMs),
    resultAtMs: Math.round(native.resultAtMs),
    inferenceMs: round4(native.inferenceMs),
    decimateMs: round4(native.decimateMs),
    framesDropped: native.framesDropped,
    out: {
      exercise: event.exercise,
      phase: event.phase,
      depth: Math.round(event.depth * 10) / 10,
      confidence: Math.round(event.confidence * 1000) / 1000,
      repCount: event.repCount,
      latencyMs: Math.round(event.latencyMs * 10) / 10,
      frontLeg: event.frontLeg,
    },
  };
  return JSON.stringify(rec);
}

export function encodeRecord(rec: ReplayRecord): string {
  return JSON.stringify(rec);
}

/**
 * Parse a JSONL log.
 *
 * Malformed lines are skipped and counted rather than thrown on: a log truncated by a crash or a
 * dropped upload is exactly the log most worth being able to read.
 */
export function parseReplayLog(text: string): {
  header: ReplayHeader | null;
  baseline: Baseline | null;
  frames: ReplayFrameRecord[];
  markers: ReplayMarkerRecord[];
  skippedLines: number;
} {
  let header: ReplayHeader | null = null;
  let baseline: Baseline | null = null;
  const frames: ReplayFrameRecord[] = [];
  const markers: ReplayMarkerRecord[] = [];
  let skippedLines = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let rec: ReplayRecord;
    try {
      rec = JSON.parse(trimmed) as ReplayRecord;
    } catch {
      skippedLines++;
      continue;
    }
    switch (rec.kind) {
      case 'header':
        header = rec;
        break;
      case 'baseline':
        baseline = rec.baseline;
        break;
      case 'frame':
        if (Array.isArray(rec.lm) && rec.lm.length >= FLAT_LANDMARK_LENGTH) frames.push(rec);
        else skippedLines++;
        break;
      case 'marker':
        markers.push(rec);
        break;
      default:
        skippedLines++;
    }
  }

  return { header, baseline, frames, markers, skippedLines };
}
