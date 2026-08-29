import {
  encodeFrameRecord,
  encodeRecord,
  parseReplayLog,
  REPLAY_FORMAT_VERSION,
  type ReplayHeader,
} from '../src/core/replayFormat';
import { FLAT_LANDMARK_LENGTH } from '../src/core/nativeContract';
import { createPipeline } from '../src/core/pipeline';
import { generateSession } from '../src/dev/synthExercises';
import { toNativeResult } from '../src/dev/runPipeline';
import { DEFAULT_CAMERA } from '../src/dev/synthBody';
import type { RecognitionEvent } from '../src/core/types';

const header: ReplayHeader = {
  kind: 'header',
  version: REPLAY_FORMAT_VERSION,
  sessionId: 's1',
  startedAtIso: '2026-08-29T00:00:00.000Z',
  imageWidth: 720,
  imageHeight: 1280,
  rotationDegrees: 0,
  mirrorX: false,
  device: { platform: 'test', osVersion: '1', model: 'm', delegate: 'GPU', targetLongEdge: 320 },
  config: { a: 1 },
};

const event: RecognitionEvent = {
  timestamp: 1000,
  exercise: 'squat',
  phase: 'bottom',
  depth: 87.65,
  confidence: 0.9876,
  repCount: 3,
  latencyMs: 41.23,
  frontLeg: null,
};

function landmarks(): number[] {
  const flat: number[] = [];
  for (let i = 0; i < FLAT_LANDMARK_LENGTH; i++) flat.push(i / FLAT_LANDMARK_LENGTH);
  return flat;
}

describe('replay log format', () => {
  it('round-trips a header, baseline, frames and markers', () => {
    const lines = [
      encodeRecord(header),
      encodeFrameRecord(
        1000,
        landmarks(),
        { nowMs: 1014, resultAtMs: 1012, inferenceMs: 12, decimateMs: 1.2, framesDropped: 4 },
        event,
      ),
      encodeRecord({ kind: 'marker', t: 1100, label: 'sloppy rep' }),
    ];
    const parsed = parseReplayLog(`${lines.join('\n')}\n`);

    expect(parsed.header?.sessionId).toBe('s1');
    expect(parsed.header?.imageWidth).toBe(720);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0].t).toBe(1000);
    expect(parsed.frames[0].lm).toHaveLength(FLAT_LANDMARK_LENGTH);
    expect(parsed.frames[0].out.exercise).toBe('squat');
    expect(parsed.frames[0].out.repCount).toBe(3);
    expect(parsed.markers).toHaveLength(1);
    expect(parsed.markers[0].label).toBe('sloppy rep');
    expect(parsed.skippedLines).toBe(0);
  });

  it('rounds coordinates to four decimals, below MediaPipe`s own precision', () => {
    const flat = landmarks();
    flat[0] = 0.123456789;
    const line = encodeFrameRecord(
      0,
      flat,
      { nowMs: 0, resultAtMs: 0, inferenceMs: 0, decimateMs: 0, framesDropped: 0 },
      event,
    );
    const parsed = parseReplayLog(line);
    expect(parsed.frames[0].lm[0]).toBe(0.1235);
  });

  it('skips malformed lines rather than throwing', () => {
    // A log truncated by a crash or a dropped upload is the one most worth still being readable.
    const good = encodeFrameRecord(
      1,
      landmarks(),
      { nowMs: 1, resultAtMs: 1, inferenceMs: 0, decimateMs: 0, framesDropped: 0 },
      event,
    );
    const text = [encodeRecord(header), 'not json at all', good, '{"kind":"frame"', ''].join('\n');
    const parsed = parseReplayLog(text);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.skippedLines).toBe(2);
  });

  it('rejects a frame with a short landmark array', () => {
    const text = `{"kind":"frame","t":1,"lm":[1,2,3],"nowMs":1,"resultAtMs":1,"inferenceMs":0,"decimateMs":0,"framesDropped":0,"out":{}}`;
    const parsed = parseReplayLog(text);
    expect(parsed.frames).toHaveLength(0);
    expect(parsed.skippedLines).toBe(1);
  });

  it('tolerates an empty log', () => {
    const parsed = parseReplayLog('');
    expect(parsed.header).toBeNull();
    expect(parsed.frames).toHaveLength(0);
  });
});

describe('record then replay', () => {
  it('reproduces the same rep count and phase stream from a recorded log', () => {
    // The whole point of the log: re-running it through the pipeline must reach the same
    // conclusion, otherwise offline tuning tells you nothing about the live behaviour.
    const frames = generateSession({ exercise: 'squat', reps: 6, seed: 909, leadInSec: 4 });

    // Pass 1: run live and record.
    const recording = createPipeline({ clock: () => 0, autoCalibrate: true, camera: { mirrorX: false, swapAnatomicalSides: false } });
    const lines: string[] = [encodeRecord({ ...header, mirrorX: false })];
    let baselineWritten = false;
    const liveEvents: RecognitionEvent[] = [];

    for (const frame of frames) {
      const native = toNativeResult(frame.flat, frame.imageWidth, frame.imageHeight, frame.timeMs);
      const out = recording.processFrame(native, frame.timeMs);
      if (!baselineWritten && recording.baseline) {
        lines.push(encodeRecord({ kind: 'baseline', baseline: recording.baseline }));
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
      liveEvents.push({ ...out.event });
    }

    const liveReps = recording.registry
      .map((m, i) => m.diagnostics(recording.exerciseState(i)).repCount)
      .reduce((a, b) => a + b, 0);
    expect(liveReps).toBe(6);

    // Pass 2: replay the log, reusing the recorded baseline.
    const parsed = parseReplayLog(`${lines.join('\n')}\n`);
    expect(parsed.baseline).not.toBeNull();

    const replay = createPipeline({ clock: () => 0, camera: { mirrorX: false, swapAnatomicalSides: false } });
    replay.setBaseline(parsed.baseline);

    let samePhase = 0;
    let compared = 0;
    for (const rec of parsed.frames) {
      const native = toNativeResult(rec.lm, DEFAULT_CAMERA.imageWidth, DEFAULT_CAMERA.imageHeight, rec.t);
      const out = replay.processFrame(native, rec.t);
      // Only compare frames the live run had a baseline for; before that the two legitimately
      // differ, since the replay starts with one.
      if (rec.out.exercise !== 'unknown') {
        compared++;
        if (out.event.phase === rec.out.phase) samePhase++;
      }
    }

    const replayReps = replay.registry
      .map((m, i) => m.diagnostics(replay.exerciseState(i)).repCount)
      .reduce((a, b) => a + b, 0);

    expect(replayReps).toBe(6);
    expect(compared).toBeGreaterThan(100);
    expect(samePhase / compared).toBeGreaterThan(0.98);
  });
});
