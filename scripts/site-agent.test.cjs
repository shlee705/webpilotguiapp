const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runSiteAgent, readAction, sanitizeContext } = require('../electron/site-agent.cjs');
const { validateCredentials, createSecretRedactor } = require('../electron/login-secrets.cjs');

const action = (name, extra = {}) => ({ action: name, element_id: name === 'click' ? 'e1' : name === 'type' ? 'e2' : '', text: '', scroll_y: 0, reason: '다음 동작', ...extra });
function harness(actions, overrides = {}) {
  const events = [], usages = [], calls = [], requests = [], sessions = [];
  let readIndex = 0, closed = false;
  const controller = new AbortController();
  const options = {
    apiKey: 'test-secret-not-real', model: 'gpt-6-luna', messages: [{ role: 'user', content: 'https://example.com/ 둘러봐' }], targetUrl: 'https://example.com/', signal: controller.signal,
    onEvent: event => events.push(event), onUsage: usage => usages.push(usage), finalizePauseMs: 0, retryDelayMs: 0,
    sessionFactory: async args => {
      sessions.push(args);
      return {
        observe: async () => ({ url: `https://example.com/page-${readIndex++}`, title: 'Fixture page', text: '둘러볼 페이지 내용', viewport: { width: 1440, height: 900 }, elements: [{ id: 'e1', role: 'link', label: '다음 페이지', type: 'a', href: 'https://example.com/next' }, { id: 'e2', role: 'textbox', label: '검색', type: 'search' }], loginAvailable: true }),
        act: async value => { calls.push(value); return { message: '사이트 내부 동작 완료', url: 'https://example.com/next' }; },
        close: async () => { closed = true; },
      };
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(actions.shift() ?? action('finish')) }] }] });
    },
    ...overrides,
  };
  return { options, events, usages, calls, requests, sessions, controller, closed: () => closed };
}

test('DOM tour sends text context, uses observed element IDs and never collects screenshots', async () => {
  const h = harness([action('click')]);
  const result = await runSiteAgent(h.options);
  assert.deepEqual(h.calls, [{ action: 'click', element_id: 'e1', text: '', scroll_y: 0 }]);
  assert.equal(typeof h.requests[0].input[1].content, 'string');
  assert.match(h.requests[0].input[1].content, /둘러볼 페이지 내용/);
  assert.match(h.requests[0].input[1].content, /"id":"e1"/);
  assert.equal(JSON.stringify(h.requests).includes('input_image'), false);
  assert.equal(h.events.some(event => event.type === 'screenshot'), false);
  assert.equal(h.requests[0].store, false);
  assert.equal(h.requests[0].max_output_tokens, 1024);
  assert.deepEqual(h.requests[0].reasoning, { effort: 'low' });
  assert.equal(h.requests[0].text.format.strict, true);
  assert.equal(h.usages.length, 2);
  assert.equal(result.visitedCount, 2);
  assert.equal(result.actionCount, 1);
  assert.equal(result.captures, undefined);
  assert.equal(h.events.at(-1).phase, 'complete');
  assert.equal(h.closed(), true);
});

test('compact DOM context retains all observed IDs, login gating and external origins', () => {
  const credentials = { username: 'private-user', password: 'private-pass&9' };
  const redact = createSecretRedactor(credentials);
  const raw = {
    url: 'https://example.com/catalog', title: 'Catalog', text: 'Product   details\n'.repeat(800),
    elements: Array.from({ length: 120 }, (_, index) => ({
      id: `e${index}`, role: 'link', type: 'a', label: `Item ${index} ${credentials.password}   `,
      href: `https://example.com/item/${index}?tracking=${'x'.repeat(3000)}`,
    })), loginAvailable: true,
  };
  raw.elements[0].href = 'https://example.com/search?q=available&sort=price';
  raw.elements[1].href = 'https://external.example/private?account=' + encodeURIComponent(credentials.username);
  const context = sanitizeContext(raw, redact, true);
  assert.deepEqual(context.elements.map(element => element.id), raw.elements.map(element => element.id));
  assert.equal(context.elements[0].href, '/search?q=available&sort=price');
  assert.ok(context.elements[1].href.startsWith('https://external.example/'));
  assert.equal(context.loginAvailable, true);
  assert.equal(sanitizeContext(raw, redact, false).loginAvailable, false);
  assert.ok(context.text.length <= 8000);
  assert.ok(context.elements.every(element => element.href.length <= 512));
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes(credentials.password), false);
  assert.equal(serialized.includes(credentials.username), false);
  assert.ok(serialized.length < JSON.stringify(raw).length / 4, 'Large DOM hints should be bounded without dropping actionable IDs.');
});

