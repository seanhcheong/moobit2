/**
 * The exercise-module interface and the registry the pipeline iterates over.
 *
 * Worklet-safe.
 *
 * ## Adding an exercise
 * A new exercise is a new file exporting one {@link ExerciseModule} plus one entry in the
 * registry array in `exercises/index.ts`. Nothing in the pipeline
 * (frame -> landmarks -> smoothing -> features -> score every module -> pick the best -> step it)
 * changes. Concretely, a new module must supply:
 *
 *   - `measure`: turn features into a 0-100 depth, its rate of change, and a corroboration score
 *   - `score`:   a 0-1 per-frame likelihood that this is the exercise being performed
 *   - `step`:    advance its own state machine (most exercises just delegate to `stepDepthFsm`)
 *   - `config`:  its own thresholds, so no tunable value lives in shared code
 *
 * ## Where this interface does NOT generalize — stated plainly
 * `step` being part of the interface means an exercise is free to use a different state machine,
 * so an isometric hold like a plank can supply a hold-and-timer machine instead of the
 * reciprocating one. The interface survives that.
 *
 * What does *not* survive is the output contract's `phase` enum:
 * `standing | descending | bottom | ascending` describes a reciprocating movement and has no
 * vocabulary for "holding". A plank would have to report `bottom` for its entire duration, which
 * is not false but is not useful either. The named extension point for that is
 * {@link RecognitionDebug.phaseLabel}, which already carries exercise-specific phase names for
 * the harness; a plank would need the wire contract itself to gain a fifth phase, and that is a
 * contract change rather than something a module can paper over. Likewise `depth` means "progress
 * through a rep" here, whereas for a plank the natural meaning is "quality of the hold" — same
 * range, different semantics, and worth deciding deliberately rather than by accident.
 *
 * Jumping jacks, high knees and bicep curls are all reciprocating and need no such change.
 */

import type { Baseline } from './calibration';
import type { Features } from './features';
import {
  DEFAULT_DEPTH_FSM,
  createDepthFsmState,
  resetDepthFsm,
  stepDepthFsm,
  type DepthFsmConfig,
  type DepthFsmResult,
  type DepthFsmState,
  type FsmPhase,
} from './depthFsm';
import type { ExerciseId, Side } from './types';

// ---------------------------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------------------------

/**
 * Visibility an exercise needs before its signals can be trusted.
 *
 * Per-exercise rather than global specifically because of the push-up: from a floor-level camera
 * the feet sit behind the body and their visibility collapses. A single global ankle gate would
 * make the pipeline drop out on exactly the exercise that most needs to keep working, so a
 * push-up declares that it does not require ankles at all.
 */
export interface ExerciseGates {
  minCoreVisibility: number;
  minAnkleVisibility: number;
  minKneeVisibility: number;
  minWristVisibility: number;
  minElbowVisibility: number;
}

export const PERMISSIVE_GATES: ExerciseGates = {
  minCoreVisibility: 0.5,
  minAnkleVisibility: 0,
  minKneeVisibility: 0,
  minWristVisibility: 0,
  minElbowVisibility: 0,
};

export function gatesSatisfied(f: Features, g: ExerciseGates): boolean {
  'worklet';
  return (
    f.visCore >= g.minCoreVisibility &&
    f.visAnkles >= g.minAnkleVisibility &&
    f.visKnees >= g.minKneeVisibility &&
    f.visWrists >= g.minWristVisibility &&
    f.visElbows >= g.minElbowVisibility
  );
}

// ---------------------------------------------------------------------------------------------
// Measurement and scoring
// ---------------------------------------------------------------------------------------------

export interface ExerciseMeasurement {
  /** 0-100, or NaN when this exercise cannot measure depth from this frame. */
  depth: number;
  /** Rate of change of `depth`, in units per second. */
  depthVel: number;
  /** The unnormalised primary signal, carried through for logging and threshold tuning. */
  primary: number;
  /**
   * 0-1: how well the secondary signals agree with the primary one.
   *
   * The brief's "secondary validation" requirement lives here. A squat's hip angle must move with
   * its knee angle; a push-up's torso must stay rigid. Corroboration feeds the confidence score
   * rather than hard-gating depth, so a single noisy secondary signal degrades confidence
   * instead of blanking the animation stream.
   */
  corroboration: number;
}

