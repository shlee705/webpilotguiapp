'use strict';

// Execute the shared local fixture inside the packaged Electron main process.
// Every product module comes from app.asar, with an isolated app/Edge profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

async function main() {
  const project = path.resolve(__dirname, '..');
  const executable = process.env.WEBPILOT_EXECUTABLE;
  assert.ok(executable, 'WEBPILOT_EXECUTABLE must name the packaged WebPilot executable.');
  const expectedVersion = process.env.EXPECTED_WEBPILOT_VERSION || JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-publish-desktop-'));
  const environment = { ...process.env, ELECTRON_DEV: '0' };
  delete environment.ELECTRON_RUN_AS_NODE;
  let desktop;
  let result;
  try {
    desktop = await _electron.launch({ executablePath: path.resolve(executable), args: [`--user-data-dir=${profile}`], env: environment });
    const window = await desktop.firstWindow();
    await window.waitForSelector('#root > *');
    result = await desktop.evaluate(async ({ app, BrowserWindow }, input) => {
      const nativeRequire = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const assert = nativeRequire('node:assert/strict');
      const fs = nativeRequire('node:fs');
      const path = nativeRequire('node:path');
      const appPath = app.getAppPath();
      assert.ok(appPath.endsWith('app.asar'), 'The registration fixture must exercise packaged product modules.');
      assert.equal(app.getVersion(), input.expectedVersion);
      assert.equal(path.resolve(app.getPath('userData')).toLowerCase(), path.resolve(input.profile).toLowerCase(), 'The test must use its isolated profile.');
      const modulePaths = [];
      const fixtureRequire = specifier => {
        if (specifier.startsWith('../electron/')) {
          assert.match(specifier, /^\.\.\/electron\/[a-z0-9-]+\.cjs$/);
          const nativePath = path.join(appPath, 'electron', specifier.slice('../electron/'.length));
          const resolved = nativeRequire.resolve(nativePath);
          assert.ok(resolved.startsWith(`${appPath}${path.sep}`));
          modulePaths.push(path.relative(appPath, resolved));
          return nativeRequire(resolved);
        }
        assert.ok(specifier.startsWith('node:'), `Unexpected fixture dependency: ${specifier}`);
        return nativeRequire(specifier);
      };
      const fixtureModule = { exports: {} };
      const source = fs.readFileSync(input.fixtureFile, 'utf8');
      new Function('require', 'module', 'exports', source)(fixtureRequire, fixtureModule, fixtureModule.exports);
      assert.equal(typeof fixtureModule.exports.main, 'function');
      const fixture = await fixtureModule.exports.main();
      assert.equal(fixture.passed, true);
      assert.equal(modulePaths.length, 3);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      return { ...fixture, version: app.getVersion(), packaged: true, isolatedProfile: true, productModules: modulePaths };
    }, { expectedVersion, profile, fixtureFile: path.join(project, 'scripts', 'smoke-site-publish.cjs') });
  } finally { await desktop?.close(); }
  console.log(JSON.stringify({ ...result, applicationClosed: true }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
