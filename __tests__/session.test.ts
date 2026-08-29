import {
  accumulateSessionStats,
  buildSessionSummary,
  createSessionStats,
  formatSessionSummary,
  SESSION_CSV_HEADER,
  sessionSummaryToCsvRow,
  type DeviceInfo,
  type ExerciseSummary,
} from '../src/core/session';
import { createLatencyTracker, recordLatency, createLatencyBreakdown } from '../src/core/latency';

const device: DeviceInfo = {
  platform: 'ios',
  osVersion: '18.0',
  model: 'iPhone 14',
  delegate: 'GPU',
  targetLongEdge: 320,
  cameraWidth: 1280,
  cameraHeight: 720,
  cameraFps: 30,
};

function trackerWith(values: number[]) {
  const t = createLatencyTracker('STATE_AGE');
  const b = createLatencyBreakdown();
  for (const v of values) {
    b.stateAgeMs = v;
    b.pipelineMs = v - 2;
    b.inferenceMs = 12;
    b.classifyMs = 0.4;
    b.resultAgeMs = 3;
    b.hopMs = 2;
    recordLatency(t, b);
  }
  return t;
}

const perExercise: ExerciseSummary[] = [
  { id: 'squat', repCount: 9, partialReps: 2, abandonedReps: 1, flickers: 3, trackingLosses: 1 },
  { id: 'pushup', repCount: 0, partialReps: 0, abandonedReps: 0, flickers: 0, trackingLosses: 0 },
  { id: 'lunge', repCount: 0, partialReps: 0, abandonedReps: 0, flickers: 0, trackingLosses: 0 },
];

function summaryFor(actualReps: number | null, statsMutator?: (s: ReturnType<typeof createSessionStats>) => void) {
  const stats = createSessionStats(1000);
  for (let i = 0; i < 100; i++) {
    accumulateSessionStats(stats, i < 10 ? 'unknown' : 'squat', 0.9, i, 1000 + i * 33, false, NaN, null);
  }
  statsMutator?.(stats);
  return buildSessionSummary({
    sessionId: 'abc',
    startedAtIso: '2026-08-29T12:00:00.000Z',
    stats,
    latencyTracker: trackerWith([40, 42, 45, 90, 41, 43]),
    perExercise,
    groundTruth: { declaredExercise: 'squat', plannedReps: 10, actualReps },
    device,
    baseline: null,
    config: { squat: { depthExcursion: 0.192 } },
  });
}

