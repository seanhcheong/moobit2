/**
 * Wires the native pose plugin, the frame-processor worklet and the recognition pipeline together.
 *
 * ## Where the classifier runs, and why
 * The plan was to run the classifier inside the frame-processor worklet, which is the lower-latency
 * arrangement. It ships running on the JS thread instead, for one reason: executing the whole core
 * inside a worklet requires every module in its import graph to survive the worklets-core babel
 * transform, and that cannot be verified without a device. A default that silently produces no
 * skeleton would be far worse than a default that costs a few milliseconds.
 *
 * The core is already written worklet-safe — pure, import-free of platform APIs, every function
 * carrying a `'worklet'` directive — so moving it into the worklet later is a change to this file
 * alone. What makes that decision measurable rather than a guess is that the hop is *included* in
 * the reported latency (see `hopMs` below), so the readout says exactly what it costs.
 *
 * ## Two rates, on purpose
 * The pipeline sees every frame: it is the recognition path and skipping frames would corrupt rep
 * counting. React renders at ~15 fps from a ref snapshot. Re-rendering an SVG skeleton at 30 fps
 * would put the overlay's cost on the same thread as the classifier and inflate the very number
 * the harness exists to measure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrameProcessor, VisionCameraProxy } from 'react-native-vision-camera';
import { useRunOnJS } from 'react-native-worklets-core';
import type { Frame } from 'react-native-vision-camera';

import { createPipeline, type Pipeline, type PipelineConfig, type PipelineOutput } from '../../core/pipeline';
import type { NativePoseResult } from '../../core/nativeContract';
import type { RecognitionDebug, RecognitionEvent } from '../../core/types';
import type { FramingStatus } from '../../core/framing';
import type { CalibrationProgress } from '../../core/calibration';
import type { PoseView } from '../../core/geometry';
import type { LatencyBreakdown } from '../../core/latency';
import { DEFAULT_NATIVE_FRAME, type NativeFrameConfig } from '../../core/config';

/** The native plugin, initialised once. Undefined when native registration did not happen. */
const posePlugin = VisionCameraProxy.initFrameProcessorPlugin('detectPose', {});

/** A snapshot of pipeline state, copied out for rendering. */
export interface PoseSnapshot {
  event: RecognitionEvent;
  debug: RecognitionDebug;
  framing: FramingStatus;
  calibration: CalibrationProgress;
  latency: LatencyBreakdown;
  mode: string;
  /** Smoothed landmark positions in isotropic space, for the overlay. */
  u: number[];
  v: number[];
  vis: number[];
  /** Unsmoothed positions, so the filter can be tuned by eye against the smoothed skeleton. */
  rawU: number[];
  rawV: number[];
  aspect: number;
  warning: string | null;
  /** Per-second rate at which the pipeline is actually processing frames. */
  processedFps: number;
  nativeDelegate: string;
  framesDropped: number;
}

function copyView(view: PoseView, u: number[], v: number[], vis: number[]): void {
  for (let i = 0; i < 33; i++) {
    u[i] = view.u[i];
    v[i] = view.v[i];
    vis[i] = view.vis[i];
  }
}

function emptySnapshot(): PoseSnapshot {
  const zeros = () => new Array(33).fill(0);
  return {
    event: {
      timestamp: 0,
      exercise: 'unknown',
      phase: 'standing',
      depth: 0,
      confidence: 0,
      repCount: 0,
      latencyMs: 0,
      frontLeg: null,
    },
    debug: {
      phaseLabel: 'standing',
      confidences: [],
      exerciseIds: [],
      primarySignal: NaN,
      corroboration: 0,
      reason: 'starting up',
      flickers: 0,
      partialReps: 0,
      abandonedReps: 0,
      trackingLosses: 0,
      unknownFrames: 0,
      frontLegVotes: '',
    },
    framing: { inFrame: false, issues: [], hint: 'Starting camera', bodyHeightFrac: 0, centerOffset: 0 },
    calibration: { active: false, progress: 0, samples: 0, reject: null, baseline: null },
    latency: {
      stateAgeMs: 0,
      pipelineMs: 0,
      resultAgeMs: 0,
      inferenceMs: 0,
      decimateMs: 0,
      classifyMs: 0,
      hopMs: 0,
      reportedMs: 0,
    },
    mode: 'framing',
    u: zeros(),
    v: zeros(),
    vis: zeros(),
    rawU: zeros(),
    rawV: zeros(),
    aspect: 0.5625,
    warning: posePlugin ? null : 'native plugin "detectPose" is not registered',
    processedFps: 0,
    nativeDelegate: 'unknown',
    framesDropped: 0,
  };
}

export interface UsePosePipelineOptions {
  config?: Partial<PipelineConfig>;
  nativeFrame?: NativeFrameConfig;
  /** How often React re-renders from the latest snapshot, in Hz. */
  uiHz?: number;
  /** Called for every processed frame, on the JS thread. Used by the session recorder. */
  onFrame?: (out: PipelineOutput, native: NativePoseResult, hopMs: number) => void;
}

export interface UsePosePipelineResult {
  /** Pass to `<Camera frameProcessor={...} />`. */
  frameProcessor: ReturnType<typeof useFrameProcessor>;
  /** Re-rendered at `uiHz`. */
  snapshot: PoseSnapshot;
  pipeline: Pipeline;
  /** True when the native plugin registered successfully. */
  pluginAvailable: boolean;
  beginCalibration: () => void;
  resetCounters: () => void;
}

