/**
 * Single tuning entry point.
 *
 * Every threshold in the system is reachable from here. Exercise-specific values live in their own
 * module — `exercises/squat.ts` owns `SQUAT_CONFIG` and nothing else may define a squat threshold —
 * but they are re-exported below so that tuning a session means opening one file to find out what
 * exists, rather than grepping for magic numbers.
 *
 * ## Provenance of the numbers
 * The thresholds are not guesses. They come from projecting an anthropometrically proportioned body
 * through a pinhole model of the exact camera placement the product specifies, and reading off the
 * measured separations:
 *
 *   npm run probe:geometry   - does the body fit; how badly are angles foreshortened
 *   npm run probe:signals    - which candidate signal is most invariant to body size and tilt
 *   npm run probe:features   - the feature table the disambiguation weights are set from
 *
 * ## What still needs real-world calibration
 * Synthetic data proves the geometry and the logic. It cannot prove the thresholds, because it has
 * no soft tissue, no clothing, no motion blur, and no MediaPipe failure modes. The values most
 * likely to need moving after the first real session, worst first:
 *
 *   1. `LUNGE_CONFIG.deadbandAnkleDz` and `wVoteAnkleDz` — MediaPipe's z has systematic error that
 *      no synthetic noise model predicts. The two z-free front-leg signals are weighted higher for
 *      exactly this reason; if z turns out unusable, set `wVoteAnkleDz` to 0 and the module keeps
 *      working.
 *   2. `SQUAT_CONFIG.depthExcursion` and `LUNGE_CONFIG.depthExcursion` — measured on a 1.75 m body
 *      at 21 degrees of tilt. Stable to +/-4% in simulation, but real squat style varies far more
 *      than body proportion does.
 *   3. `PUSHUP_CONFIG.sagFullAt` / `sagZeroAt` — the synthetic hip-sag model is the least
 *      trustworthy part of the generator, which is why `rejectSaggedReps` defaults to off.
 *   4. `DEFAULT_ONE_EURO.beta` — the lag/jitter trade-off cannot be judged without real jitter.
 */

export { DEFAULT_ONE_EURO, type OneEuroParams } from './oneEuro';
export { DEFAULT_CALIBRATION, type CalibrationConfig } from './calibration';
export { DEFAULT_FRAMING, type FramingConfig } from './framing';
export { DEFAULT_DISAMBIGUATION, type DisambiguationConfig } from './disambiguate';
export { DEFAULT_DEPTH_FSM, type DepthFsmConfig } from './depthFsm';
export {
  DEFAULT_CAMERA_CONFIG,
  defaultPipelineConfig,
  type CameraConfig,
  type PipelineConfig,
} from './pipeline';
export { SQUAT_CONFIG, PUSHUP_CONFIG, LUNGE_CONFIG } from './exercises';

/**
 * Frame-processing settings passed from JS to the native plugin.
 *
 * `targetLongEdge` is honoured on Android, which must convert YUV to RGB anyway and fuses a
 * downscale into that pass. On iOS the pixel buffer reaches MediaPipe as a Metal texture and is
 * resized on the GPU, so a CPU downscale there would cost time rather than save it; resolution is
 * controlled by camera-format selection instead.
 */
export interface NativeFrameConfig {
  /** Longest edge fed to the detector, in pixels. Try 256 and 320. */
  targetLongEdge: number;
  /**
   * Clockwise rotation needed to make the camera image upright, in degrees.
   *
   * Passed per frame rather than inferred natively. Wrong rotation on a floor-mounted portrait
   * phone produces plausible-looking but silently wrong joint angles, so this stays a value the
   * harness displays and can flip while watching the overlay.
   *
   * 90 is correct for a portrait phone, and measured on an iPhone 16 Pro front camera rather
   * than assumed: the sensor delivers 1280x720 landscape buffers that need a quarter turn
   * clockwise to stand upright. It was 0, which is wrong in two ways at once — MediaPipe saw a
   * sideways image, AND the quarter turn swaps which axis is which, so coordinates were
   * normalised against a 1.78 aspect instead of 0.56. The skeleton bore no relation to the body.
   *
   * A quarter turn is right for any phone held upright, so 90 is the correct default rather than
   * a device-specific tweak. Landscape use would need 0 or 180, which is why the override stays.
   * The robust version of this is to stop trusting a value from JS at all: VisionCamera's
   * `Frame.orientation` is already a UIImageOrientation, exactly what MPImage wants, so the
   * plugin can read the true orientation itself. That is a native change, so it waits for the
   * next build rather than risking a working one.
   */
  rotationDegrees: number;
}

export const DEFAULT_NATIVE_FRAME: NativeFrameConfig = {
  targetLongEdge: 320,
  rotationDegrees: 90,
};

/** Target the harness measures against, so the readout can flag a shortfall itself. */
export const LATENCY_TARGET_MS = 50;
