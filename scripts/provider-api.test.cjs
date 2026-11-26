const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiSettings } = require('../electron/ai-settings.cjs');
const { createAiService, createOpenAiService } = require('../electron/openai.cjs');
const { normalizeAnthropicUsage } = require('../electron/anthropic.cjs');

const OPENAI_KEY = 'openai-provider-fixture-secret';
const CLAUDE_KEY = 'anthropic-provider-fixture-secret';
function fixture(t, fetchImpl, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-providers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settings = createAiSettings({ directory, safeStorage: { isEncryptionAvailable: () => false } });
  settings.save({ provider: 'openai', model: 'gpt-6-luna', apiKey: OPENAI_KEY });
  settings.save({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: CLAUDE_KEY });
  const service = createAiService({ settings, fetchImpl, retryDelayMs: 0, ...options });
  return { settings, service };
}
const request = overrides => ({ requestId: 'provider-test', messages: [{ role: 'user', content: '테스트 계획을 설명해 줘.' }], ...overrides });
function stream(events) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 5) controller.enqueue(bytes.slice(index, index + 5));
    controller.close();
  } }));
}
const start = { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } };
const delta = { type: 'content_block_delta', delta: { type: 'text_delta', text: '테스트 응답 🌏' } };
const end = (stopReason = 'end_turn') => [{ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } }, { type: 'message_stop' }];

test('Claude chat uses selected Messages contract and counts cumulative cached input once', async t => {
  assert.equal(createAiService, createOpenAiService);
  let sent;
  const { settings, service } = fixture(t, async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return stream([start, { type: 'ping' }, { type: 'future_event' }, delta, ...end()]);
  });
  const events = [];
  assert.deepEqual(await service.start(request(), event => events.push(event)), { ok: true });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.headers.Authorization, `Bearer ${CLAUDE_KEY}`);
  assert.equal(sent.headers['anthropic-version'], '2026-10-21');
  assert.equal(sent.body.model, 'claude-haiku-5-5');
  assert.equal(sent.body.max_tokens, 4096);
  assert.equal(sent.body.stream, true);
  assert.equal(typeof sent.body.system, 'string');
  assert.deepEqual(sent.body.messages.map(item => item.role), ['user']);
  for (const field of ['input', 'reasoning', 'store', 'text', 'output_config']) assert.equal(sent.body[field], undefined);
  assert.equal(JSON.stringify(sent.body).includes(OPENAI_KEY), false);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['테스트 응답 🌏']);
  assert.deepEqual(events.find(event => event.type === 'usage').usage, { inputTokens: 10, outputTokens: 7, totalTokens: 17 });
  assert.equal(settings.get('anthropic').usage.requests, 1);
  assert.equal(settings.get('openai').usage.requests, 0);
});

test('provider model lookup is metadata only, accepts aliases and never persists a check key', async t => {
  const calls = [];
  const { service, settings } = fixture(t, async (url, options) => { calls.push({ url, ...options }); return Response.json({ id: 'claude-haiku-5-5-canonical' }); });
  const result = await service.testConnection({ provider: 'anthropic', apiKey: 'temporary-claude-check-key' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['claude-haiku-5-5', 'claude-haiku-5-5-canonical']);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models/claude-haiku-5-5');
  assert.equal(calls[0].headers.Authorization, 'Bearer temporary-claude-check-key');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].body, undefined);
  assert.equal(settings.getKey('anthropic'), CLAUDE_KEY);
  assert.equal(settings.get('anthropic').usage.requests, 0);
});

test('missing provider key never falls back to the other profile in chat or metadata check', async t => {
  const { settings, service } = fixture(t, async () => assert.fail('No key: no API call'));
  settings.save({ provider: 'anthropic', forgetKey: true });
  settings.save({ provider: 'openai' });
  assert.equal((await service.start(request({ provider: 'anthropic' }), () => {})).ok, false);
  assert.equal((await service.testConnection({ provider: 'anthropic' })).ok, false);
  assert.equal((await service.start(request({ provider: 'unknown' }), () => {})).ok, false);
  assert.equal(settings.getKey('openai'), OPENAI_KEY);
});

test('in-flight requests retain provider credentials and usage when settings change', async t => {
  let settings, sent;
  const f = fixture(t, async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    settings.save({ provider: 'openai', model: 'custom-openai-model' });
    return stream([start, delta, ...end()]);
  });
  settings = f.settings;
  assert.equal((await f.service.start(request(), () => {})).ok, true);
  assert.equal(sent.body.model, 'claude-haiku-5-5');
  assert.equal(sent.headers.Authorization, `Bearer ${CLAUDE_KEY}`);
  assert.equal(settings.get().provider, 'openai');
  assert.equal(settings.get('openai').usage.requests, 0);
  assert.equal(settings.get('anthropic').usage.totalTokens, 17);
});