export function usePosePipeline(opts: UsePosePipelineOptions = {}): UsePosePipelineResult {
  const uiHz = opts.uiHz ?? 15;
  const nativeFrame = opts.nativeFrame ?? DEFAULT_NATIVE_FRAME;

  // Created exactly once, deliberately. The pipeline owns the filter history, the calibration
  // baseline and every rep count; rebuilding it because a config object changed identity would
  // silently reset a session mid-set. Runtime-changeable settings are pushed into
  // `pipeline.config` by the caller instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pipeline = useMemo(() => createPipeline(opts.config), []);
  const latest = useRef<PoseSnapshot>(emptySnapshot());
  const [snapshot, setSnapshot] = useState<PoseSnapshot>(latest.current);
  const dirty = useRef(false);

  // Frame-rate bookkeeping, kept out of the pipeline so it measures only itself.
  const frameCount = useRef(0);
  const fpsWindowStart = useRef(0);
  const processedFps = useRef(0);

  /**
   * Smallest observed offset between the JS wall clock and the native monotonic clock.
   *
   * The two clocks are unrelated, so the hop cannot be measured by subtracting one from the
   * other directly. Tracking the MINIMUM difference works: the smallest offset ever seen
   * corresponds to the fastest hop, which puts the floor of the estimate at ~0 and makes every
   * larger value a genuine excess delay. Wall-clock jumps only ever raise a sample, never lower
   * the tracked minimum, so a clock adjustment cannot make the estimate optimistic.
   */
  const clockOffset = useRef<number>(Number.POSITIVE_INFINITY);

  const onFrameJs = useRunOnJS((native: unknown) => {
    const result = native as NativePoseResult;
    const wallNow = Date.now();

    let hopMs = 0;
    if (result && result.ok === true && Number.isFinite(result.nowMs)) {
      const offset = wallNow - result.nowMs;
      if (offset < clockOffset.current) clockOffset.current = offset;
      hopMs = Math.max(0, offset - clockOffset.current);
    }

    const out = pipeline.processFrame(result, wallNow, hopMs);

    // FPS over a one-second window.
    frameCount.current++;
    if (fpsWindowStart.current === 0) fpsWindowStart.current = wallNow;
    else if (wallNow - fpsWindowStart.current >= 1000) {
      processedFps.current = (frameCount.current * 1000) / (wallNow - fpsWindowStart.current);
      frameCount.current = 0;
      fpsWindowStart.current = wallNow;
    }

    // The pipeline reuses one event object per frame by design, so everything is copied out.
    const s = latest.current;
    s.event = { ...out.event };
    s.debug = { ...out.debug, confidences: out.debug.confidences.slice(), exerciseIds: out.debug.exerciseIds.slice() };
    s.framing = { ...out.framing, issues: out.framing.issues.slice() };
    s.calibration = { ...out.calibration };
    s.latency = { ...out.latency };
    s.mode = out.mode;
    s.aspect = out.view.aspect > 0 ? out.view.aspect : s.aspect;
    s.warning = out.warning;
    s.processedFps = processedFps.current;
    if (out.view.valid) copyView(out.view, s.u, s.v, s.vis);
    if (out.rawView.valid) {
      for (let i = 0; i < 33; i++) {
        s.rawU[i] = out.rawView.u[i];
        s.rawV[i] = out.rawView.v[i];
      }
    }
    if (result && result.ok === true) {
      s.nativeDelegate = result.delegate;
      s.framesDropped = result.framesDropped;
    }

    dirty.current = true;
    opts.onFrame?.(out, result, hopMs);
  }, []);

  const rotationDegrees = nativeFrame.rotationDegrees;
  const targetLongEdge = nativeFrame.targetLongEdge;

  const frameProcessor = useFrameProcessor(
    (frame: Frame) => {
      'worklet';
      if (posePlugin == null) return;
      // VisionCamera's TS return type for a plugin call does not describe nested arrays, though
      // its JSI converter handles them. The cast is the boundary between the two.
      const result = posePlugin.call(frame, { rotationDegrees, targetLongEdge }) as unknown;
      if (result == null) return;
      onFrameJs(result);
    },
    [onFrameJs, rotationDegrees, targetLongEdge],
  );

  // Render from the ref at a fixed rate rather than on every frame, so overlay cost stays off the
  // recognition path.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      setSnapshot({
        ...latest.current,
        u: latest.current.u.slice(),
        v: latest.current.v.slice(),
        vis: latest.current.vis.slice(),
        rawU: latest.current.rawU.slice(),
        rawV: latest.current.rawV.slice(),
      });
    }, Math.max(16, Math.round(1000 / uiHz)));
    return () => clearInterval(interval);
  }, [uiHz]);

  const beginCalibration = useCallback(() => {
    pipeline.beginCalibration();
  }, [pipeline]);

  const resetCounters = useCallback(() => {
    pipeline.resetCounters();
    clockOffset.current = Number.POSITIVE_INFINITY;
    frameCount.current = 0;
    fpsWindowStart.current = 0;
  }, [pipeline]);

  return {
    frameProcessor,
    snapshot,
    pipeline,
    pluginAvailable: posePlugin != null,
    beginCalibration,
    resetCounters,
  };
}
