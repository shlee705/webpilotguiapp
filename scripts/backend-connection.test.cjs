'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackendConnectionTest } = require('../electron/backend-connection.cjs');
const models = { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' };
function setup(fetchImpl, apiKey = 'backend-only-fixture-key') {
  const settings = { get: () => ({ provider: 'openai' }), resolveConfig: provider => ({ provider, models, apiKey }) };
  return createBackendConnectionTest({ settings, fetchImpl });
}
test('backend connection check retrieves both selected models using only its dedicated key', async () => {
  const calls = [];
  const check = setup(async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'canonical-model' }); });
  assert.deepEqual(await check(), { ok: true });
  assert.deepEqual(calls.map(call => call.url), ['https://api.openai.com/v1/models/gpt-6.2-sol', 'https://api.openai.com/v1/models/gpt-6-luna']);
  for (const { options } of calls) {
    assert.equal(options.headers.Authorization, 'Bearer backend-only-fixture-key');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
  }
});
test('temporary Claude backend key is routed only to Anthropic and does not persist', async () => {
  let sent;
  const check = setup(async (url, options) => { sent = { url, options }; return Response.json({ id: 'resolved-alias' }); });
  assert.deepEqual(await check({ provider: 'anthropic', models: { plan: 'claude-sonnet-5-5', triage: 'claude-sonnet-5-5' }, apiKey: 'temporary-backend-claude-key' }), { ok: true });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/models/claude-sonnet-5-5');
  assert.equal(sent.options.headers.Authorization, 'Bearer temporary-backend-claude-key');
  assert.equal(sent.options.headers['anthropic-version'], '2026-10-21');
});
test('missing backend keys and malformed settings never call an API or borrow a visual key', async () => {
  let called = false;
  const check = setup(async () => { called = true; }, '');
  assert.equal((await check()).ok, false);
  for (const input of [null, [], { provider: 'other' }, { models: { plan: '../secret', triage: 'gpt-6-luna' } }, { visualKey: 'unrelated-secret' }]) {
    assert.equal((await check(input)).ok, false);
  }
  assert.equal(called, false);
});
test('a second model failure does not claim a complete connection and never exposes diagnostics', async () => {
  let count = 0;
  const check = setup(async () => ++count === 1 ? Response.json({ id: 'model' }) : Response.json({ error: { message: 'private-backend-key-value', code: 'model_not_found' } }, { status: 404 }));
  const result = await check();
  assert.equal(result.ok, false);
  assert.match(result.error, /모델/);
  assert.equal(JSON.stringify(result).includes('private-backend'), false);
});