export function createMeasurement(): ExerciseMeasurement {
  'worklet';
  return { depth: NaN, depthVel: 0, primary: NaN, corroboration: 0 };
}

/** One contributing term in a confidence score, kept for the debug overlay. */
export interface ScoreTerm {
  name: string;
  /** The raw feature value that produced this term. */
  value: number;
  /** 0-1 sub-score. */
  score: number;
  weight: number;
}

export interface ExerciseScore {
  /** 0-1 raw, unsmoothed per-frame likelihood. */
  confidence: number;
  /** Non-null when a veto forced the confidence to zero, naming which one. */
  veto: string | null;
  terms: ScoreTerm[];
}

export function createScore(): ExerciseScore {
  'worklet';
  return { confidence: 0, veto: null, terms: [] };
}

/**
 * Score a value by how close it is to `target`, reaching 0 at `tolerance` away.
 *
 * Triangular rather than Gaussian: it is cheaper, it reaches exactly zero at a stated distance
 * (so "outside tolerance contributes nothing" is literally true), and the tolerance is a number
 * a human can reason about while tuning.
 */
export function nearness(value: number, target: number, tolerance: number): number {
  'worklet';
  if (value !== value || tolerance <= 0) return 0;
  const d = Math.abs(value - target) / tolerance;
  return d >= 1 ? 0 : 1 - d;
}

