/**
 * The recognition pipeline: native landmark result -> one {@link RecognitionEvent} per frame.
 *
 * Worklet-safe, and deliberately the only place the stages are wired together:
 *
 *   fill pose view -> One Euro smoothing -> features -> framing -> calibration
 *                  -> score every registered exercise -> pick the active one -> step it
 *
 * Nothing here names a specific exercise. Adding one is a new module plus a registry entry.
 *
 * Nothing here allocates per frame either, once the pipeline exists: every buffer, view, feature
 * object and per-exercise state is created once at construction. On the frame-processor thread a
 * few hundred short-lived objects per second is exactly the kind of thing that turns into a GC
 * pause and a p99 latency spike.
 */

import {
  DEFAULT_CALIBRATION,
  baselineFromFeatures,
  cancelCalibration,
  createCalibrationState,
  startCalibration,
  stepCalibration,
  type Baseline,
  type CalibrationConfig,
  type CalibrationProgress,
  type CalibrationState,
} from './calibration';
import {
  DEFAULT_DISAMBIGUATION,
  createDisambiguationState,
  resetDisambiguation,
  stepDisambiguation,
  type DisambiguationConfig,
  type DisambiguationState,
} from './disambiguate';
import { EXERCISE_REGISTRY } from './exercises';
import type { ExerciseModule, ExerciseStepResult } from './exercise';
import {
  computeFeatures,
  createFeatureHistory,
  createFeatures,
  resetFeatureHistory,
  type FeatureHistory,
  type Features,
} from './features';
import {
  DEFAULT_FRAMING,
  checkFraming,
  createFramingStatus,
  type FramingConfig,
  type FramingStatus,
} from './framing';
import { createPoseView, fillPoseView, type PoseView } from './geometry';
import {
  createLatencyBreakdown,
  createLatencyTracker,
  recordLatency,
  resetLatencyTracker,
  type LatencyBreakdown,
  type LatencyDefinition,
  type LatencyTracker,
} from './latency';
import {
  DEFAULT_ONE_EURO,
  applyOneEuro,
  createOneEuroBank,
  resetOneEuroBank,
  setOneEuroParams,
  type OneEuroBank,
  type OneEuroParams,
} from './oneEuro';
import { hasLandmarks, type NativePoseResult } from './nativeContract';
import { toContractPhase } from './depthFsm';
import type { ExerciseLabel, RecognitionDebug, RecognitionEvent } from './types';

export type PipelineMode = 'framing' | 'calibrating' | 'running';

export interface CameraConfig {
  /**
   * Mirror `x` so the skeleton lines up with the mirrored front-camera preview.
   *
   * A flag rather than a constant because getting it backwards is the classic bug in this kind of
   * pipeline, and it is verifiable in seconds against the colour-coded overlay. It is harmless to
   * the maths: every angle here comes from an unsigned dot product and every distance from an
   * absolute difference, both invariant under reflection.
   */
  mirrorX: boolean;

  /**
   * Swap MediaPipe's anatomical left/right labels.
   *
   * Should not be needed — MediaPipe infers the subject's own sides from body appearance, so the
   * labels are already correct on an unmirrored front-camera frame. Exposed so a device that
   * disagrees can be corrected without a rebuild, and so the assumption is testable rather than
   * buried.
   */
  swapAnatomicalSides: boolean;
}

export const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  mirrorX: true,
  swapAnatomicalSides: false,
};

export interface PipelineConfig {
  camera: CameraConfig;
  filter: OneEuroParams;
  calibration: CalibrationConfig;
  framing: FramingConfig;
  disambiguation: DisambiguationConfig;
  latencyDefinition: LatencyDefinition;
  /** Move from framing straight into calibration as soon as framing is good. */
  autoCalibrate: boolean;
  /**
   * Monotonic clock in ms, used only to time the classifier itself.
   *
   * Injected because the frame-processor worklet runtime does not guarantee `performance.now`.
   * When it returns 0 the classify time is reported as 0 rather than as a fabricated number.
   */
  clock: () => number;
}

function defaultClock(): number {
  'worklet';
  const g = globalThis as any;
  if (g && g.performance && typeof g.performance.now === 'function') return g.performance.now();
  if (typeof Date !== 'undefined' && typeof Date.now === 'function') return Date.now();
  return 0;
}

export function defaultPipelineConfig(): PipelineConfig {
  'worklet';
  return {
    camera: { ...DEFAULT_CAMERA_CONFIG },
    filter: { ...DEFAULT_ONE_EURO },
    calibration: { ...DEFAULT_CALIBRATION },
    framing: { ...DEFAULT_FRAMING },
    disambiguation: { ...DEFAULT_DISAMBIGUATION },
    latencyDefinition: 'STATE_AGE',
    autoCalibrate: false,
    clock: defaultClock,
  };
}

