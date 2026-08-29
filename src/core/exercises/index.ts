/**
 * The exercise registry.
 *
 * Worklet-safe.
 *
 * Adding an exercise is: write the module, import it, add it to `EXERCISE_REGISTRY`. Nothing in
 * `pipeline.ts` or `disambiguate.ts` references a specific exercise, so neither changes.
 *
 * Order matters only for tie-breaking and for the order of `RecognitionDebug.confidences`.
 */

import type { ExerciseModule } from '../exercise';
import { squatModule } from './squat';
import { pushupModule } from './pushup';
import { lungeModule } from './lunge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EXERCISE_REGISTRY: readonly ExerciseModule<any>[] = [
  squatModule,
  pushupModule,
  lungeModule,
];

export { squatModule, pushupModule, lungeModule };
export { SQUAT_CONFIG, SQUAT_GATES } from './squat';
export { PUSHUP_CONFIG, PUSHUP_GATES } from './pushup';
export { LUNGE_CONFIG, LUNGE_GATES, alternationRate } from './lunge';
