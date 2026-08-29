/**
 * Offline pipeline runner: drives the real recognition pipeline over synthetic or recorded frames.
 *
 * This is the verification harness. It runs exactly the code that runs on the device — same
 * smoothing, same features, same state machines, same disambiguation — so a rep count asserted
 * here is a rep count the phone would produce from the same landmarks.
 *
 * What it cannot verify is anything about the *landmarks themselves*: MediaPipe's real accuracy,
 * its failure modes, real jitter statistics. Those need a device.
 */

import { createPipeline, type Pipeline, type PipelineConfig } from '../core/pipeline';
import { latencyReport, type LatencyReport } from '../core/latency';
import type { NativePoseOk } from '../core/nativeContract';
import type { RecognitionEvent, Side } from '../core/types';
import { alternationRate } from '../core/exercises';
import type { LungeState } from '../core/exercises/lunge';
import { generateSession, type SynthFrame, type SynthSessionSpec } from './synthExercises';

/**
 * Wrap a frame of landmarks in the native contract.
 *
 * `inferenceMs` models the async LIVE_STREAM lag: the result the pipeline reads describes a frame
 * captured `inferenceMs` ago. Setting it non-zero is what keeps the offline runs honest about the
 * staleness the real pipeline has to live with.
 */
export function toNativeResult(
  flat: number[],
  imageWidth: number,
  imageHeight: number,
  captureMs: number,
  opts?: { inferenceMs?: number; readDelayMs?: number; framesDropped?: number },
): NativePoseOk {
  const inferenceMs = opts?.inferenceMs ?? 12;
  const readDelayMs = opts?.readDelayMs ?? 2;
  const resultAtMs = captureMs + inferenceMs;
  const nowMs = resultAtMs + readDelayMs;
  return {
    ok: true,
    nowMs,
    captureMs,
    captureClock: 'ELAPSED_REALTIME',
    rotationDegrees: 0,
    frameMirrored: true,
    decimateMs: 1.2,
    decimateStep: 4,
    submitted: true,
    delegate: 'GPU',
    framesSubmitted: 1,
    framesDropped: opts?.framesDropped ?? 0,
    hasResult: true,
    personDetected: true,
    landmarks: flat,
    landmarkCount: 33,
    imageWidth,
    imageHeight,
    frameId: Math.round(captureMs),
    resultCaptureMs: captureMs,
    resultAtMs,
    inferenceMs,
    resultAgeMs: nowMs - resultAtMs,
  };
}

export interface RunResult {
  events: RecognitionEvent[];
  /** Ground truth alongside each event, when the frames carried it. */
  truth: (SynthFrame['truth'] | null)[];
  /** Rep count per exercise id at the end of the run. */
  repCounts: Record<string, number>;
  /** Front-leg label per completed lunge rep, in order. */
  frontLegs: Side[];
  /** Fraction of consecutive lunge reps whose front leg alternates. */
  alternation: number;
  /** Frames the pipeline reported as `unknown` while a baseline was in force. */
  unknownFrames: number;
  /** Phase-transition chatter, summed across exercises. */
  flickers: number;
  partialReps: number;
  latency: LatencyReport;
  /** Distinct exercise labels seen, in order of first appearance. */
  labelSequence: string[];
  pipeline: Pipeline;
}

export interface RunOptions {
  config?: Partial<PipelineConfig>;
  /**
   * Force the baseline from the frame at this time (seconds) instead of running the stillness
   * capture. Defaults to running the real calibration, which is what a session does.
   */
  forceBaselineAtSec?: number;
  /** Simulated MediaPipe inference time, in ms. */
  inferenceMs?: number;
  /** Called after every frame, for debugging a specific run. */
  onFrame?: (event: RecognitionEvent, frame: SynthFrame, pipeline: Pipeline) => void;
}

