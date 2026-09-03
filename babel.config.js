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
 * ## The six @babel/* devDependencies nothing here imports
 * worklets-core's `makeWorklet` re-enters Babel with `configFile: false, babelrc: false` and its
 * own hardcoded list of one preset and five plugins, named as STRINGS which Babel then resolves
 * against THIS package's node_modules. worklets-core declares none of them, so all six are
 * silent dependencies of ours:
 *
 *   @babel/preset-typescript
 *   @babel/plugin-transform-shorthand-properties
 *   @babel/plugin-transform-arrow-functions
 *   @babel/plugin-transform-template-literals
 *   @babel/plugin-proposal-optional-chaining              <- pre-rename names; Babel now calls
 *   @babel/plugin-proposal-nullish-coalescing-operator       these plugin-transform-*
 *
 * A missing one fails ONLY the real Android/iOS build, with e.g. "Cannot find module
 * '@babel/preset-typescript'" — never the tests, since the `isTest` branch above removes the very
 * plugin that would ask for it. __tests__/workletTransform.test.ts closes that gap by running
 * this plugin over every `'worklet';` source in a child process with NODE_ENV unset, and by
 * re-reading the list out of the installed plugin so an upgrade that adds a seventh name fails a
 * test rather than someone's phone.
 *
 * Do not drop any of the six because `npm ls` shows it arriving anyway — four of them are
 * hoisted transitives of @babel/preset-env, present by accident of npm's flat layout rather than
 * by anyone's declaration.
 */
const isTest = process.env.NODE_ENV === 'test' || process.env.BABEL_ENV === 'test';

module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: isTest ? [] : ['react-native-worklets-core/plugin'],
};
