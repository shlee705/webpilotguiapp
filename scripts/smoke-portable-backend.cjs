'use strict';

// Usage: node scripts/smoke-portable-backend.cjs <win-unpacked directory>
// Copies only shipped backend resources to an isolated temp root. No model API,
// development dependencies, user settings, or production reports are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

// The isolated preload also applies to the real Playwright worker processes.
// Keep the local HTTP fixture available, but prevent model transports entirely.
const NETWORK_GUARD = `
  const deny = () => { throw new Error('External/model transport is forbidden in the portable smoke.'); };
  globalThis.fetch = async () => deny();
  const https = require('node:https');
  https.request = https.get = deny;
  require('node:module').syncBuiltinESMExports();
`;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function verifyReducedBackend(backend) {
  assert.ok(!fs.existsSync(path.join(backend, '.env')), 'Do not test a package containing backend credentials.');
  const browsers = fs.readdirSync(path.join(backend, '.browsers'));
  assert.ok(browsers.some(name => /^chromium_headless_shell-\d+$/.test(name)), 'Bundled Headless Shell is required.');
  assert.ok(!browsers.some(name => /^chromium-\d+$/.test(name)), 'This smoke must exercise the reduced package without full Chromium.');
  for (const name of ['typescript', '@typescript', '@types/node', 'undici-types']) {
    assert.ok(!fs.existsSync(path.join(backend, 'qa', 'node_modules', name)), `QA development dependency is still bundled: ${name}`);
  }
}

async function childSmoke(directory) {
  assert.equal(process.env.WEBPILOT_PORTABLE_GUARD, '1');
  assert.ok(process.env.NODE_OPTIONS.includes(path.join(directory, 'network-guard.cjs').replaceAll('\\', '/')));
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(directory, 'node.exe')));
  assert.ok(!Object.keys(process.env).some(name => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^NODE_PATH$/i.test(name)));
  const backend = path.join(directory, 'webtestpilot-backend');
  verifyReducedBackend(backend);
  const backendRequire = createRequire(path.join(backend, 'package.json'));
  const qaRequire = createRequire(path.join(backend, 'qa', 'package.json'));
  for (const [loader, specifier] of [[backendRequire, 'playwright'], [backendRequire, '@playwright/test'],
    [qaRequire, '@anthropic-ai/sdk'], [qaRequire, '@modelcontextprotocol/sdk/server/index.js']]) {
    assert.ok(inside(backend, fs.realpathSync(loader.resolve(specifier))), 'Dependencies must resolve inside the isolated shipped backend.');
  }
  assert.throws(() => qaRequire.resolve('typescript'), { code: 'MODULE_NOT_FOUND' });
  const source = name => import(pathToFileURL(path.join(backend, 'qa', 'src', name)).href);
  const [{ runPlan }, { judge }, { Budget }, { writeReport }] = await Promise.all([
    source('run.ts'), source('triage.ts'), source('agent.ts'), source('report.ts'),
  ]);
  const { chromium } = backendRequire('playwright');
  let requests = 0, modelCalls = 0, browser;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    requests++;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="en"><head><title>Portable backend smoke</title></head><body><main>'
      + '<h1>Portable backend smoke</h1><button type="button" onclick="document.getElementById(\'status\').textContent=\'Complete\'">Run check</button>'
      + '<p id="status" role="status">Ready</p></main></body></html>');
  });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    await page.goto(url);
    assert.equal(await page.getByRole('status').textContent(), 'Ready');
    assert.equal(await page.getByRole('button', { name: 'Run check', exact: true }).count(), 1);
    await page.close();
    const plan = { version: 1, requirements: [{ id: 'R1', text: 'Clicking Run check changes the status to Complete.' }],
      features: [], observations: [], questions: [], unplanned: [],
      targets: {
        T1: { target: { role: 'button', name: '^Run check$' }, group: false, url },
        T2: { target: { role: 'status' }, group: false, url },
      },
      scenarios: [{ id: 'S1', title: 'Local status changes after a real click', covers: ['R1'], start: { url },
        steps: [{ id: 'S1.A1', op: 'click', target: 'T1' }],
        checks: [{ id: 'S1.C1', after: 'S1.A1', target: 'T2', read: 'text', op: 'equals', expected: 'Complete',
          source: { kind: 'requirement', id: 'R1', quote: 'changes the status to Complete' } }] }],
    };
    const out = path.join(directory, 'result');
    fs.mkdirSync(out);
    const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value));
    save('plan.json', plan);
    save('explore.json', { complete: true, sitemap: { visited: [url], unvisited: [], failed: [], templates: [{ key: url, pages: [url] }] },
      conversations: [{ template: url, url, stop: 'done', turns: 0, planned: true, detail: 'Deterministic local smoke fixture plan; no model.' }] });
    save('summary.json', { startUrl: url, provider: 'openai', spentUsd: 0, budgetUsd: 0,
      models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna' } });
    const run = await runPlan({ plan, policy: { origins: [new URL(url).origin], allowWrites: false },
      runDir: path.join(out, 'run'), workers: 1, timeoutMs: 5000 });
    assert.equal(run.exitCode, 0, fs.readFileSync(path.join(out, 'run', 'playwright.log'), 'utf8'));
    assert.deepEqual(run.problems, []);
    assert.equal(run.scenarios.length, 1);
    assert.equal(run.scenarios[0].valid, true);
    assert.equal(run.scenarios[0].start, 'ok');
    assert.deepEqual(run.scenarios[0].steps.map(step => step.status), ['ok']);
    assert.deepEqual(run.scenarios[0].checks.map(check => [check.status, check.actual]), [['passed', 'Complete']]);
    const send = async () => { modelCalls++; throw new Error('No model call is permitted in this passing fixture.'); };
    const budget = new Budget(0);
    const judgment = await judge({ plan, run, send, model: 'gpt-6-luna', budget, reproduceDir: path.join(out, 'repro') });
    assert.equal(judgment.stage, 'done');
    assert.equal(judgment.verdicts.find(item => item.id === 'S1.C1').class, 'passed');
    const written = await writeReport(out, browser);
    assert.ok(written.pdf, written.pdfError);
    const pdf = fs.readFileSync(path.join(out, 'report.pdf'));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 1000 && pdf.subarray(-1024).includes(Buffer.from('%%EOF')));
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.run.endReason, 'completed');
    assert.deepEqual(report.run.scenarios, { planned: 1, started: 1 });
    assert.equal(report.passed.checks, 1);
    assert.equal(report.bugs.length, 0);
    assert.equal(modelCalls, 0);
    assert.equal(budget.spent, 0);
    assert.ok(requests >= 2, 'Both observation and the independent Playwright worker must visit the local fixture.');
    console.log(JSON.stringify({ passed: true, isolatedShippedRuntime: true, node: process.version,
      playwright: backendRequire('playwright/package.json').version, headlessShellOnly: true, qaCompilerAbsent: true,
      realScenarios: 1, passedChecks: 1, actualClicks: 1, pdfBytes: pdf.length, modelCalls, spentUsd: budget.spent }));
  } finally {
    await browser?.close();
    await new Promise(done => server.close(() => done()));
  }
}

