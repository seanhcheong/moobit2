/**
 * The shared reciprocating state machine: `top -> descending -> bottom -> ascending -> top`.
 *
 * Worklet-safe.
 *
 * ## Thresholds live in the normalized depth domain, not in angle space
 * Every exercise converts its own primary signal into a 0-100 `depth` before reaching this
 * module, so the transition thresholds here are dimensionless and identical for all exercises.
 * That is what makes them portable: a threshold in degrees would have to be re-derived for each
 * body and each camera tilt (measurements put that variation at +/-17% across body heights),
 * whereas "60% of the way down" means the same thing to everyone. It is also what makes adding
 * a new exercise cheap — a new module supplies a depth function and inherits this whole machine.
 *
 * ## Hysteresis is asymmetric on purpose
 * Dwell debouncing is applied only to transitions that REVERSE direction, never to forward
 * progress. Chatter only happens at a reversal, and `depth`/`phase` are meant to drive character
 * animation: delaying the entry to `bottom` by 120 ms to debounce something that was not going
 * to chatter anyway would show up as a visibly late animation.
 */

export type FsmPhase = 'top' | 'descending' | 'bottom' | 'ascending';

export interface DepthFsmConfig {
  /** Depth at or below which the movement counts as back at the top. */
  topDepth: number;
  /** Depth that must be exceeded to leave the top. The gap to `topDepth` is the dead band. */
  enterDescendDepth: number;
  /** Depth at or above which the movement counts as bottomed out. */
  enterBottomDepth: number;
  /** Depth below which a bottomed-out movement counts as rising again. */
  exitBottomDepth: number;

  /**
   * Peak depth a rep must reach to be counted.
   *
   * Deliberately higher than `enterBottomDepth`: a shallow rep still *reports* the `bottom`
   * phase, so the animation stream stays truthful, but is rejected as a partial for counting.
   */
  minRepDepth: number;

  /** Reps faster than this are rejected as noise rather than counted. */
  minRepMs: number;
  /** A rep taking longer than this is abandoned and the machine resets to the top. */
  maxRepMs: number;

  /** Debounce applied only to direction-reversing transitions. */
  reverseDwellMs: number;

  /**
   * Peak depth above which an aborted descent counts as a partial rep rather than as flicker.
   *
   * Both are rejected either way, but the session summary uses flicker count as a *signal
   * quality* metric and partial count as a *user form* metric. Conflating "the user did a half
   * squat" with "the phase output chattered" would make the quality number meaningless.
   */
  partialAttemptDepth: number;

  /** Minimum depth rate (units/sec) required to leave the top, so a twitch does not start a rep. */
  minDescendVel: number;
  /** Minimum upward rate required to leave the bottom. */
  minAscendVel: number;

  /**
   * Missing depth for longer than this resets the machine without counting a rep.
   *
   * Tracking loss mid-rep is common — the user turns, a limb leaves frame — and without this the
   * machine would sit in `bottom` forever and then emit a bogus rep when tracking returned.
   */
  lossTimeoutMs: number;
}

export const DEFAULT_DEPTH_FSM: DepthFsmConfig = {
  topDepth: 8,
  enterDescendDepth: 15,
  enterBottomDepth: 60,
  exitBottomDepth: 50,
  minRepDepth: 70,
  minRepMs: 500,
  maxRepMs: 8000,
  reverseDwellMs: 120,
  partialAttemptDepth: 30,
  minDescendVel: 2,
  minAscendVel: 2,
  lossTimeoutMs: 700,
};

export interface DepthFsmState {
  phase: FsmPhase;
  /** ms timestamp the current phase was entered. */
  phaseEnteredMs: number;
  /** ms timestamp the current rep attempt began (leaving the top). */
  repStartedMs: number;
  /** Deepest depth reached during the current rep attempt. */
  peakDepth: number;
  /** Last valid depth seen. */
  lastDepth: number;
  /** ms timestamp of the last valid depth. */
  lastValidMs: number;

  repCount: number;

  // ---- Diagnostics, surfaced in the session summary -----------------------------------------
  /** Reps rejected for not reaching `minRepDepth`. */
  partialReps: number;
  /** Rep attempts abandoned on `maxRepMs` or on tracking loss. */
  abandonedReps: number;
  /** Direction reversals that did not complete a rep — the chatter counter. */
  flickers: number;
  /** Resets caused by missing depth. */
  trackingLosses: number;
}

export function createDepthFsmState(): DepthFsmState {
  'worklet';
  return {
    phase: 'top',
    phaseEnteredMs: 0,
    repStartedMs: 0,
    peakDepth: 0,
    lastDepth: 0,
    lastValidMs: 0,
    repCount: 0,
    partialReps: 0,
    abandonedReps: 0,
    flickers: 0,
    trackingLosses: 0,
  };
}

export function resetDepthFsm(s: DepthFsmState, nowMs: number, keepCount: boolean): void {
  'worklet';
  s.phase = 'top';
  s.phaseEnteredMs = nowMs;
  s.repStartedMs = 0;
  s.peakDepth = 0;
  s.lastDepth = 0;
  s.lastValidMs = nowMs;
  if (!keepCount) {
    s.repCount = 0;
    s.partialReps = 0;
    s.abandonedReps = 0;
    s.flickers = 0;
    s.trackingLosses = 0;
  }
}

