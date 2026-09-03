#!/usr/bin/env node
'use strict';

/**
 * Make React Native's prebuilt-dependency unpacking work with macOS's `cp`.
 *
 * Runs from `postinstall`, so it re-applies after every `npm install`. Also available as
 * `npm run patch:rn`.
 *
 * ## The bug
 * With RCT_USE_RN_DEP=1 (set in ios/Podfile, because Xcode 26 cannot compile the fmt 11.0.2 that
 * RN 0.80.3 pins), RN downloads a prebuilt ReactNativeDependencies.xcframework and unpacks it in
 * the podspec's `prepare_command`. The Maven tarball's layout is
 *
 *   packages/react-native/third-party/ReactNativeDependencies.xcframework
 *
 * and `spec.vendored_frameworks` expects the xcframework to end up at
 *
 *   framework/packages/react-native/ReactNativeDependencies.xcframework
 *
 * so the script copies the xcframework's PARENT DIRECTORY'S CONTENTS into place with:
 *
 *   cp -R "$XCFRAMEWORK_PATH/.." framework/packages/react-native/
 *
 * That only does what it intends under GNU cp, which copies the contents of a source whose final
 * component is `..`. BSD cp — macOS — instead takes the literal basename, computes the
 * destination `framework/packages/react-native/..`, finds it already there and fails:
 *
 *   cp: framework/packages/react-native/..: File exists
 *
 * `prepare_command` runs under `set -e`, so `pod install` aborts. And because the two lines after
 * the copy delete the original files, letting the error slide is not an option either — a partly
 * prepared pod is worse than a failed one.
 *
 * ## The fix
 * Ask for the contents explicitly: `"$XCFRAMEWORK_PATH/../."`. That is the same idiom RN already
 * uses one line earlier for the headers (`cp -R "$HEADERS_PATH/." Headers`), it means exactly the
 * same thing to both cp implementations, and it is a one-character change. Verified against the
 * real 0.80.3 tarball layout: the xcframework lands where vendored_frameworks looks for it, and
 * the binary survives the subsequent `find -exec rm`.
 *
 * ## Why patch node_modules rather than the Podfile
 * `prepare_command` runs while CocoaPods is downloading the pod, which is before `pre_install`
 * and every other Podfile hook. There is no hook that can reach it.
 *
 * Delete this script once React Native ships the portable form upstream, or once this project
 * moves to RN 0.83+, whose fmt 12.1.0 compiles under Xcode 26 and makes RCT_USE_RN_DEP
 * unnecessary in the first place.
 */

const fs = require('fs');
const path = require('path');

const PODSPEC = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native',
  'third-party-podspecs',
  'ReactNativeDependencies.podspec'
);

const BROKEN = 'cp -R "$XCFRAMEWORK_PATH/.." framework/packages/react-native/';
const FIXED = 'cp -R "$XCFRAMEWORK_PATH/../." framework/packages/react-native/';

function main() {
  // Not an error: Android-only checkouts and the CI lint/test job never install iOS tooling, and
  // a missing file here must not fail `npm install`.
  if (!fs.existsSync(PODSPEC)) {
    console.log('[patch-rn-podspec] react-native not installed yet, nothing to do');
    return;
  }

  const before = fs.readFileSync(PODSPEC, 'utf8');

  if (before.includes(FIXED)) {
    console.log('[patch-rn-podspec] already patched');
    return;
  }

  if (!before.includes(BROKEN)) {
    // Either RN fixed it upstream or the script changed shape. Either way this patch is now
    // guesswork, so say so loudly instead of silently doing nothing — a silent no-op here
    // resurfaces as an opaque `pod install` failure much later.
    console.warn(
      '[patch-rn-podspec] NOTE: the expected `cp -R "$XCFRAMEWORK_PATH/.."` line is not in\n' +
        `  ${path.relative(path.join(__dirname, '..'), PODSPEC)}\n` +
        '  Nothing was changed. If React Native fixed this upstream, delete scripts/patch-rn-podspec.js\n' +
        '  and its postinstall hook. If `pod install` fails unpacking ReactNativeDependencies, read\n' +
        "  that file's prepare_command and compare against the comment at the top of this script."
    );
    return;
  }

  fs.writeFileSync(PODSPEC, before.split(BROKEN).join(FIXED));
  console.log('[patch-rn-podspec] patched ReactNativeDependencies.podspec for BSD/macOS cp');
}

main();
