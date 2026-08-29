/**
 * Push-up, performed facing the fixed floor-level camera.
 *
 * Worklet-safe.
 *
 * ## Primary signal: shoulder height above the planted wrists
 * `shoulderOverWrist = (wristV - shoulderV) / shoulderWidth` sweeps 1.32 -> 0.86 over a full
 * push-up on the reference geometry: a 35% relative excursion, using only shoulders and wrists.
 * Those are the best landmarks available here — the hands are planted on the floor nearest the
 * lens, and the shoulders are never occluded.
 *
 * Elbow angle, which the brief named as primary, is kept as a corroborator instead. It *is*
 * measurable head-on (166 -> 132 degrees, so 34 degrees of real range), but its response is badly
 * non-linear: it gives up only 15 degrees over the first 80% of the descent and then 19 degrees
 * in the last 20%. As a depth metric that compresses the top of the movement into noise, which is
 * precisely where a character animation needs resolution.
 *
 * ## The ankle question, answered
 * The brief asked whether feet stay usable from this angle and instructed us to de-emphasise them
 * if not. Projection says they do not: at 6 ft, head-on, the feet sit directly behind the body
 * along the view axis. This module therefore sets `minAnkleVisibility: 0`, uses no ankle-derived
 * feature at all, and measures torso rigidity against the KNEES rather than the ankles.
 *
 * ## Why the top reference is learned, not calibrated
 * Calibration captures a standing pose, which says nothing about the top of a plank. Rather than
 * ask for a second calibration, the top reference is learned as a fast-attack, slow-decay running
 * maximum, seeded from anatomy: arm length over shoulder width is about 1.29 for standard
 * proportions, and the measured apparent value is 1.32. The bottom anchor is then a fixed
 * *fraction* of that reference, so it scales with the individual's arm-to-shoulder proportion
 * automatically.
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

export const PUSHUP_GATES: ExerciseGates = {
  minCoreVisibility: 0.45,
  // Explicitly zero. From a floor-level camera 6 ft away with the user head-on, the feet are
  // behind the body; requiring them would disable the pipeline on this exercise.
  minAnkleVisibility: 0,
  minKneeVisibility: 0,
  minWristVisibility: 0.4,
  minElbowVisibility: 0.35,
};

export const PUSHUP_CONFIG = {
  // ---- Depth -------------------------------------------------------------------------------
  /**
   * Seed for the learned top reference: arm length over shoulder width for standard
   * proportions. Measured apparent value at the top of a push-up is 1.32.
   */
  topRefDefault: 1.3,
  topRefMin: 0.85,
  topRefMax: 1.95,
  /** Fast attack toward a new maximum. */
  topRefAttack: 0.5,
  /** Slow decay, so a changed hand position is eventually followed but noise is not. */
  topRefDecay: 0.0025,

  /**
   * Fraction of the top reference given up at full depth. Measured 0.458/1.320 = 0.347.
   * Expressed as a fraction so it scales with the individual's arm-to-shoulder proportion.
   */
  depthExcursionFrac: 0.347,

  // ---- Corroborators -----------------------------------------------------------------------
  /** Apparent elbow angle falls this far, in degrees, at full depth. */
  elbowDropAtFullDepth: 34.4,
  /** torso/shoulderWidth falls this far at full depth. */
  torsoRatioDropAtFullDepth: 0.199,
  /** Apparent torso/shoulderWidth at the top of a clean push-up. */
  torsoRatioAtTop: 0.54,
  corroborationTolerance: 0.9,
  corroborationMinDepth: 25,

  // ---- Rigidity ("cheat" detection) --------------------------------------------------------
  /**
   * Hip deviation below the shoulder-to-knee line, in shoulder widths, at which rigidity scores
   * zero. A clean plank measures ~0.
   */
  sagFullAt: 0.04,
  sagZeroAt: 0.16,
  /**
   * Reject reps that fail the rigidity check.
   *
   * OFF by default. The synthetic sag model is the least trustworthy part of the generator, so
   * silently discarding the user's reps on the strength of it would be the wrong trade. The
   * rigidity score is reported every frame so it can be validated on real footage first; turn
   * this on once it has been.
   */
  rejectSaggedReps: false,
  /** Rigidity below this rejects a rep, when the above is enabled. */
  minRigidityForRep: 0.35,

  // ---- Disambiguation ----------------------------------------------------------------------
  /** Bounding-box aspect ramp. Push-up measures 1.72-2.33; a squat is 0.54-0.97. */
  aspectZeroAt: 1.15,
  aspectFullAt: 1.6,
  /** Veto below this: the body is upright, so this is not a push-up. */
  aspectVeto: 1.1,

  /** torso/shoulderWidth ramp. Push-up measures 0.34-0.54; a squat is 1.04-1.11. */
  torsoRatioFullAt: 0.6,
  torsoRatioZeroAt: 0.9,
  /** Veto above this: the torso is side-on to the lens, so the body is upright. */
  torsoRatioVeto: 0.95,

  wAspect: 1.2,
  wTorsoRatio: 1.2,
  wWristsBelow: 0.5,
  wRigidity: 0.5,
  wCorroboration: 0.8,

  maxVelGapSec: 0.35,

  fsm: {
    ...DEFAULT_DEPTH_FSM,
    // Push-ups cycle faster than squats and the arms can snap back quickly at the top.
    minRepMs: 400,
  },
} as const;

