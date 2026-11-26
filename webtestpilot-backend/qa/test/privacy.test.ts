import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { configurePrivateValues, privateData, privateJson, privateRequest, privateText, runtimeData } from '../src/privacy.ts';
import { createProviderSend } from '../src/providers.ts';

afterEach(() => configurePrivateValues([]));

test('account names that coincide with public plan IDs preserve plan and ledger references', () => {
  for (const username of ['S1', 'T1', 'R1']) {
    configurePrivateValues([username, 'fixture-password']);
    const plan = { requirements: [{ id: 'R1', text: 'page loads' }], targets: { T1: { target: { role: 'heading', name: 'Home' } } },
      scenarios: [{ id: 'S1', covers: ['R1'], checks: [{ id: 'S1.C1', after: 'start', target: 'T1', expected: 'true' }] }] };
    assert.deepEqual(privateData(plan), plan);
    const entry = { kind: 'check', id: 'S1.C1', scenario: 'S1', status: 'passed', actual: 'true' };
    assert.deepEqual(JSON.parse(privateJson(entry, undefined, 'ledger')), entry);
  }
});

test('account text and encoded variants are removed without corrupting the verified public target URL', () => {
  const username = 'fixture+account@example.test';
  const password = 'fixture password"\\';
  const target = 'http://fixture.invalid/admin/';
  configurePrivateValues([username, password], [target]);
  for (const value of [username, password, encodeURIComponent(username), encodeURIComponent(password),
    new URLSearchParams({ v: password }).toString().slice(2), JSON.stringify(password).slice(1, -1)]) {
    assert.notEqual(privateText(value), value);
  }
  assert.equal(privateData({ startUrl: target }).startUrl, target);
});

test('repeated request sanitization is idempotent even when a secret occurs in placeholder syntax', () => {
  configurePrivateValues(['fixture-account', '1']);
  const once = privateText('fixture-account password 1');
  assert.equal(privateText(once), once);
});

test('only complete observed selectors and URLs can be restored; model-created strings and fill values cannot', () => {
  configurePrivateValues(['fixture-account', 'fixture-password']);
  const label = 'Account menu fixture-account';
  const url = 'http://fixture.invalid/users/fixture-account';
  const safeLabel = privateText(label);
  const safeUrl = privateText(url);
  assert.equal(runtimeData({ name: safeLabel }).name, label);
  assert.equal(runtimeData({ url: safeUrl }).url, url);
  assert.equal(runtimeData({ name: `${safeLabel} injected` }).name, `${safeLabel} injected`);
  assert.equal(runtimeData({ url: `${safeUrl}?copy=1` }).url, `${safeUrl}?copy=1`);
  assert.equal(runtimeData({ value: safeLabel }).value, safeLabel);
  assert.deepEqual(runtimeData({ input: { name: safeLabel } }), { input: { name: safeLabel } });
  const password = privateText('fixture-password');
  assert.equal(runtimeData({ expected: password }).expected, password);
});

test('passwords and credential query or fragment values are never restored into URLs', () => {
  configurePrivateValues(['fixture-account', 'fixture-password']);
  for (const url of [
    'http://fixture.invalid/fixture-password',
    'http://fixture.invalid/?user=fixture-account',
    'http://fixture.invalid/#fixture-account',
    'http://fixture.invalid/#/route?user=fixture-account',
  ]) {
    const safe = privateText(url);
    assert.notEqual(safe, url);
    assert.equal(runtimeData({ url: safe }).url, safe);
  }
  configurePrivateValues(['same-fixture', 'same-fixture']);
  const safe = privateText('http://fixture.invalid/same-fixture');
  assert.equal(runtimeData({ url: safe }).url, safe);
});

