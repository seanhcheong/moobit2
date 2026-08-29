/**
 * Dev-only feature gating.
 *
 * The telemetry path is a development convenience and must not exist in a release build. `__DEV__`
 * is a compile-time constant that Metro replaces with a literal, so an `if (!__DEV__) return;`
 * guard lets the minifier remove the branch and everything only that branch reaches. That is why
 * every telemetry entry point is guarded rather than merely configured off: a config flag ships
 * the code and hopes nobody sets it.
 */

/** True in a debug build, false in release. Replaced at build time by Metro. */
export const IS_DEV: boolean = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

/**
 * Whether the dev telemetry client is compiled in at all.
 *
 * Never make this configurable at runtime. The whole guarantee is that a release build contains
 * no code that can POST a session anywhere.
 */
export const TELEMETRY_ENABLED = IS_DEV;

/** Whether the raw landmark replay log may be recorded. Large files; dev only. */
export const REPLAY_LOGGING_ENABLED = IS_DEV;

export const DEV_SERVER_DEFAULTS = {
  /** Overwritten from the in-app settings; the phone must reach the dev machine's LAN address. */
  host: '127.0.0.1',
  port: 8787,
  /** Short, so an unreachable server costs a moment rather than blocking the end of a session. */
  timeoutMs: 4000,
  /** Frames per raw-log chunk. Bounds both memory and the size of a single POST. */
  rawChunkFrames: 300,
};