export function runFrames(frames: SynthFrame[], opts: RunOptions = {}): RunResult {
  const pipeline = createPipeline({
    // Deterministic and zero-cost: the offline runs must not have their classify timings polluted
    // by whatever the host machine is doing.
    clock: () => 0,
    autoCalibrate: opts.forceBaselineAtSec === undefined,
    ...(opts.config ?? {}),
  });

  const events: RecognitionEvent[] = [];
  const truth: (SynthFrame['truth'] | null)[] = [];
  const labelSequence: string[] = [];
  const frontLegs: Side[] = [];
  let forced = false;

  for (const frame of frames) {
    const native = toNativeResult(
      frame.flat,
      frame.imageWidth,
      frame.imageHeight,
      frame.timeMs,
      { inferenceMs: opts.inferenceMs ?? 12 },
    );

    const out = pipeline.processFrame(native, frame.timeMs);

    if (
      !forced &&
      opts.forceBaselineAtSec !== undefined &&
      frame.timeMs / 1000 >= opts.forceBaselineAtSec
    ) {
      pipeline.forceBaselineFromCurrentFrame(frame.timeMs);
      forced = true;
    }

    // Copy: the pipeline reuses one event object per frame by design.
    const e: RecognitionEvent = { ...out.event };
    events.push(e);
    truth.push(frame.truth ?? null);

    if (labelSequence.length === 0 || labelSequence[labelSequence.length - 1] !== e.exercise) {
      labelSequence.push(e.exercise);
    }
    if (out.repCompleted && e.exercise === 'lunge' && e.frontLeg) frontLegs.push(e.frontLeg);

    opts.onFrame?.(e, frame, pipeline);
  }

  const repCounts: Record<string, number> = {};
  let flickers = 0;
  let partialReps = 0;
  for (let i = 0; i < pipeline.registry.length; i++) {
    const mod = pipeline.registry[i];
    const diag = mod.diagnostics(pipeline.exerciseState(i));
    repCounts[mod.id] = diag.repCount;
    flickers += diag.flickers;
    partialReps += diag.partialReps;
  }

  const lungeIdx = pipeline.registry.findIndex((m) => m.id === 'lunge');
  const lungeState = lungeIdx >= 0 ? (pipeline.exerciseState(lungeIdx) as LungeState) : null;
  const history = lungeState ? lungeState.legHistory : [];

  return {
    events,
    truth,
    repCounts,
    frontLegs,
    alternation: alternationRate(history),
    unknownFrames: pipeline.disambiguation.unknownFrames,
    flickers,
    partialReps,
    latency: latencyReport(pipeline.latencyTracker),
    labelSequence,
    pipeline,
  };
}

/** Generate a synthetic session and run it in one call. */
export function runSynth(spec: SynthSessionSpec, opts: RunOptions = {}): RunResult {
  return runFrames(generateSession(spec), opts);
}

/**
 * Splice several sessions into one continuous timeline.
 *
 * Needed to test the disambiguation switch rules: a user who squats, then drops to the floor for
 * push-ups, then stands up for lunges is the case where a label can plausibly get stuck or flip
 * mid-rep, and it cannot be produced by a single-exercise generator.
 */
export function concatSessions(specs: SynthSessionSpec[], fps = 30): SynthFrame[] {
  const out: SynthFrame[] = [];
  let offsetMs = 0;
  for (const spec of specs) {
    const frames = generateSession({ ...spec, fps });
    for (const f of frames) out.push({ ...f, timeMs: f.timeMs + offsetMs });
    if (frames.length > 0) offsetMs = out[out.length - 1].timeMs + 1000 / fps;
  }
  return out;
}

/**
 * Collapse visibility on a set of landmarks over a time window, to emulate tracking loss.
 *
 * Mutates the frames in place and returns them.
 */
export function injectTrackingLoss(
  frames: SynthFrame[],
  fromSec: number,
  toSec: number,
  landmarks: readonly number[],
  visibility = 0.05,
): SynthFrame[] {
  for (const f of frames) {
    const t = f.timeMs / 1000;
    if (t < fromSec || t > toSec) continue;
    for (const lm of landmarks) f.flat[lm * 4 + 3] = visibility;
  }
  return frames;
}

/** Drop every Nth frame, to emulate the camera or inference falling behind. */
export function decimateFrames(frames: SynthFrame[], keepEvery: number): SynthFrame[] {
  return frames.filter((_, i) => i % keepEvery === 0);
}

/**
 * Ordered phase transitions of a run, for asserting the state machine visits states in order.
 *
 * Only frames of the given exercise are considered, so an `unknown` gap does not fabricate a
 * transition.
 */
export function phaseSequence(events: readonly RecognitionEvent[], exercise: string): string[] {
  const seq: string[] = [];
  for (const e of events) {
    if (e.exercise !== exercise) continue;
    if (seq.length === 0 || seq[seq.length - 1] !== e.phase) seq.push(e.phase);
  }
  return seq;
}

/** Peak reported depth while the given exercise was active. */
export function peakDepth(events: readonly RecognitionEvent[], exercise: string): number {
  let peak = 0;
  for (const e of events) {
    if (e.exercise === exercise && e.depth > peak) peak = e.depth;
  }
  return peak;
}

/**
 * Correlation between reported depth and the generator's ground-truth depth.
 *
 * The single most informative number about whether a depth metric is fit to drive animation: a
 * high rep count with a poorly correlated depth curve would still animate badly.
 */
export function depthCorrelation(result: RunResult, exercise: string): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < result.events.length; i++) {
    const e = result.events[i];
    const t = result.truth[i];
    if (!t || e.exercise !== exercise) continue;
    xs.push(t.depth * 100);
    ys.push(e.depth);
  }
  if (xs.length < 8) return NaN;

  let mx = 0;
  let my = 0;
  for (let i = 0; i < xs.length; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= xs.length;
  my /= ys.length;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx <= 0 || dy <= 0 ? NaN : num / Math.sqrt(dx * dy);
}