export interface PipelineOutput {
  /** The wire contract event. Always present, even when nothing is recognised. */
  event: RecognitionEvent;
  /** Harness-only detail. */
  debug: RecognitionDebug;
  mode: PipelineMode;
  framing: FramingStatus;
  calibration: CalibrationProgress;
  latency: LatencyBreakdown;
  /** The smoothed pose, for the overlay. */
  view: PoseView;
  /** The unsmoothed pose, so the overlay can show both and the filter can be tuned by eye. */
  rawView: PoseView;
  features: Features;
  /** True on the single frame a rep completes. */
  repCompleted: boolean;
  /** Native-side warning or error, if any. */
  warning: string | null;
}

export interface Pipeline {
  readonly config: PipelineConfig;
  readonly registry: readonly ExerciseModule<any>[];
  readonly latencyTracker: LatencyTracker;
  readonly disambiguation: DisambiguationState;
  baseline: Baseline | null;
  mode: PipelineMode;

  /**
   * @param hopMs time already spent getting here from the frame-processor worklet. Zero when the
   *   classifier runs inside the worklet; see {@link LatencyBreakdown.hopMs}.
   */
  processFrame(native: NativePoseResult, wallClockMs: number, hopMs?: number): PipelineOutput;
  beginCalibration(): void;
  cancelCalibration(): void;
  /** Adopt a baseline captured earlier, e.g. when replaying a recorded session. */
  setBaseline(b: Baseline | null): void;
  /** Force a baseline from the current frame. Offline use only; skips the stillness gates. */
  forceBaselineFromCurrentFrame(wallClockMs: number): Baseline | null;
  setFilterParams(p: OneEuroParams): void;
  /** Clear rep counts, filter history and the active exercise. Keeps the baseline. */
  resetCounters(): void;
  /** Full reset, back to framing with no baseline. */
  reset(): void;
  exerciseState(index: number): any;
}

