/**
 * Bodyweight squat.
 *
 * Worklet-safe.
 *
 * ## Primary signal: hip height ratio, NOT knee angle
 * The brief specified average knee angle as the primary signal, normalised between a standing
 * ~170 degrees and a full-squat ~70-90 degrees. Measurement says that cannot work from this
 * camera. With the phone on the floor 6 ft away and the user facing it, knee flexion happens
 * almost entirely along the camera's depth axis, which barely projects into the image: a squat
 * whose true 3D knee angle sweeps 180 -> 62 degrees is observed as only 180 -> 151. The
 * remaining 29 degrees also varies by +/-17% with body height, so no fixed pair of angle
 * thresholds transfers between users.
 *
 * `hipRatio` — where the hips sit between the ankles and the shoulders — behaves far better:
 *
 *   signal        excursion   spread across 1.55-1.95 m bodies   spread across 10-40 deg tilt
 *   hipRatio        0.192              +/-4%                            +/-2.4%
 *   knee angle      29 deg             +/-17%                           +/-7%
 *
 * It is a ratio of two image distances, so the projective scale factor they share cancels,
 * which is why it survives changes in body size and camera geometry. Knee angle is kept as a
 * corroborator: it must fall roughly as far as expected for the depth being claimed, which is
 * what rules out a hip hinge masquerading as a squat.
 *
 * All numbers below come from `npm run probe:features` and `npm run probe:signals`.
 */

import { clamp01, normalizeRange } from '../geometry';
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
  resetReciprocatingState,
  stepReciprocating,
  type ExerciseDiagnostics,
  type ExerciseGates,
  type ExerciseModule,
  type ExerciseScore,
  type ExerciseStepResult,
  type ReciprocatingState,
} from '../exercise';

export const SQUAT_GATES: ExerciseGates = {
  minCoreVisibility: 0.5,
  // A standing exercise: the feet must be visible, both to measure hipRatio and to rule out a
  // lunge. This is exactly the gate a push-up cannot satisfy, and should not have to.
  minAnkleVisibility: 0.4,
  minKneeVisibility: 0.4,
  minWristVisibility: 0,
  minElbowVisibility: 0,
};

export const SQUAT_CONFIG = {
  // ---- Depth -------------------------------------------------------------------------------
  /**
   * Drop in `hipRatio` from the calibrated standing baseline that corresponds to depth 100.
   * Measured 0.192 for a full bodyweight squat on the reference geometry.
   */
  depthExcursion: 0.192,

  /**
   * Adapt the full-depth anchor to the deepest rep actually seen this session.
   *
   * Off by default, deliberately. The measured excursion is stable to +/-4% across body heights,
   * so a fixed anchor is good enough — and an anchor that moves during a session would make the
   * detected-vs-actual accuracy numbers non-comparable between sessions, which is the thing the
   * harness exists to measure.
   */
  adaptAnchor: false,
  /** When adapting: bounds on the anchor as a multiple of `depthExcursion`. */
  adaptMin: 0.65,
  adaptMax: 1.35,
  /** When adapting: EMA weight per completed rep. */
  adaptRate: 0.25,

  // ---- Corroborators -----------------------------------------------------------------------
  //
  // These check DIRECTION and a MINIMUM, not a matched magnitude. That is a correction: the
  // original design matched each excursion against an expected value, and measurement showed
  // that cannot work here. Sweeping squat style — how far the hips travel back, which with
  // planted feet and a given pelvis height fully determines how far the knee travels forward —
  // moves the apparent knee drop at full depth from 29 degrees to 156 degrees, a 5.4x swing,
  // because a knee-dominant squat points the thigh almost straight down the camera's view axis
  // and foreshortens it to nothing. Reproduce with `npm run probe:style`.
  //
  // A matched target calibrated at one style scored 0.00 at every other style, silently zeroing
  // the corroboration term for essentially every real user. A saturating minimum accepts all
  // styles while still rejecting a movement in which the joint does not flex at all, which is
  // the only thing the check is actually for.
  //
  /** Knee flexion, in degrees at full depth, for full corroboration. Ramps from `...Floor`. */
  kneeDropForFullScore: 20,
  kneeDropFloor: 6,
  /** Hip flexion, in degrees at full depth, for full corroboration. */
  hipDropForFullScore: 18,
  hipDropFloor: 5,
  /** Thigh/shank ratio must fall by at least this fraction of its baseline at full depth. */
  thighShankDropForFullScore: 0.25,
  thighShankDropFloor: 0.05,
  /** Below this depth the corroborators are not evaluated — the expected drop is within noise. */
  corroborationMinDepth: 25,

  // ---- Disambiguation ----------------------------------------------------------------------
  /** Bounding-box aspect ramp. Squat measures 0.54-0.97; a push-up is 1.72-2.33. */
  aspectFullAt: 1.05,
  aspectZeroAt: 1.5,
  /** Veto above this: the body is horizontal and this is not a standing exercise. */
  aspectVeto: 1.55,

  /** torso/shoulderWidth ramp. Squat measures 1.04-1.11; a push-up is 0.34-0.54. */
  torsoRatioZeroAt: 0.62,
  torsoRatioFullAt: 0.85,
  /** Veto below this: the torso is pointing at the lens. */
  torsoRatioVeto: 0.60,

  /** Ankle depth separation ramp. Squat measures 0.000; a lunge is 0.30-0.33. */
  ankleSepZFullAt: 0.10,
  ankleSepZZeroAt: 0.22,
  /** Ankle vertical separation ramp. Squat 0.000; lunge 0.022-0.081. */
  ankleSepVFullAt: 0.012,
  ankleSepVZeroAt: 0.035,
  /** |ln(shank length ratio)| ramp. Squat 0 (symmetric); a lunge is 0.16 upward. */
  shankAsymFullAt: 0.08,
  shankAsymZeroAt: 0.20,

  /**
   * Vetoes on split feet.
   *
   * These exist because weighted terms were not enough. A squat and a lunge share their upright
   * torso, their visible ankles, and — since a lunge also drops the hips and flexes the knees —
   * most of the corroboration signal too. With separation as merely one contribution among
   * several, the squat kept a confidence floor around 0.62 all the way through a lunge, which is
   * high enough to hold the label and swallow the lunge's reps.
   *
   * Foot separation is not weak evidence, though: a "squat" with one foot three quarters of a
   * metre in front of the other is not a squat. Treating it as categorical rather than
   * probabilistic is both more accurate and far more stable.
   */
  vetoAnkleSepV: 0.05,
  vetoAnkleSepZ: 0.22,
  vetoShankAsym: 0.35,

  /** Weights for the confidence terms. */
  wAspect: 1.0,
  wTorsoRatio: 1.0,
  wAnkleSepZ: 0.8,
  wAnkleSepV: 0.6,
  wShankAsym: 0.6,
  wAnkleVisible: 0.4,
  wCorroboration: 0.8,

  /** Gap beyond which a depth velocity is treated as a frame-drop artefact, in seconds. */
  maxVelGapSec: 0.35,

  fsm: { ...DEFAULT_DEPTH_FSM },
} as const;