function portableSmoke(bundle) {
  assert.ok(bundle, 'Usage: node scripts/smoke-portable-backend.cjs <win-unpacked directory>');
  const resources = path.join(fs.realpathSync(path.resolve(bundle)), 'resources');
  const source = path.join(resources, 'webtestpilot-backend');
  verifyReducedBackend(source);
  const base = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, 'webpilot-portable-backend-'));
  assert.ok(!inside(path.resolve(__dirname, '..'), directory), 'The smoke must run outside the development workspace.');
  try {
    fs.cpSync(source, path.join(directory, 'webtestpilot-backend'), { recursive: true, filter(file) {
      assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'Do not follow package links into development dependencies.');
      assert.ok(!/^\.env(?:\.|$)|^(?:ai-settings|auth_state|storage_state|storageState|credentials)\.json$/i.test(path.basename(file)), 'Private package file rejected.');
      return true;
    } });
    fs.copyFileSync(path.join(resources, 'backend-runtime', 'node.exe'), path.join(directory, 'node.exe'));
    fs.copyFileSync(__filename, path.join(directory, 'smoke.cjs'));
    fs.writeFileSync(path.join(directory, 'network-guard.cjs'), NETWORK_GUARD);
    const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOME|LANG|LC_ALL|TZ)$/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name)));
    Object.assign(env, { WEBPILOT_PORTABLE_GUARD: '1', NODE_OPTIONS: `--require ${JSON.stringify(path.join(directory, 'network-guard.cjs').replaceAll('\\', '/'))}`,
      PLAYWRIGHT_BROWSERS_PATH: path.join(directory, 'webtestpilot-backend', '.browsers'), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', CI: '1' });
    const result = spawnSync(path.join(directory, 'node.exe'), [path.join(directory, 'smoke.cjs'), '--child', directory],
      { cwd: directory, env, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.ok(!result.error, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(output.passed, true);
    console.log(JSON.stringify(output));
  } finally {
    const target = fs.realpathSync(directory);
    assert.ok(inside(base, target) && path.basename(target).startsWith('webpilot-portable-backend-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (require.main === module) {
  Promise.resolve().then(() => process.argv[2] === '--child' ? childSmoke(path.resolve(process.argv[3])) : portableSmoke(process.argv[2]))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
}