test('only the documented Luna model uses low reasoning and stable page prefixes precede changing outcomes', async () => {
  const h = harness([action('click'), action('finish')]);
  const factory = h.options.sessionFactory;
  h.options.sessionFactory = async options => {
    const session = await factory(options);
    const context = await session.observe();
    session.observe = async () => context;
    return session;
  };
  await runSiteAgent(h.options);
  const inputs = h.requests.map(request => request.input[1].content);
  assert.equal(inputs[0].split('\nRecent outcomes:')[0], inputs[1].split('\nRecent outcomes:')[0]);
  assert.notEqual(inputs[0], inputs[1]);
  assert.deepEqual(h.requests[0].reasoning, { effort: 'low' });
  const custom = harness([action('finish')], { model: 'custom-model' });
  await runSiteAgent(custom.options);
  assert.equal(Object.hasOwn(custom.requests[0], 'reasoning'), false);
});

test('configured action bound limits DOM observations and API calls', async () => {
  const h = harness([action('click'), action('click'), action('click')], { maxActions: 2 });
  const result = await runSiteAgent(h.options);
  assert.equal(h.calls.length, 2);
  assert.equal(h.requests.length, 2);
  assert.equal(result.pages.length, 3);
});

test('default bound performs at most five actions and reads the resulting page', async () => {
  const h = harness(Array.from({ length: 8 }, () => action('scroll', { scroll_y: 300 })));
  const result = await runSiteAgent(h.options);
  assert.equal(h.calls.length, 5);
  assert.equal(h.requests.length, 5);
  assert.equal(result.pages.length, 6);
  assert.match(result.summary, /스크롤 5회/);
});

test('invalid per-run limits fail before browser or API work', async () => {
  for (const maxActions of [0, -1, 1.5, '2', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness([], { maxActions });
    await assert.rejects(runSiteAgent(h.options), /1 이상/);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.requests.length, 0);
  }
});

test('unknown element IDs and credential-less login never reach the browser action layer', async () => {
  const h = harness([action('click', { element_id: 'invented-id' }), action('login')]);
  const result = await runSiteAgent(h.options);
  assert.equal(h.calls.length, 0);
  assert.equal(result.actionCount, 0);
  assert.equal(result.observations.filter(item => item.blocked).length, 2);
  assert.match(h.requests[0].input[1].content, /"loginAvailable":false/);
});

test('typing uses only the observed field ID with ordinary text', async () => {
  const h = harness([action('type', { text: '테스트 검색' })]);
  await runSiteAgent(h.options);
  assert.deepEqual(h.calls[0], { action: 'type', element_id: 'e2', text: '테스트 검색', scroll_y: 0 });
});

test('browser closes before finalizing and summaries describe real observations', async () => {
  const timeline = [];
  const h = harness([]);
  h.options.onEvent = event => {
    h.events.push(event);
    if (event.type === 'activity') {
      timeline.push(event.phase);
      if (event.phase === 'finalizing') assert.equal(h.closed(), true);
    }
    if (event.type === 'delta') timeline.push('summary');
  };
  const result = await runSiteAgent(h.options);
  assert.ok(timeline.indexOf('reading') < timeline.indexOf('thinking'));
  assert.ok(timeline.indexOf('finalizing') < timeline.indexOf('summary'));
  assert.ok(timeline.indexOf('summary') < timeline.indexOf('complete'));
  assert.match(result.summary, /클릭 0회 · 입력 0회 · 스크롤 0회/);
  assert.match(result.summary, /https:\/\/example.com\/page-0/);
  assert.equal(/스크린샷|버그 발견|검사 완료/.test(result.summary), false);
});

