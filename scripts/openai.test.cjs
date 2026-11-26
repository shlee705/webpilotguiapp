const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiSettings, monthKey } = require('../electron/ai-settings.cjs');
const { createOpenAiService, normalizeUsage } = require('../electron/openai.cjs');
const { createCaptureStore } = require('../electron/captures.cjs');

const KEY = 'sk-project-test-only-not-a-real-key';
function storageFixture({ encrypted = true, now = () => new Date('2026-11-25T01:00:00Z') } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-ai-test-'));
  const safeStorage = {
    isEncryptionAvailable: () => encrypted,
    encryptString: value => Buffer.from(value.split('').reverse().join('')),
    decryptString: value => value.toString().split('').reverse().join(''),
  };
  const settings = createAiSettings({ directory, safeStorage, now });
  return { settings, directory, safeStorage, now };
}

function serviceFixture(fetchImpl, extra = {}) {
  const fixture = storageFixture();
  fixture.settings.save({ model: 'gpt-6-luna', apiKey: KEY });
  return { ...fixture, service: createOpenAiService({ settings: fixture.settings, fetchImpl, now: fixture.now, retryDelayMs: 0, ...extra }) };
}

function streamResponse(events) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

const request = (requestId = 'request-1') => ({ requestId, model: 'gpt-6-luna', messages: [{ role: 'user', content: '테스트 계획을 알려 줘' }] });
const completed = (usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 }) => ({ type: 'response.completed', response: { usage } });

test('API key is encrypted on disk and omitted from public settings', () => {
  const { settings, directory, safeStorage, now } = storageFixture();
  const publicSettings = settings.save({ model: 'gpt-6-luna', apiKey: KEY });
  assert.equal(publicSettings.keyConfigured, true);
  assert.equal(publicSettings.storage, 'encrypted');
  assert.equal(JSON.stringify(publicSettings).includes(KEY), false);
  assert.equal(fs.readFileSync(path.join(directory, 'ai-settings.json'), 'utf8').includes(KEY), false);
  const restored = createAiSettings({ directory, safeStorage, now });
  assert.equal(restored.getKey(), KEY);
  restored.save({ model: 'gpt-6-luna', forgetKey: true });
  assert.equal(createAiSettings({ directory, safeStorage, now }).get().keyConfigured, false);
});

test('unavailable OS encryption keeps the key in memory only', () => {
  const fixture = storageFixture({ encrypted: false });
  const publicSettings = fixture.settings.save({ model: 'gpt-6-luna', apiKey: KEY });
  assert.equal(publicSettings.storage, 'session');
  assert.equal(fixture.settings.getKey(), KEY);
  const saved = JSON.parse(fs.readFileSync(path.join(fixture.directory, 'ai-settings.json'), 'utf8'));
  assert.equal(saved.profiles.openai.encryptedKey, '');
  assert.equal(createAiSettings(fixture).get().keyConfigured, false);
});

test('usage persists separately from chats and rolls over by Korean calendar month', () => {
  let instant = new Date('2026-11-30T14:59:00Z');
  const fixture = storageFixture({ now: () => instant });
  fixture.settings.recordUsage({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  fixture.settings.recordUsage(undefined);
  assert.deepEqual(fixture.settings.get().usage, { month: '2026-11', inputTokens: 11, outputTokens: 7, totalTokens: 18, requests: 2, untrackedRequests: 1 });
  assert.equal(createAiSettings(fixture).get().usage.totalTokens, 18);
  instant = new Date('2026-11-30T15:00:00Z');
  assert.equal(monthKey(instant), '2026-12');
  assert.equal(fixture.settings.get().usage.requests, 0);
});

test('real Responses request streams Unicode, sets store:false, and tracks actual usage before done', async () => {
  let sent;
  const { service, settings } = serviceFixture(async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return streamResponse([{ type: 'response.output_text.delta', delta: '안녕하세요 🌏' }, completed()]);
  });
  const events = [];
  assert.deepEqual(await service.start(request(), event => events.push(event)), { ok: true });
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.input[0].role, 'developer');
  assert.equal(sent.body.tools, undefined);
  assert.equal(events.find(event => event.type === 'delta').text, '안녕하세요 🌏');
  assert.ok(events.findIndex(event => event.type === 'usage') < events.findIndex(event => event.type === 'done'));
  assert.equal(settings.get().usage.totalTokens, 18);
  assert.equal(settings.get().usage.untrackedRequests, 0);
});