export interface DepthFsmResult {
  phase: FsmPhase;
  /** True on the single frame a valid rep completes. */
  repCompleted: boolean;
  /** True on the single frame a rep is rejected for insufficient depth. */
  partialRejected: boolean;
  /** Peak depth of the rep that just finished; NaN otherwise. */
  completedPeakDepth: number;
  /** Duration of the rep that just finished, in ms; NaN otherwise. */
  completedDurationMs: number;
}

function enter(s: DepthFsmState, phase: FsmPhase, nowMs: number): void {
  'worklet';
  s.phase = phase;
  s.phaseEnteredMs = nowMs;
}

/**
 * Advance the machine by one frame.
 *
 * @param depth 0-100, or NaN when the exercise could not measure it this frame.
 * @param depthVel rate of change of `depth`, in units per second.
 */
export function stepDepthFsm(
  s: DepthFsmState,
  cfg: DepthFsmConfig,
  depth: number,
  depthVel: number,
  nowMs: number,
): DepthFsmResult {
  'worklet';
  const res: DepthFsmResult = {
    phase: s.phase,
    repCompleted: false,
    partialRejected: false,
    completedPeakDepth: NaN,
    completedDurationMs: NaN,
  };

  // ---- Missing depth: hold, then give up ----------------------------------------------------
  if (depth !== depth) {
    if (s.lastValidMs > 0 && nowMs - s.lastValidMs > cfg.lossTimeoutMs) {
      if (s.phase !== 'top') {
        s.abandonedReps++;
        s.trackingLosses++;
      }
      resetDepthFsm(s, nowMs, true);
    }
    res.phase = s.phase;
    return res;
  }

  s.lastValidMs = nowMs;
  if (depth > s.peakDepth && s.phase !== 'top') s.peakDepth = depth;

  const inPhaseMs = nowMs - s.phaseEnteredMs;
  const repMs = s.repStartedMs > 0 ? nowMs - s.repStartedMs : 0;

  // A rep attempt that overruns is abandoned from any non-top phase. Checked before the normal
  // transitions so a stalled machine always recovers.
  if (s.phase !== 'top' && repMs > cfg.maxRepMs) {
    s.abandonedReps++;
    resetDepthFsm(s, nowMs, true);
    res.phase = s.phase;
    s.lastDepth = depth;
    return res;
  }

  switch (s.phase) {
    case 'top': {
      if (depth > cfg.enterDescendDepth && depthVel >= cfg.minDescendVel) {
        s.repStartedMs = nowMs;
        s.peakDepth = depth;
        enter(s, 'descending', nowMs);
      }
      break;
    }

    case 'descending': {
      if (depth >= cfg.enterBottomDepth) {
        // Forward progress: no dwell, so the animation is never held back.
        enter(s, 'bottom', nowMs);
      } else if (depth <= cfg.topDepth && inPhaseMs >= cfg.reverseDwellMs) {
        // Aborted before bottoming out. A descent that got meaningfully deep was a half rep by
        // the user; a shallow one was signal chatter. They are different diagnostics.
        if (s.peakDepth >= cfg.partialAttemptDepth) {
          s.partialReps++;
          res.partialRejected = true;
          res.completedPeakDepth = s.peakDepth;
          res.completedDurationMs = repMs;
        } else {
          s.flickers++;
        }
        resetDepthFsm(s, nowMs, true);
      }
      break;
    }

    case 'bottom': {
      if (depth <= cfg.exitBottomDepth && depthVel <= -cfg.minAscendVel) {
        enter(s, 'ascending', nowMs);
      }
      break;
    }

    case 'ascending': {
      if (depth <= cfg.topDepth) {
        const duration = repMs;
        if (s.peakDepth >= cfg.minRepDepth && duration >= cfg.minRepMs) {
          s.repCount++;
          res.repCompleted = true;
        } else if (s.peakDepth < cfg.minRepDepth) {
          s.partialReps++;
          res.partialRejected = true;
        } else {
          // Deep enough but implausibly fast — a landmark glitch, not a rep.
          s.flickers++;
        }
        res.completedPeakDepth = s.peakDepth;
        res.completedDurationMs = duration;
        resetDepthFsm(s, nowMs, true);
      } else if (depth >= cfg.enterBottomDepth && inPhaseMs >= cfg.reverseDwellMs) {
        // Went back down without reaching the top: one rep with a wobble, not two reps.
        s.flickers++;
        enter(s, 'bottom', nowMs);
      }
      break;
    }
  }

  s.lastDepth = depth;
  res.phase = s.phase;
  return res;
}

/** Map the machine's internal phase onto the wire contract's phase names. */
export function toContractPhase(phase: FsmPhase): 'standing' | 'descending' | 'bottom' | 'ascending' {
  'worklet';
  // The output contract has no 'up' state, so a push-up's top maps onto 'standing'. Exercise
  // modules carry a human-readable label for the debug overlay instead.
  return phase === 'top' ? 'standing' : phase;
}
