'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSiteAgent } = require('../electron/site-agent.cjs');
const { createProgressFeed, createInspectionAgent } = require('../electron/inspection.cjs');

function fixture(overrides = {}) {
  const feed = createProgressFeed(), events = [], requests = [], opened = [], followed = [], acts = [];
  const controller = new AbortController();
  const credentials = { username: 'fixture-private-user', password: 'fixture-private-password!7' };
  let authenticated = 0, closed = 0, location;
  feed.update({ sequence: 1, phase: 'starting' });
  const options = {
    apiKey: 'visual-only-fixture-key', model: 'gpt-6-luna', targetUrl: 'https://example.test/',
    loginUrl: 'https://example.test/signin.html', credentials, backendProgress: feed,
    messages: [{ role: 'user', content: '검색 기능을 검사해 줘.' }], signal: controller.signal,
    onEvent: event => events.push(event), onUsage() {}, retryDelayMs: 0,
    sessionFactory: async input => {
      opened.push(input); location = input.url;
      return {
        authenticate: async () => {
          authenticated++;
          feed.update({ sequence: 2, phase: 'exploring', url: 'https://example.test/early' });
          await new Promise(resolve => setImmediate(resolve));
          feed.update({ sequence: 3, phase: 'executing', url: 'https://example.test/protected', action: 'inspect' });
          location = 'https://example.test/welcome';
          return { url: location, message: 'native login confirmed', login: { status: 'confirmed' } };
        },
        observe: async () => ({ url: location, title: 'Protected page', text: 'Page content', elements: [], loginAvailable: false, loginFormVisible: false }),
        followBackendUrl: async url => { followed.push(url); location = url; return { url }; },
        act: async action => { acts.push(action); feed.finish(); return { url: location, message: '스크롤 완료', performed: true }; },
        close: async () => { closed++; },
      };
    },
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ action: 'scroll', scroll_y: 120, element_id: '', text: '', reason: '현재 검사 화면 확인' }) }] }] });
    },
    ...overrides,
  };
  return { options, feed, events, requests, opened, followed, acts, credentials, controller,
    authenticated: () => authenticated, closed: () => closed };
}

test('explicit login setting opens configured login before any backend location or model call, then follows latest observation', async () => {
  const h = fixture();
  const fetch = h.options.fetchImpl;
  h.options.fetchImpl = async (...args) => {
    assert.equal(h.authenticated(), 1);
    assert.deepEqual(h.followed, ['https://example.test/protected']);
    return fetch(...args);
  };
  const result = await runSiteAgent(h.options);
  assert.equal(h.opened[0].url, h.options.loginUrl);
  assert.deepEqual(h.opened[0].credentials, h.credentials);
  assert.equal(h.opened[0].followBackend, true);
  assert.equal(h.authenticated(), 1);
  assert.equal(h.closed(), 1);
  assert.equal(result.actionCount, 2, 'One native login and one visual action are observed.');
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].input[1].content, /"loginAvailable":false/);
  assert.match(h.requests[0].input[1].content, /"phase":"executing"/);
  for (const value of [h.credentials.username, h.credentials.password, h.options.loginUrl]) {
    assert.equal(JSON.stringify(h.requests).includes(value), false);
  }
  for (const value of Object.values(h.credentials)) assert.equal(JSON.stringify(h.events).includes(value), false);
});

test('authenticated visual session waits without model calls until backend observes a location', async () => {
  const h = fixture(), factory = h.options.sessionFactory;
  h.options.sessionFactory = async input => ({ ...await factory(input), authenticate: async () => ({ url: 'https://example.test/welcome', login: { status: 'confirmed' } }) });
  h.feed.waitForChange = async () => {
    assert.equal(h.requests.length, 0);
    h.feed.update({ sequence: 2, phase: 'mapping', url: 'https://example.test/protected' });
    return h.feed.current();
  };
  await runSiteAgent(h.options);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.followed, ['https://example.test/protected']);
});

test('unauthorized login never starts and native login URL rejects external or secret destinations before browser creation', async () => {
  for (const overrides of [
    { loginUrl: 'https://outside.test/signin' },
    { loginUrl: 'https://example.test/signin?password=fixture-private-password!7' },
    { credentials: undefined },
  ]) {
    const h = fixture(overrides);
    await assert.rejects(runSiteAgent(h.options));
    assert.equal(h.opened.length, 0);
    assert.equal(h.requests.length, 0);
  }
  const h = fixture({ credentials: undefined, loginUrl: undefined });
  h.feed.update({ sequence: 2, phase: 'exploring', url: 'https://example.test/public' });
  await runSiteAgent(h.options);
  assert.equal(h.authenticated(), 0);
  assert.equal(h.opened[0].url, 'https://example.test/public');
});