test('finalizing animation remains cancellable without an extra API call', async () => {
  let ready;
  const finalizing = new Promise(resolve => { ready = resolve; });
  const h = harness([], { finalizePauseMs: 10000 });
  h.options.onEvent = event => { h.events.push(event); if (event.phase === 'finalizing') ready(); };
  const pending = runSiteAgent(h.options);
  await finalizing;
  assert.equal(h.closed(), true);
  h.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.events.some(event => event.type === 'delta' || event.phase === 'complete'), false);
  assert.equal(h.requests.length, 1);
});

test('API errors record unknown usage and close the browser without exposing server text', async () => {
  const h = harness([], { fetchImpl: async () => Response.json({ error: { message: 'private server detail' } }, { status: 401 }) });
  await assert.rejects(runSiteAgent(h.options), /API 키 인증/);
  assert.deepEqual(h.usages, [undefined]);
  assert.equal(h.closed(), true);
});

test('pre-aborted tours open no browser and make no model call', async () => {
  const h = harness([]); h.controller.abort();
  await assert.rejects(runSiteAgent(h.options));
  assert.equal(h.sessions.length, 0);
  assert.equal(h.requests.length, 0);
});

test('credentials remain native-only while DOM, prompts, messages, URLs and summaries are redacted', async () => {
  const credentials = { username: 'alice-private-account', password: 'p@ss word&<9>' };
  const secrets = [credentials.username, credentials.password, encodeURIComponent(credentials.password)];
  const h = harness([action('login')], { credentials, messages: [{ role: 'user', content: `계정 ${credentials.username} ${credentials.password}로 로그인` }] });
  const factory = h.options.sessionFactory;
  h.options.sessionFactory = async args => {
    const session = await factory(args);
    const observe = session.observe;
    args.onStatus(`진행 ${credentials.password}`);
    session.observe = async () => ({ ...await observe(), title: credentials.username, text: secrets.join(' '), url: `https://example.com/?account=${encodeURIComponent(credentials.username)}`, elements: [{ id: 'e1', role: 'button', type: 'submit', label: credentials.password, value: credentials.password }] });
    const act = session.act;
    session.act = async value => ({ ...await act(value), message: `로그인 제출 ${credentials.password}` });
    return session;
  };
  const result = await runSiteAgent(h.options);
  assert.deepEqual(h.sessions[0].credentials, credentials);
  assert.deepEqual(h.calls[0], { action: 'login', element_id: '', text: '', scroll_y: 0 });
  assert.match(h.requests[0].input[1].content, /"loginAvailable":true/);
  const publicContent = JSON.stringify({ requests: h.requests, events: h.events, result, actions: h.calls });
  for (const secret of secrets) assert.equal(publicContent.includes(secret), false, `Secret must not leave native session: ${secret.length} characters`);
  assert.equal(h.requests[0].input[1].content.includes('"value"'), false);
  assert.match(result.summary, /로그인 제출 1회/);
});

test('native errors are redacted and invalid credentials never open a session', async () => {
  const credentials = { username: 'private-user', password: 'private-password' };
  const h = harness([], { credentials, sessionFactory: async () => { throw new Error(`bad ${credentials.password}`); } });
  await assert.rejects(runSiteAgent(h.options), error => !error.message.includes(credentials.password));
  for (const value of [null, {}, { username: 'a' }, { username: 'a', password: '' }, { username: 'a', password: 'x\n' }, { username: 'a', password: 'b', extra: 'c' }]) assert.throws(() => validateCredentials(value));
  assert.deepEqual(validateCredentials({ username: ' a ', password: ' secret ' }), { username: 'a', password: ' secret ' });
  const redact = createSecretRedactor({ username: 'REDACTED', password: '숨김' });
  assert.equal(redact('REDACTED 숨김').includes('숨김'), false);
});

