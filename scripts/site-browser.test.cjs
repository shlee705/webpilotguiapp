const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTargetUrl, validateBackendFollowUrl, validateAction, validateDomAction, matchesLoginRequest, matchesLoginPreparationRequest, matchesContentSubmission, validateTaskPermissions, isForbiddenContentContext, requestPolicy, VIEWPORT, waitForPageReady, typingDelay, readWithNavigationRecovery, SitePolicyError, SiteInteractionError, sanitizeInteractionError, isStandaloneButton, isSensitiveControl, normalizeInputText, inputChunks } = require('../electron/site-browser.cjs');

test('native backend page synchronization keeps the original navigation policy', () => {
  const start = 'http://localhost:8000/catalog';
  assert.equal(validateBackendFollowUrl('http://localhost:8000/details?id=2', start).href, 'http://localhost:8000/details?id=2');
  for (const destination of ['https://localhost:8000/', 'http://localhost:8001/', 'http://user:pass@localhost:8000/', 'http://localhost:8000/logout', 'javascript:alert(1)', 'file:///private']) {
    assert.throws(() => validateBackendFollowUrl(destination, start), SitePolicyError);
  }
});

test('standalone default-submit buttons are safe only with no form or submission semantics', () => {
  const standalone = { type: 'submit', disabled: false, hasFormOwner: false, inForm: false, hasFormAttribute: false, hasSubmitOverrides: false };
  assert.equal(isStandaloneButton(standalone), true);
  assert.equal(isStandaloneButton({ ...standalone, type: 'button' }), true);
  for (const override of [{ type: 'reset' }, { disabled: true }, { hasFormOwner: true }, { inForm: true }, { hasFormAttribute: true }, { hasSubmitOverrides: true }]) {
    assert.equal(isStandaloneButton({ ...standalone, ...override }), false);
  }
  assert.equal(isStandaloneButton(undefined), false);
  assert.equal(isStandaloneButton({ type: 'submit' }), false);
});

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

test('editor navigation is distinct from publishing and sample account shortcuts', () => {
  for (const label of ['글쓰기', '게시글 작성', '새 게시글', '게시판', 'Write a post', 'Create post']) assert.equal(isSensitiveControl(label), false, label);
  for (const label of ['게시', '게시글 게시', '게시글 작성 후 발행', 'Publish post', 'Submit', '삭제', '관리자 계정', '학생 계정', '관리자 123456 / fixture', '학생 654321 / sample', '샘플 계정 입력', 'Demo account', 'ID: fixture / password: sample']) assert.equal(isSensitiveControl(label), true, label);
});

test('draft text allows LF and normalizes CRLF without allowing other control characters', () => {
  assert.equal(normalizeInputText('제목\r\n본문'), '제목\n본문');
  assert.equal(normalizeInputText('제목\r본문'), '제목\n본문');
  assert.equal(normalizeInputText('가'.repeat(4000)).length, 4000);
  for (const value of ['', ' \n', '가'.repeat(4001), 'a\vb', 'a\tb', 'a\u0000b', 'a\u202eb', 'a\u2028b']) assert.throws(() => normalizeInputText(value), SitePolicyError);
  const id = '9f083b19-b5f8-4847-bc30-bd3a93aa6451';
  assert.equal(validateDomAction({ action: 'type', element_id: id, text: 'one\r\ntwo' }).text, 'one\ntwo');
  assert.equal(validateAction({ type: 'type', x: 1, y: 1, text: 'one\r\ntwo' }).text, 'one\ntwo');
});

test('only bounded left clicks, scrolls and valid draft text are accepted', () => {
  assert.equal(validateAction({ type: 'click', x: 10, y: 20 }).type, 'click');
  assert.equal(validateAction({ type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: 500 }).type, 'scroll');
  assert.equal(validateAction({ type: 'type', x: 10, y: 20, text: 'WebPilot 검색' }).type, 'type');
  for (const action of [
    { type: 'click', x: VIEWPORT.width, y: 0 }, { type: 'click', x: -1, y: 0 }, { type: 'click', x: NaN, y: 20 },
    { type: 'click', x: 10, y: 20, button: 'right' }, { type: 'click', x: 10, y: 20, code: 'anything' },
    { type: 'type', text: 'password' }, { type: 'type', x: 1, y: 1, text: 'a'.repeat(4001) },
    { type: 'type', x: 1, y: 1, text: 'hello\vsubmit' }, { type: 'type', x: 1, y: 1, text: 'hello\u0000' },
    { type: 'type', x: 1, y: 1, text: '\u202ehidden' }, { type: 'type', x: 1, y: 1, text: '' },
    { type: 'keypress', keys: ['WIN'] }, { type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: 100000 },
    { type: 'scroll', x: 10, y: 20, scroll_x: 0, scroll_y: 0 },
  ]) assert.throws(() => validateAction(action));
  assert.equal(validateAction({ type: 'click', x: 1600, y: 900 }, { width: 1920, height: 1080 }).type, 'click');
  assert.throws(() => validateAction({ type: 'click', x: 900, y: 500 }, { width: 800, height: 600 }));
});