export function createPipeline(
  configIn?: Partial<PipelineConfig>,
  registry: readonly ExerciseModule<any>[] = EXERCISE_REGISTRY,
): Pipeline {
  'worklet';
  const config: PipelineConfig = { ...defaultPipelineConfig(), ...(configIn ?? {}) };

  const rawView = createPoseView();
  const view = createPoseView();
  const bank: OneEuroBank = createOneEuroBank(config.filter);
  const history: FeatureHistory = createFeatureHistory();
  const features: Features = createFeatures();
  const framing: FramingStatus = createFramingStatus();
  const calibration: CalibrationState = createCalibrationState(config.calibration);
  const disambiguation: DisambiguationState = createDisambiguationState(
    registry.length,
    config.disambiguation,
  );
  const latencyTracker: LatencyTracker = createLatencyTracker(config.latencyDefinition);
  const latency: LatencyBreakdown = createLatencyBreakdown();

  const states: any[] = [];
  for (let i = 0; i < registry.length; i++) states.push(registry[i].createState());

  const event: RecognitionEvent = {
    timestamp: 0,
    exercise: 'unknown',
    phase: 'standing',
    depth: 0,
    confidence: 0,
    repCount: 0,
    latencyMs: 0,
    frontLeg: null,
  };

  const debug: RecognitionDebug = {
    phaseLabel: 'standing',
    confidences: registry.map(() => 0),
    exerciseIds: registry.map((m) => m.id),
    primarySignal: NaN,
    corroboration: 0,
    reason: 'startup',
    flickers: 0,
    partialReps: 0,
    abandonedReps: 0,
    trackingLosses: 0,
    unknownFrames: 0,
    frontLegVotes: '',
  };

  let calProgress: CalibrationProgress = {
    active: false,
    progress: 0,
    samples: 0,
    reject: null,
    baseline: null,
  };

  const out: PipelineOutput = {
    event,
    debug,
    mode: 'framing',
    framing,
    calibration: calProgress,
    latency,
    view,
    rawView,
    features,
    repCompleted: false,
    warning: null,
  };

  const pipeline: Pipeline = {
    config,
    registry,
    latencyTracker,
    disambiguation,
    baseline: null,
    mode: 'framing',

    beginCalibration() {
      'worklet';
      pipeline.mode = 'calibrating';
      pipeline.baseline = null;
      startCalibration(calibration, features.timeSec);
      resetDisambiguation(disambiguation);
      for (let i = 0; i < registry.length; i++) registry[i].reset(states[i], 0, false);
    },

    cancelCalibration() {
      'worklet';
      cancelCalibration(calibration);
      pipeline.mode = pipeline.baseline ? 'running' : 'framing';
    },

    setBaseline(b) {
      'worklet';
      pipeline.baseline = b;
      pipeline.mode = b ? 'running' : 'framing';
    },

    forceBaselineFromCurrentFrame(wallClockMs) {
      'worklet';
      if (!features.valid) return null;
      const b = baselineFromFeatures(features, wallClockMs);
      pipeline.setBaseline(b);
      return b;
    },

    setFilterParams(p) {
      'worklet';
      setOneEuroParams(bank, p);
    },

    resetCounters() {
      'worklet';
      resetOneEuroBank(bank);
      resetFeatureHistory(history);
      resetDisambiguation(disambiguation);
      resetLatencyTracker(latencyTracker);
      for (let i = 0; i < registry.length; i++) registry[i].reset(states[i], 0, false);
      event.repCount = 0;
    },

    reset() {
      'worklet';
      pipeline.resetCounters();
      cancelCalibration(calibration);
      pipeline.baseline = null;
      pipeline.mode = 'framing';
    },

    exerciseState(index) {
      'worklet';
      return states[index];
    },

    processFrame(native, wallClockMs, hopMs = 0) {
      'worklet';
      const t0 = config.clock();

      out.warning = null;
      out.repCompleted = false;

      if (!native || native.ok !== true) {
        out.warning = native && 'error' in native ? native.error : 'no native result';
        latencyTracker.noResultFrames++;
        return finishUnknown(native ? native.nowMs : 0);
      }

      if (native.warning) out.warning = native.warning;
      latencyTracker.droppedFrames = native.framesDropped;

      if (!hasLandmarks(native)) {
        latencyTracker.noResultFrames++;
        return finishUnknown(native.nowMs);
      }

      const imageWidth = native.imageWidth ?? 0;
      const imageHeight = native.imageHeight ?? 0;
      const captureMs = native.resultCaptureMs ?? native.captureMs;
      const timeSec = captureMs / 1000;

      // ---- Stage 1: into isotropic space -----------------------------------------------------
      if (!fillPoseView(rawView, native.landmarks, imageWidth, imageHeight, config.camera.mirrorX)) {
        latencyTracker.noResultFrames++;
        return finishUnknown(native.nowMs);
      }
      if (config.camera.swapAnatomicalSides) swapSides(rawView);

      // ---- Stage 2: smoothing, before any angle maths ----------------------------------------
      applyOneEuro(bank, rawView, view, timeSec);

      // ---- Stage 3: features -----------------------------------------------------------------
      computeFeatures(view, history, timeSec, features);

      // ---- Stage 4: framing ------------------------------------------------------------------
      checkFraming(features, config.framing, view.aspect, framing);

      // ---- Stage 5: calibration --------------------------------------------------------------
      if (pipeline.mode === 'framing' && config.autoCalibrate && framing.inFrame) {
        pipeline.beginCalibration();
      }
      if (pipeline.mode === 'calibrating') {
        calProgress = stepCalibration(calibration, features, wallClockMs);
        out.calibration = calProgress;
        if (calProgress.baseline) {
          pipeline.baseline = calProgress.baseline;
          pipeline.mode = 'running';
        }
      } else {
        calProgress.active = false;
        calProgress.progress = pipeline.baseline ? 1 : 0;
        calProgress.reject = null;
        calProgress.baseline = null;
        out.calibration = calProgress;
      }

      // ---- Stage 6: classify -----------------------------------------------------------------
      let label: ExerciseLabel = 'unknown';
      let confidence = 0;
      let depth = 0;
      let frontLeg: import('./types').Side | null = null;
      let phaseLabel = 'standing';
      let primary = NaN;
      let corroboration = 0;

      const baseline = pipeline.baseline;
      if (baseline && pipeline.mode === 'running') {
        // A challenger may only take over while the incumbent is between reps.
        const activeIdx = disambiguation.activeIndex;
        const atTop =
          activeIdx < 0 ||
          (states[activeIdx] as any).fsm.phase === 'top';

        const decision = stepDisambiguation(
          disambiguation,
          registry,
          states,
          features,
          baseline,
          atTop,
        );
        label = decision.label;
        confidence = decision.confidence;
        debug.reason = decision.reason;

        for (let i = 0; i < registry.length; i++) debug.confidences[i] = disambiguation.smoothed[i];

        if (decision.index >= 0) {
          const mod = registry[decision.index];
          const m = disambiguation.measurements[decision.index];
          const res: ExerciseStepResult = mod.step(
            states[decision.index],
            features,
            baseline,
            m,
            captureMs,
          );

          depth = m.depth === m.depth ? m.depth : 0;
          primary = m.primary;
          corroboration = m.corroboration;
          frontLeg = res.frontLeg;
          phaseLabel = res.phase === 'top' ? mod.topPhaseLabel : res.phase;
          event.phase = toContractPhase(res.phase);
          out.repCompleted = res.repCompleted;

          const diag = mod.diagnostics(states[decision.index]);
          event.repCount = diag.repCount;
          debug.flickers = diag.flickers;
          debug.partialReps = diag.partialReps;
          debug.abandonedReps = diag.abandonedReps;
          debug.trackingLosses = diag.trackingLosses;
          debug.frontLegVotes = mod.describe(states[decision.index], features, baseline, m);
        } else {
          event.phase = 'standing';
          phaseLabel = 'standing';
        }
      } else {
        debug.reason = baseline ? `mode=${pipeline.mode}` : 'awaiting calibration';
        for (let i = 0; i < registry.length; i++) debug.confidences[i] = 0;
      }

      // ---- Stage 7: latency ------------------------------------------------------------------
      const t1 = config.clock();
      const classifyMs = t1 > 0 && t0 > 0 ? t1 - t0 : 0;
      const resultAtMs = native.resultAtMs ?? native.nowMs;

      latency.resultAgeMs = native.resultAgeMs ?? 0;
      latency.inferenceMs = native.inferenceMs ?? 0;
      latency.decimateMs = native.decimateMs;
      latency.classifyMs = classifyMs;
      latency.hopMs = hopMs;
      latency.pipelineMs = resultAtMs - captureMs + hopMs + classifyMs;
      latency.stateAgeMs = native.nowMs - captureMs + hopMs + classifyMs;
      latency.reportedMs =
        config.latencyDefinition === 'STATE_AGE' ? latency.stateAgeMs : latency.pipelineMs;
      recordLatency(latencyTracker, latency);

      // ---- Emit ------------------------------------------------------------------------------
      event.timestamp = captureMs;
      event.exercise = label;
      event.depth = depth;
      event.confidence = confidence;
      event.latencyMs = latency.reportedMs;
      event.frontLeg = label === 'lunge' ? frontLeg : null;

      debug.phaseLabel = phaseLabel;
      debug.primarySignal = primary;
      debug.corroboration = corroboration;
      debug.unknownFrames = disambiguation.unknownFrames;

      out.mode = pipeline.mode;
      return out;
    },
  };

  /** Emit a well-formed "nothing recognised" event so downstream code never sees a gap. */
  function finishUnknown(nowMs: number): PipelineOutput {
    'worklet';
    features.valid = false;
    framing.inFrame = false;
    framing.issues.length = 0;
    framing.issues.push('no-person');
    framing.hint = 'Stand in front of the camera';

    event.timestamp = nowMs;
    event.exercise = 'unknown';
    event.phase = 'standing';
    event.depth = 0;
    event.confidence = 0;
    event.latencyMs = 0;
    event.frontLeg = null;

    debug.phaseLabel = 'standing';
    debug.primarySignal = NaN;
    debug.corroboration = 0;
    debug.reason = out.warning ?? 'no landmarks';
    for (let i = 0; i < registry.length; i++) debug.confidences[i] = 0;

    out.mode = pipeline.mode;
    out.repCompleted = false;
    return out;
  }

  return pipeline;
}

/**
 * Swap the left/right halves of every paired landmark.
 *
 * The escape hatch for {@link CameraConfig.swapAnatomicalSides}. Only the landmarks the core
 * actually reads are swapped; the decorative ones would only cost time.
 */
function swapSides(v: PoseView): void {
  'worklet';
  const pairs = [
    [11, 12],
    [13, 14],
    [15, 16],
    [23, 24],
    [25, 26],
    [27, 28],
    [29, 30],
    [31, 32],
    [7, 8],
  ];
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i][0];
    const b = pairs[i][1];
    let t = v.u[a];
    v.u[a] = v.u[b];
    v.u[b] = t;
    t = v.v[a];
    v.v[a] = v.v[b];
    v.v[b] = t;
    t = v.z[a];
    v.z[a] = v.z[b];
    v.z[b] = t;
    t = v.vis[a];
    v.vis[a] = v.vis[b];
    v.vis[b] = t;
  }
}