test('incomplete billable responses retain usage and report failure', async () => {
  const { service, settings } = serviceFixture(async () => streamResponse([
    { type: 'response.output_text.delta', delta: '부분 응답' },
    { type: 'response.incomplete', response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]));
  const events = [];
  const result = await service.start(request(), event => events.push(event));
  assert.equal(result.ok, false);
  assert.equal(events.some(event => event.type === 'done'), false);
  assert.equal(settings.get().usage.totalTokens, 15);
  assert.equal(settings.get().usage.untrackedRequests, 0);
});

test('premature stream end and missing final usage are counted as untracked', async () => {
  const fixture = serviceFixture(async () => streamResponse([{ type: 'response.output_text.delta', delta: 'partial' }]));
  assert.equal((await fixture.service.start(request(), () => {})).ok, false);
  assert.equal(fixture.settings.get().usage.untrackedRequests, 1);
  const missing = serviceFixture(async () => streamResponse([{ type: 'response.output_text.delta', delta: '응답' }, completed(null)]));
  assert.equal((await missing.service.start(request(), () => {})).ok, true);
  assert.equal(missing.settings.get().usage.untrackedRequests, 1);
});

test('refusal text streams normally and HTTP failures never expose raw server messages or keys', async () => {
  const refusal = serviceFixture(async () => streamResponse([{ type: 'response.refusal.delta', delta: '도와드릴 수 없습니다.' }, completed()]));
  const events = [];
  assert.equal((await refusal.service.start(request(), event => events.push(event))).ok, true);
  assert.equal(events.find(event => event.type === 'delta').text, '도와드릴 수 없습니다.');
  const unauthorized = serviceFixture(async () => new Response(JSON.stringify({ error: { message: `Invalid key ${KEY}` } }), { status: 401 }));
  const result = await unauthorized.service.start(request(), () => {});
  assert.equal(result.ok, false);
  assert.match(result.error, /API 키/);
  assert.equal(result.error.includes(KEY), false);
});

test('cancellation aborts the network request and records unknown usage', async () => {
  let networkSignal;
  const { service, settings } = serviceFixture(async (_url, { signal }) => {
    networkSignal = signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }));
  });
  const pending = service.start(request(), () => {});
  service.cancel('request-1');
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(networkSignal.aborted, true);
  assert.equal(settings.get().usage.untrackedRequests, 1);
});

test('shutdown waits for cancellation usage accounting to finish', async () => {
  const { service, settings } = serviceFixture(async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  } })));
  const first = service.start(request('one'), () => {});
  const second = service.start(request('two'), () => {});
  assert.equal(service.hasActive(), true);
  await service.cancelAll();
  assert.equal(service.hasActive(), false);
  assert.equal(settings.get().usage.untrackedRequests, 2);
  assert.equal((await first).cancelled, true);
  assert.equal((await second).cancelled, true);
});

test('backend termination failure survives cancellation for a native shutdown notification', async () => {
  const fixture = serviceFixture(async () => { throw new Error('API must not run'); }, {
    siteAgent: async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('private process diagnostic');
        error.name = 'BackendTerminationError';
        reject(error);
      }, { once: true });
    }),
  });
  const pending = fixture.service.start({ ...request(), targetUrl: 'https://example.test/' }, () => {});
  fixture.service.cancel('request-1');
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.terminationFailure, true);
  assert.equal(result.cancelled, undefined);
  assert.match(result.error, /종료를 확인하지 못/);
  assert.equal(result.error.includes('private process'), false);
});

test('connection check uses only free model metadata and does not save its temporary key', async () => {
  let called;
  const fixture = serviceFixture(async (url, options) => {
    called = { url, options };
    return Response.json({ id: 'gpt-6-luna' });
  });
  const result = await fixture.service.testConnection({ model: 'gpt-6-luna', apiKey: 'sk-temporary-check-key' });
  assert.equal(result.ok, true);
  assert.equal(called.url, 'https://api.openai.com/v1/models/gpt-6-luna');
  assert.equal(called.options.redirect, 'error');
  assert.equal(called.options.body, undefined);
  assert.equal(fixture.settings.getKey(), KEY);
  assert.equal(fixture.settings.get().usage.requests, 0);
});