test('DOM actions accept only opaque element IDs and bounded operations', () => {
  const id = '9f083b19-b5f8-4847-bc30-bd3a93aa6451';
  assert.equal(validateDomAction({ action: 'click', element_id: id }).action, 'click');
  assert.equal(validateDomAction({ action: 'submit', element_id: id }).action, 'submit');
  assert.equal(validateDomAction({ action: 'type', element_id: id, text: 'Search docs' }).text, 'Search docs');
  assert.equal(validateDomAction({ action: 'login' }).action, 'login');
  assert.equal(validateDomAction({ action: 'scroll', scroll_y: 500 }).scroll_y, 500);
  for (const action of [
    { action: 'click', element_id: '#delete' }, { action: 'evaluate', text: 'window.close()' },
    { action: 'click', element_id: id, selector: 'button' }, { action: 'type', element_id: id, text: 'x\t' },
    { action: 'scroll', scroll_y: 1201 }, { action: 'scroll', scroll_y: NaN }, { action: 'scroll', scroll_y: 0 },
  ]) assert.throws(() => validateDomAction(action));
  assert.throws(() => validateDomAction({ action: 'submit' }));
});

test('content submission needs a valid trusted task permission object', () => {
  assert.equal(validateTaskPermissions(undefined).allowContentSubmission, false);
  assert.deepEqual(validateTaskPermissions({ allowContentSubmission: true, contentKinds: ['notice', 'post'] }), { allowContentSubmission: true, contentKinds: ['notice', 'post'] });
  for (const value of [true, [], null, { allowContentSubmission: 'yes', contentKinds: ['notice'] }, { allowContentSubmission: true, contentKinds: ['payment'] }, { allowContentSubmission: true, contentKinds: ['post'], endpoint: '/anything' }]) assert.throws(() => validateTaskPermissions(value), SitePolicyError);
});

test('new editor form names remain allowed while edit and update tokens stay blocked', () => {
  for (const description of ['/notices post-editor 공지 등록', '/articles article_editor 새 글 등록', 'content editor Publish post']) assert.equal(isForbiddenContentContext(description), false, description);
  for (const description of ['/posts/edit', 'post-edit', 'post_update', 'update', 'Edit post', '공지 수정', 'payment editor', 'delete post']) assert.equal(isForbiddenContentContext(description), true, description);
});

test('content POST gate binds one submitted form to its exact text and field values', () => {
  const permit = { allowedOrigin: 'https://example.com', mode: 'spa', submitted: true, used: false, expires: 2000, contentKind: 'notice',
    fields: { title: 'QA title', body: 'first\nsecond', category: '학과', secret: false, pinned: false }, checkboxValues: { secret: 'on', pinned: 'on' } };
  const payload = { ...permit.fields, board: 'notices' };
  const request = { url: 'https://example.com/api/posts', method: 'POST', mainFrame: true, navigation: false, contentType: 'application/json', body: JSON.stringify(payload) };
  assert.equal(matchesContentSubmission(request, permit, 1000), true);
  for (const override of [
    { url: 'https://outside.example/api/posts' }, { url: 'https://example.com/api/posts/123' }, { url: 'https://example.com/api/delete/posts' },
    { url: 'https://example.com/api/payments/posts' }, { url: 'https://example.com/api/account/posts' }, { url: 'https://example.com/api/posts?delete=1' },
    { method: 'PATCH' }, { method: 'DELETE' }, { mainFrame: false }, { navigation: true }, { contentType: 'multipart/form-data' },
  ]) assert.equal(matchesContentSubmission({ ...request, ...override }, permit, 1000), false);
  for (const delta of [{ title: 'changed' }, { body: 'changed' }, { category: 'other' }, { secret: true }, { pinned: true }, { board: 'articles' }, { userId: 'administrator' }, { amount: '10' }, { body: { nested: 'value' } }]) {
    assert.equal(matchesContentSubmission({ ...request, body: JSON.stringify({ ...payload, ...delta }) }, permit, 1000), false);
  }
  assert.equal(matchesContentSubmission(request, { ...permit, used: true }, 1000), false);
  assert.equal(matchesContentSubmission(request, { ...permit, submitted: false }, 1000), false);
  assert.equal(matchesContentSubmission(request, permit, 2001), false);
  assert.equal(matchesContentSubmission({ ...request, body: JSON.stringify({ ...payload, body: 'first\r\nsecond' }) }, permit, 1000), true);
});

