/**
 * MediaPipe Pose landmark indices and the groupings the recognition core cares about.
 *
 * Worklet-safe: no imports beyond types, no platform APIs.
 *
 * ## On MediaPipe's left/right labels and the front camera
 * `LEFT_*` and `RIGHT_*` are the *subject's* anatomical sides, which MediaPipe infers from body
 * appearance — they are NOT "the left of the image". A front-camera frame that has not been
 * mirrored shows the user as another person would see them, so their anatomical right hand
 * appears at a small image `x`. MediaPipe still labels it `RIGHT_WRIST`, correctly, so the
 * labels need no swapping.
 *
 * What *does* need care is display: the camera preview the user sees IS mirrored, so the
 * overlay must mirror `x` to line up with it. That is a rendering concern, kept separate from
 * anatomy — and, because getting it backwards is the classic bug here, both are configurable
 * flags verified against the debug overlay rather than silent assumptions
 * (see `CameraConfig` in `config.ts`).
 */

export const LM = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export type LandmarkIndex = (typeof LM)[keyof typeof LM];

/** Human-readable names, indexed by landmark id. Used by the debug overlay and replay logs. */
export const LANDMARK_NAMES: readonly string[] = [
  'nose',
  'left_eye_inner',
  'left_eye',
  'left_eye_outer',
  'right_eye_inner',
  'right_eye',
  'right_eye_outer',
  'left_ear',
  'right_ear',
  'mouth_left',
  'mouth_right',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_pinky',
  'right_pinky',
  'left_index',
  'right_index',
  'left_thumb',
  'right_thumb',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_heel',
  'right_heel',
  'left_foot_index',
  'right_foot_index',
];

/**
 * Bones to draw in the debug skeleton overlay.
 *
 * `side` drives colour-coding, which is how the mirroring and anatomical-side flags get
 * *visually* verified: raise one hand during calibration and check the highlighted limb is the
 * one you actually raised.
 */
export const SKELETON_BONES: readonly {
  a: LandmarkIndex;
  b: LandmarkIndex;
  side: 'left' | 'right' | 'center';
}[] = [
  // Torso
  { a: LM.LEFT_SHOULDER, b: LM.RIGHT_SHOULDER, side: 'center' },
  { a: LM.LEFT_HIP, b: LM.RIGHT_HIP, side: 'center' },
  { a: LM.LEFT_SHOULDER, b: LM.LEFT_HIP, side: 'left' },
  { a: LM.RIGHT_SHOULDER, b: LM.RIGHT_HIP, side: 'right' },

  // Arms
  { a: LM.LEFT_SHOULDER, b: LM.LEFT_ELBOW, side: 'left' },
  { a: LM.LEFT_ELBOW, b: LM.LEFT_WRIST, side: 'left' },
  { a: LM.RIGHT_SHOULDER, b: LM.RIGHT_ELBOW, side: 'right' },
  { a: LM.RIGHT_ELBOW, b: LM.RIGHT_WRIST, side: 'right' },

  // Legs
  { a: LM.LEFT_HIP, b: LM.LEFT_KNEE, side: 'left' },
  { a: LM.LEFT_KNEE, b: LM.LEFT_ANKLE, side: 'left' },
  { a: LM.RIGHT_HIP, b: LM.RIGHT_KNEE, side: 'right' },
  { a: LM.RIGHT_KNEE, b: LM.RIGHT_ANKLE, side: 'right' },

  // Feet
  { a: LM.LEFT_ANKLE, b: LM.LEFT_HEEL, side: 'left' },
  { a: LM.LEFT_HEEL, b: LM.LEFT_FOOT_INDEX, side: 'left' },
  { a: LM.RIGHT_ANKLE, b: LM.RIGHT_HEEL, side: 'right' },
  { a: LM.RIGHT_HEEL, b: LM.RIGHT_FOOT_INDEX, side: 'right' },

  // Head, enough to make orientation obvious at a glance
  { a: LM.LEFT_EAR, b: LM.NOSE, side: 'left' },
  { a: LM.RIGHT_EAR, b: LM.NOSE, side: 'right' },
];

/**
 * The landmarks every exercise depends on.
 *
 * Torso and limb joints only. Notably this excludes ankles: from a floor-level camera during a
 * push-up the feet are behind the body and unreliable, so requiring them would make the whole
 * pipeline drop out on exactly the exercise that needs it most. Exercises that genuinely need
 * ankles declare them in their own `requiredLandmarks`.
 */
export const CORE_LANDMARKS: readonly LandmarkIndex[] = [
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
  LM.LEFT_KNEE,
  LM.RIGHT_KNEE,
  LM.LEFT_ELBOW,
  LM.RIGHT_ELBOW,
];

/** Landmarks used to judge whether the user is framed correctly for a standing exercise. */
export const FRAMING_LANDMARKS: readonly LandmarkIndex[] = [
  LM.NOSE,
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
  LM.LEFT_ANKLE,
  LM.RIGHT_ANKLE,
];