test('site companion receives only the explicitly chosen provider profile and captured accounting', async t => {
  let captured, settings;
  const f = fixture(t, async () => assert.fail('Site companion owns model calls'), { siteAgent: async options => {
    captured = options;
    settings.save({ provider: 'openai' });
    options.onUsage({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  } });
  settings = f.settings;
  settings.save({ provider: 'openai' });
  assert.equal((await f.service.start(request({ provider: 'anthropic', targetUrl: 'https://example.test/' }), () => {})).ok, true);
  assert.equal(captured.provider, 'anthropic');
  assert.equal(captured.apiKey, CLAUDE_KEY);
  assert.equal(captured.model, 'claude-haiku-5-5');
  assert.equal(settings.get('anthropic').usage.totalTokens, 10);
  assert.equal(settings.get('openai').usage.requests, 0);
});

test('Claude partial streams, max_tokens and refusal never emit done or replay visible output', async t => {
  for (const ending of [[], end('max_tokens'), end('refusal'), [{ type: 'error', error: { type: 'overloaded_error', message: CLAUDE_KEY } }]]) {
    let calls = 0;
    const { service, settings } = fixture(t, async () => { calls++; return stream([start, delta, ...ending]); });
    const events = [];
    const result = await service.start(request(), event => events.push(event));
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.equal(events.some(event => event.type === 'done'), false);
    assert.equal(JSON.stringify({ result, events }).includes(CLAUDE_KEY), false);
    assert.equal(settings.get('anthropic').usage.requests, 1);
    assert.equal(settings.get('anthropic').usage.inputTokens, ending[0]?.type === 'message_delta' ? 10 : 0);
    assert.equal(settings.get('anthropic').usage.untrackedRequests, ending[0]?.type === 'message_delta' ? 0 : 1);
  }
});

test('Claude errors before output retry at most three times and hide raw diagnostics', async t => {
  let calls = 0;
  const { service, settings } = fixture(t, async () => {
    calls++;
    return stream([start, { type: 'error', error: { type: 'overloaded_error', message: `private ${CLAUDE_KEY}` } }]);
  });
  const result = await service.start(request(), () => {});
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.equal(result.error.includes(CLAUDE_KEY), false);
  assert.equal(settings.get('anthropic').usage.requests, 3);
  assert.equal(settings.get('anthropic').usage.untrackedRequests, 3);
  const unauthorized = fixture(t, async () => Response.json({ error: { type: 'authentication_error', message: CLAUDE_KEY } }, { status: 401 }));
  const failure = await unauthorized.service.start(request(), () => {});
  assert.equal(failure.ok, false);
  assert.match(failure.error, /Anthropic API 키 인증/);
  assert.equal(failure.error.includes(CLAUDE_KEY), false);
  assert.equal(unauthorized.settings.get('anthropic').usage.requests, 1);
});

test('Claude cancellation aborts the request and accounts its own profile', async t => {
  let networkSignal;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service, settings } = fixture(t, async (_url, { signal }) => {
    networkSignal = signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const running = service.start(request(), () => {});
  await ready;
  service.cancel('provider-test');
  assert.deepEqual(await running, { ok: false, cancelled: true });
  assert.equal(networkSignal.aborted, true);
  assert.equal(settings.get('anthropic').usage.untrackedRequests, 1);
  assert.equal(settings.get('openai').usage.requests, 0);
});

test('cancelling a partially streamed Claude response leaves initial usage untracked', async t => {
  const { service, settings } = fixture(t, async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode([start, delta].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    controller.enqueue(bytes);
    signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  } })));
  const result = await service.start(request(), event => { if (event.type === 'delta') service.cancel('provider-test'); });
  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.equal(settings.get('anthropic').usage.untrackedRequests, 1);
  assert.equal(settings.get('anthropic').usage.totalTokens, 0);
});

test('Claude completion without final output-token accounting remains untracked', async t => {
  const { service, settings } = fixture(t, async () => stream([start, delta,
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5 } }, { type: 'message_stop' }]));
  assert.equal((await service.start(request(), () => {})).ok, true);
  assert.equal(settings.get('anthropic').usage.untrackedRequests, 1);
  assert.equal(settings.get('anthropic').usage.totalTokens, 0);
});

test('invalid Anthropic usage is unknown rather than a precise zero', () => {
  for (const usage of [null, {}, { input_tokens: 0 }, { input_tokens: 1, output_tokens: -1 }, { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: '3' }]) {
    assert.equal(normalizeAnthropicUsage(usage), undefined);
  }
  assert.deepEqual(normalizeAnthropicUsage({ input_tokens: 0, output_tokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});
