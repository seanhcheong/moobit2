/**
 * Babel config.
 *
 * `react-native-worklets-core/plugin` is what lets the pure recognition core in `src/core` be
 * *called from inside* a VisionCamera frame processor. Functions in the core carry a `'worklet';`
 * directive as their first statement; this plugin hoists them into the worklet runtime so the
 * whole recognition path runs on the frame-processor thread and never touches the JS thread.
 *
 * ## Why the plugin is excluded by an `if`, not by `env.test`
 * Babel MERGES an `env` block on top of the root config rather than replacing it, so putting the
 * plugin at the root and an empty `plugins: []` under `env.test` leaves the plugin active in
 * tests. An explicit conditional is the only thing that actually removes it. Jest sets
 * `NODE_ENV=test`, and `BABEL_ENV` is honoured too for anything that sets it instead.
 *
 * Excluding it matters because Jest and the offline replay CLI run the very same core modules as
 * ordinary Node functions — a `'worklet';` directive is an inert string expression to a plain JS
 * engine — so the transform is pure risk there with nothing to gain.
 *
 * ## The two legacy @babel/plugin-proposal-* devDependencies
 * worklets-core 1.6.3's plugin internally requires `@babel/plugin-proposal-optional-chaining` and
 * `@babel/plugin-proposal-nullish-coalescing-operator`, which Babel renamed to
 * `plugin-transform-*` and which RN 0.81's preset therefore no longer installs. worklets-core does
 * not declare them either, so without those two devDependencies the build fails with
 * "Cannot find module '@babel/plugin-proposal-optional-chaining'". This affects the real Android
 * and iOS builds, not only the tests. Remove them only once worklets-core stops asking for the
 * pre-rename names.
 */
const isTest = process.env.NODE_ENV === 'test' || process.env.BABEL_ENV === 'test';

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: isTest ? [] : ['react-native-worklets-core/plugin'],
};