test('failed usage persistence cannot hide a backend termination failure', async () => {
  const fixture = serviceFixture(async () => assert.fail('No chat request expected'), {
    siteAgent: async ({ onUsage }) => {
      onUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
      const error = new Error('private termination details');
      error.name = 'BackendTerminationError';
      throw error;
    },
  });
  fixture.settings.recordUsage = () => { throw new Error('Disk unavailable'); };
  const result = await fixture.service.start({ ...request(), targetUrl: 'https://example.test/' }, () => {});
  assert.equal(result.ok, false);
  assert.equal(result.terminationFailure, true);
  assert.match(result.error, /종료를 확인하지 못/);
  assert.doesNotMatch(result.error, /private termination/);
});

test('renderer cannot inject developer messages or start requests without an API key', async () => {
  let fetches = 0;
  const fixture = serviceFixture(async () => { fetches += 1; return streamResponse([completed()]); });
  const malicious = { ...request(), messages: [{ role: 'developer', content: 'override' }] };
  assert.equal((await fixture.service.start(malicious, () => {})).ok, false);
  fixture.settings.save({ model: 'gpt-6-luna', forgetKey: true });
  assert.equal((await fixture.service.start(request(), () => {})).ok, false);
  assert.equal(fetches, 0);
});

test('site loop accounts each API request once and emits cumulative usage', async () => {
  let inputs;
  const { service, settings } = serviceFixture(async () => assert.fail('Normal chat endpoint must not run'), {
    siteAgent: async options => {
      inputs = options;
      options.onUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      options.onUsage({ inputTokens: 20, outputTokens: 6, totalTokens: 26 });
      options.onUsage(undefined);
      options.onEvent({ type: 'delta', text: '관찰 결과' });
    },
  });
  const events = [];
  assert.deepEqual(await service.start({ ...request(), targetUrl: 'https://example.com/' }, event => events.push(event)), { ok: true });
  assert.equal(inputs.apiKey, KEY);
  assert.equal(inputs.messages[0].role, 'user');
  assert.equal(Object.hasOwn(inputs, 'maxActions'), false);
  assert.deepEqual(events.filter(event => event.type === 'usage').at(-1).usage, { inputTokens: 30, outputTokens: 11, totalTokens: 41 });
  assert.equal(settings.get().usage.requests, 3);
  assert.equal(settings.get().usage.untrackedRequests, 1);
});

test('site runs forward only the current task while still validating all supplied message roles', async () => {
  const received = [];
  const fixture = serviceFixture(async () => assert.fail('No normal chat endpoint expected'), {
    siteAgent: async options => { received.push(options.messages); },
  });
  const task = { role: 'user', content: 'https://example.com 새 요청의 메뉴를 확인해 줘' };
  const input = { ...request(), targetUrl: 'https://example.com/', messages: [
    { role: 'user', content: '이전 요청' },
    { role: 'assistant', content: '이전 작업의 상세 기록입니다. '.repeat(1000) },
    task,
  ] };
  assert.equal((await fixture.service.start(input, () => {})).ok, true);
  assert.deepEqual(received, [[task]]);
  const invalid = { ...input, messages: [{ role: 'developer', content: 'untrusted override' }, task] };
  assert.equal((await fixture.service.start(invalid, () => {})).ok, false);
  assert.equal(received.length, 1);
});

