module.exports = {
  root: true,
  extends: '@react-native',
  ignorePatterns: ['node_modules/', 'sessions/', 'android/', 'ios/', 'tools/'],
  overrides: [
    {
      // The recognition core must run unchanged in three environments: the VisionCamera
      // frame-processor worklet, Node (Jest and the replay CLI), and the RN JS thread. Two
      // idioms follow from that and would otherwise be flagged 40+ times.
      files: ['src/core/**/*.ts', 'src/dev/**/*.ts'],
      rules: {
        // `v === v` is the NaN test used throughout. It is not a pointless self-comparison: it is
        // the only NaN check guaranteed available in a worklet runtime, where `Number.isNaN` may
        // not be, and it is faster than a function call on the per-frame hot path.
        'no-self-compare': 'off',
        // Bit operations are deliberate: fixed-point colour conversion, integer halving in the
        // median, and the seedable PRNG that keeps every test reproducible.
        'no-bitwise': 'off',
      },
    },
    {
      files: ['src/app/**/*.ts', 'src/app/**/*.tsx'],
      rules: {
        // `void somePromise()` is how a deliberately un-awaited promise is marked here, which is
        // more informative than an unmarked floating promise.
        'no-void': 'off',
      },
    },
    {
      files: ['__tests__/**/*.ts', '__tests__/**/*.tsx'],
      rules: {
        'no-self-compare': 'off',
      },
    },
  ],
};
