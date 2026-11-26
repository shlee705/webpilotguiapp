'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInspectionAgent, createProgressFeed } = require('../electron/inspection.cjs');
const RUN = '8aadce32-93aa-4bde-b22e-634328016b60';
const RESULT = { runId: RUN, completed: true, pdfPath: 'verified-result/report.pdf' };
const REPORT = { status: 'ready', id: '21e3fc41-46c7-4ede-ae35-77392d328c40', name: 'report.pdf', size: 100, updatedAt: '2026-11-26T00:00:00.000Z' };
const waitAbort = signal => new Promise((_, reject) => {
  if (signal.aborted) return reject(new Error('aborted'));
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
function fixture(overrides = {}) {
  const events = [];
  const controller = new AbortController();
  const options = { targetUrl: 'https://example.test/', messages: [{ role: 'user', content: '검색 기능 확인' }],
    provider: 'anthropic', apiKey: 'anthropic-visual-only', model: 'visual-model-only', maxActions: 3, signal: controller.signal, onEvent: event => events.push(event), onUsage() {} };
  const run = createInspectionAgent({
    backendRunner: { preflight: async () => {}, run: async () => RESULT },
    attachBackendReport: async () => REPORT, siteAgent: async () => {}, ...overrides,
  });
  return { events, controller, options, run };
}

test('backend receives task, URL and dedicated options; completion follows verified PDF attachment', async () => {
  let backendInput;
  let visualInput;
  const item = fixture({ backendRunner: { preflight: async () => {}, run: async input => {
    backendInput = input;
    input.onProgress({ phase: 'exploring', sequence: 1, url: 'https://example.test/search', action: 'snapshot' });
    return RESULT;
  } }, siteAgent: async input => { visualInput = input; await waitAbort(input.signal); }, attachBackendReport: async result => {
    assert.equal(result, RESULT);
    assert.equal(item.events.some(event => event.type === 'delta'), false);
    return REPORT;
  } });
  await item.run(item.options);
  assert.deepEqual(Object.keys(backendInput).sort(), ['backendOptions', 'onProgress', 'signal', 'targetUrl', 'task']);
  assert.equal(backendInput.task, '검색 기능 확인');
  assert.equal(visualInput.provider, 'anthropic');
  assert.equal(visualInput.model, 'visual-model-only');
  assert.equal(visualInput.apiKey, 'anthropic-visual-only');
  assert.equal(Object.hasOwn(visualInput, 'maxActions'), false);
  assert.equal(visualInput.backendOptions, undefined);
  assert.equal(visualInput.backendTask, undefined);
  assert.equal(visualInput.backendProgress.current().url, 'https://example.test/search');
  assert.equal(visualInput.signal.aborted, true);
  const attached = item.events.findIndex(event => event.type === 'report');
  const completed = item.events.findIndex(event => event.type === 'delta' && event.text.includes('완료했고'));
  assert.ok(attached >= 0 && completed > attached);
  assert.equal(item.events[attached].report.runId, RUN);
});

test('backend preflight failure starts no visual API work or report attachment', async () => {
  let used = false;
  const item = fixture({ backendRunner: { preflight: async () => { throw new Error('backend-key-missing'); }, run: async () => { used = true; } },
    siteAgent: async () => { used = true; }, attachBackendReport: async () => { used = true; } });
  await assert.rejects(item.run(item.options), /backend-key-missing/);
  assert.equal(used, false);
  assert.equal(item.events.some(event => event.type === 'report' || event.type === 'delta'), false);
});

test('authorized account and validated login URL reach both native browsers with independent model settings', async () => {
  let backendInput;
  let visualInput;
  const item = fixture({ backendRunner: { preflight: async () => {}, run: async options => { backendInput = options; return RESULT; } },
    siteAgent: async options => { visualInput = options; } });
  item.options.credentials = { username: 'memory-login-user', password: 'memory-login-password' };
  item.options.backendLoginUrl = 'https://example.test/login';
  await item.run(item.options);
  assert.deepEqual(backendInput.credentials, item.options.credentials);
  assert.equal(backendInput.backendLoginUrl, item.options.backendLoginUrl);
  assert.deepEqual(visualInput.credentials, item.options.credentials);
  assert.equal(visualInput.backendLoginUrl, undefined);
  assert.equal(visualInput.loginUrl, item.options.backendLoginUrl);
  assert.equal(backendInput.apiKey, undefined);
  assert.equal(backendInput.model, undefined);
  assert.equal(JSON.stringify(item.events).includes(item.options.credentials.password), false);
  const invalid = fixture({ backendRunner: { preflight: async () => assert.fail('Must reject before probes'), run: async () => assert.fail('Must not run') } });
  await assert.rejects(invalid.run({ ...invalid.options, backendLoginUrl: 'https://example.test/login' }), /계정/);
});

test('explicit backend task and options reach preflight and execution without entering the visual model', async () => {
  let checked;
  let backendInput;
  let visualInput;
  const item = fixture({ backendRunner: { preflight: async options => { checked = options; }, run: async options => {
    backendInput = options; return RESULT;
  } }, siteAgent: async options => { visualInput = options; } });
  item.options.backendTask = '백엔드에 전달할 정확한 요구사항';
  item.options.backendOptions = { provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' }, maxPages: 7 };
  await item.run(item.options);
  assert.equal(checked, backendInput.backendOptions);
  assert.equal(backendInput.task, item.options.backendTask);
  assert.equal(backendInput.backendOptions.maxPages, 7);
  assert.equal(backendInput.apiKey, undefined);
  assert.equal(backendInput.provider, undefined);
  assert.equal(visualInput.backendOptions, undefined);
  assert.equal(visualInput.backendTask, undefined);
  assert.equal(visualInput.model, 'visual-model-only');
  assert.equal(visualInput.provider, 'anthropic');
});

test('visual failure does not discard a successfully completed backend report', async () => {
  const item = fixture({ siteAgent: async () => { throw new Error('private-visual-error'); }, backendRunner: {
    preflight: async () => {}, run: async () => { await new Promise(resolve => setImmediate(resolve)); return RESULT; },
  } });
  await item.run(item.options);
  assert.ok(item.events.some(event => event.type === 'report' && event.report.status === 'ready'));
  assert.ok(item.events.some(event => event.type === 'delta' && event.text.includes('화면 표현은 중간에 중단')));
  assert.equal(JSON.stringify(item.events).includes('private-visual-error'), false);
});

test('partial backend results complete their verified PDF delivery while retaining the incomplete inspection scope', async () => {
  const item = fixture({ backendRunner: { preflight: async () => {}, run: async () => ({ ...RESULT, completed: false }) } });
  assert.equal((await item.run(item.options)).completed, false);
  const report = item.events.find(event => event.type === 'report').report;
  assert.equal(report.inspectionCompleted, false);
  assert.equal(item.events.some(event => event.type === 'delta' && event.text.includes('완료했고')), false);
  assert.equal(item.events.some(event => event.type === 'activity' && event.phase === 'complete'), true);
  assert.equal(item.events.some(event => event.type === 'delta' && event.text.includes('보고서 생성을 완료했어요.')), true);
  assert.equal(item.events.some(event => event.type === 'inspection' && event.phase === 'complete'), false);
  assert.equal(item.events.filter(event => event.type === 'inspection').at(-1).phase, 'incomplete');
});

test('attachment failure retains its run identity and never falls back to an old report', async () => {
  const item = fixture({ attachBackendReport: async () => ({ status: 'error', message: 'copy-failed' }) });
  await assert.rejects(item.run(item.options), /첨부하지 못/);
  assert.equal(item.events.find(event => event.type === 'report').report.runId, RUN);
  assert.equal(item.events.some(event => event.type === 'delta'), false);
});

test('backend failure stops visual work and attaches no report', async () => {
  let stopped = false;
  const item = fixture({ backendRunner: { preflight: async () => {}, run: async () => {
    await new Promise(resolve => setImmediate(resolve)); throw new Error('backend-failed');
  } }, siteAgent: async input => { try { await waitAbort(input.signal); } finally { stopped = true; } } });
  await assert.rejects(item.run(item.options), /backend-failed/);
  assert.equal(stopped, true);
  assert.equal(item.events.some(event => event.type === 'report'), false);
});

test('user cancellation cancels both workers and prevents PDF attachment', async () => {
  let backendSignal;
  let visualSignal;
  const item = fixture({ backendRunner: { preflight: async () => {}, run: async input => { backendSignal = input.signal; return waitAbort(input.signal); } },
    siteAgent: async input => { visualSignal = input.signal; return waitAbort(input.signal); } });
  const pending = item.run(item.options);
  await new Promise(resolve => setImmediate(resolve));
  item.controller.abort('cancelled');
  await assert.rejects(pending);
  assert.equal(backendSignal.aborted, true);
  assert.equal(visualSignal.aborted, true);
  assert.equal(item.events.some(event => event.type === 'report' || event.type === 'delta'), false);
});

test('progress feed wakes on observations, finish, and cancellation without stale changes', async () => {
  const feed = createProgressFeed();
  const controller = new AbortController();
  const first = feed.waitForChange(0, controller.signal);
  feed.update({ phase: 'exploring', sequence: 1, url: 'https://example.test/a' });
  assert.equal((await first).sequence, 1);
  const cancelled = feed.waitForChange(1, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const last = feed.waitForChange(1, new AbortController().signal);
  feed.finish();
  assert.equal(await last, null);
  assert.equal(feed.isFinished(), true);
  feed.update({ sequence: 2 });
  assert.equal(feed.current().sequence, 1);
});