export interface SquatState extends ReciprocatingState {
  /** Current full-depth anchor, in hipRatio units. */
  anchor: number;
  anchorInitialised: boolean;
  /** Deepest hipRatio drop observed in the current rep. */
  repMaxDrop: number;
}

function createState(): SquatState {
  'worklet';
  const base = createReciprocatingState();
  return {
    fsm: base.fsm,
    lastDepth: base.lastDepth,
    lastDepthTimeSec: base.lastDepthTimeSec,
    depthPrimed: base.depthPrimed,
    anchor: SQUAT_CONFIG.depthExcursion,
    anchorInitialised: false,
    repMaxDrop: 0,
  };
}

export const squatModule: ExerciseModule<SquatState> = {
  id: 'squat',
  displayName: 'Squat',
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

  gates: SQUAT_GATES,

  calibrationMetrics: ['hipRatio', 'kneeAngle', 'hipAngle', 'thighShankRatio', 'torsoOverShoulderWidth'],

  config: SQUAT_CONFIG,

  createState,

  reset(s, nowMs, keepCount) {
    'worklet';
    resetReciprocatingState(s, nowMs, keepCount);
    s.repMaxDrop = 0;
    if (!keepCount) {
      s.anchor = SQUAT_CONFIG.depthExcursion;
      s.anchorInitialised = false;
    }
  },

  measure(s, f, b, out) {
    'worklet';
    const cfg = SQUAT_CONFIG;

    if (!f.valid || !gatesSatisfied(f, SQUAT_GATES) || b.hipRatio !== b.hipRatio) {
      out.depth = NaN;
      out.depthVel = depthVelocity(s, NaN, f.timeSec, cfg.maxVelGapSec);
      out.primary = f.hipRatio;
      out.corroboration = 0;
      return;
    }

    if (!s.anchorInitialised) {
      s.anchor = cfg.depthExcursion;
      s.anchorInitialised = true;
    }

    // Depth is how far the hips have dropped, as a fraction of a full squat's drop.
    const drop = b.hipRatio - f.hipRatio;
    if (drop > s.repMaxDrop) s.repMaxDrop = drop;
    const depth = 100 * clamp01(drop / Math.max(1e-4, s.anchor));

    out.primary = f.hipRatio;
    out.depth = depth;
    out.depthVel = depthVelocity(s, depth, f.timeSec, cfg.maxVelGapSec);

    // ---- Corroboration -------------------------------------------------------------------
    // Below a shallow depth the expected excursions are smaller than landmark noise, so
    // scoring them would just add jitter to the confidence.
    if (depth < cfg.corroborationMinDepth) {
      out.corroboration = 1;
      return;
    }

    const frac = depth / 100;
    let sum = 0;
    let n = 0;

    const kneeDrop = b.kneeAngle - f.kneeAngle;
    if (kneeDrop === kneeDrop) {
      sum += atLeast(kneeDrop, cfg.kneeDropFloor * frac, cfg.kneeDropForFullScore * frac);
      n++;
    }

    // The brief's requirement that hip angle move *with* knee angle, so a forward hinge with
    // straight legs cannot register as a squat. Note the depth metric already rejects a hinge on
    // its own — the hips barely drop in one, so `hipRatio` hardly moves — which is why the hinge
    // test kept passing even while this term was scoring zero.
    const hipDrop = b.hipAngle - f.hipAngle;
    if (hipDrop === hipDrop) {
      sum += atLeast(hipDrop, cfg.hipDropFloor * frac, cfg.hipDropForFullScore * frac);
      n++;
    }

    const tsDrop = b.thighShankRatio - f.thighShankRatio;
    if (tsDrop === tsDrop) {
      sum += atLeast(
        tsDrop,
        cfg.thighShankDropFloor * frac,
        cfg.thighShankDropForFullScore * frac,
      );
      n++;
    }

    out.corroboration = n === 0 ? 0 : sum / n;
  },

  score(_s, f, _b, m, out) {
    'worklet';
    const cfg = SQUAT_CONFIG;
    out.terms.length = 0;
    out.veto = null;

    if (!f.valid) {
      out.confidence = 0;
      out.veto = 'no-pose';
      return;
    }
    if (!gatesSatisfied(f, SQUAT_GATES)) {
      out.confidence = 0;
      out.veto = 'gates';
      return;
    }

    // Vetoes: shapes a standing exercise simply cannot produce. Preferring a veto to a low score
    // here is what keeps the system flickering between 'unknown' and the right answer rather
    // than between two wrong answers.
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

    // Split feet mean this is a lunge, not a squat. Any one of these is sufficient, so the
    // decision survives the z channel being unusable.
    if (
      f.ankleSepV > cfg.vetoAnkleSepV ||
      (f.zUsable && f.ankleSepZ > cfg.vetoAnkleSepZ) ||
      (shankAsym === shankAsym && shankAsym > cfg.vetoShankAsym)
    ) {
      out.confidence = 0;
      out.veto = 'feet-split';
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
    // Abstain rather than vote when z is dead: a collapsed z channel reads as "feet together",
    // which is exactly the evidence for a squat over a lunge, so voting on it would let missing
    // data argue confidently for this exercise. A NaN value makes `combineTerms` skip the term.
    out.terms.push({
      name: 'feetTogether(z)',
      value: f.zUsable ? f.ankleSepZ : NaN,
      score: atMost(f.ankleSepZ, cfg.ankleSepZFullAt, cfg.ankleSepZZeroAt),
      weight: cfg.wAnkleSepZ,
    });
    out.terms.push({
      name: 'feetTogether(v)',
      value: f.ankleSepV,
      score: atMost(f.ankleSepV, cfg.ankleSepVFullAt, cfg.ankleSepVZeroAt),
      weight: cfg.wAnkleSepV,
    });
    out.terms.push({
      name: 'legsSymmetric',
      value: shankAsym,
      score: atMost(shankAsym, cfg.shankAsymFullAt, cfg.shankAsymZeroAt),
      weight: cfg.wShankAsym,
    });
    out.terms.push({
      name: 'anklesVisible',
      value: f.visAnkles,
      score: atLeast(f.visAnkles, 0.3, 0.6),
      weight: cfg.wAnkleVisible,
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
    const res: ExerciseStepResult = stepReciprocating(s, SQUAT_CONFIG.fsm, m, nowMs);

    if ((res.repCompleted || res.partialRejected) && SQUAT_CONFIG.adaptAnchor) {
      const cfg = SQUAT_CONFIG;
      const lo = cfg.depthExcursion * cfg.adaptMin;
      const hi = cfg.depthExcursion * cfg.adaptMax;
      const observed = s.repMaxDrop < lo ? lo : s.repMaxDrop > hi ? hi : s.repMaxDrop;
      s.anchor = s.anchor + (observed - s.anchor) * cfg.adaptRate;
    }
    if (res.repCompleted || res.partialRejected || res.phase === 'top') s.repMaxDrop = 0;

    return res;
  },

  diagnostics(s): ExerciseDiagnostics {
    'worklet';
    return diagnosticsOf(s);
  },

  describe(s, f, b, m) {
    'worklet';
    const drop = b.hipRatio - f.hipRatio;
    return (
      `hipRatio ${f.hipRatio.toFixed(3)} (base ${b.hipRatio.toFixed(3)}, drop ${drop.toFixed(3)}` +
      `/${s.anchor.toFixed(3)}) knee ${f.kneeAngle.toFixed(0)} hip ${f.hipAngle.toFixed(0)} ` +
      `aspect ${f.bboxAspect.toFixed(2)} torsoR ${f.torsoOverShoulderWidth.toFixed(2)} ` +
      `sepZ ${f.ankleSepZ.toFixed(3)} corrob ${m.corroboration.toFixed(2)}`
    );
  },
};

/** Re-exported so tests can assert the depth formula without duplicating it. */
export function squatDepthFor(hipRatio: number, baselineHipRatio: number, anchor: number): number {
  'worklet';
  return 100 * normalizeRange(baselineHipRatio - hipRatio, 0, anchor);
}

export type { ExerciseScore };
