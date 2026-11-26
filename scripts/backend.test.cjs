'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createBackendRunner, backendEnvironment, safeProgress, FIXED_MODELS } = require('../electron/backend.cjs');
const { BACKEND_RUN_DEFAULTS } = require('../electron/backend-run-options.cjs');
const RUN_FLAGS = { budgetUsd: 'budget', exploreMinutes: 'explore-minutes', maxPages: 'max-pages', maxTemplates: 'max-templates',
  turnsPerTemplate: 'turns-per-template', maxTurns: 'max-turns', pagesPerTemplate: 'pages-per-template',
  concurrency: 'concurrency', workers: 'workers', planEffort: 'plan-effort', sessions: 'sessions' };
const readParameters = args => Object.fromEntries(Object.entries(RUN_FLAGS).map(([key, flag]) => [key,
  typeof BACKEND_RUN_DEFAULTS[key] === 'number' ? Number(args[args.indexOf(`--${flag}`) + 1]) : args[args.indexOf(`--${flag}`) + 1]]));

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webpilot-backend-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const backendRoot = path.join(directory, 'backend');
  const runsDirectory = path.join(directory, 'runs');
  for (const file of ['qa/src/cli.ts', 'node_modules/playwright/package.json', 'node_modules/@playwright/test/package.json',
    'qa/node_modules/@anthropic-ai/sdk/package.json', 'qa/node_modules/@modelcontextprotocol/sdk/package.json']) {
    await fs.mkdir(path.dirname(path.join(backendRoot, file)), { recursive: true });
    await fs.writeFile(path.join(backendRoot, file), '{}');
  }
  const invocations = [];
  const executions = [];
  let child;
  const environment = { SystemRoot: 'C:\\Windows', PATH: 'safe-path', ANTHROPIC_API_KEY: 'backend-only-key',
    OPENAI_API_KEY: 'never-copy-openai-key', NODE_OPTIONS: '--require injected', CUSTOM_PASSWORD: 'never-copy-password', ...options.environment };
  const execFileImpl = async (command, args, config) => {
    executions.push({ command, args, config });
    if (args[0] === '/PID') {
      if (options.killError) throw new Error('secret raw taskkill error');
      if (!options.killDoesNotClose) setImmediate(() => child.emit('close', null, 'SIGKILL'));
    }
    if (options.probeError && args[0] === '-e') throw new Error('secret raw browser failure');
    return { stdout: options.nodeVersion || 'v24.20.0', stderr: '' };
  };
  const spawnImpl = (command, args, config) => {
    invocations.push({ command, args, config });
    if (options.spawnThrows) throw new Error('secret raw spawn failure');
    child = new EventEmitter();
    child.pid = 4312;
    child.kill = () => { if (!options.killDoesNotClose) setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; };
    if (options.onSpawn) setImmediate(() => options.onSpawn(child, args, config));
    return child;
  };
  const runner = createBackendRunner({ backendRoot, runsDirectory, environment, nodePath: 'test-node.exe',
    spawnImpl, execFileImpl, platform: 'win32', killTimeoutMs: 20, ...(options.getConfiguration ? { getConfiguration: options.getConfiguration } : {}) });
  const args = () => invocations[0].args;
  const runDir = () => args()[args().indexOf('--output-dir') + 1];
  const finish = async ({ incomplete = false, brokenPdf = false, reportOverrides, resultPath, resultPdf = true, exitCode = 0, sendResult = true } = {}) => {
    const out = runDir();
    await fs.mkdir(out, { recursive: true });
    const launched = invocations[0].args;
    const report = { version: 'report/2', run: { startUrl: 'https://example.test/', provider: launched[launched.indexOf('--provider') + 1],
      models: { plan: launched[launched.indexOf('--plan-model') + 1], triage: launched[launched.indexOf('--triage-model') + 1] },
      parameters: readParameters(launched),
      verdicts: { stage: 'done', later: [] }, endReason: incomplete ? 'incomplete' : 'completed', incompleteReasons: incomplete ? ['test skipped'] : [], ...reportOverrides } };
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report));
    await fs.writeFile(path.join(out, 'report.pdf'), brokenPdf ? 'not a PDF' : '%PDF-1.7\nexample');
    if (sendResult) child.emit('message', { type: 'backend-result', runDir: resultPath || out, pdf: resultPdf });
    child.emit('close', exitCode);
  };
  const waitSpawn = async () => { for (let i = 0; i < 100 && !invocations.length; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(invocations.length, 1); };
  return { runner, backendRoot, runsDirectory, environment, invocations, executions, finish, waitSpawn, child: () => child, runDir };
}