test('observed id, models and parameters fields are sanitized while execution metadata remains exact', () => {
  configurePrivateValues(['fixture-account', 'fixture-password']);
  const source = { observed: { id: 'fixture-account', models: { label: 'fixture-password' }, parameters: { value: 'fixture-account' } },
    run: { models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna' }, parameters: { maxPages: 4 } } };
  const safe = privateData(source);
  assert.equal(JSON.stringify(safe).includes('fixture-account'), false);
  assert.equal(JSON.stringify(safe).includes('fixture-password'), false);
  assert.deepEqual(safe.run, source.run);
});

test('tool inputs do not gain metadata exemptions and canonical protocol IDs and content identity survive', () => {
  configurePrivateValues(['fixture-account', 'fixture-password']);
  const blocks: Anthropic.ContentBlockParam[] = [{ type: 'tool_use', id: 'call-fixture-account', name: 'inspect',
    input: { id: 'fixture-account', models: { value: 'fixture-password' }, parameters: { value: 'fixture-account' } } }];
  const request: Anthropic.MessageCreateParamsNonStreaming = { model: 'gpt-6-luna', max_tokens: 100,
    messages: [{ role: 'assistant', content: blocks }, { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-fixture-account', content: 'fixture-account fixture-password' },
    ] }] };
  privateRequest(request);
  assert.equal(request.messages[0].content, blocks);
  assert.equal((blocks[0] as Anthropic.ToolUseBlockParam).id, 'call-fixture-account');
  const input = (blocks[0] as Anthropic.ToolUseBlockParam).input;
  assert.equal(JSON.stringify(input).includes('fixture-account'), false);
  assert.equal(JSON.stringify(input).includes('fixture-password'), false);
  assert.equal((request.messages[1].content as Anthropic.ToolResultBlockParam[])[0].tool_use_id, 'call-fixture-account');
});

test('GPT history replay sanitizes raw output text and arguments while preserving opaque reasoning and call linkage', async () => {
  configurePrivateValues(['fixture-account', 'fixture-password']);
  const wire: any[] = [];
  const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-state-exact', summary: [] };
  const send = createProviderSend({ provider: 'openai', apiKey: 'fixture-key-no-network', fetchImpl: (async (_url, options) => {
    wire.push(JSON.parse(options!.body as string));
    return Response.json({ id: 'resp_fixture', model: 'gpt-6-luna', status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 }, output: [reasoning,
        { type: 'message', content: [{ type: 'output_text', text: 'fixture-account fixture-password' }] },
        { type: 'function_call', status: 'completed', call_id: 'call_1', name: 'inspect',
          arguments: JSON.stringify({ id: 'fixture-account', models: { value: 'fixture-password' } }) },
      ] });
  }) as typeof fetch });
  const request: Anthropic.MessageCreateParamsNonStreaming = { model: 'gpt-6-luna', max_tokens: 100,
    messages: [{ role: 'user', content: 'inspect page' }], tools: [{ name: 'inspect', input_schema: { type: 'object' } }] };
  privateRequest(request);
  const response = await send(request);
  request.messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call_1', content: 'fixture-account fixture-password' },
  ] });
  privateRequest(request);
  await send(request);
  assert.equal(JSON.stringify(wire[1]).includes('fixture-account'), false);
  assert.equal(JSON.stringify(wire[1]).includes('fixture-password'), false);
  assert.deepEqual(wire[1].input.find((item: any) => item.type === 'reasoning'), reasoning);
  assert.equal(wire[1].input.find((item: any) => item.type === 'function_call').call_id, 'call_1');
  assert.equal(wire[1].input.find((item: any) => item.type === 'function_call_output').call_id, 'call_1');
});

test('GPT history replay preserves numeric JSON arguments when the password is a digit', async () => {
  configurePrivateValues(['fixture-account', '1']);
  const wire: any[] = [];
  const send = createProviderSend({ provider: 'openai', apiKey: 'fixture-key-no-network', fetchImpl: (async (_url, options) => {
    wire.push(JSON.parse(options!.body as string));
    return Response.json({ id: 'resp_fixture', model: 'gpt-6-luna', status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 }, output: [
        { type: 'function_call', status: 'completed', call_id: 'call_1', name: 'inspect', arguments: '{"count":1,"value":"1"}' },
      ] });
  }) as typeof fetch });
  const request: Anthropic.MessageCreateParamsNonStreaming = { model: 'gpt-6-luna', max_tokens: 100,
    messages: [{ role: 'user', content: 'inspect page' }], tools: [{ name: 'inspect', input_schema: { type: 'object' } }] };
  privateRequest(request);
  const response = await send(request);
  request.messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call_1', content: 'observation complete' },
  ] });
  privateRequest(request);
  await send(request);
  const args = JSON.parse(wire[1].input.find((item: any) => item.type === 'function_call').arguments);
  assert.equal(args.count, 1);
  assert.notEqual(args.value, '1');
});
