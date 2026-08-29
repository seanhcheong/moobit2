/**
 * Forward alternating lunge.
 *
 * Worklet-safe.
 *
 * ## Primary signal
 * `hipRatio`, as for the squat, but with its own excursion: a lunge drops the pelvis less far,
 * measuring 0.677 -> 0.554 (0.123) against the squat's 0.192. Front knee angle is a corroborator
 * for the same reason knee angle is not primary in the squat — from a head-on camera it is
 * heavily foreshortened.
 *
 * ## Front-leg identification: the brief's proposed signal is the weakest of the three
 * The brief proposed relative ankle image-y as primary ("the leg stepped toward the camera will
 * appear lower and larger in frame") with MediaPipe z as a doubtful secondary. Measurement
 * (`npm run probe:signals`) contradicts both halves:
 *
 *   signal            value at full depth   SNR    sign consistent through the whole rep?
 *   ankle dy            +0.0101             6.5x   NO — it is negative until ~25% depth
 *   knee dv             -0.108             70x     yes
 *   shank length diff   +0.118             76x     yes
 *   ankle dz            -0.333             35x     yes
 *
 * Two things are wrong with the ankle-dy claim. First the *sign*: with the lens 5 cm off the floor
 * tilted up, a nearer object subtends a larger elevation angle, so the near leg appears HIGHER,
 * not lower. Second, ankles sit essentially AT lens height, which is exactly where that vertical
 * projection difference degenerates to nothing — which is why the measured signal is ~13 px and
 * only acquires a stable sign once the trailing heel lifts. It is a signal about the heel rising,
 * dressed up as a signal about depth ordering.
 *
 * The knee, sitting well above lens height, does not degenerate, and the apparent shank length
 * difference is enormous (the trailing shank points almost along the view axis and foreshortens
 * to nearly nothing).
 *
 * So this module votes across three signals rather than trusting one. The two z-free signals
 * carry the most weight, because MediaPipe's z is the one quantity whose real-world error cannot
 * be predicted from a synthetic model — it has systematic bias, not just noise. Votes are
 * accumulated across the whole rep and the label is latched at the bottom, so a per-frame wobble
 * cannot flip the answer mid-rep. Every vote is exposed in the debug readout so the assumption
 * can be checked against a real device rather than trusted.
 */

import { clamp01 } from '../geometry';
import { LM } from '../landmarks';
import {
  DEFAULT_DEPTH_FSM,
  atLeast,
  atMost,
  combineTerms,
  createReciprocatingState,
  depthVelocity,
  diagnosticsOf,
  gatesSatisfied,
  nearness,
  resetReciprocatingState,
  stepReciprocating,
  type ExerciseDiagnostics,
  type ExerciseGates,
  type ExerciseModule,
  type ExerciseStepResult,
  type ReciprocatingState,
} from '../exercise';
import type { Side } from '../types';

export const LUNGE_GATES: ExerciseGates = {
  minCoreVisibility: 0.5,
  minAnkleVisibility: 0.4,
  minKneeVisibility: 0.4,
  minWristVisibility: 0,
  minElbowVisibility: 0,
};