test('arbitrary code, coordinate actions and secret fields are not accepted from the model', () => {
  for (const value of [{ action: 'exec', code: 'evil' }, { ...action('click'), x: 1 }, { ...action('login'), password: 'secret' }, action('scroll', { scroll_y: 601 })]) {
    assert.throws(() => readAction({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }), /지원하지 않는/);
  }
});

test('more than five actions run and model history remains bounded during a long session', async () => {
  const h = harness(Array.from({ length: 30 }, () => action('scroll', { scroll_y: 300 })), { maxActions: 30 });
  const result = await runSiteAgent(h.options);
  assert.equal(h.calls.length, 30);
  assert.equal(result.actionCount, 30);
  assert.equal(result.pages.length, 31);
  const input = h.requests.at(-1).input[1].content;
  const recent = JSON.parse(input.split('Recent outcomes: ')[1].split('\nActions remaining:')[0]);
  assert.equal(recent.length, 12);
  assert.ok(input.length < 25000);
  const huge = harness([], { maxActions: Number.MAX_SAFE_INTEGER });
  await runSiteAgent(huge.options);
  assert.equal(huge.requests.length, 1);
});

test('temporary network and HTTP failures retry selection without repeating an executed action', async () => {
  for (const failure of [new TypeError('network unavailable'), 408, 429, 500, 503]) {
    const h = harness([action('click')], { maxActions: 1 });
    const succeed = h.options.fetchImpl;
    let attempts = 0;
    h.options.fetchImpl = async (...args) => {
      if (++attempts === 1) {
        if (failure instanceof Error) throw failure;
        return Response.json({ error: { code: 'temporary_failure' } }, { status: failure });
      }
      return succeed(...args);
    };
    await runSiteAgent(h.options);
    assert.equal(attempts, 2);
    assert.equal(h.calls.length, 1);
    assert.equal(h.usages.length, 2);
    assert.equal(h.usages[0], undefined);
    assert.ok(h.events.some(event => event.phase === 'thinking' && /2\/3/.test(event.detail)));
  }
});

test('malformed, empty and incomplete selections recover and account every billable response', async () => {
  for (const initial of [() => new Response('not json'), () => Response.json({ status: 'completed', output: [] }), () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{' }] }] })]) {
    const h = harness([action('click')], { maxActions: 1 });
    const succeed = h.options.fetchImpl;
    let attempts = 0;
    h.options.fetchImpl = async (...args) => ++attempts === 1 ? initial() : succeed(...args);
    await runSiteAgent(h.options);
    assert.equal(attempts, 2);
    assert.equal(h.calls.length, 1);
    assert.equal(h.usages.length, 2);
  }
  const h = harness([action('click')], { maxActions: 1 });
  const succeed = h.options.fetchImpl;
  const budgets = [];
  h.options.fetchImpl = async (...args) => {
    budgets.push(JSON.parse(args[1].body).max_output_tokens);
    return budgets.length < 3 ? Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 } }) : succeed(...args);
  };
  await runSiteAgent(h.options);
  assert.deepEqual(budgets, [1024, 2048, 4096]);
  assert.deepEqual(h.usages.map(usage => usage.totalTokens), [15, 15, 120]);
  assert.equal(h.calls.length, 1);
});

test('retries stop after three attempts and permanent API errors never retry', async () => {
  for (const [status, code, expected] of [[503, 'server_error', 3], [429, 'insufficient_quota', 1], [401, 'invalid_api_key', 1], [403, 'permission_denied', 1], [404, 'model_not_found', 1], [400, 'invalid_request_error', 1]]) {
    let attempts = 0;
    const h = harness([], { fetchImpl: async () => { attempts++; return Response.json({ error: { code, message: 'raw private detail' } }, { status }); } });
    await assert.rejects(runSiteAgent(h.options), error => !error.message.includes('raw private'));
    assert.equal(attempts, expected);
    assert.equal(h.usages.length, expected);
    assert.equal(h.calls.length, 0);
    assert.equal(h.closed(), true);
  }
});

