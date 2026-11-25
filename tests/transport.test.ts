import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sendChat } from '../src/lib/transport';
import { createMessage } from '../src/lib/storage';
import { DEFAULT_MODEL, type AgentEvent, type LoginCredentials, type MessageRole } from '../src/types';

type Envelope = { requestId: string; event: AgentEvent };
type Request = { requestId: string; messages: { role: MessageRole; content: string }[]; model: string; targetUrl?: string; maxActions?: number; credentials?: LoginCredentials };
type Result = { ok: boolean; error?: string; cancelled?: boolean };

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function bridge(start?: (request: Request) => Promise<Result>) {
  const listeners = new Set<(details: Envelope) => void>();
  const requests: Request[] = [];
  const cancelled: string[] = [];
  const api = {
    startAiChat(request: Request) { requests.push(request); return start?.(request) ?? Promise.resolve({ ok: true }); },
    cancelAiChat(requestId: string) { cancelled.push(requestId); return Promise.resolve(); },
    onAiEvent(listener: (details: Envelope) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { pilotDesktop: api } });
  return { api, requests, listeners, cancelled, emit(details: Envelope) { for (const listener of listeners) listener(details); } };
}

function options(events: AgentEvent[] = [], signal = new AbortController().signal) {
  return {
    conversationId: 'same-conversation',
    messages: [createMessage('user', '안녕하세요')],
    model: DEFAULT_MODEL,
    signal,
    onEvent: (event: AgentEvent) => { events.push(event); },
  };
}

test('browser preview rejects without a native bridge and never supplies demo output', async () => {
  const events: AgentEvent[] = [];
  await assert.rejects(sendChat(options(events)), /데스크톱 앱/);
  assert.deepEqual(events, []);
});

test('subscribes before native launch, sends only actual conversation content and forwards usage', async () => {
  const events: AgentEvent[] = [];
  const mock = bridge(async (request) => {
    assert.equal(mock.listeners.size, 1);
    mock.emit({ requestId: request.requestId, event: { type: 'delta', text: '실제 응답' } });
    mock.emit({ requestId: request.requestId, event: { type: 'usage', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } } });
    mock.emit({ requestId: request.requestId, event: { type: 'done' } });
    return { ok: true };
  });
  const request = options(events);
  request.messages.unshift({ ...createMessage('assistant', 'old demo'), source: 'legacy' });
  request.messages.unshift({ ...createMessage('assistant', 'local plan card, not API output'), source: 'local' });
  request.messages.push(createMessage('assistant', ''));
  await sendChat(request);
  assert.deepEqual(mock.requests[0].messages, [{ role: 'user', content: '안녕하세요' }]);
  assert.equal(mock.requests[0].model, DEFAULT_MODEL);
  assert.deepEqual(events.map((event) => event.type), ['delta', 'usage', 'done']);
  assert.equal(mock.listeners.size, 0);
});

test('isolates simultaneous requests in the same conversation and removes each listener', async () => {
  const pending = [deferred<Result>(), deferred<Result>()];
  let count = 0;
  const mock = bridge(() => pending[count++].promise);
  const first: AgentEvent[] = [];
  const second: AgentEvent[] = [];
  const firstCall = sendChat(options(first));
  const secondCall = sendChat(options(second));
  const [a, b] = mock.requests;
  assert.notEqual(a.requestId, b.requestId);
  mock.emit({ requestId: a.requestId, event: { type: 'delta', text: 'first' } });
  mock.emit({ requestId: b.requestId, event: { type: 'delta', text: 'second' } });
  mock.emit({ requestId: 'unrelated', event: { type: 'delta', text: 'ignored' } });
  pending[0].resolve({ ok: true });
  await firstCall;
  assert.equal(mock.listeners.size, 1);
  pending[1].resolve({ ok: true });
  await secondCall;
  assert.deepEqual(first, [{ type: 'delta', text: 'first' }, { type: 'done' }]);
  assert.deepEqual(second, [{ type: 'delta', text: 'second' }, { type: 'done' }]);
  assert.equal(mock.listeners.size, 0);
});

test('abort immediately rejects, cancels native work and ignores late native completion', async () => {
  const pending = deferred<Result>();
  const mock = bridge(() => pending.promise);
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const call = sendChat(options(events, controller.signal));
  const { requestId } = mock.requests[0];
  mock.emit({ requestId, event: { type: 'delta', text: 'partial' } });
  controller.abort();
  await assert.rejects(call, { name: 'AbortError' });
  assert.deepEqual(mock.cancelled, [requestId]);
  assert.equal(mock.listeners.size, 0);
  mock.emit({ requestId, event: { type: 'done' } });
  pending.reject(new Error('late failure'));
  await Promise.resolve();
  assert.deepEqual(events, [{ type: 'delta', text: 'partial' }]);
});

test('pre-aborted requests do not subscribe or launch native work', async () => {
  const mock = bridge();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sendChat(options([], controller.signal)), { name: 'AbortError' });
  assert.equal(mock.requests.length, 0);
  assert.equal(mock.listeners.size, 0);
});

