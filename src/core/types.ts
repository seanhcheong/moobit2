/**
 * The output data contract and its supporting types.
 *
 * Worklet-safe: types plus a couple of constants, nothing else.
 */

export type ExerciseId = 'squat' | 'pushup' | 'lunge';
export type ExerciseLabel = ExerciseId | 'unknown';
export type Side = 'left' | 'right';

/**
 * The phase vocabulary of the output contract.
 *
 * Note there is no `up`: a push-up's top state maps onto `standing`. Exercise modules carry a
 * human-readable `topPhaseLabel` for the debug overlay so the harness can still show "up"
 * without the wire format having to grow a synonym.
 */
export type Phase = 'standing' | 'descending' | 'bottom' | 'ascending';

/**
 * One event per processed frame.
 *
 * `depth` and `phase` are the primary product — they are what will eventually drive smooth
 * character animation — and `repCount` is a derived statistic.
 */
export interface RecognitionEvent {
  /** Monotonic ms timestamp of the frame this state was derived from. */
  timestamp: number;
  exercise: ExerciseLabel;
  phase: Phase;
  /** 0-100 continuous completion metric. */
  depth: number;
  /** 0-1 confidence in `exercise`. */
  confidence: number;
  repCount: number;
  /** End-to-end ms, frame capture -> classification. See `latency.ts` for what it includes. */
  latencyMs: number;
  /** Populated only when `exercise === 'lunge'`. */
  frontLeg: Side | null;
}

/**
 * Everything the debug harness shows that is not part of the wire contract.
 *
 * Kept separate so the contract stays exactly as specified while the harness still has the
 * per-signal detail needed to tune thresholds and to check the camera assumptions visually.
 */
export interface RecognitionDebug {
  /** Label for the current phase in this exercise's own vocabulary, e.g. 'up' for a push-up. */
  phaseLabel: string;
  /** Per-exercise smoothed confidence, in registry order. */
  confidences: number[];
  /** Names matching `confidences`. */
  exerciseIds: string[];
  /** The active exercise's primary signal value, unnormalised. */
  primarySignal: number;
  /** 0-1: do the active exercise's secondary signals agree with its primary? */
  corroboration: number;
  /** Why the active exercise was chosen, or why nothing was. */
  reason: string;
  /** Counters for the session summary. */
  flickers: number;
  partialReps: number;
  abandonedReps: number;
  trackingLosses: number;
  unknownFrames: number;
  /** Lunge front-leg detail: the per-signal votes, for validating the signal on device. */
  frontLegVotes: string;
}

export const PHASES: readonly Phase[] = ['standing', 'descending', 'bottom', 'ascending'];
