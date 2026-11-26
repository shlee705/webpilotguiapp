'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBackendPaths } = require('../electron/backend-paths.cjs');

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'webpilot-backend-paths-'));
  t.after(() => {
    const target = fs.realpathSync(root), relative = path.relative(base, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(target).startsWith('webpilot-backend-paths-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'webpilot-desktop', webpilotWorkspace: 'webpilot-report-root-v1' }));
  const backend = path.join(root, 'webtestpilot-backend');
  fs.mkdirSync(path.join(backend, 'qa', 'src'), { recursive: true });
  fs.writeFileSync(path.join(backend, 'qa', 'src', 'cli.ts'), '// Source ZIP: dependencies are intentionally absent.\n');
  const resources = path.join(root, 'release', '1.0.3', 'win-unpacked', 'resources');
  return { root, backend, resources };
}

test('a packaged executable inside a source ZIP ignores the ancestor workspace backend', t => {
  const f = fixture(t);
  assert.ok(!fs.existsSync(path.join(f.backend, 'node_modules')));
  const actual = resolveBackendPaths({ appPath: path.join(f.resources, 'app.asar'), resourcesPath: f.resources, isPackaged: true },
    () => { throw new Error('Packaged path selection must not probe a source workspace or external runtime.'); });
  assert.deepEqual(actual, { backendRoot: path.join(f.resources, 'webtestpilot-backend'),
    nodePath: path.join(f.resources, 'backend-runtime', 'node.exe') });
  assert.notEqual(actual.backendRoot, f.backend);
});

test('missing packaged resources never fall back to source files or system Node', t => {
  const f = fixture(t);
  const actual = resolveBackendPaths({ appPath: f.root, resourcesPath: f.resources, isPackaged: true }, () => false);
  assert.equal(actual.backendRoot, path.join(f.resources, 'webtestpilot-backend'));
  assert.equal(actual.nodePath, path.join(f.resources, 'backend-runtime', 'node.exe'));
  assert.notEqual(actual.nodePath, 'node');
  assert.throws(() => resolveBackendPaths({ appPath: f.root, resourcesPath: 'resources', isPackaged: true }));
});

test('development keeps its workspace backend and its existing Node fallback', t => {
  const f = fixture(t);
  const options = { appPath: f.root, resourcesPath: f.resources, isPackaged: false };
  assert.deepEqual(resolveBackendPaths(options), { backendRoot: f.backend, nodePath: 'node' });
  const runtime = path.join(f.root, 'artifacts', 'backend-runtime', 'node.exe');
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, 'fixture-runtime');
  assert.deepEqual(resolveBackendPaths(options), { backendRoot: f.backend, nodePath: runtime });
});