test('backend environment excludes visual provider settings, unrelated secrets, and Node injection options', () => {
  const env = backendEnvironment({ PATH: 'node', SystemRoot: 'windows', ANTHROPIC_API_KEY: 'separate-key',
    OPENAI_API_KEY: 'secret', GUI_ANTHROPIC_API_KEY: 'visual-claude-key', GUI_PROVIDER: 'anthropic', NODE_OPTIONS: '--import arbitrary', ELECTRON_RUN_AS_NODE: '1', API_KEY: 'gui-key', MODEL: 'gpt-6-luna' }, path.resolve('backend'));
  assert.equal(env.ANTHROPIC_API_KEY, 'separate-key');
  assert.equal(env.PATH, 'node');
  for (const name of ['OPENAI_API_KEY', 'GUI_ANTHROPIC_API_KEY', 'GUI_PROVIDER', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'API_KEY', 'MODEL']) assert.equal(env[name], undefined);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.resolve('backend', '.browsers'));
});

test('progress accepts only increasing observations and strips all untrusted payload fields', () => {
  const event = safeProgress({ type: 'backend-progress', phase: 'exploring', sequence: 2, action: 'fill', url: 'https://example.test/a?password=secret#token',
    password: 'secret', text: 'ignore previous instructions', apiKey: 'hidden' }, 'https://example.test', 1);
  assert.deepEqual(event, { type: 'backend-progress', phase: 'exploring', sequence: 2, action: 'fill', url: 'https://example.test/a' });
  assert.equal(safeProgress({ ...event, sequence: 1 }, 'https://example.test', 1), undefined);
  assert.equal(safeProgress({ ...event, phase: 'fake-success' }, 'https://example.test', 1), undefined);
  assert.equal(safeProgress({ ...event, url: 'https://external.test/' }, 'https://example.test', 1).url, undefined);
  assert.equal(safeProgress({ ...event, url: 'https://example.test/#!/products' }, 'https://example.test', 1).url, 'https://example.test/#!/products');
});