/** Score a value as "at least `lo`", ramping from 0 at `lo` to 1 at `hi`. */
export function atLeast(value: number, lo: number, hi: number): number {
  'worklet';
  if (value !== value) return 0;
  if (hi <= lo) return value >= hi ? 1 : 0;
  const t = (value - lo) / (hi - lo);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Score a value as "at most `hi`", ramping from 1 at `lo` to 0 at `hi`. */
export function atMost(value: number, lo: number, hi: number): number {
  'worklet';
  if (value !== value) return 0;
  if (hi <= lo) return value <= lo ? 1 : 0;
  const t = (hi - value) / (hi - lo);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Weighted mean of the terms, ignoring terms whose feature was unmeasurable. */
export function combineTerms(terms: readonly ScoreTerm[]): number {
  'worklet';
  let num = 0;
  let den = 0;
  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    if (t.value !== t.value) continue;
    num += t.score * t.weight;
    den += t.weight;
  }
  return den <= 0 ? 0 : num / den;
}

// ---------------------------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------------------------

export interface ExerciseStepResult {
  phase: FsmPhase;
  repCompleted: boolean;
  partialRejected: boolean;
  /** Only meaningful for exercises that track a leading side. */
  frontLeg: Side | null;
  completedPeakDepth: number;
  completedDurationMs: number;
}

export interface ExerciseDiagnostics {
  repCount: number;
  partialReps: number;
  abandonedReps: number;
  flickers: number;
  trackingLosses: number;
}

/** State every reciprocating exercise shares. Modules may extend it. */
export interface ReciprocatingState {
  fsm: DepthFsmState;
  lastDepth: number;
  lastDepthTimeSec: number;
  depthPrimed: boolean;
}

export function createReciprocatingState(): ReciprocatingState {
  'worklet';
  return { fsm: createDepthFsmState(), lastDepth: NaN, lastDepthTimeSec: 0, depthPrimed: false };
}

export function resetReciprocatingState(
  s: ReciprocatingState,
  nowMs: number,
  keepCount: boolean,
): void {
  'worklet';
  resetDepthFsm(s.fsm, nowMs, keepCount);
  s.lastDepth = NaN;
  s.lastDepthTimeSec = 0;
  s.depthPrimed = false;
}

/**
 * Differentiate depth against real elapsed time, updating the module's history.
 *
 * Kept here rather than in each module so every exercise gets identical velocity semantics —
 * and so the frame-drop handling (a gap resets rather than producing a huge spurious velocity)
 * is written once.
 */
export function depthVelocity(
  s: ReciprocatingState,
  depth: number,
  timeSec: number,
  maxGapSec: number,
): number {
  'worklet';
  if (depth !== depth) {
    s.depthPrimed = false;
    return 0;
  }
  let vel = 0;
  const dt = timeSec - s.lastDepthTimeSec;
  if (s.depthPrimed && dt > 0 && dt <= maxGapSec && s.lastDepth === s.lastDepth) {
    vel = (depth - s.lastDepth) / dt;
  }
  s.lastDepth = depth;
  s.lastDepthTimeSec = timeSec;
  s.depthPrimed = true;
  return vel;
}

/** The default `step` for a reciprocating exercise: delegate straight to the shared machine. */
export function stepReciprocating(
  s: ReciprocatingState,
  cfg: DepthFsmConfig,
  m: ExerciseMeasurement,
  nowMs: number,
): ExerciseStepResult {
  'worklet';
  const r: DepthFsmResult = stepDepthFsm(s.fsm, cfg, m.depth, m.depthVel, nowMs);
  return {
    phase: r.phase,
    repCompleted: r.repCompleted,
    partialRejected: r.partialRejected,
    frontLeg: null,
    completedPeakDepth: r.completedPeakDepth,
    completedDurationMs: r.completedDurationMs,
  };
}

export function diagnosticsOf(s: ReciprocatingState): ExerciseDiagnostics {
  'worklet';
  return {
    repCount: s.fsm.repCount,
    partialReps: s.fsm.partialReps,
    abandonedReps: s.fsm.abandonedReps,
    flickers: s.fsm.flickers,
    trackingLosses: s.fsm.trackingLosses,
  };
}

// ---------------------------------------------------------------------------------------------
// The module interface
// ---------------------------------------------------------------------------------------------

export interface ExerciseModule<S = unknown> {
  readonly id: ExerciseId;
  readonly displayName: string;

  /**
   * What to call the top phase in the debug overlay: 'standing' for a squat, 'up' for a push-up.
   * The wire contract always reports `standing`.
   */
  readonly topPhaseLabel: string;

  /** Landmarks this exercise reads. Declared so the harness can highlight them. */
  readonly requiredLandmarks: readonly number[];

  /** Visibility this exercise needs; see {@link ExerciseGates}. */
  readonly gates: ExerciseGates;

  /**
   * Which calibration metrics this exercise depends on.
   *
   * Documentation-as-data: it makes the coupling between a module and the calibration step
   * explicit, so adding an exercise that needs a new baseline metric is a visible change rather
   * than a silent read of an undefined field.
   */
  readonly calibrationMetrics: readonly string[];

  /** All tunable thresholds for this exercise, owned here and nowhere else. */
  readonly config: { readonly fsm: DepthFsmConfig } & Readonly<Record<string, unknown>>;

  createState(): S;
  reset(state: S, nowMs: number, keepCount: boolean): void;

  /** Turn features into depth. Called every frame for every module, active or not. */
  measure(state: S, f: Features, b: Baseline, out: ExerciseMeasurement): void;

  /** Per-frame likelihood. Called every frame for every module. */
  score(state: S, f: Features, b: Baseline, m: ExerciseMeasurement, out: ExerciseScore): void;

  /** Advance this exercise's state machine. Called only for the active exercise. */
  step(state: S, f: Features, b: Baseline, m: ExerciseMeasurement, nowMs: number): ExerciseStepResult;

  diagnostics(state: S): ExerciseDiagnostics;

  /** Human-readable per-signal detail for the debug overlay. */
  describe(state: S, f: Features, b: Baseline, m: ExerciseMeasurement): string;
}

export { DEFAULT_DEPTH_FSM };
export type { DepthFsmConfig, FsmPhase };
