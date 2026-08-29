/**
 * Exercise disambiguation: which of the registered exercises is being performed right now.
 *
 * Worklet-safe.
 *
 * ## The governing preference
 * The brief is explicit that flicker between `unknown` and a correct label is preferable to
 * flicker between two wrong labels. Three mechanisms enforce that:
 *
 *   1. **Temporal smoothing.** Confidences are EMA-filtered, so a single odd frame cannot win.
 *   2. **A commit margin.** Becoming active requires not just the highest confidence but a clear
 *      lead over the runner-up, sustained for several frames. When two exercises are close, the
 *      result is `unknown` rather than a coin toss.
 *   3. **No switching mid-rep.** Once an exercise is active, a challenger can only take over
 *      while the incumbent's state machine is at the top of its movement. Swapping labels
 *      half-way down a squat would corrupt both the rep count and the animation stream, and a
 *      person cannot in fact change exercise mid-descent.
 *
 * The switch margin is deliberately larger than the commit margin: leaving a known-good state
 * should be harder than entering one from nothing.
 */

import type { Baseline } from './calibration';
import type { Features } from './features';
import {
  createMeasurement,
  createScore,
  type ExerciseMeasurement,
  type ExerciseModule,
  type ExerciseScore,
} from './exercise';
import type { ExerciseId, ExerciseLabel } from './types';

export interface DisambiguationConfig {
  /** Time constant of the confidence EMA, in seconds. */
  smoothingTauSec: number;

  /** Smoothed confidence required to commit from `unknown`. */
  commitThreshold: number;
  /** Lead over the runner-up required to commit. */
  commitMargin: number;
  /** Consecutive frames both commit conditions must hold. */
  commitFrames: number;

  /** Lead a challenger needs over the incumbent to take over. Larger than `commitMargin`. */
  switchMargin: number;
  /** Consecutive frames the challenger's lead must hold. */
  switchFrames: number;

  /** Below this the active exercise starts losing the label. */
  dropThreshold: number;
  /** Consecutive frames below `dropThreshold` before dropping to `unknown`. */
  dropFrames: number;

  /**
   * Consecutive vetoed frames before dropping the label. Much shorter than `dropFrames`.
   *
   * A veto is not a low score, it is a statement that this exercise is geometrically impossible
   * right now — the body is horizontal, or the feet are half a metre apart. Making that wait as
   * long as a merely weak score does costs a third of a second of holding a label that is already
   * known to be wrong, and that is long enough to swallow the start of the real exercise's rep.
   */
  vetoDropFrames: number;
}

export const DEFAULT_DISAMBIGUATION: DisambiguationConfig = {
  smoothingTauSec: 0.25,
  commitThreshold: 0.55,
  commitMargin: 0.12,
  commitFrames: 4,
  switchMargin: 0.25,
  switchFrames: 8,
  dropThreshold: 0.35,
  dropFrames: 10,
  vetoDropFrames: 3,
};

export interface DisambiguationState {
  config: DisambiguationConfig;
  /** Smoothed confidence per registered exercise, in registry order. */
  smoothed: number[];
  /** Raw confidence per registered exercise. */
  raw: number[];
  /** Veto reason per registered exercise, or null. */
  vetoes: (string | null)[];
  /** Reusable measurement and score objects, one per exercise — nothing allocated per frame. */
  measurements: ExerciseMeasurement[];
  scores: ExerciseScore[];

  /** Index into the registry, or -1 for `unknown`. */
  activeIndex: number;
  candidateIndex: number;
  candidateFrames: number;
  dropCounter: number;
  primed: boolean;
  lastTimeSec: number;

  /** Frames spent reporting `unknown`, for the session summary. */
  unknownFrames: number;
  /** How many times the active label changed, for the session summary. */
  labelSwitches: number;

  reason: string;
}

export function createDisambiguationState(
  exerciseCount: number,
  config: DisambiguationConfig = DEFAULT_DISAMBIGUATION,
): DisambiguationState {
  'worklet';
  const smoothed: number[] = [];
  const raw: number[] = [];
  const vetoes: (string | null)[] = [];
  const measurements: ExerciseMeasurement[] = [];
  const scores: ExerciseScore[] = [];
  for (let i = 0; i < exerciseCount; i++) {
    smoothed.push(0);
    raw.push(0);
    vetoes.push(null);
    measurements.push(createMeasurement());
    scores.push(createScore());
  }
  return {
    config,
    smoothed,
    raw,
    vetoes,
    measurements,
    scores,
    activeIndex: -1,
    candidateIndex: -1,
    candidateFrames: 0,
    dropCounter: 0,
    primed: false,
    lastTimeSec: 0,
    unknownFrames: 0,
    labelSwitches: 0,
    reason: 'startup',
  };
}

export function resetDisambiguation(s: DisambiguationState): void {
  'worklet';
  for (let i = 0; i < s.smoothed.length; i++) {
    s.smoothed[i] = 0;
    s.raw[i] = 0;
    s.vetoes[i] = null;
  }
  s.activeIndex = -1;
  s.candidateIndex = -1;
  s.candidateFrames = 0;
  s.dropCounter = 0;
  s.primed = false;
  s.unknownFrames = 0;
  s.labelSwitches = 0;
  s.reason = 'reset';
}

export interface DisambiguationResult {
  label: ExerciseLabel;
  /** Index into the registry, or -1. */
  index: number;
  /** Smoothed confidence of the active exercise, or the best confidence when unknown. */
  confidence: number;
  reason: string;
}

/**
 * Score every registered exercise and decide which is active.
 *
 * @param atTop true when the currently active exercise's state machine is at the top of its
 *   movement. Only then may a challenger take over.
 */