export const LUNGE_CONFIG = {
  // ---- Depth -------------------------------------------------------------------------------
  /** Drop in `hipRatio` at full lunge depth. Measured 0.123 — smaller than a squat's 0.192. */
  depthExcursion: 0.123,

  // ---- Corroborators -----------------------------------------------------------------------
  /** Apparent knee angle (mean of both legs) falls this far at full depth. */
  kneeDropAtFullDepth: 36.6,
  /** Apparent hip angle falls this far at full depth. */
  hipDropAtFullDepth: 28.5,
  corroborationTolerance: 0.9,
  corroborationMinDepth: 25,

  // ---- Disambiguation ----------------------------------------------------------------------
  /** Feet must be separated along depth. Lunge measures 0.30-0.33; a squat is 0.000. */
  ankleSepZZeroAt: 0.1,
  ankleSepZFullAt: 0.24,
  /** Vertical ankle separation. Lunge 0.022 (top) to 0.081 (bottom); a squat is 0.000. */
  ankleSepVZeroAt: 0.015,
  ankleSepVFullAt: 0.05,
  /** |ln(shank length ratio)|. Lunge 0.16 (top) to 1.46 (bottom); a squat is 0. */
  shankAsymZeroAt: 0.08,
  shankAsymFullAt: 0.3,

  /**
   * Veto when the feet are unambiguously together — the mirror of the squat's `feet-split` veto.
   *
   * All three conditions must hold, so a merely staggered stance does not disqualify a lunge.
   * With this in place a plain squat can never be labelled a lunge, whatever the other terms do.
   */
  vetoAnkleSepV: 0.008,
  vetoAnkleSepZ: 0.08,
  vetoShankAsym: 0.05,

  /** Upright-body terms, shared in spirit with the squat. */
  aspectFullAt: 1.05,
  aspectZeroAt: 1.5,
  aspectVeto: 1.55,
  torsoRatioZeroAt: 0.62,
  torsoRatioFullAt: 0.85,
  torsoRatioVeto: 0.6,

  wAspect: 0.8,
  wTorsoRatio: 0.8,
  wAnkleSepZ: 1.0,
  wAnkleSepV: 1.0,
  wShankAsym: 1.2,
  wCorroboration: 0.8,

  // ---- Front-leg voting --------------------------------------------------------------------
  /**
   * Weights per signal. The z-free signals dominate deliberately: MediaPipe's z is the one
   * quantity whose real-world error a synthetic model cannot predict.
   */
  wVoteKneeDv: 1.2,
  wVoteShank: 1.0,
  wVoteAnkleDz: 0.8,

  /** Dead bands below which a signal abstains rather than voting. */
  deadbandKneeDv: 0.015,
  deadbandShankLog: 0.1,
  deadbandAnkleDz: 0.08,

  /** Accumulated |score| needed before a front leg is committed. */
  minVoteMargin: 1.5,

  maxVelGapSec: 0.35,

  fsm: { ...DEFAULT_DEPTH_FSM },
} as const;

export interface LungeState extends ReciprocatingState {
  /** Accumulated front-leg vote for the current rep. Negative = left, positive = right. */
  voteAccum: number;
  /** Latched label for the current rep; survives to the next rep as the "last known" answer. */
  frontLeg: Side | null;
  /** True once the label has been latched for this rep (at the bottom). */
  latched: boolean;
  /** Per-rep labels in order, so alternation can be reported. */
  legHistory: Side[];
  /** Most recent per-signal votes, for the debug readout. */
  lastVotes: { kneeDv: number; shank: number; ankleDz: number };
}

function createState(): LungeState {
  'worklet';
  const base = createReciprocatingState();
  return {
    fsm: base.fsm,
    lastDepth: base.lastDepth,
    lastDepthTimeSec: base.lastDepthTimeSec,
    depthPrimed: base.depthPrimed,
    voteAccum: 0,
    frontLeg: null,
    latched: false,
    legHistory: [],
    lastVotes: { kneeDv: 0, shank: 0, ankleDz: 0 },
  };
}

/** -1 votes left, +1 votes right, 0 abstains. */
function signedVote(value: number, deadband: number, leftIsNegative: boolean): number {
  'worklet';
  if (value !== value) return 0;
  if (value < -deadband) return leftIsNegative ? -1 : 1;
  if (value > deadband) return leftIsNegative ? 1 : -1;
  return 0;
}