test('rejected or ambiguous native login stops display without model work or resubmission', async () => {
  for (const status of ['rejected', 'unconfirmed', undefined]) {
    const h = fixture(), factory = h.options.sessionFactory;
    let calls = 0;
    h.options.sessionFactory = async input => ({ ...await factory(input), authenticate: async () => {
      calls++; return { url: input.url, login: { status } };
    } });
    await assert.rejects(runSiteAgent(h.options), /로그인 성공/);
    assert.equal(calls, 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.followed.length, 0);
    assert.equal(h.closed(), 1);
    assert.ok(h.events.some(event => event.id === 'site-login' && event.label.includes('로그인 중단')));
    assert.equal(h.events.some(event => event.id === 'site-login' && event.label.includes('유지 확인')), false);
  }
});

test('a native challenge failure is redacted and backend completion or cancellation never starts later visual work', async () => {
  for (const kind of ['challenge', 'cancel', 'finish', 'finish-on-open']) {
    const h = fixture(), factory = h.options.sessionFactory;
    let calls = 0;
    h.options.sessionFactory = async input => {
      const session = await factory(input);
      if (kind === 'finish-on-open') h.feed.finish();
      return { ...session, authenticate: async () => {
        calls++;
        if (kind === 'challenge') throw Object.assign(new Error(`추가 인증 필요 ${h.credentials.password}`), { name: 'SitePolicyError' });
        if (kind === 'cancel') h.controller.abort(); else h.feed.finish();
        return { url: input.url, login: { status: 'confirmed' } };
      } };
    };
    if (['challenge', 'cancel'].includes(kind)) await assert.rejects(runSiteAgent(h.options)); else await runSiteAgent(h.options);
    assert.equal(calls, kind === 'finish-on-open' ? 0 : 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.followed.length, 0);
    assert.equal(h.closed(), 1);
    assert.equal(JSON.stringify(h.events).includes(h.credentials.password), false);
  }
});

test('returning to a login form does not resubmit credentials or ask a model to bypass authentication', async () => {
  const h = fixture(), factory = h.options.sessionFactory;
  h.options.sessionFactory = async input => ({ ...await factory(input), observe: async () => ({ url: input.url, elements: [], loginFormVisible: true, loginAvailable: false }) });
  await assert.rejects(runSiteAgent(h.options), /로그인 세션/);
  assert.equal(h.authenticated(), 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.closed(), 1);
});

test('an explicitly observed public login page remains viewable without submitting another login', async () => {
  const h = fixture(), factory = h.options.sessionFactory;
  h.options.sessionFactory = async input => {
    const session = await factory(input);
    return { ...session, authenticate: async () => {
      const result = await session.authenticate();
      h.feed.update({ sequence: 4, phase: 'exploring', url: input.url, action: 'inspect' });
      return result;
    }, observe: async () => ({ url: input.url, elements: [], loginFormVisible: true, loginAvailable: true }) };
  };
  await runSiteAgent(h.options);
  assert.equal(h.authenticated(), 1);
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].input[1].content, /"loginAvailable":false/);
});

test('visual login failure preserves independent completed backend result and its verified report', async () => {
  const events = [], native = fixture();
  const runner = createInspectionAgent({
    backendRunner: { preflight: async () => {}, run: async ({ onProgress }) => {
      onProgress({ sequence: 1, phase: 'starting' });
      await new Promise(resolve => setTimeout(resolve, 20));
      return { runId: 'fixture-run', completed: true };
    } },
    siteAgent: input => runSiteAgent({ ...native.options, ...input, sessionFactory: async args => ({
      authenticate: async () => ({ url: args.url, login: { status: 'rejected' } }), close: async () => {},
    }) }),
    attachBackendReport: async () => ({ status: 'ready', id: 'fixture-report' }),
  });
  await runner({ ...native.options, backendLoginUrl: native.options.loginUrl, onEvent: event => events.push(event) });
  assert.ok(events.some(event => event.id === 'site-login' && event.label.includes('중단')));
  assert.ok(events.some(event => event.type === 'report' && event.report.inspectionCompleted));
  assert.ok(events.some(event => event.type === 'delta' && event.text.includes('화면 표현은 중간에 중단')));
  assert.equal(native.requests.length, 0);
});