export interface PushupState extends ReciprocatingState {
  /** Learned top-of-plank reference for `shoulderOverWrist`. */
  topRef: number;
  topRefPrimed: boolean;
  /** Worst (lowest) rigidity seen during the current rep. */
  repMinRigidity: number;
  /** Rigidity of the frame just measured, cached for `score` and the debug readout. */
  rigidity: number;
  /** Reps flagged as insufficiently rigid. */
  saggedReps: number;
}

function createState(): PushupState {
  'worklet';
  const base = createReciprocatingState();
  return {
    fsm: base.fsm,
    lastDepth: base.lastDepth,
    lastDepthTimeSec: base.lastDepthTimeSec,
    depthPrimed: base.depthPrimed,
    topRef: PUSHUP_CONFIG.topRefDefault,
    topRefPrimed: false,
    repMinRigidity: 1,
    rigidity: 1,
    saggedReps: 0,
  };
}

export const pushupModule: ExerciseModule<PushupState> = {
  id: 'pushup',
  displayName: 'Push-up',
  topPhaseLabel: 'up',

  // No ankles, on purpose: see the module note.
  requiredLandmarks: [
    LM.LEFT_SHOULDER,
    LM.RIGHT_SHOULDER,
    LM.LEFT_ELBOW,
    LM.RIGHT_ELBOW,
    LM.LEFT_WRIST,
    LM.RIGHT_WRIST,
    LM.LEFT_HIP,
    LM.RIGHT_HIP,
    LM.LEFT_KNEE,
    LM.RIGHT_KNEE,
  ],

  gates: PUSHUP_GATES,

  // Notably does NOT depend on the standing baseline for its depth reference; see the note.
  calibrationMetrics: ['shoulderWidth', 'torsoOverShoulderWidth'],

  config: PUSHUP_CONFIG,

  createState,

  reset(s, nowMs, keepCount) {
    'worklet';
    resetReciprocatingState(s, nowMs, keepCount);
    s.repMinRigidity = 1;
    s.rigidity = 1;
    if (!keepCount) {
      s.topRef = PUSHUP_CONFIG.topRefDefault;
      s.topRefPrimed = false;
      s.saggedReps = 0;
    }
  },

  measure(s, f, _b, out) {
    'worklet';
    const cfg = PUSHUP_CONFIG;

    if (!f.valid || !gatesSatisfied(f, PUSHUP_GATES) || f.shoulderOverWrist !== f.shoulderOverWrist) {
      out.depth = NaN;
      out.depthVel = depthVelocity(s, NaN, f.timeSec, cfg.maxVelGapSec);
      out.primary = f.shoulderOverWrist;
      out.corroboration = 0;
      s.rigidity = 0;
      return;
    }

    const sow = f.shoulderOverWrist;

    // Fast attack, slow decay: follows a genuinely higher plank immediately, but is not dragged
    // down by a single noisy frame or up by a transient.
    if (!s.topRefPrimed) {
      s.topRef = sow > cfg.topRefDefault ? sow : cfg.topRefDefault;
      s.topRefPrimed = true;
    } else if (sow > s.topRef) {
      s.topRef += (sow - s.topRef) * cfg.topRefAttack;
    } else {
      s.topRef += (sow - s.topRef) * cfg.topRefDecay;
    }
    if (s.topRef < cfg.topRefMin) s.topRef = cfg.topRefMin;
    if (s.topRef > cfg.topRefMax) s.topRef = cfg.topRefMax;

    const anchor = s.topRef * cfg.depthExcursionFrac;
    const depth = 100 * clamp01((s.topRef - sow) / Math.max(1e-4, anchor));

    out.primary = sow;
    out.depth = depth;
    out.depthVel = depthVelocity(s, depth, f.timeSec, cfg.maxVelGapSec);

    // ---- Rigidity ------------------------------------------------------------------------
    // Measured against the knees, not the ankles, because the feet are not reliably visible.
    s.rigidity = atMost(Math.abs(f.plankSag), cfg.sagFullAt, cfg.sagZeroAt);
    if (s.rigidity < s.repMinRigidity) s.repMinRigidity = s.rigidity;

    // ---- Corroboration -------------------------------------------------------------------
    if (depth < cfg.corroborationMinDepth) {
      out.corroboration = 1;
      return;
    }

    const frac = depth / 100;
    let sum = 0;
    let n = 0;

    // Elbow flexion must accompany the shoulder descent. This is what separates a real push-up
    // from the whole body being lowered with straight arms.
    const elbowTop = 165.9;
    const elbowDrop = elbowTop - f.elbowAngle;
    if (elbowDrop === elbowDrop) {
      const expected = cfg.elbowDropAtFullDepth * frac;
      sum += nearness(elbowDrop, expected, Math.max(8, expected * cfg.corroborationTolerance + 8));
      n++;
    }

    const torsoDrop = cfg.torsoRatioAtTop - f.torsoOverShoulderWidth;
    if (torsoDrop === torsoDrop) {
      const expected = cfg.torsoRatioDropAtFullDepth * frac;
      sum += nearness(torsoDrop, expected, Math.max(0.08, expected * cfg.corroborationTolerance + 0.08));
      n++;
    }

    out.corroboration = n === 0 ? 0 : sum / n;
  },

  score(s, f, _b, m, out) {
    'worklet';
    const cfg = PUSHUP_CONFIG;
    out.terms.length = 0;
    out.veto = null;

    if (!f.valid) {
      out.confidence = 0;
      out.veto = 'no-pose';
      return;
    }
    if (!gatesSatisfied(f, PUSHUP_GATES)) {
      out.confidence = 0;
      out.veto = 'gates';
      return;
    }
    if (f.bboxAspect < cfg.aspectVeto) {
      out.confidence = 0;
      out.veto = 'body-upright';
      return;
    }
    if (f.torsoOverShoulderWidth > cfg.torsoRatioVeto) {
      out.confidence = 0;
      out.veto = 'torso-not-foreshortened';
      return;
    }

    out.terms.push({
      name: 'horizontal(aspect)',
      value: f.bboxAspect,
      score: atLeast(f.bboxAspect, cfg.aspectZeroAt, cfg.aspectFullAt),
      weight: cfg.wAspect,
    });
    out.terms.push({
      name: 'horizontal(torsoRatio)',
      value: f.torsoOverShoulderWidth,
      score: atMost(f.torsoOverShoulderWidth, cfg.torsoRatioFullAt, cfg.torsoRatioZeroAt),
      weight: cfg.wTorsoRatio,
    });
    out.terms.push({
      name: 'wristsBelowShoulders',
      value: f.shoulderOverWrist,
      score: atLeast(f.shoulderOverWrist, 0.35, 0.7),
      weight: cfg.wWristsBelow,
    });
    out.terms.push({
      name: 'torsoRigid',
      value: f.plankSag,
      score: s.rigidity,
      weight: cfg.wRigidity,
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
    const cfg = PUSHUP_CONFIG;
    const res: ExerciseStepResult = stepReciprocating(s, cfg.fsm, m, nowMs);

    if (res.repCompleted) {
      if (s.repMinRigidity < cfg.minRigidityForRep) {
        s.saggedReps++;
        if (cfg.rejectSaggedReps) {
          // Undo the count the shared machine already made, and record it as a partial so the
          // session summary shows the rep was seen and deliberately not credited.
          s.fsm.repCount--;
          s.fsm.partialReps++;
          res.repCompleted = false;
          res.partialRejected = true;
        }
      }
    }
    if (res.repCompleted || res.partialRejected || res.phase === 'top') s.repMinRigidity = 1;

    return res;
  },

  diagnostics(s): ExerciseDiagnostics {
    'worklet';
    return diagnosticsOf(s);
  },

  describe(s, f, _b, m) {
    'worklet';
    return (
      `sow ${f.shoulderOverWrist.toFixed(3)} (topRef ${s.topRef.toFixed(3)}) ` +
      `elbow ${f.elbowAngle.toFixed(0)} aspect ${f.bboxAspect.toFixed(2)} ` +
      `torsoR ${f.torsoOverShoulderWidth.toFixed(2)} sag ${f.plankSag.toFixed(3)} ` +
      `rigid ${s.rigidity.toFixed(2)} sagged ${s.saggedReps} corrob ${m.corroboration.toFixed(2)}`
    );
  },
};