test('HTML content submission accepts exact form fields once and blocks duplicates', () => {
  const permit = { allowedOrigin: 'https://example.com', mode: 'html', url: 'https://example.com/articles', submitted: true, used: false, expires: 2000, contentKind: 'article',
    fields: { title: 'QA title', content: 'body', category: 'news', secret: false, pinned: true }, checkboxValues: { secret: 'on', pinned: 'on' } };
  const request = { url: permit.url, method: 'POST', mainFrame: true, navigation: true, contentType: 'application/x-www-form-urlencoded', body: 'title=QA+title&content=body&category=news&pinned=on' };
  assert.equal(matchesContentSubmission(request, permit, 1000), true);
  for (const body of [request.body + '&title=second', request.body + '&secret=on', request.body.replace('&pinned=on', ''), request.body + '&operation=delete']) assert.equal(matchesContentSubmission({ ...request, body }, permit, 1000), false);
  assert.equal(matchesContentSubmission({ ...request, url: 'https://example.com/api/articles' }, permit, 1000), false);
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

test('SPA CSRF preparation is read-only and requires an actual armed form submission', () => {
  const permit = { mode: 'spa', allowedOrigin: 'https://example.com', used: false, expires: 2000 };
  const request = { url: 'https://example.com/api/auth/csrf', method: 'GET', mainFrame: true, navigation: false };
  assert.equal(matchesLoginPreparationRequest(request, permit, true, 1000), true);
  assert.equal(matchesLoginPreparationRequest(request, permit, false, 1000), false);
  assert.equal(matchesLoginPreparationRequest(request, undefined, true, 1000), false);
  for (const override of [{ used: true }, { expires: 500 }, { mode: 'html' }]) {
    assert.equal(matchesLoginPreparationRequest(request, { ...permit, ...override }, true, 1000), false);
  }
  for (const override of [{ url: 'https://outside.example/api/auth/csrf' }, { url: 'https://example.com/api/auth/csrf?value=partial' },
    { url: 'https://example.com/api/auth/csrf#partial' }, { url: 'https://example.com/api/auth/accounts' },
    { method: 'POST' }, { navigation: true }, { mainFrame: false }]) {
    assert.equal(matchesLoginPreparationRequest({ ...request, ...override }, permit, true, 1000), false);
  }
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

test('long native input chunks are bounded and never split Unicode code points', () => {
  const text = `${'가'.repeat(99)}😀${'한국어🙂'.repeat(800)}`;
  const chunks = inputChunks(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length > 30);
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk).length <= 100);
    assert.equal(chunk.isWellFormed(), true);
  }
  assert.deepEqual(inputChunks(''), []);
  assert.deepEqual(inputChunks('short'), ['short']);
});

test('uncertain input errors remain fatal without exposing private diagnostics', () => {
  const timeout = new Error('Timeout typing secret-value at private selector');
  const policy = new SitePolicyError('Input field changed');
  assert.equal(sanitizeInteractionError(policy), policy);
  assert.equal(sanitizeInteractionError(policy, { privateInputStarted: true }), policy);
  for (const [error, options] of [[timeout, { privateInputStarted: true }], [timeout, { inputStarted: true }], [policy, { inputStarted: true }]]) {
    const safe = sanitizeInteractionError(error, options);
    assert.ok(safe instanceof SiteInteractionError);
    assert.equal(safe instanceof SitePolicyError, false);
    assert.doesNotMatch(safe.message, /secret-value|private selector/);
    assert.equal(safe.cause, undefined);
  }
  const cancelled = new DOMException('Cancelled', 'AbortError');
  assert.equal(sanitizeInteractionError(cancelled, { inputStarted: true, privateInputStarted: true }), cancelled);
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