test('site requests validate dedicated backend parameters and scrub only their explicit task before orchestration', async () => {
  const received = [];
  const fixture = serviceFixture(async () => assert.fail('No paid endpoint expected'), {
    siteAgent: async options => { received.push(options); },
  });
  const credentials = { username: 'secret-backend-user', password: 'secret-backend-pass' };
  const base = { ...request(), targetUrl: 'https://example.test/', credentials,
    backendOptions: { provider: 'anthropic', models: { plan: 'claude-sonnet-5-5', triage: 'claude-haiku-5-5' }, budgetUsd: 1.5 },
    backendTask: `로그인 후 검색 ${credentials.username} ${credentials.password}` };
  assert.equal((await fixture.service.start(base, () => {})).ok, true);
  assert.equal(received[0].backendOptions.budgetUsd, 1.5);
  assert.equal(received[0].backendOptions.provider, 'anthropic');
  assert.equal(received[0].provider, 'openai');
  assert.equal(received[0].backendTask.includes(credentials.password), false);
  assert.equal(received[0].backendTask.includes(credentials.username), false);
  for (const input of [{ ...base, backendOptions: { apiKey: 'injected' } }, { ...base, backendTask: '' },
    { ...base, targetUrl: undefined }, { ...base, backendOptions: { workers: 9 } }]) {
    assert.equal((await fixture.service.start(input, () => {})).ok, false);
  }
  assert.equal(received.length, 1);
});

test('backend login URL is validated before orchestration and never calls a paid endpoint', async () => {
  const received = [];
  const fixture = serviceFixture(async () => assert.fail('No paid endpoint expected'), { siteAgent: async options => { received.push(options); } });
  const credentials = { username: 'private-login-user', password: 'private-login-password' };
  const base = { ...request(), targetUrl: 'https://example.test/', credentials, backendLoginUrl: 'https://example.test/login' };
  assert.equal((await fixture.service.start(base, () => {})).ok, true);
  assert.equal(received[0].backendLoginUrl, base.backendLoginUrl);
  assert.deepEqual(received[0].credentials, credentials);
  for (const input of [{ ...base, credentials: undefined }, { ...base, backendLoginUrl: 'https://other.test/login' },
    { ...base, backendLoginUrl: `https://example.test/?password=${credentials.password}` }]) assert.equal((await fixture.service.start(input, () => {})).ok, false);
  assert.equal(received.length, 1);
});