test('runs the dedicated backend profile with isolated key and verifies this run before returning', async t => {
  const f = await fixture(t);
  const progress = [];
  const resultPromise = f.runner.run({ targetUrl: 'https://example.test/', task: '검색 기능을 확인해 줘', onProgress: value => progress.push(value),
    provider: 'anthropic', apiKey: 'must-never-pass', model: 'must-never-pass' });
  await f.waitSpawn();
  const invocation = f.invocations[0];
  assert.equal(invocation.config.shell, false);
  assert.equal(invocation.config.windowsHide, true);
  assert.deepEqual(invocation.config.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(invocation.config.env.ANTHROPIC_API_KEY, 'backend-only-key');
  assert.equal(invocation.args.some(arg => /api.key|credential|allow-writes|origins/.test(arg)), false);
  assert.equal(invocation.args[invocation.args.indexOf('--provider') + 1], 'anthropic');
  assert.equal(invocation.args[invocation.args.indexOf('--plan-model') + 1], FIXED_MODELS.plan);
  assert.equal(invocation.args[invocation.args.indexOf('--triage-model') + 1], FIXED_MODELS.triage);
  assert.equal(JSON.stringify(invocation).includes('must-never-pass'), false);
  const requirements = invocation.args[invocation.args.indexOf('--requirements') + 1];
  assert.deepEqual(JSON.parse(await fs.readFile(requirements, 'utf8')), [{ id: 'R1', text: '검색 기능을 확인해 줘' }]);
  f.child().emit('message', { type: 'backend-progress', phase: 'mapping', sequence: 1, url: 'https://example.test/a' });
  await f.finish();
  const result = await resultPromise;
  assert.equal(result.completed, true);
  assert.equal(result.runDir, path.join(f.runsDirectory, result.runId));
  assert.equal(progress.length, 1);
  assert.equal((await f.runner.readResult(result.runId)).pdfPath, result.pdfPath);
  await assert.rejects(fs.stat(requirements), { code: 'ENOENT' });
});

test('GPT backend snapshots only its key and selected models while settings change during a run', async t => {
  let configuration = { provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' }, apiKey: 'backend-openai-snapshot-key' };
  const f = await fixture(t, { getConfiguration: () => configuration });
  const pending = f.runner.run({ targetUrl: 'https://example.test/', provider: 'anthropic', apiKey: 'visual-only-key', model: 'visual-only-model' });
  configuration = { provider: 'anthropic', models: { plan: 'claude-haiku-5-5', triage: 'claude-sonnet-5-5' }, apiKey: 'later-backend-claude-key' };
  await f.waitSpawn();
  const invocation = f.invocations[0];
  assert.equal(invocation.config.env.OPENAI_API_KEY, 'backend-openai-snapshot-key');
  assert.equal(invocation.config.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(invocation.args[invocation.args.indexOf('--provider') + 1], 'openai');
  assert.equal(invocation.args[invocation.args.indexOf('--plan-model') + 1], 'gpt-6.2-sol');
  assert.equal(invocation.args[invocation.args.indexOf('--triage-model') + 1], 'gpt-6-luna');
  assert.equal(JSON.stringify(invocation).includes('visual-only'), false);
  assert.ok(f.executions.every(call => !call.config.env.ANTHROPIC_API_KEY && !call.config.env.OPENAI_API_KEY));
  await f.finish();
  const result = await pending;
  assert.equal(result.provider, 'openai');
  const marker = JSON.parse(await fs.readFile(path.join(result.runDir, '.desktop-result.json'), 'utf8'));
  assert.equal(marker.version, 3);
  assert.equal(marker.provider, 'openai');
  assert.deepEqual(marker.models, { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' });
  assert.equal(JSON.stringify(marker).includes('key'), false);
  assert.equal((await f.runner.readResult(result.runId)).provider, 'openai');
});

test('a missing selected backend key never borrows the other provider and unsupported budget models fail before work', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.backendRoot, '.env'), 'WEBPILOT_BACKEND_PROVIDER=openai\n');
  delete f.environment.OPENAI_API_KEY;
  await assert.rejects(f.runner.preflight(), /OPENAI_API_KEY/);
  assert.equal(f.executions.length, 0);
  for (const models of [{ plan: 'gpt-custom-unknown', triage: 'gpt-6-luna' }, { plan: 'claude-opus-5-5', triage: 'gpt-6-luna' }]) {
    const invalid = await fixture(t, { getConfiguration: () => ({ provider: 'openai', models, apiKey: 'backend-test-key' }) });
    await assert.rejects(invalid.runner.preflight(), /비용 계산/);
    assert.equal(invalid.executions.length, 0);
    assert.equal(invalid.invocations.length, 0);
  }
});

test('new results require the captured provider and models instead of trusting the result claim', async t => {
  const f = await fixture(t, { getConfiguration: () => ({ provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' }, apiKey: 'backend-gpt-key' }) });
  const pending = f.runner.run({ targetUrl: 'https://example.test/' });
  const failed = assert.rejects(pending, /이번 백엔드 실행/);
  await f.waitSpawn();
  await f.finish({ reportOverrides: { provider: 'anthropic' } });
  await failed;
});

test('a valid partial report remains incomplete, including when reattached', async t => {
  const f = await fixture(t);
  const promise = f.runner.run({ targetUrl: 'https://example.test/' });
  await f.waitSpawn(); await f.finish({ incomplete: true });
  const result = await promise;
  assert.equal(result.completed, false);
  assert.match(result.incompleteReasons[0], /미완료/);
  assert.equal((await f.runner.readResult(result.runId)).completed, false);
});

test('readResult does not need a key and rejects edits after completion', async t => {
  const f = await fixture(t);
  const promise = f.runner.run({ targetUrl: 'https://example.test/' });
  await f.waitSpawn(); await f.finish();
  const result = await promise;
  delete f.environment.ANTHROPIC_API_KEY;
  assert.equal((await f.runner.readResult(result.runId)).completed, true);
  await fs.writeFile(result.pdfPath, '%PDF-1.7\nchanged');
  await assert.rejects(f.runner.readResult(result.runId), /확인된 백엔드 보고서/);
  await assert.rejects(f.runner.readResult('../report'), /실행 ID/);
});

test('v1 and v2 reports without per-run parameters remain readable without current settings or keys', async t => {
  const f = await fixture(t);
  const promise = f.runner.run({ targetUrl: 'https://example.test/' });
  await f.waitSpawn(); await f.finish();
  const result = await promise;
  const markerPath = path.join(result.runDir, '.desktop-result.json');
  const originalMarker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  const originalReport = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  delete f.environment.ANTHROPIC_API_KEY;
  delete f.environment.OPENAI_API_KEY;
  for (const version of [1, 2]) {
    const report = structuredClone(originalReport);
    delete report.run.parameters;
    if (version === 1) delete report.run.provider;
    const bytes = Buffer.from(JSON.stringify(report));
    const marker = { ...originalMarker, version, reportSha256: createHash('sha256').update(bytes).digest('hex') };
    delete marker.parameters;
    if (version === 1) { delete marker.provider; delete marker.models; }
    await fs.writeFile(result.reportPath, bytes);
    await fs.writeFile(markerPath, JSON.stringify(marker));
    const restored = await f.runner.readResult(result.runId);
    assert.equal(restored.completed, true);
    assert.deepEqual(restored.models, FIXED_MODELS);
  }
});

test('exit 0 cannot claim completion when no matching PDF receipt exists', async t => {
  for (const settings of [{ sendResult: false }, { resultPath: path.resolve('another-run') }, { resultPdf: false }]) {
    const f = await fixture(t);
    const promise = f.runner.run({ targetUrl: 'https://example.test/' });
    const rejection = assert.rejects(promise, /PDF 생성/);
    await f.waitSpawn(); await f.finish(settings); await rejection;
    await assert.rejects(fs.stat(path.join(f.runDir(), '.desktop-result.json')), { code: 'ENOENT' });
  }
});

test('invalid, mismatched, or unfinished report cannot attach an old PDF', async t => {
  for (const settings of [{ brokenPdf: true }, { reportOverrides: { startUrl: 'https://other.test/' } },
    { reportOverrides: { verdicts: { stage: 'triage' } } }, { reportOverrides: { models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna' } } }]) {
    const f = await fixture(t);
    const promise = f.runner.run({ targetUrl: 'https://example.test/' });
    const rejection = assert.rejects(promise, /이번 백엔드 실행/);
    await f.waitSpawn(); await f.finish(settings); await rejection;
  }
});

test('failed backend exit is never converted into a completed report', async t => {
  const f = await fixture(t);
  const promise = f.runner.run({ targetUrl: 'https://example.test/' });
  const rejection = assert.rejects(promise, /오류로 종료/);
  await f.waitSpawn(); await f.finish({ exitCode: 1 }); await rejection;
});

test('cancellation kills the Windows process tree and waits for close', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const promise = f.runner.run({ targetUrl: 'https://example.test/', signal: controller.signal });
  const rejection = assert.rejects(promise, { name: 'AbortError' });
  await f.waitSpawn(); controller.abort(); await rejection;
  const kill = f.executions.find(call => call.args[0] === '/PID');
  assert.deepEqual(kill.args, ['/PID', '4312', '/T', '/F']);
  assert.equal(kill.config.windowsHide, true);
  assert.equal(kill.config.shell, false);
  assert.equal(kill.config.env.ANTHROPIC_API_KEY, undefined);
});

test('a failed process-tree stop is reported instead of claiming all processes stopped', async t => {
  const f = await fixture(t, { killError: true });
  const controller = new AbortController();
  const promise = f.runner.run({ targetUrl: 'https://example.test/', signal: controller.signal });
  const rejection = assert.rejects(promise, error => error.name === 'BackendTerminationError' && /하위 프로세스의 종료/.test(error.message));
  await f.waitSpawn(); controller.abort(); await rejection;
});

test('unconfirmed child termination cannot hang application shutdown', async t => {
  const f = await fixture(t, { killError: true, killDoesNotClose: true });
  const controller = new AbortController();
  const promise = f.runner.run({ targetUrl: 'https://example.test/', signal: controller.signal });
  const rejection = assert.rejects(promise, error => error.name === 'BackendTerminationError' && /하위 프로세스의 종료/.test(error.message));
  await f.waitSpawn(); controller.abort(); await rejection;
});

test('a failed spawn removes its staged requirements and does not expose raw errors', async t => {
  const f = await fixture(t, { spawnThrows: true });
  await assert.rejects(f.runner.run({ targetUrl: 'https://example.test/', task: 'private task' }), error => /시작하지 못했습니다/.test(error.message) && !/secret/.test(error.message));
  assert.deepEqual(await fs.readdir(f.runsDirectory), []);
});

test('authorized login secrets enter only the backend child environment and staged inputs are cleaned', async t => {
  const f = await fixture(t, { environment: { WEBPILOT_LOGIN_USERNAME: 'unrelated-parent-account', WEBPILOT_LOGIN_PASSWORD: 'unrelated-parent-password' } });
  const credentials = { username: 'account-only-in-memory', password: 'private-account-password&99' };
  const events = [];
  const pending = f.runner.run({ targetUrl: 'https://example.test/', backendLoginUrl: 'https://example.test/login', credentials,
    task: `검색 확인 ${credentials.username} ${credentials.password}`, onProgress: event => events.push(event) });
  await f.waitSpawn();
  const invocation = f.invocations[0];
  assert.equal(invocation.config.env.WEBPILOT_LOGIN_USERNAME, credentials.username);
  assert.equal(invocation.config.env.WEBPILOT_LOGIN_PASSWORD, credentials.password);
  assert.ok(f.executions.every(call => !call.config.env.WEBPILOT_LOGIN_USERNAME && !call.config.env.WEBPILOT_LOGIN_PASSWORD));
  const appFile = invocation.args[invocation.args.indexOf('--app') + 1];
  const requirementsFile = invocation.args[invocation.args.indexOf('--requirements') + 1];
  const appText = await fs.readFile(appFile, 'utf8');
  assert.deepEqual(JSON.parse(appText), { deny: ['/logout', '/signout', '/sign-out', '/log-out'], login: { url: 'https://example.test/login', auto: true,
    env: { username: 'WEBPILOT_LOGIN_USERNAME', password: 'WEBPILOT_LOGIN_PASSWORD' } } });
  const staged = JSON.stringify(invocation.args) + appText + await fs.readFile(requirementsFile, 'utf8');
  for (const secret of Object.values(credentials)) assert.equal(staged.includes(secret), false);
  f.child().emit('message', { type: 'backend-progress', phase: 'mapping', sequence: 1, url: `https://example.test/${credentials.username}`, detail: credentials.password });
  assert.equal(events[0].url, undefined);
  await f.finish();
  const result = await pending;
  const marker = await fs.readFile(path.join(result.runDir, '.desktop-result.json'), 'utf8');
  for (const secret of Object.values(credentials)) assert.equal(marker.includes(secret), false);
  await assert.rejects(fs.stat(appFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(requirementsFile), { code: 'ENOENT' });
});

test('login inputs fail closed before backend probes and unrelated environment accounts are not inherited', async t => {
  const f = await fixture(t, { environment: { WEBPILOT_LOGIN_USERNAME: 'unrelated-user', WEBPILOT_LOGIN_PASSWORD: 'unrelated-pass' } });
  const credentials = { username: 'private-user-123', password: 'private-password-456' };
  for (const input of [{ backendLoginUrl: 'https://example.test/login' },
    { credentials, backendLoginUrl: 'https://other.test/login' },
    { credentials: { ...credentials, token: 'injected' } },
    { credentials, backendLoginUrl: `https://example.test/?username=${credentials.username}` }]) {
    await assert.rejects(f.runner.run({ targetUrl: 'https://example.test/', ...input }));
  }
  assert.equal(f.executions.length, 0);
  assert.equal(f.invocations.length, 0);
  const pending = f.runner.run({ targetUrl: 'https://example.test/' });
  await f.waitSpawn();
  assert.equal(f.invocations[0].config.env.WEBPILOT_LOGIN_USERNAME, undefined);
  assert.equal(f.invocations[0].config.env.WEBPILOT_LOGIN_PASSWORD, undefined);
  assert.equal(f.invocations[0].args.includes('--app'), false);
  await f.finish();
  await pending;
});

test('login setup defaults to the target and is removed after spawn failure or cancellation', async t => {
  const credentials = { username: 'private-user-123', password: 'private-password-456' };
  const failed = await fixture(t, { spawnThrows: true });
  await assert.rejects(failed.runner.run({ targetUrl: 'https://example.test/', credentials }), /시작하지 못했습니다/);
  assert.deepEqual(await fs.readdir(failed.runsDirectory), []);
  const cancelled = await fixture(t);
  const controller = new AbortController();
  const pending = cancelled.runner.run({ targetUrl: 'https://example.test/', credentials, signal: controller.signal });
  const rejection = assert.rejects(pending, error => error.name === 'AbortError');
  await cancelled.waitSpawn();
  const appFile = cancelled.invocations[0].args[cancelled.invocations[0].args.indexOf('--app') + 1];
  assert.equal(JSON.parse(await fs.readFile(appFile, 'utf8')).login.url, 'https://example.test/');
  controller.abort();
  await rejection;
  assert.deepEqual(await fs.readdir(cancelled.runsDirectory), []);
});

test('missing backend key is actionable and never uses either visual provider key', async t => {
  const f = await fixture(t, { environment: { ANTHROPIC_API_KEY: '', GUI_ANTHROPIC_API_KEY: 'visual-claude-key' } });
  await assert.rejects(f.runner.preflight(), error => /ANTHROPIC_API_KEY/.test(error.message) && /GPT·Claude/.test(error.message));
  assert.equal(f.executions.length, 0);
  await fs.writeFile(path.join(f.backendRoot, '.env'), 'OPENAI_API_KEY=gui-key\nANTHROPIC_API_KEY="backend-dotenv-key"\n');
  await f.runner.preflight();
  assert.equal(f.executions.every(call => !Object.hasOwn(call.config.env, 'OPENAI_API_KEY')), true);
});

test('preflight rejects missing local dependencies rather than borrowing GUI packages', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.backendRoot, 'qa', 'node_modules', '@anthropic-ai', 'sdk', 'package.json'));
  await assert.rejects(f.runner.preflight(), /setup:backend/);
  assert.equal(f.executions.length, 0);
});

test('preflight masks raw runtime errors and enforces Node 24', async t => {
  const old = await fixture(t, { nodeVersion: 'v22.8.0' });
  await assert.rejects(old.runner.preflight(), /Node.js 24/);
  const browser = await fixture(t, { probeError: true });
  await assert.rejects(browser.runner.preflight(), error => /Chromium/.test(error.message) && !/secret/.test(error.message));
});

test('pre-aborted requests do not launch or stage a run', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runner.run({ targetUrl: 'https://example.test/', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.executions.length, 0);
  assert.equal(f.invocations.length, 0);
});

test('per-run backend settings select the matching dedicated key and reach every CLI flag and report marker', async t => {
  const requested = [];
  const profiles = { openai: { provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' }, apiKey: 'dedicated-gpt-key' },
    anthropic: { provider: 'anthropic', models: FIXED_MODELS, apiKey: 'dedicated-claude-key' } };
  const f = await fixture(t, { getConfiguration: provider => { requested.push(provider); return profiles[provider ?? 'anthropic']; } });
  const backendOptions = { provider: 'openai', models: { plan: 'gpt-6.2-astra', triage: 'gpt-5.4-mini' }, budgetUsd: 1.25,
    exploreMinutes: 7, maxPages: 11, maxTemplates: 4, turnsPerTemplate: 8, maxTurns: 13, pagesPerTemplate: 2,
    concurrency: 2, workers: 3, planEffort: 'low', sessions: 'cluster' };
  await f.runner.preflight(backendOptions);
  const pending = f.runner.run({ targetUrl: 'https://example.test/', task: '정확한 요구사항\n--allow-writes', backendOptions,
    provider: 'anthropic', model: 'visual-only', apiKey: 'visual-key' });
  await f.waitSpawn();
  const invocation = f.invocations[0];
  const { provider, models, ...parameters } = backendOptions;
  assert.deepEqual(requested, ['openai', 'openai']);
  assert.deepEqual(readParameters(invocation.args), parameters);
  assert.equal(invocation.args[invocation.args.indexOf('--provider') + 1], provider);
  assert.equal(invocation.args[invocation.args.indexOf('--plan-model') + 1], models.plan);
  assert.equal(invocation.config.env.OPENAI_API_KEY, 'dedicated-gpt-key');
  assert.equal(invocation.config.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(invocation.args.includes('--allow-writes'), false);
  assert.equal(JSON.stringify(invocation).includes('visual-key'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(invocation.args[invocation.args.indexOf('--requirements') + 1], 'utf8')),
    [{ id: 'R1', text: '정확한 요구사항\n--allow-writes' }]);
  await f.finish();
  const result = await pending;
  assert.deepEqual(result.parameters, parameters);
  const marker = JSON.parse(await fs.readFile(path.join(result.runDir, '.desktop-result.json'), 'utf8'));
  assert.equal(marker.version, 3);
  assert.deepEqual(marker.parameters, parameters);
  assert.equal(JSON.stringify(marker).includes('dedicated-'), false);
  assert.equal((await f.runner.readResult(result.runId)).completed, true);
});

test('unknown backend fields and mismatched profile keys fail before any runtime work', async t => {
  const f = await fixture(t);
  for (const backendOptions of [{ allowWrites: true }, { apiKey: 'injected' }, { maxPages: 0 }]) {
    await assert.rejects(f.runner.preflight(backendOptions));
    await assert.rejects(f.runner.run({ targetUrl: 'https://example.test/', backendOptions }));
  }
  assert.equal(f.executions.length, 0);
  assert.equal(f.invocations.length, 0);
  const wrong = await fixture(t, { getConfiguration: () => ({ provider: 'anthropic', models: FIXED_MODELS, apiKey: 'wrong-profile-key' }) });
  await assert.rejects(wrong.runner.preflight({ provider: 'openai' }), /전용 키 설정/);
  assert.equal(wrong.executions.length, 0);
});

test('a report claiming different backend parameters cannot become a completed artifact', async t => {
  const f = await fixture(t);
  const pending = f.runner.run({ targetUrl: 'https://example.test/', backendOptions: { maxPages: 6 } });
  await f.waitSpawn();
  await f.finish({ reportOverrides: { parameters: { ...BACKEND_RUN_DEFAULTS, maxPages: 30 } } });
  await assert.rejects(pending, /이번 백엔드 실행/);
  await assert.rejects(fs.stat(path.join(f.runDir(), '.desktop-result.json')));
});

test('real Node subprocess IPC completes only with its own verified artifacts', async t => {
  const f = await fixture(t);
  const worker = `
const fs = require('node:fs');
const path = require('node:path');
if (process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS || process.argv[process.argv.indexOf('--plan-model')+1]!=='claude-opus-5-5') process.exit(12);
const out = process.argv[process.argv.indexOf('--output-dir') + 1];
const url = process.argv[process.argv.indexOf('--url') + 1];
fs.mkdirSync(out);
fs.writeFileSync(path.join(out, 'report.pdf'), '%PDF-1.7\\nlocal fixture');
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ version: 'report/2', run: {
  startUrl: url, provider: 'anthropic', models: { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' },
  parameters: ${JSON.stringify(BACKEND_RUN_DEFAULTS)},
  verdicts: { stage: 'done', later: [] }, endReason: 'completed', incompleteReasons: []
} }));
process.send({ type: 'backend-progress', phase: 'exploring', sequence: 1, url: url + 'products?token=must-not-show', action: 'snapshot' });
process.send({ type: 'backend-result', runDir: out, pdf: true }, () => process.disconnect());
`;
  await fs.writeFile(path.join(f.backendRoot, 'qa', 'src', 'cli.ts'), worker);
  const progress = [];
  const runner = createBackendRunner({ backendRoot: f.backendRoot, runsDirectory: f.runsDirectory,
    nodePath: process.execPath, environment: f.environment, execFileImpl: async () => ({ stdout: process.version }) });
  const result = await runner.run({ targetUrl: 'https://example.test/', onProgress: value => progress.push(value) });
  assert.equal(result.completed, true);
  assert.deepEqual(progress, [{ type: 'backend-progress', phase: 'exploring', sequence: 1, url: 'https://example.test/products', action: 'snapshot' }]);
  assert.equal((await runner.readResult(result.runId)).pdfSha256, result.pdfSha256);
});
