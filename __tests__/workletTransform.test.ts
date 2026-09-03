/**
 * Does the worklets-core Babel plugin actually survive our source?
 *
 * ## Why this exists
 * Every other test in this repo runs the recognition core as ordinary Node functions, because
 * babel.config.js deliberately drops `react-native-worklets-core/plugin` under NODE_ENV=test (a
 * `'worklet';` directive is an inert string expression to a plain JS engine, so the transform is
 * pure risk there). That is the right call for the tests — and it means the tests can never fail
 * for a reason that only exists inside that plugin.
 *
 * Which is exactly what happened. 107 green tests, and the iPhone build died with:
 *
 *   Error: src/core/oneEuro.ts: Cannot find module '@babel/preset-typescript'
 *     at makeWorklet (react-native-worklets-core/src/plugin/index.js:413)
 *
 * The cause is that `makeWorklet` re-enters Babel with `configFile: false, babelrc: false` and a
 * hardcoded list of presets and plugins named as STRINGS, which Babel then resolves from the
 * app's own node_modules. worklets-core declares none of them. So every name on that list is a
 * silent dependency of ours, and one missing name breaks the device build only.
 *
 * Worse, the ones that do resolve today mostly resolve by accident: they are hoisted transitives
 * of @babel/preset-env, not anything we asked for. A dependency bump that stops hoisting them
 * breaks the build with no source change at all.
 *
 * ## What is checked
 * 1. Run the plugin over every source carrying a `'worklet';` directive and require no throw.
 *    This is the actual device transform, so it catches a missing dependency, a plugin version
 *    that rejects our syntax, and any future worklets-core change to that hardcoded list.
 * 2. Read the list out of the installed plugin's source and assert each entry is declared in our
 *    package.json — not merely resolvable. Reading it from the plugin rather than restating it
 *    here is the point: an upgrade that adds a seventh name fails this test instead of failing
 *    on someone's phone.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');

/** Sources whose functions get hoisted into the worklet runtime. */
function workletSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes("'worklet'")) {
        out.push(p);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return out.sort();
}

describe('worklets-core babel plugin', () => {
  const sources = workletSources();

  it('finds the worklet sources it is supposed to check', () => {
    // A refactor that renames or moves src/core must not turn this suite into a no-op that
    // silently passes.
    expect(sources.length).toBeGreaterThanOrEqual(10);
    expect(sources.some((s) => s.endsWith('oneEuro.ts'))).toBe(true);
    expect(sources.some((s) => s.endsWith('pipeline.ts'))).toBe(true);
  });

  it.each(sources.map((s) => [path.relative(ROOT, s), s]))(
    'transforms %s with the plugin enabled',
    (_rel, abs) => {
      // A child process with NODE_ENV unset, because this very test file runs under
      // NODE_ENV=test, which is the condition babel.config.js uses to REMOVE the plugin. Asking
      // Babel in-process would transform without the plugin and prove nothing.
      const script = `
        const babel = require('@babel/core');
        const out = babel.transformFileSync(${JSON.stringify(abs)}, {
          presets: ['module:@react-native/babel-preset'],
          plugins: ['react-native-worklets-core/plugin'],
          configFile: false,
          babelrc: false,
        });
        if (!out || typeof out.code !== 'string') throw new Error('no output');
      `;
      // Throws on a nonzero exit, and the plugin's own error text lands in the failure message.
      execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'production', BABEL_ENV: 'production' },
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
    },
    30000
  );

  it('declares every preset and plugin the installed plugin resolves by name', () => {
    const pluginSrc = fs.readFileSync(
      path.join(ROOT, 'node_modules/react-native-worklets-core/src/plugin/index.js'),
      'utf8'
    );

    // Only the names inside `presets:` / `plugins:` array literals, because only those are handed
    // to Babel as strings and resolved against OUR node_modules. The plugin's own top-level
    // require()s of @babel/generator and @babel/traverse are deliberately not covered here: Node
    // resolves those from worklets-core's own directory upward, and they arrive guaranteed with
    // @babel/core, which we do declare. Declaring them ourselves would pin them independently of
    // @babel/core, and Babel requires that trio version-matched — so listing them would swap a
    // hypothetical resolution failure for a real mismatch.
    const names = new Set<string>();
    const key = /(?:presets|plugins)\s*:\s*\[/g;
    for (let m = key.exec(pluginSrc); m !== null; m = key.exec(pluginSrc)) {
      // Balanced scan from the opening bracket, so a nested entry such as
      // ["@babel/plugin-transform-template-literals", { loose: true }] is included whole rather
      // than truncated at its own closing bracket.
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < pluginSrc.length; i++) {
        const c = pluginSrc[i];
        if (c === '[') depth++;
        else if (c === ']' && --depth === 0) break;
      }
      const body = pluginSrc.slice(m.index, i);
      for (const q of body.match(/["'`]@babel\/[\w-]+["'`]/g) ?? []) {
        names.add(q.slice(1, -1));
      }
    }

    // worklets-core 1.6.3 names one preset and five plugins. A floor guards against the scan
    // silently matching nothing and the assertion below passing vacuously.
    expect(names.size).toBeGreaterThanOrEqual(6);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    const undeclared = [...names].filter((n) => !(n in declared)).sort();
    expect(undeclared).toEqual([]);
  });
});
