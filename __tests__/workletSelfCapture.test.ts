/**
 * Worklets must not capture the binding of the object literal they are defined inside.
 *
 * ## The bug this exists for
 * The worklets-core Babel plugin rewrites a `'worklet'` function so its free variables are read
 * from a closure object captured WHEN THE FUNCTION IS CREATED:
 *
 *   _f.__closure = { pipeline: pipeline };
 *   // body becomes: const { pipeline } = this.__closure; pipeline.mode = ...
 *
 * So `const pipeline: Pipeline = { setBaseline(b) { 'worklet'; pipeline.baseline = b; } }`
 * evaluates that capture partway through the initialiser of the binding it reads. React Native's
 * preset compiles the `const` to a `var`, so rather than a TDZ error the worklet captures
 * `undefined` permanently and every call fails with
 *
 *   TypeError: Cannot read property 'setBaseline' of undefined
 *
 * which is what the app did on device, on the first frame.
 *
 * ## Why the existing tests could not see it
 * babel.config.js drops the worklets plugin under NODE_ENV=test — correctly, since the core runs
 * as ordinary Node functions in Jest and the replay CLI. Untransformed closures bind late, so the
 * code works fine there. 124 tests passed while the recognition path was completely dead on
 * device.
 *
 * __tests__/workletTransform.test.ts closed half of that gap by checking the sources still
 * TRANSFORM. This closes the other half: transformed worklets must also RUN. That distinction is
 * the whole point — this bug compiled perfectly.
 *
 * ## Two independent checks
 * 1. A static AST check for the shape, over every worklet in the tree. Cheap, and it names the
 *    offending function and line rather than leaving a stack trace to decode.
 * 2. Actually building a pipeline from the *transformed* module and calling the methods. This is
 *    the ground truth; it would have failed with the device's exact error.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');

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

/** Node script body: reports `file:line worklet captures binding` for the broken shape. */
const SCAN = `
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const fs = require('fs');
const files = JSON.parse(process.argv[1]);
const found = [];

const hasWorklet = (n) =>
  n.body && n.body.type === 'BlockStatement' &&
  (n.body.directives || []).some((d) => d.value.value === 'worklet');

for (const file of files) {
  const ast = parser.parse(fs.readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript'],
  });
  traverse(ast, {
    'FunctionExpression|ArrowFunctionExpression|ObjectMethod|FunctionDeclaration'(p) {
      if (!hasWorklet(p.node)) return;

      // The variable declarator whose initialiser this worklet lives inside, if any.
      const decl = p.findParent((a) => a.isVariableDeclarator());
      if (!decl || !decl.node.id || decl.node.id.type !== 'Identifier') return;
      const name = decl.node.id.name;

      // Does the worklet read that same binding?
      let refs = 0;
      p.traverse({
        Identifier(ip) {
          if (ip.node.name !== name || !ip.isReferencedIdentifier()) return;
          const b = ip.scope.getBinding(name);
          if (b && b.path.node === decl.node) refs++;
        },
      });

      if (refs > 0) {
        const fn = (p.node.key && p.node.key.name) || (p.node.id && p.node.id.name) || '(anonymous)';
        found.push(file + ':' + p.node.loc.start.line + '  ' + fn + '() captures \\'' + name + '\\'');
      }
    },
  });
}
console.log(JSON.stringify(found));
`;

describe('worklet closure capture', () => {
  it('no worklet captures the binding of the literal it is defined in', () => {
    const sources = workletSources();
    expect(sources.length).toBeGreaterThanOrEqual(10);

    const raw = execFileSync(process.execPath, ['-e', SCAN, JSON.stringify(sources)], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    const offenders: string[] = JSON.parse(raw.trim());
    expect(offenders.map((o) => path.relative(ROOT, o))).toEqual([]);
  });

  it('a transformed pipeline actually runs its own methods', () => {
    // Built and exercised in a child process with NODE_ENV unset, because this file runs under
    // NODE_ENV=test — the very condition babel.config.js uses to REMOVE the worklets plugin.
    // Requiring the module in-process would load an untransformed copy and prove nothing.
    const script = `
      // A minimal require hook, rather than pulling in @babel/register for one test (it also
      // conflicts on peers here). Registering the extension is what makes Node's resolver try
      // '.ts' for the extensionless imports inside the core.
      const babel = require('@babel/core');
      require.extensions['.ts'] = function (m, filename) {
        m._compile(babel.transformFileSync(filename, {
          presets: ['module:@react-native/babel-preset'],
          plugins: ['react-native-worklets-core/plugin'],
          configFile: false,
          babelrc: false,
        }).code, filename);
      };

      const { createPipeline } = require('./src/core/pipeline.ts');
      const p = createPipeline();

      // Each of these self-referred through the closure and threw
      // "Cannot read property '<x>' of undefined" on device.
      p.beginCalibration();
      if (p.mode !== 'calibrating') throw new Error('beginCalibration did not set mode, got ' + p.mode);

      p.cancelCalibration();
      if (p.mode !== 'framing') throw new Error('cancelCalibration did not set mode, got ' + p.mode);

      p.setBaseline({ hipRatio: 1, kneeAngle: 170, capturedAtMs: 0 });
      if (p.mode !== 'running') throw new Error('setBaseline did not set mode, got ' + p.mode);
      if (!p.baseline) throw new Error('setBaseline did not store the baseline');

      p.reset();
      if (p.mode !== 'framing' || p.baseline !== null) throw new Error('reset did not clear state');

      p.resetCounters();

      // processFrame self-refers ten times, so it was dead too. A rejected native result is
      // enough to exercise the self-referring paths without needing synthetic landmarks.
      const out = p.processFrame({ ok: false, hasResult: false, error: 'test', nowMs: 1 }, 1, 0);
      if (!out || typeof out.mode !== 'string') throw new Error('processFrame returned nothing usable');

      console.log('OK');
    `;

    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', BABEL_ENV: 'production' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(out.trim().split('\n').pop()).toBe('OK');
  }, 60000);
});