test('legacy action counts are ignored and never forwarded to desktop inspection', async () => {
  const runs = [];
  const { service, settings } = serviceFixture(async () => assert.fail('No normal API request expected'), {
    siteAgent: async options => { runs.push(options); },
  });
  const base = { ...request(), targetUrl: 'https://example.com/' };
  for (const maxActions of [undefined, 1, 6, Number.MAX_SAFE_INTEGER, 0, -3, 2.5, '3', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await service.start({ ...base, maxActions }, () => {});
    assert.equal(result.ok, true);
  }
  assert.equal(runs.length, 12);
  assert.ok(runs.every(options => !Object.hasOwn(options, 'maxActions')));
  assert.equal(settings.get().usage.requests, 0);
});

test('login credentials are native-only and scrubbed from model messages, public events and errors', async () => {
  const credentials = { username: 'private-login-user', password: 'private-login-password&9' };
  let nativeRequest;
  const fixture = serviceFixture(async () => assert.fail('No normal API call expected'), {
    siteAgent: async options => {
      nativeRequest = options;
      options.onEvent({ type: 'activity', phase: 'acting', actionCount: 0, visitedCount: 1, url: `https://example.com/?u=${credentials.username}`, detail: credentials.password });
      options.onEvent({ type: 'delta', text: `${credentials.username} ${credentials.password}` });
      throw new Error(`failed ${credentials.password}`);
    },
  });
  const events = [];
  const result = await fixture.service.start({ ...request(), targetUrl: 'https://example.com/', credentials,
    messages: [{ role: 'user', content: `${credentials.username} ${credentials.password} 로그인` }] }, event => events.push(event));
  assert.deepEqual(nativeRequest.credentials, credentials);
  const publicText = JSON.stringify({ messages: nativeRequest.messages, events, result });
  assert.equal(publicText.includes(credentials.username), false);
  assert.equal(publicText.includes(credentials.password), false);
  const saved = fs.readFileSync(path.join(fixture.directory, 'ai-settings.json'), 'utf8');
  assert.equal(saved.includes(credentials.username), false);
  assert.equal(saved.includes(credentials.password), false);
});

test('credentials require a site URL and malformed objects are rejected before work', async () => {
  let calls = 0;
  const fixture = serviceFixture(async () => { calls += 1; return streamResponse([completed()]); }, { siteAgent: async () => { calls += 1; } });
  const credentials = { username: 'test-user', password: 'test-password' };
  assert.equal((await fixture.service.start({ ...request(), credentials }, () => {})).ok, false);
  assert.equal((await fixture.service.start({ ...request(), targetUrl: 'https://example.com/', credentials: { ...credentials, token: 'unexpected' } }, () => {})).ok, false);
  assert.equal(calls, 0);
});

test('invalid usage cannot become a falsely precise zero-token count', () => {
  assert.equal(normalizeUsage(null), undefined);
  assert.equal(normalizeUsage({ input_tokens: '12', output_tokens: 0 }), undefined);
  assert.deepEqual(normalizeUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test('saved PNG captures can be reopened by ID while traversal and non-PNG input are rejected', () => {
  const store = createCaptureStore(fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-captures-test-')));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5z8AAAAASUVORK5CYII=';
  const capture = store.saveCapture(png, { url: 'https://example.com/', index: 1 });
  assert.equal(store.readCapture(capture.id), png);
  assert.equal(capture.index, 1);
  assert.equal(capture.url, 'https://example.com/');
  assert.throws(() => store.readCapture('../ai-settings'));
  assert.throws(() => store.readCapture('..\\ai-settings'));
  assert.throws(() => store.saveCapture('data:image/png;base64,' + Buffer.from('not-png').toString('base64'), { url: 'https://example.com', index: 1 }));
  assert.throws(() => store.saveCapture(png, { url: 'file:///C:/Windows', index: 1 }));
});

test('normal chat retries missing responses before output and counts every attempt', async () => {
  let attempts = 0;
  const { service, settings } = serviceFixture(async () => {
    attempts++;
    return attempts === 1 ? streamResponse([completed({ input_tokens: 2, output_tokens: 1, total_tokens: 3 })])
      : streamResponse([{ type: 'response.output_text.delta', delta: '복구된 응답' }, completed()]);
  });
  const events = [];
  assert.equal((await service.start(request(), event => events.push(event))).ok, true);
  assert.equal(attempts, 2);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '복구된 응답');
  assert.equal(settings.get().usage.requests, 2);
  assert.equal(settings.get().usage.totalTokens, 21);
  assert.equal(events.filter(event => event.type === 'usage').at(-1).usage.totalTokens, 21);
});

test('permanent empty chat responses stop after three attempts and partial text is never duplicated', async () => {
  let attempts = 0;
  const empty = serviceFixture(async () => { attempts++; return streamResponse([completed(null)]); });
  assert.match((await empty.service.start(request(), () => {})).error, /빈 응답/);
  assert.equal(attempts, 3);
  assert.equal(empty.settings.get().usage.untrackedRequests, 3);
  attempts = 0;
  const partial = serviceFixture(async () => { attempts++; return streamResponse([{ type: 'response.output_text.delta', delta: '부분 응답' }]); });
  const events = [];
  assert.equal((await partial.service.start(request(), event => events.push(event))).ok, false);
  assert.equal(attempts, 1);
  assert.equal(events.filter(event => event.type === 'delta').length, 1);
});

test('normal chat cancellation during retry backoff cancels cleanly without another API call', async () => {
  let attempts = 0;
  const fixture = serviceFixture(async () => { attempts++; return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }); }, { retryDelayMs: 10000 });
  const result = await fixture.service.start(request(), event => { if (event.id === 'openai-retry') fixture.service.cancel('request-1'); });
  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.equal(attempts, 1);
  assert.equal(fixture.settings.get().usage.requests, 1);
});

test('site runs have no whole-run timeout and receive request timeouts plus report provider', async () => {
  const reportProvider = async () => ({ status: 'missing', message: 'missing' });
  let supplied;
  const fixture = serviceFixture(async () => assert.fail('No chat call'), {
    timeoutMs: 5, reportProvider,
    siteAgent: async options => {
      supplied = options;
      await new Promise(resolve => setTimeout(resolve, 25));
      options.signal.throwIfAborted();
      options.onEvent({ type: 'delta', text: '완료' });
    },
  });
  const result = await fixture.service.start({ ...request(), targetUrl: 'https://example.com/', maxActions: 100 }, () => {});
  assert.equal(result.ok, true);
  assert.equal(supplied.requestTimeoutMs, 5);
  assert.equal(Object.hasOwn(supplied, 'maxActions'), false);
  assert.equal(supplied.reportProvider, reportProvider);
});
