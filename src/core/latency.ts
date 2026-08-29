/**
 * Latency accounting.
 *
 * Worklet-safe.
 *
 * ## What `latencyMs` means, precisely
 * Under async `LIVE_STREAM` a frame processor invocation cannot return its own frame's landmarks;
 * it returns the newest result available, which came from an earlier frame. There are therefore
 * two defensible definitions of end-to-end latency, and only one of them is honest about what
 * the user will feel:
 *
 *   `PIPELINE`  = resultAtMs - resultCaptureMs + classify time
 *                 How long that landmark result took to produce, from the capture of *its* frame.
 *                 Flattering, and wrong for our purpose: it ignores that the state we are acting
 *                 on describes the world as it was several frames ago.
 *
 *   `STATE_AGE` = nowMs - resultCaptureMs + classify time
 *                 How stale the state we just emitted actually is, measured from the capture of
 *                 the frame it describes to the moment we finished classifying it. Includes the
 *                 `resultAgeMs` gap.
 *
 * `STATE_AGE` is the default, because this stream is meant to drive character animation and the
 * felt lag is the age of the state being rendered, not the throughput of the detector. Both are
 * recorded so the session summary can show the difference and attribute a shortfall.
 *
 * ## Percentiles, not just a mean
 * A good average with occasional spikes still feels broken, so every session reports p50/p95/p99.
 * Samples are kept in full (30 fps for 10 minutes is 18,000 numbers) and sorted once at summary
 * time rather than maintaining an online estimator: exact percentiles matter more here than the
 * memory, and this runs at most once per session.
 */

/** Which definition of end-to-end latency to report as `latencyMs`. */
export type LatencyDefinition = 'STATE_AGE' | 'PIPELINE';

export interface LatencyBreakdown {
  /** `nowMs - resultCaptureMs`, plus classification: the age of the state just emitted. */
  stateAgeMs: number;
  /** `resultAtMs - resultCaptureMs`, plus classification: detector capture-to-result. */
  pipelineMs: number;
  /** How stale the landmark result was when this frame read it. */
  resultAgeMs: number;
  /** Wall time inside MediaPipe for the result being used. */
  inferenceMs: number;
  /** CPU time in the native decimate/convert pass. Always 0 on iOS. */
  decimateMs: number;
  /** Time spent in the shared TypeScript classifier this frame. */
  classifyMs: number;
  /** Whatever `latencyMs` is configured to report. */
  reportedMs: number;
}

export function createLatencyBreakdown(): LatencyBreakdown {
  'worklet';
  return {
    stateAgeMs: 0,
    pipelineMs: 0,
    resultAgeMs: 0,
    inferenceMs: 0,
    decimateMs: 0,
    classifyMs: 0,
    reportedMs: 0,
  };
}

export interface LatencyTracker {
  definition: LatencyDefinition;
  stateAge: number[];
  pipeline: number[];
  inference: number[];
  classify: number[];
  resultAge: number[];
  /** Frames the native side dropped because inference was busy. */
  droppedFrames: number;
  /** Frames processed by the classifier. */
  processedFrames: number;
  /** Frames where the native side had no landmark result yet. */
  noResultFrames: number;
  /** Cap, so a very long session cannot grow these arrays without bound. */
  maxSamples: number;
}

export function createLatencyTracker(
  definition: LatencyDefinition = 'STATE_AGE',
  maxSamples = 60000,
): LatencyTracker {
  'worklet';
  return {
    definition,
    stateAge: [],
    pipeline: [],
    inference: [],
    classify: [],
    resultAge: [],
    droppedFrames: 0,
    processedFrames: 0,
    noResultFrames: 0,
    maxSamples,
  };
}

export function resetLatencyTracker(t: LatencyTracker): void {
  'worklet';
  t.stateAge.length = 0;
  t.pipeline.length = 0;
  t.inference.length = 0;
  t.classify.length = 0;
  t.resultAge.length = 0;
  t.droppedFrames = 0;
  t.processedFrames = 0;
  t.noResultFrames = 0;
}

export function recordLatency(t: LatencyTracker, b: LatencyBreakdown): void {
  'worklet';
  t.processedFrames++;
  if (t.stateAge.length >= t.maxSamples) return;
  t.stateAge.push(b.stateAgeMs);
  t.pipeline.push(b.pipelineMs);
  t.inference.push(b.inferenceMs);
  t.classify.push(b.classifyMs);
  t.resultAge.push(b.resultAgeMs);
}

export interface Percentiles {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const EMPTY_PERCENTILES: Percentiles = {
  count: 0,
  min: NaN,
  mean: NaN,
  p50: NaN,
  p95: NaN,
  p99: NaN,
  max: NaN,
};

/**
 * Exact percentiles by nearest-rank on a sorted copy.
 *
 * Nearest-rank rather than interpolation: with thousands of millisecond samples the difference is
 * negligible, and reporting a value that actually occurred is easier to reason about when chasing
 * a spike.
 */
export function percentiles(values: readonly number[]): Percentiles {
  'worklet';
  const clean: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === v && v !== Infinity && v !== -Infinity) clean.push(v);
  }
  if (clean.length === 0) return { ...EMPTY_PERCENTILES };

  clean.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < clean.length; i++) sum += clean[i];

  const at = (q: number): number => {
    const idx = Math.ceil(q * clean.length) - 1;
    return clean[idx < 0 ? 0 : idx >= clean.length ? clean.length - 1 : idx];
  };

  return {
    count: clean.length,
    min: clean[0],
    mean: sum / clean.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: clean[clean.length - 1],
  };
}

export interface LatencyReport {
  definition: LatencyDefinition;
  endToEnd: Percentiles;
  pipeline: Percentiles;
  inference: Percentiles;
  classify: Percentiles;
  resultAge: Percentiles;
  processedFrames: number;
  droppedFrames: number;
  noResultFrames: number;
  /** Fraction of camera frames dropped because inference was busy. */
  dropRate: number;
}

export function latencyReport(t: LatencyTracker): LatencyReport {
  'worklet';
  const total = t.processedFrames + t.droppedFrames;
  return {
    definition: t.definition,
    endToEnd: percentiles(t.definition === 'STATE_AGE' ? t.stateAge : t.pipeline),
    pipeline: percentiles(t.pipeline),
    inference: percentiles(t.inference),
    classify: percentiles(t.classify),
    resultAge: percentiles(t.resultAge),
    processedFrames: t.processedFrames,
    droppedFrames: t.droppedFrames,
    noResultFrames: t.noResultFrames,
    dropRate: total > 0 ? t.droppedFrames / total : 0,
  };
}

/** Live rolling percentiles over the most recent `window` samples, for the on-screen readout. */
export function rollingPercentiles(values: readonly number[], window: number): Percentiles {
  'worklet';
  const start = values.length > window ? values.length - window : 0;
  const slice: number[] = [];
  for (let i = start; i < values.length; i++) slice.push(values[i]);
  return percentiles(slice);
}