describe('session summary', () => {
  it('computes detected-vs-actual accuracy, the point of the ground-truth flow', () => {
    const s = summaryFor(10);
    expect(s.reps.detected).toBe(9);
    expect(s.reps.actual).toBe(10);
    expect(s.reps.error).toBe(-1);
    expect(s.reps.accuracy).toBeCloseTo(0.9, 6);
  });

  it('reports over-counting as a positive error', () => {
    const s = summaryFor(7);
    expect(s.reps.error).toBe(2);
    expect(s.reps.accuracy).toBeCloseTo(1 - 2 / 7, 6);
  });

  it('leaves accuracy null when no actual count was entered', () => {
    const s = summaryFor(null);
    expect(s.reps.actual).toBeNull();
    expect(s.reps.error).toBeNull();
    expect(s.reps.accuracy).toBeNull();
  });

  it('counts unknown frames as the dropout metric', () => {
    const s = summaryFor(10);
    expect(s.quality.unknownFrames).toBe(10);
    expect(s.quality.unknownFraction).toBeCloseTo(0.1, 6);
  });

  it('sums flickers, partials, abandoned reps and tracking losses across exercises', () => {
    const s = summaryFor(10);
    expect(s.quality.flickers).toBe(3);
    expect(s.quality.partialReps).toBe(2);
    expect(s.quality.abandonedReps).toBe(1);
    expect(s.quality.trackingLosses).toBe(1);
  });

  it('reports latency percentiles, so a spike is visible behind a good average', () => {
    const s = summaryFor(10);
    // One 90 ms outlier among six samples: the mean hides it, p99 does not.
    expect(s.latency.endToEnd.p50).toBeLessThan(50);
    expect(s.latency.endToEnd.max).toBe(90);
    expect(s.latency.endToEnd.p99).toBe(90);
    expect(s.latency.hop.p50).toBe(2);
  });

  it('records per-rep peak depths — the path the device recorder must actually drive', () => {
    // Regression guard: the recorder originally passed repCompleted as a hardcoded false, so
    // meanRepPeakDepth and the lunge front-leg list were silently always empty on device.
    const s = summaryFor(3, (stats) => {
      accumulateSessionStats(stats, 'squat', 0.9, 88, 5000, true, 88, null);
      accumulateSessionStats(stats, 'squat', 0.9, 92, 6000, true, 92, null);
    });
    expect(s.quality.meanRepPeakDepth).toBeCloseTo(90, 6);
  });

  it('records the lunge front-leg sequence and its alternation rate', () => {
    const stats = createSessionStats(0);
    for (const leg of ['left', 'right', 'left', 'right'] as const) {
      accumulateSessionStats(stats, 'lunge', 0.9, 90, 0, true, 90, leg);
    }
    const s = buildSessionSummary({
      sessionId: 'l1',
      startedAtIso: '2026-08-29T12:00:00.000Z',
      stats,
      latencyTracker: trackerWith([40]),
      perExercise: [{ id: 'lunge', repCount: 4, partialReps: 0, abandonedReps: 0, flickers: 0, trackingLosses: 0 }],
      groundTruth: { declaredExercise: 'lunge', plannedReps: 4, actualReps: 4 },
      device,
      baseline: null,
      config: {},
    });
    expect(s.lunge.frontLegs).toEqual(['left', 'right', 'left', 'right']);
    expect(s.lunge.alternationRate).toBe(1);
  });

  it('reports a non-alternating lunge sequence honestly', () => {
    const stats = createSessionStats(0);
    for (const leg of ['left', 'left', 'left', 'right'] as const) {
      accumulateSessionStats(stats, 'lunge', 0.9, 90, 0, true, 90, leg);
    }
    const s = buildSessionSummary({
      sessionId: 'l2',
      startedAtIso: '2026-08-29T12:00:00.000Z',
      stats,
      latencyTracker: trackerWith([40]),
      perExercise: [{ id: 'lunge', repCount: 4, partialReps: 0, abandonedReps: 0, flickers: 0, trackingLosses: 0 }],
      groundTruth: { declaredExercise: 'lunge', plannedReps: 4, actualReps: 4 },
      device,
      baseline: null,
      config: {},
    });
    expect(s.lunge.alternationRate).toBeCloseTo(1 / 3, 6);
  });

  it('falls back to the most-seen label when no exercise was declared', () => {
    const stats = createSessionStats(0);
    for (let i = 0; i < 50; i++) accumulateSessionStats(stats, 'pushup', 0.8, 50, i, false, NaN, null);
    for (let i = 0; i < 5; i++) accumulateSessionStats(stats, 'squat', 0.8, 50, i, false, NaN, null);
    const s = buildSessionSummary({
      sessionId: 'nd',
      startedAtIso: '2026-08-29T12:00:00.000Z',
      stats,
      latencyTracker: trackerWith([40]),
      perExercise,
      groundTruth: { declaredExercise: null, plannedReps: null, actualReps: null },
      device,
      baseline: null,
      config: {},
    });
    expect(s.exercise).toBe('pushup');
  });

  it('records the config in force, so two sessions can actually be compared', () => {
    const s = summaryFor(10);
    expect(s.config).toEqual({ squat: { depthExcursion: 0.192 } });
  });

  it('emits a CSV row whose column count matches the header', () => {
    const s = summaryFor(10);
    const row = sessionSummaryToCsvRow(s);
    expect(row.split(',')).toHaveLength(SESSION_CSV_HEADER.split(',').length);
  });

  it('quotes the notes field and neutralises inner quotes', () => {
    const s = summaryFor(10);
    s.notes = 'had a "wobble", then, more commas';
    const row = sessionSummaryToCsvRow(s);
    // The notes field is the last one and is quoted, so a real CSV reader keeps its commas
    // together. Inner double-quotes become single quotes so they cannot terminate the field.
    expect(row).toContain(',"had a \'wobble\', then, more commas"');
    expect(row.endsWith('"')).toBe(true);
    // Newlines would break the row outright regardless of quoting.
    expect(row).not.toContain('\n');
  });

  it('formats a readable summary including both latency framings', () => {
    const text = formatSessionSummary(summaryFor(10));
    expect(text).toContain('detected 9 / actual 10');
    expect(text).toContain('accuracy 90%');
    expect(text).toContain('STATE_AGE');
    expect(text).toContain('result staleness');
  });
});