test('native failure and native cancellation clean up listeners', async () => {
  const failed = bridge(async () => ({ ok: false, error: 'API key missing' }));
  await assert.rejects(sendChat(options()), /API key missing/);
  assert.equal(failed.listeners.size, 0);
  const cancelled = bridge(async () => ({ ok: false, cancelled: true }));
  await assert.rejects(sendChat(options()), { name: 'AbortError' });
  assert.equal(cancelled.listeners.size, 0);
  const thrown = bridge(async () => { throw new Error('IPC closed'); });
  await assert.rejects(sendChat(options()), /IPC closed/);
  assert.equal(thrown.listeners.size, 0);
});

test('callback failure cancels native work and releases event subscription', async () => {
  const pending = deferred<Result>();
  const mock = bridge(() => pending.promise);
  const call = sendChat({ ...options(), onEvent: () => { throw new Error('render failed'); } });
  const { requestId } = mock.requests[0];
  mock.emit({ requestId, event: { type: 'delta', text: 'hello' } });
  await assert.rejects(call, /render failed/);
  assert.deepEqual(mock.cancelled, [requestId]);
  assert.equal(mock.listeners.size, 0);
  pending.resolve({ ok: true });
});

test('deduplicates done but accepts trailing usage before native completion', async () => {
  const pending = deferred<Result>();
  const mock = bridge(() => pending.promise);
  const events: AgentEvent[] = [];
  const call = sendChat(options(events));
  const { requestId } = mock.requests[0];
  mock.emit({ requestId, event: { type: 'done' } });
  mock.emit({ requestId, event: { type: 'done' } });
  mock.emit({ requestId, event: { type: 'delta', text: 'late ignored text' } });
  mock.emit({ requestId, event: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } });
  pending.resolve({ ok: true });
  await call;
  assert.deepEqual(events.map((event) => event.type), ['done', 'usage']);
});

test('requires model and user message before native launch', async () => {
  const mock = bridge();
  await assert.rejects(sendChat({ ...options(), model: ' ' }), /모델/);
  await assert.rejects(sendChat({ ...options(), messages: [] }), /메시지/);
  assert.equal(mock.requests.length, 0);
});

test('forwards target URL to native agent and returns browser execution events', async () => {
  const events: AgentEvent[] = [];
  const mock = bridge(async (request) => {
    assert.equal(request.targetUrl, 'https://example.com/');
    mock.emit({ requestId: request.requestId, event: { type: 'browser', url: request.targetUrl!, status: 'opened' } });
    return { ok: true };
  });
  await sendChat({ ...options(events), targetUrl: 'https://example.com/' });
  assert.deepEqual(events, [{ type: 'browser', url: 'https://example.com/', status: 'opened' }, { type: 'done' }]);
});

test('forwards native screenshot metadata without fetching image bytes in the transport', async () => {
  const events: AgentEvent[] = [];
  const capture = { id: 'capture-1', url: 'https://example.com/', index: 1, createdAt: new Date().toISOString() };
  const mock = bridge(async (request) => {
    mock.emit({ requestId: request.requestId, event: { type: 'screenshot', capture } });
    return { ok: true };
  });
  await sendChat(options(events));
  assert.deepEqual(events, [{ type: 'screenshot', capture }, { type: 'done' }]);
});

test('forwards action limit and all native activity phases for a started tour', async () => {
  const events: AgentEvent[] = [];
  const mock = bridge(async (request) => {
    assert.equal(request.maxActions, 3);
    for (const phase of ['reading', 'thinking', 'acting', 'finalizing', 'complete'] as const) {
      mock.emit({ requestId: request.requestId, event: { type: 'activity', phase, visitedCount: 4, actionCount: 3, url: 'https://example.com/' } });
    }
    return { ok: true };
  });
  await sendChat({ ...options(events), targetUrl: 'https://example.com/', maxActions: 3 });
  assert.deepEqual(events.filter(event => event.type === 'activity').map(event => event.phase), ['reading', 'thinking', 'acting', 'finalizing', 'complete']);
  assert.equal(events.at(-1)?.type, 'done');
});

test('keeps credentials in transient native fields and strips them from all API text', async () => {
  const mock = bridge();
  const credentials = { username: 'account-744', password: 'secret-388' };
  await sendChat({ ...options(), targetUrl: 'https://example.com/', credentials, messages: [
    createMessage('user', '로그인해 줘\nid: account-744\npassword: secret-388'),
    { ...createMessage('assistant', 'Repeated account-744 and secret-388'), source: 'openai', model: DEFAULT_MODEL },
    { ...createMessage('assistant', 'local planning'), source: 'local' },
  ] });
  assert.deepEqual(mock.requests[0].credentials, credentials);
  assert.equal(JSON.stringify(mock.requests[0].messages).includes('secret-388'), false);
  assert.equal(JSON.stringify(mock.requests[0].messages).includes('account-744'), false);
  assert.equal(mock.requests[0].messages.length, 2);
});