test('per-call timeouts recover and cancelling retry backoff launches no extra request', async () => {
  const h = harness([action('click')], { maxActions: 1, requestTimeoutMs: 10 });
  const succeed = h.options.fetchImpl;
  let attempts = 0;
  h.options.fetchImpl = (...args) => ++attempts === 1 ? new Promise((_resolve, reject) => args[1].signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) : succeed(...args);
  await runSiteAgent(h.options);
  assert.equal(attempts, 2);
  assert.equal(h.calls.length, 1);
  const cancelled = harness([], { retryDelayMs: 10000, fetchImpl: async () => { throw new TypeError('offline'); } });
  cancelled.options.onEvent = event => { cancelled.events.push(event); if (event.id === 'site-response-retry') cancelled.controller.abort(); };
  await assert.rejects(runSiteAgent(cancelled.options), { name: 'AbortError' });
  assert.equal(cancelled.usages.length, 1);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.closed(), true);
});

test('transient observation failure refreshes the snapshot but failed native actions are never replayed', async () => {
  const h = harness([action('click')], { maxActions: 1 });
  const factory = h.options.sessionFactory;
  let reads = 0;
  h.options.sessionFactory = async options => {
    const session = await factory(options), observe = session.observe;
    session.observe = () => ++reads === 1 ? Promise.reject(new Error('Execution context was destroyed during navigation')) : observe();
    return session;
  };
  await runSiteAgent(h.options);
  assert.equal(reads, 3);
  assert.equal(h.calls.length, 1);
  assert.ok(h.events.some(event => event.id === 'site-read-retry'));
  const failed = harness([action('login')], { credentials: { username: 'fixture-user', password: 'fixture-pass' } });
  const original = failed.options.sessionFactory;
  let nativeAttempts = 0;
  failed.options.sessionFactory = async options => ({ ...await original(options), act: async () => { nativeAttempts++; throw new Error('Native outcome uncertain'); } });
  await assert.rejects(runSiteAgent(failed.options), /outcome uncertain/);
  assert.equal(nativeAttempts, 1);
  assert.equal(failed.requests.length, 1);
});

test('reports attach after browser close and only ready reports produce the requested completion sentence', async () => {
  const ready = { status: 'ready', id: '84696dda-339b-4142-850e-394c881c4ada', name: 'report.pdf', size: 100, updatedAt: '2026-11-25T00:00:00.000Z', path: 'private-path-must-be-removed' };
  for (const report of [ready, { status: 'missing', message: '보고서 없음' }, { status: 'error', message: '읽기 실패' }, { status: 'ready' }, { ...ready, id: 'a'.repeat(36) }, { ...ready, updatedAt: '2026-11-25' }, { status: 'missing', message: 100 }, { status: 'error', message: '\u0000' }]) {
    const h = harness([]);
    h.options.reportProvider = async ({ signal }) => { assert.equal(h.closed(), true); signal.throwIfAborted(); return report; };
    const result = await runSiteAgent(h.options);
    const index = h.events.findIndex(event => event.type === 'report');
    assert.ok(index > h.events.findIndex(event => event.phase === 'finalizing'));
    assert.ok(index < h.events.findIndex(event => event.type === 'delta'));
    assert.equal(result.summary.startsWith('버그 탐색을 완료했고 보고서를 완성했어요.'), report === ready);
    assert.equal(result.report.path, undefined);
    if (result.report.status !== 'ready') assert.ok(typeof result.report.message === 'string' && result.report.message.trim());
    if (report !== ready) assert.match(result.summary, /보고서를 불러오지 못했어요/);
  }
  const error = harness([], { reportProvider: async () => { throw new Error('private filesystem detail'); } });
  const result = await runSiteAgent(error.options);
  assert.equal(result.report.status, 'error');
  assert.doesNotMatch(result.summary, /private filesystem|보고서를 완성/);
});

test('cancellation while attaching a report publishes no report or completed response', async () => {
  const h = harness([]);
  h.options.reportProvider = async () => { h.controller.abort(); return { status: 'missing', message: 'missing' }; };
  await assert.rejects(runSiteAgent(h.options), { name: 'AbortError' });
  assert.equal(h.events.some(event => event.type === 'report' || event.type === 'delta' || event.phase === 'complete'), false);
});
