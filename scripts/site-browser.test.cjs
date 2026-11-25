const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTargetUrl, validateAction, validateDomAction, matchesLoginRequest, requestPolicy, VIEWPORT, waitForPageReady, typingDelay, readWithNavigationRecovery, SitePolicyError } = require('../electron/site-browser.cjs');

test('site URL policy permits HTTP(S) only, without embedded credentials or mutating paths', () => {
  assert.equal(validateTargetUrl('http://localhost:8000/path').origin, 'http://localhost:8000');
  for (const url of ['file:///tmp/file', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/logout', 'https://example.com/api/delete?id=1']) assert.throws(() => validateTargetUrl(url));
});

test('navigation stays on the exact origin including protocol and port', () => {
  const policy = overrides => requestPolicy({ url: 'http://localhost:8000/page', method: 'GET', navigation: true, ownedPage: true, ...overrides }, 'http://localhost:8000');
  assert.equal(policy({}), null);
  for (const url of ['https://localhost:8000/', 'http://localhost:8001/', 'http://127.0.0.1:8000/', 'https://example.com/']) assert.ok(policy({ url }));
  assert.ok(policy({ ownedPage: false }));
  assert.ok(policy({ method: 'POST' }));
  assert.ok(policy({ method: 'DELETE', navigation: false }));
  assert.ok(policy({ url: 'http://localhost:8000/account?operation=delete' }));
  assert.equal(policy({ url: 'https://cdn.example.com/image.png', navigation: false }), null);
});

test('only bounded left clicks, scrolls and printable short text are accepted', () => {
  assert.equal(validateAction({ type: 'click', x: 10, y: 20 }).type, 'click');
  assert.equal(validateAction({ type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: 500 }).type, 'scroll');
  assert.equal(validateAction({ type: 'type', x: 10, y: 20, text: 'WebPilot 검색' }).type, 'type');
  for (const action of [
    { type: 'click', x: VIEWPORT.width, y: 0 }, { type: 'click', x: -1, y: 0 }, { type: 'click', x: NaN, y: 20 },
    { type: 'click', x: 10, y: 20, button: 'right' }, { type: 'click', x: 10, y: 20, code: 'anything' },
    { type: 'type', text: 'password' }, { type: 'type', x: 1, y: 1, text: 'a'.repeat(201) },
    { type: 'type', x: 1, y: 1, text: 'hello\nsubmit' }, { type: 'type', x: 1, y: 1, text: 'hello\u0000' },
    { type: 'type', x: 1, y: 1, text: '\u202ehidden' }, { type: 'type', x: 1, y: 1, text: '' },
    { type: 'keypress', keys: ['WIN'] }, { type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: 100000 },
  ]) assert.throws(() => validateAction(action));
  assert.equal(validateAction({ type: 'click', x: 1600, y: 900 }, { width: 1920, height: 1080 }).type, 'click');
  assert.throws(() => validateAction({ type: 'click', x: 900, y: 500 }, { width: 800, height: 600 }));
});

test('DOM actions accept only opaque element IDs and bounded operations', () => {
  const id = '9f083b19-b5f8-4847-bc30-bd3a93aa6451';
  assert.equal(validateDomAction({ action: 'click', element_id: id }).action, 'click');
  assert.equal(validateDomAction({ action: 'type', element_id: id, text: 'Search docs' }).text, 'Search docs');
  assert.equal(validateDomAction({ action: 'login' }).action, 'login');
  assert.equal(validateDomAction({ action: 'scroll', scroll_y: 500 }).scroll_y, 500);
  for (const action of [
    { action: 'click', element_id: '#delete' }, { action: 'evaluate', text: 'window.close()' },
    { action: 'click', element_id: id, selector: 'button' }, { action: 'type', element_id: id, text: 'x\n' },
    { action: 'scroll', scroll_y: 1201 }, { action: 'scroll', scroll_y: NaN },
  ]) assert.throws(() => validateDomAction(action));
});

test('login exception is a single exact native form POST with the provided account pair', () => {
  const credentials = { username: 'fixture-user', password: 'fixture-pass' };
  const permit = { url: 'https://example.com/session', usernameField: 'username', passwordField: 'password', fields: ['username', 'password', 'csrf'], used: false, expires: 2000 };
  const request = { url: permit.url, method: 'POST', navigation: true, mainFrame: true, contentType: 'application/x-www-form-urlencoded', body: 'username=fixture-user&password=fixture-pass&csrf=fixed-token' };
  assert.equal(matchesLoginRequest(request, permit, credentials, 1000), true);
  for (const override of [
    { url: 'https://outside.example/session' }, { url: 'https://example.com/other' }, { navigation: false }, { mainFrame: false }, { method: 'GET' },
    { contentType: 'application/json' }, { body: 'username=fixture-user&password=wrong' },
    { body: 'username=fixture-user&username=other&password=fixture-pass' }, { body: 'username=fixture-user&password=fixture-pass&operation=delete' },
  ]) assert.equal(matchesLoginRequest({ ...request, ...override }, permit, credentials, 1000), false);
  assert.equal(matchesLoginRequest(request, { ...permit, used: true }, credentials, 1000), false);
  assert.equal(matchesLoginRequest(request, permit, credentials, 2001), false);
  assert.equal(matchesLoginRequest(request, permit, undefined, 1000), false);
});

test('SPA login permits one same-origin auth endpoint and exact flat credential fields only', () => {
  const credentials = { username: 'fixture-user', password: 'fixture-pass' };
  const permit = { mode: 'spa', allowedOrigin: 'https://example.com', usernameField: 'email', passwordField: 'password', fields: ['email', 'password', 'csrf', 'rememberMe'], used: false, expires: 2000 };
  const request = { url: 'https://example.com/api/auth/login', method: 'POST', navigation: false, mainFrame: true, contentType: 'application/json', body: JSON.stringify({ email: credentials.username, password: credentials.password, csrf: 'fixed', rememberMe: true }) };
  assert.equal(matchesLoginRequest(request, permit, credentials, 1000), true);
  assert.equal(matchesLoginRequest({ ...request, contentType: 'application/x-www-form-urlencoded', body: 'email=fixture-user&password=fixture-pass' }, permit, credentials, 1000), true);
  for (const override of [
    { url: 'https://outside.example/api/auth/login' }, { url: 'https://example.com/api/write' }, { url: 'https://example.com/api/auth/reset' },
    { url: 'https://example.com/api/auth/signup' }, { navigation: true }, { mainFrame: false },
    { body: JSON.stringify({ email: credentials.username, password: credentials.password, operation: 'delete' }) },
    { body: JSON.stringify({ user: { email: credentials.username, password: credentials.password } }) },
  ]) assert.equal(matchesLoginRequest({ ...request, ...override }, permit, credentials, 1000), false);
  assert.equal(matchesLoginRequest(request, { ...permit, used: true }, credentials, 1000), false);
  assert.equal(matchesLoginRequest(request, permit, credentials, 2001), false);
});

test('an already stable page proceeds immediately without a fixed post-action delay', async () => {
  let waits = 0;
  assert.equal(await waitForPageReady({ read: async () => ({ ready: true, pending: false, busy: false, quietForMs: 200 }),
    now: () => 0, wait: async () => { waits += 1; } }), true);
  assert.equal(waits, 0);
});

test('SPA content waits for its request and resulting DOM updates, then proceeds', async () => {
  let elapsed = 0;
  const ready = await waitForPageReady({ now: () => elapsed, wait: async ms => { elapsed += ms; },
    read: async () => ({ ready: true, pending: elapsed < 900, busy: elapsed < 900, quietForMs: Math.max(0, elapsed - 950) }) });
  assert.equal(ready, true);
  assert.ok(elapsed >= 1040 && elapsed < 1100);
});

test('continuous animation and long polling have bounded waits', async () => {
  for (const [pending, busy, bound] of [[false, false, 180], [true, false, 1500], [true, true, 3000]]) {
    let elapsed = 0;
    assert.equal(await waitForPageReady({ now: () => elapsed, wait: async ms => { elapsed += ms; },
      read: async () => ({ ready: true, pending, busy, quietForMs: 0 }) }), false);
    assert.equal(elapsed, bound);
  }
});

test('debounced input can start a delayed request without delaying immediate DOM updates', async () => {
  let elapsed = 0;
  const options = { expectChange: true, now: () => elapsed, wait: async ms => { elapsed += ms; } };
  assert.equal(await waitForPageReady({ ...options,
    read: async () => ({ ready: true, pending: elapsed >= 300 && elapsed < 700, busy: false, changed: elapsed >= 700, quietForMs: elapsed < 700 ? 1000 : elapsed - 700 }) }), true);
  assert.ok(elapsed >= 790 && elapsed <= 850);
  elapsed = 0;
  assert.equal(await waitForPageReady({ ...options,
    read: async () => ({ ready: true, pending: false, busy: false, changed: true, quietForMs: 100 }) }), true);
  assert.equal(elapsed, 0);
});

test('page readiness observation stops immediately on cancellation', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(waitForPageReady({ signal: controller.signal, now: () => 0,
    read: async () => { reads += 1; return { ready: true, pending: true, busy: false, quietForMs: 0 }; },
    wait: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(reads, 1);
});

test('typing retains per-key events with at most 120ms intentional pacing per field', () => {
  for (const length of [1, 20, 60, 200, 320, 1024]) {
    const delay = typingDelay(length);
    assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 6);
    assert.ok(length * delay <= 120);
  }
});

test('readiness reads recover across delayed document replacement without repeating an action', async () => {
  let reads = 0, recoveries = 0, documentReady = false, checks = 0;
  const result = await readWithNavigationRecovery({
    read: async () => {
      reads += 1;
      if (!documentReady) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
      return { ready: true, url: 'https://example.com/inside' };
    },
    recover: async () => { recoveries += 1; await new Promise(resolve => setImmediate(resolve)); documentReady = true; },
    assertActive: () => { checks += 1; },
  });
  assert.deepEqual(result, { ready: true, url: 'https://example.com/inside' });
  assert.equal(reads, 2); assert.equal(recoveries, 1); assert.ok(checks >= 3);
});

test('navigation-context recovery attempts at most three reads', async () => {
  let reads = 0, recoveries = 0;
  const failure = new Error('Protocol error (Runtime.callFunctionOn): Cannot find context with specified id');
  await assert.rejects(readWithNavigationRecovery({
    read: async () => { reads += 1; throw failure; },
    recover: async () => { recoveries += 1; },
  }), error => error === failure);
  assert.equal(reads, 3); assert.equal(recoveries, 2);
});

test('cancelling during document recovery prevents another read', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(readWithNavigationRecovery({ signal: controller.signal,
    read: async () => { reads += 1; throw new Error('Execution context was destroyed'); },
    recover: async () => { await new Promise(resolve => setImmediate(resolve)); controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(reads, 1);
});

test('document recovery never bypasses origin policy or retries unrelated failures', async () => {
  let reads = 0, recoveries = 0, allowed = true;
  await assert.rejects(readWithNavigationRecovery({
    assertActive: () => { if (!allowed) throw new SitePolicyError('허용된 사이트 범위를 벗어났습니다.'); },
    read: async () => { reads += 1; throw new Error('Execution context was destroyed'); },
    recover: async () => { recoveries += 1; allowed = false; },
  }), SitePolicyError);
  assert.equal(reads, 1); assert.equal(recoveries, 1);
  for (const failure of [new Error('Target page, context or browser has been closed'), new Error('Read failed'), new SitePolicyError('Execution context was destroyed')]) {
    let attempts = 0;
    await assert.rejects(readWithNavigationRecovery({
      read: async () => { attempts += 1; throw failure; },
      recover: async () => assert.fail('Unrelated failures must not be retried'),
    }), error => error === failure);
    assert.equal(attempts, 1);
  }
});