test('strips partial or historical credential assignments without automatically reusing them for login', async () => {
  const mock = bridge();
  await sendChat({ ...options(), messages: [createMessage('user', 'password: old-secret-821')] });
  assert.equal(JSON.stringify(mock.requests[0].messages).includes('old-secret-821'), false);
  assert.equal(mock.requests[0].credentials, undefined);
});

test('rejects invalid credentials and credential use without a target site before launch', async () => {
  const mock = bridge();
  await assert.rejects(sendChat({ ...options(), credentials: { username: 'person', password: 'secret' } }), /사이트 주소/);
  await assert.rejects(sendChat({ ...options(), targetUrl: 'https://example.com/', credentials: { username: 'person', password: 'secret\tvalue' } }), /제어 문자/);
  assert.equal(mock.requests.length, 0);
});

test('rejects invalid action limits and malformed model IDs before native launch', async () => {
  const mock = bridge();
  for (const maxActions of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(sendChat({ ...options(), maxActions }), /양의 정수/);
  await assert.rejects(sendChat({ ...options(), model: 'invalid model' }), /모델/);
  assert.equal(mock.requests.length, 0);
  assert.equal(mock.listeners.size, 0);
});

test('forwards large safe action limits without imposing the previous five-action cap', async () => {
  const mock = bridge();
  for (const maxActions of [6, 250, Number.MAX_SAFE_INTEGER]) await sendChat({ ...options(), targetUrl: 'https://example.com/', maxActions });
  assert.deepEqual(mock.requests.map(request => request.maxActions), [6, 250, Number.MAX_SAFE_INTEGER]);
});

test('forwards validated report metadata, ignores invalid reports and accepts final report after done', async () => {
  const pending = deferred<Result>();
  const mock = bridge(() => pending.promise);
  const events: AgentEvent[] = [];
  const call = sendChat(options(events));
  const { requestId } = mock.requests[0];
  mock.emit({ requestId, event: { type: 'report', report: { status: 'ready', id: 'invalid', name: 'report.pdf', size: 1, updatedAt: new Date().toISOString() } } });
  assert.deepEqual(events, []);
  mock.emit({ requestId, event: { type: 'done' } });
  const report = { status: 'ready' as const, id: 'c1f75f37-1698-45de-82cf-df6c8b4c0fd5', name: 'report.pdf' as const, size: 2034, updatedAt: '2026-11-25T12:00:00.000Z' };
  mock.emit({ requestId, event: { type: 'report', report: { ...report, path: 'private' } as typeof report } });
  pending.resolve({ ok: true });
  await call;
  assert.deepEqual(events, [{ type: 'done' }, { type: 'report', report }]);
});

test('inactivity timeout cancels hung native IPC, releases listener and ignores late completion', async () => {
  const pending = deferred<Result>();
  const mock = bridge(() => pending.promise);
  const events: AgentEvent[] = [];
  const call = sendChat({ ...options(events), inactivityTimeoutMs: 30 });
  const { requestId } = mock.requests[0];
  await assert.rejects(call, { name: 'TimeoutError' });
  assert.deepEqual(mock.cancelled, [requestId]);
  assert.equal(mock.listeners.size, 0);
  mock.emit({ requestId, event: { type: 'delta', text: 'late output' } });
  pending.resolve({ ok: true });
  await Promise.resolve();
  assert.deepEqual(events, []);
});

test('matching activity resets inactivity timeout so long runs have no overall fixed limit', async () => {
  const pending = deferred<Result>();
  const mock = bridge(() => pending.promise);
  let failure: unknown;
  const call = sendChat({ ...options(), maxActions: 100, inactivityTimeoutMs: 50 }).catch(error => { failure = error; });
  const { requestId } = mock.requests[0];
  for (let count = 0; count < 4; count += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    mock.emit({ requestId, event: { type: 'activity', phase: 'thinking', actionCount: count, visitedCount: count + 1, url: 'https://example.com/' } });
  }
  pending.resolve({ ok: true });
  await call;
  assert.equal(failure, undefined);
  assert.deepEqual(mock.cancelled, []);
  assert.equal(mock.listeners.size, 0);
});

test('unrelated request events do not keep a hung request alive', async () => {
  const pending = deferred<Result>();
  const mock = bridge(() => pending.promise);
  const call = sendChat({ ...options(), inactivityTimeoutMs: 35 });
  const noise = setInterval(() => mock.emit({ requestId: 'unrelated', event: { type: 'delta', text: 'noise' } }), 8);
  try { await assert.rejects(call, { name: 'TimeoutError' }); }
  finally { clearInterval(noise); pending.resolve({ ok: true }); }
  assert.equal(mock.cancelled.length, 1);
});

test('successful native completion clears the watchdog even without a done event', async () => {
  const mock = bridge();
  const events: AgentEvent[] = [];
  await sendChat({ ...options(events), inactivityTimeoutMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(events, [{ type: 'done' }]);
  assert.deepEqual(mock.cancelled, []);
});