export function stepDisambiguation(
  s: DisambiguationState,
  registry: readonly ExerciseModule<any>[],
  states: any[],
  f: Features,
  b: Baseline,
  atTop: boolean,
): DisambiguationResult {
  'worklet';
  const cfg = s.config;

  // ---- Measure and score every module ------------------------------------------------------
  for (let i = 0; i < registry.length; i++) {
    const mod = registry[i];
    mod.measure(states[i], f, b, s.measurements[i]);
    mod.score(states[i], f, b, s.measurements[i], s.scores[i]);
    s.raw[i] = s.scores[i].confidence;
    s.vetoes[i] = s.scores[i].veto;
  }

  // ---- Smooth ------------------------------------------------------------------------------
  const dt = s.primed ? f.timeSec - s.lastTimeSec : 0;
  if (!s.primed || dt <= 0 || dt > 0.5) {
    for (let i = 0; i < registry.length; i++) s.smoothed[i] = s.raw[i];
    s.primed = true;
  } else {
    const alpha = dt / (cfg.smoothingTauSec + dt);
    for (let i = 0; i < registry.length; i++) {
      s.smoothed[i] += alpha * (s.raw[i] - s.smoothed[i]);
    }
  }
  s.lastTimeSec = f.timeSec;

  // ---- Rank --------------------------------------------------------------------------------
  let best = -1;
  let bestVal = -1;
  let secondVal = -1;
  for (let i = 0; i < registry.length; i++) {
    const v = s.smoothed[i];
    if (v > bestVal) {
      secondVal = bestVal;
      bestVal = v;
      best = i;
    } else if (v > secondVal) {
      secondVal = v;
    }
  }
  if (secondVal < 0) secondVal = 0;

  // ---- Decide ------------------------------------------------------------------------------
  if (s.activeIndex < 0) {
    // Currently unknown: commit only on a clear, sustained lead.
    const eligible = best >= 0 && bestVal >= cfg.commitThreshold && bestVal - secondVal >= cfg.commitMargin;
    if (eligible) {
      if (s.candidateIndex === best) s.candidateFrames++;
      else {
        s.candidateIndex = best;
        s.candidateFrames = 1;
      }
      if (s.candidateFrames >= cfg.commitFrames) {
        s.activeIndex = best;
        s.candidateIndex = -1;
        s.candidateFrames = 0;
        s.dropCounter = 0;
        s.labelSwitches++;
        s.reason = `committed to ${registry[best].id} (conf ${bestVal.toFixed(2)}, lead ${(bestVal - secondVal).toFixed(2)})`;
      } else {
        s.reason = `holding ${registry[best].id} ${s.candidateFrames}/${cfg.commitFrames}`;
      }
    } else {
      s.candidateIndex = -1;
      s.candidateFrames = 0;
      s.reason =
        best < 0
          ? 'no candidate'
          : bestVal < cfg.commitThreshold
            ? `best ${registry[best].id} only ${bestVal.toFixed(2)} < ${cfg.commitThreshold}`
            : `${registry[best].id} lead ${(bestVal - secondVal).toFixed(2)} < ${cfg.commitMargin}`;
    }
  } else {
    const activeVal = s.smoothed[s.activeIndex];
    const activeVeto = s.vetoes[s.activeIndex];

    // Losing the label entirely. A veto short-circuits the patience, since the incumbent has
    // declared itself geometrically impossible rather than merely uncertain.
    if (activeVeto !== null || activeVal < cfg.dropThreshold) {
      const limit = activeVeto !== null ? cfg.vetoDropFrames : cfg.dropFrames;
      s.dropCounter++;
      if (s.dropCounter >= limit) {
        s.reason =
          activeVeto !== null
            ? `dropped ${registry[s.activeIndex].id} (veto: ${activeVeto})`
            : `dropped ${registry[s.activeIndex].id} (conf ${activeVal.toFixed(2)})`;
        s.activeIndex = -1;
        s.candidateIndex = -1;
        s.candidateFrames = 0;
        s.dropCounter = 0;
      } else {
        s.reason =
          activeVeto !== null
            ? `${registry[s.activeIndex].id} vetoed (${activeVeto}) ${s.dropCounter}/${limit}`
            : `${registry[s.activeIndex].id} weak ${s.dropCounter}/${limit}`;
      }
    } else {
      s.dropCounter = 0;

      // A challenger may only take over between reps.
      if (best >= 0 && best !== s.activeIndex && bestVal - activeVal >= cfg.switchMargin) {
        if (s.candidateIndex === best) s.candidateFrames++;
        else {
          s.candidateIndex = best;
          s.candidateFrames = 1;
        }
        if (s.candidateFrames >= cfg.switchFrames && atTop) {
          s.reason = `switched ${registry[s.activeIndex].id} -> ${registry[best].id}`;
          s.activeIndex = best;
          s.candidateIndex = -1;
          s.candidateFrames = 0;
          s.labelSwitches++;
        } else if (!atTop) {
          s.reason = `${registry[best].id} leads but ${registry[s.activeIndex].id} is mid-rep`;
        } else {
          s.reason = `challenger ${registry[best].id} ${s.candidateFrames}/${cfg.switchFrames}`;
        }
      } else {
        s.candidateIndex = -1;
        s.candidateFrames = 0;
        s.reason = `${registry[s.activeIndex].id} active (conf ${activeVal.toFixed(2)})`;
      }
    }
  }

  if (s.activeIndex < 0) {
    s.unknownFrames++;
    return {
      label: 'unknown',
      index: -1,
      confidence: bestVal < 0 ? 0 : bestVal,
      reason: s.reason,
    };
  }

  return {
    label: registry[s.activeIndex].id as ExerciseId,
    index: s.activeIndex,
    confidence: s.smoothed[s.activeIndex],
    reason: s.reason,
  };
}
