const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTargetUrl, validateAction, validateDomAction, matchesLoginRequest, requestPolicy, VIEWPORT } = require('../electron/site-browser.cjs');

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