export const lungeModule: ExerciseModule<LungeState> = {
  id: 'lunge',
  displayName: 'Lunge',
  topPhaseLabel: 'standing',

  requiredLandmarks: [
    LM.LEFT_SHOULDER,
    LM.RIGHT_SHOULDER,
    LM.LEFT_HIP,
    LM.RIGHT_HIP,
    LM.LEFT_KNEE,
    LM.RIGHT_KNEE,
    LM.LEFT_ANKLE,
    LM.RIGHT_ANKLE,
  ],

  gates: LUNGE_GATES,

  calibrationMetrics: ['hipRatio', 'kneeAngle', 'hipAngle', 'ankleSepZ', 'ankleSepV'],

  config: LUNGE_CONFIG,

  createState,

  reset(s, nowMs, keepCount) {
    'worklet';
    resetReciprocatingState(s, nowMs, keepCount);
    s.voteAccum = 0;
    s.latched = false;
    if (!keepCount) {
      s.frontLeg = null;
      s.legHistory.length = 0;
    }
  },

  measure(s, f, b, out) {
    'worklet';
    const cfg = LUNGE_CONFIG;

    if (!f.valid || !gatesSatisfied(f, LUNGE_GATES) || b.hipRatio !== b.hipRatio) {
      out.depth = NaN;
      out.depthVel = depthVelocity(s, NaN, f.timeSec, cfg.maxVelGapSec);
      out.primary = f.hipRatio;
      out.corroboration = 0;
      return;
    }

    const drop = b.hipRatio - f.hipRatio;
    const depth = 100 * clamp01(drop / Math.max(1e-4, cfg.depthExcursion));

    out.primary = f.hipRatio;
    out.depth = depth;
    out.depthVel = depthVelocity(s, depth, f.timeSec, cfg.maxVelGapSec);

    // ---- Front-leg voting ------------------------------------------------------------------
    // A nearer landmark above lens height appears HIGHER, so a negative kneeDv (left knee higher)
    // means the LEFT leg is forward. A longer left shank likewise means left is forward. A more
    // negative left ankle z means the left ankle is nearer, so again left is forward.
    const shankLog =
      f.shankLenRatio === f.shankLenRatio && f.shankLenRatio > 0 ? Math.log(f.shankLenRatio) : NaN;

    const vKnee = signedVote(f.kneeDv, cfg.deadbandKneeDv, true);
    const vShank = signedVote(shankLog, cfg.deadbandShankLog, false);
    // A dead z channel must abstain, not vote zero-and-be-counted. The two z-free signals then
    // carry the decision on their own, which is why they hold the larger weights.
    const vDz = f.zUsable ? signedVote(f.ankleDz, cfg.deadbandAnkleDz, true) : 0;

    s.lastVotes.kneeDv = vKnee;
    s.lastVotes.shank = vShank;
    s.lastVotes.ankleDz = vDz;

    // Accumulate only while actually moving through a rep; at the top the legs are together and
    // the signals are meaningless.
    if (s.fsm.phase !== 'top' && !s.latched) {
      s.voteAccum +=
        vKnee * cfg.wVoteKneeDv + vShank * cfg.wVoteShank + vDz * cfg.wVoteAnkleDz;
    }

    // ---- Corroboration ---------------------------------------------------------------------
    if (depth < cfg.corroborationMinDepth) {
      out.corroboration = 1;
      return;
    }

    const frac = depth / 100;
    let sum = 0;
    let n = 0;

    const kneeDrop = b.kneeAngle - f.kneeAngle;
    if (kneeDrop === kneeDrop) {
      const expected = cfg.kneeDropAtFullDepth * frac;
      sum += nearness(kneeDrop, expected, Math.max(6, expected * cfg.corroborationTolerance + 6));
      n++;
    }

    const hipDrop = b.hipAngle - f.hipAngle;
    if (hipDrop === hipDrop) {
      const expected = cfg.hipDropAtFullDepth * frac;
      sum += nearness(hipDrop, expected, Math.max(6, expected * cfg.corroborationTolerance + 6));
      n++;
    }

    out.corroboration = n === 0 ? 0 : sum / n;
  },

  score(_s, f, _b, m, out) {
    'worklet';
    const cfg = LUNGE_CONFIG;
    out.terms.length = 0;
    out.veto = null;

    if (!f.valid) {
      out.confidence = 0;
      out.veto = 'no-pose';
      return;
    }
    if (!gatesSatisfied(f, LUNGE_GATES)) {
      out.confidence = 0;
      out.veto = 'gates';
      return;
    }
    if (f.bboxAspect > cfg.aspectVeto) {
      out.confidence = 0;
      out.veto = 'body-horizontal';
      return;
    }
    if (f.torsoOverShoulderWidth < cfg.torsoRatioVeto) {
      out.confidence = 0;
      out.veto = 'torso-foreshortened';
      return;
    }

    const shankAsym =
      f.shankLenRatio === f.shankLenRatio && f.shankLenRatio > 0
        ? Math.abs(Math.log(f.shankLenRatio))
        : NaN;

    if (
      f.ankleSepV < cfg.vetoAnkleSepV &&
      (!f.zUsable || f.ankleSepZ < cfg.vetoAnkleSepZ) &&
      shankAsym === shankAsym &&
      shankAsym < cfg.vetoShankAsym
    ) {
      out.confidence = 0;
      out.veto = 'feet-together';
      return;
    }

    out.terms.push({
      name: 'upright(aspect)',
      value: f.bboxAspect,
      score: atMost(f.bboxAspect, cfg.aspectFullAt, cfg.aspectZeroAt),
      weight: cfg.wAspect,
    });
    out.terms.push({
      name: 'upright(torsoRatio)',
      value: f.torsoOverShoulderWidth,
      score: atLeast(f.torsoOverShoulderWidth, cfg.torsoRatioZeroAt, cfg.torsoRatioFullAt),
      weight: cfg.wTorsoRatio,
    });
    // Abstain when z is dead, matching the squat module. Here the naive failure is the mirror
    // image: a collapsed z reads as "feet together" and silently argues *against* a lunge.
    out.terms.push({
      name: 'feetSplit(z)',
      value: f.zUsable ? f.ankleSepZ : NaN,
      score: atLeast(f.ankleSepZ, cfg.ankleSepZZeroAt, cfg.ankleSepZFullAt),
      weight: cfg.wAnkleSepZ,
    });
    out.terms.push({
      name: 'feetSplit(v)',
      value: f.ankleSepV,
      score: atLeast(f.ankleSepV, cfg.ankleSepVZeroAt, cfg.ankleSepVFullAt),
      weight: cfg.wAnkleSepV,
    });
    out.terms.push({
      name: 'legsAsymmetric',
      value: shankAsym,
      score: atLeast(shankAsym, cfg.shankAsymZeroAt, cfg.shankAsymFullAt),
      weight: cfg.wShankAsym,
    });
    out.terms.push({
      name: 'corroboration',
      value: m.corroboration,
      score: m.corroboration,
      weight: cfg.wCorroboration,
    });

    out.confidence = combineTerms(out.terms);
  },

  step(s, _f, _b, m, nowMs) {
    'worklet';
    const cfg = LUNGE_CONFIG;
    const wasTop = s.fsm.phase === 'top';
    const res: ExerciseStepResult = stepReciprocating(s, cfg.fsm, m, nowMs);

    // A new rep attempt: clear the accumulated votes so the previous rep's evidence cannot
    // bleed into this one — which matters most here, since alternating lunges expect the answer
    // to flip every rep.
    if (wasTop && res.phase === 'descending') {
      s.voteAccum = 0;
      s.latched = false;
    }

    // Latch at the bottom, where the legs are maximally separated and every signal is strongest.
    if (!s.latched && res.phase === 'bottom' && Math.abs(s.voteAccum) >= cfg.minVoteMargin) {
      s.frontLeg = s.voteAccum < 0 ? 'left' : 'right';
      s.latched = true;
    }

    if (res.repCompleted && s.frontLeg !== null) {
      s.legHistory.push(s.frontLeg);
      // Bounded, so a long session cannot grow this without limit in the worklet.
      if (s.legHistory.length > 64) s.legHistory.shift();
    }

    res.frontLeg = s.frontLeg;
    return res;
  },

  diagnostics(s): ExerciseDiagnostics {
    'worklet';
    return diagnosticsOf(s);
  },

  describe(s, f, _b, m) {
    'worklet';
    const v = s.lastVotes;
    return (
      `hipRatio ${f.hipRatio.toFixed(3)} sepZ ${f.ankleSepZ.toFixed(3)} ` +
      `sepV ${f.ankleSepV.toFixed(3)} shankR ${f.shankLenRatio.toFixed(2)} ` +
      `front ${s.frontLeg ?? '-'} votes[knee ${v.kneeDv} shank ${v.shank} dz ${v.ankleDz}] ` +
      `accum ${s.voteAccum.toFixed(1)} corrob ${m.corroboration.toFixed(2)}`
    );
  },
};

/**
 * Fraction of consecutive rep pairs whose front leg alternates.
 *
 * The product does alternating lunges only, so this is the honest measure of whether the
 * front-leg signal is good enough to track alternation or only good enough to say "a lunge
 * happened". It goes in the session summary.
 */
export function alternationRate(history: readonly Side[]): number {
  'worklet';
  if (history.length < 2) return NaN;
  let alternating = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i] !== history[i - 1]) alternating++;
  }
  return alternating / (history.length - 1);
}
