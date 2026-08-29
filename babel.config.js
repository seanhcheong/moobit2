/**
 * Babel config.
 *
 * `react-native-worklets-core/plugin` is what lets the pure recognition core in `src/core`
 * be *called from inside* a VisionCamera frame processor. Functions in the core carry a
 * `'worklet';` directive as their first statement; this plugin hoists them into the worklet
 * runtime so the whole recognition path runs on the frame-processor thread and never touches
 * the JS thread.
 *
 * The plugin is deliberately DISABLED under `env.test`: Jest and the offline replay CLI run
 * the very same core modules as ordinary Node functions (a `'worklet';` directive is just an
 * inert string expression to a plain JS engine), so the transform is unnecessary there and
 * only adds a failure mode. This is the mechanism that lets one source of truth be both
 * worklet-executable on device and unit-testable off device.
 */
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-worklets-core/plugin'],
  env: {
    test: {
      plugins: [],
    },
  },
};
