import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { Budget, runAgent } from '../src/agent.ts';
import { createProviderSend, openAiUsage, providerConfiguration } from '../src/providers.ts';

const KEY = 'backend-openai-fixture-never-network';
const request = (extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}): Anthropic.MessageCreateParamsNonStreaming => ({
  model: 'gpt-6-luna', max_tokens: 1000, system: [{ type: 'text', text: 'native task', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'inspect this site' }], tools: [{ name: 'submit', input_schema: { type: 'object' } }], ...extra,
});
const reply = (extra: Record<string, unknown> = {}) => ({ id: 'resp_fixture', model: 'gpt-6-luna', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } }, ...extra });
const call = (name = 'submit', id = 'call_1', args = '{}') => ({ type: 'function_call', status: 'completed', name, call_id: id, arguments: args });
const mocked = (fn: (url: string, options: RequestInit) => unknown) => (async (url: string | URL | Request, options?: RequestInit) => Response.json(await fn(String(url), options!))) as typeof fetch;

test('backend provider and both models come only from backend configuration with independent keys', () => {
  const file = { WEBPILOT_BACKEND_PROVIDER: 'openai', OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: 'other-provider-secret',
    WEBPILOT_BACKEND_OPENAI_PLAN_MODEL: 'gpt-6.1-terra', WEBPILOT_BACKEND_OPENAI_TRIAGE_MODEL: 'gpt-5.4-mini' };
  assert.deepEqual(providerConfiguration({}, file), { provider: 'openai', apiKey: KEY, models: { plan: 'gpt-6.1-terra', triage: 'gpt-5.4-mini' } });
  assert.equal(providerConfiguration({ OPENAI_API_KEY: 'dedicated-environment-key' }, file).apiKey, 'dedicated-environment-key');
  assert.equal(providerConfiguration({ ANTHROPIC_API_KEY: 'wrong-key' }, {}, { provider: 'openai' }).apiKey, '');
  assert.deepEqual(providerConfiguration({}, {}).models, { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' });
  assert.throws(() => providerConfiguration({}, file, { provider: 'anthropic', planModel: 'gpt-6-luna' }), /일치하지/);
  assert.throws(() => providerConfiguration({}, file, { planModel: 'gpt-unknown' }), /가격 정보/);
});

test('Responses request maps the backend system, functions, images and requested effort without secrets in body', async () => {
  let sent: any;
  const send = createProviderSend({ provider: 'openai', apiKey: KEY, fetchImpl: mocked((url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body as string) }; return reply();
  }) });
  await send(request({ output_config: { effort: 'high' }, messages: [{ role: 'user', content: [
    { type: 'text', text: 'screen' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
  ] }] }));
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.instructions, 'native task');
  assert.deepEqual(sent.body.reasoning, { effort: 'high' });
  assert.deepEqual(sent.body.prompt_cache_options, { ttl: '30m' });
  assert.deepEqual(sent.body.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'high' });
  assert.deepEqual(sent.body.tools[0], { type: 'function', name: 'submit', parameters: { type: 'object' }, strict: false });
  assert.equal(JSON.stringify(sent.body).includes(KEY), false);
  for (const field of ['system', 'messages', 'max_tokens', 'cache_control', 'output_config']) assert.equal(sent.body[field], undefined);
});

test('all tool-choice forms map to Responses and unknown forced tools fail before a request', async () => {
  let sent: any;
  let calls = 0;
  const send = createProviderSend({ provider: 'openai', apiKey: KEY, fetchImpl: mocked((_url, options) => { calls++; sent = JSON.parse(options.body as string); return reply(); }) });
  for (const [choice, expected] of [ [{ type: 'auto' }, 'auto'], [{ type: 'any' }, 'required'], [{ type: 'none' }, 'none'], [{ type: 'tool', name: 'submit' }, { type: 'function', name: 'submit' }] ] as const) {
    await send(request({ tool_choice: choice })); assert.deepEqual(sent.tool_choice, expected); assert.equal(sent.parallel_tool_calls, false);
  }
  await assert.rejects(send(request({ tool_choice: { type: 'tool', name: 'not-declared' } })), /도구/);
  assert.equal(calls, 4);
});

test('real QA loop executes complete GPT tools once and preserves reasoning and image tool outputs between turns', async () => {
  const requests: any[] = [];
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-response-state', summary: [] };
  const send = createProviderSend({ provider: 'openai', apiKey: KEY, fetchImpl: mocked((_url, options) => {
    requests.push(JSON.parse(options.body as string));
    return reply({ output: requests.length === 1 ? [reasoning, call('observe')] : [call('submit', 'call_2', '{"ready":true}')] });
  }) });
  let observed = 0, submitted = 0;
  const budget = new Budget(1);
  const result = await runAgent({ send, model: 'gpt-6-luna', system: 's', user: 'u', budget, maxTurns: 3, maxTokens: 1000,
    tools: [{ def: { name: 'observe', input_schema: { type: 'object' } }, run: async () => { observed++; return { text: 'observed', image: 'AQID' }; } },
      { def: { name: 'submit', input_schema: { type: 'object' } }, run: async args => { submitted++; return { text: 'accepted', done: args }; } }],
  });
  assert.equal(result.stop, 'done'); assert.deepEqual(result.result, { ready: true });
  assert.equal(observed, 1); assert.equal(submitted, 1); assert.equal(requests.length, 2);
  assert.ok(requests[1].input.some((item: any) => item.encrypted_content === reasoning.encrypted_content));
  assert.equal(JSON.stringify(result).includes(reasoning.encrypted_content), false);
  const output = requests[1].input.find((item: any) => item.type === 'function_call_output');
  assert.equal(output.call_id, 'call_1'); assert.equal(output.output[1].image_url, 'data:image/png;base64,AQID');
  assert.equal(budget.held, 0); assert.ok(budget.spent > 0);
});

test('truncated or refused GPT responses never execute even an otherwise valid native tool call', async () => {
  for (const extra of [ { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [call()] },
    { output: [call(), { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] } ]) {
    let executed = 0;
    const send = createProviderSend({ provider: 'openai', apiKey: KEY, fetchImpl: mocked(() => reply(extra)) });
    const result = await runAgent({ send, model: 'gpt-6-luna', system: 's', user: 'u', budget: new Budget(1), maxTurns: 1,
      tools: [{ def: { name: 'submit', input_schema: { type: 'object' } }, run: async () => { executed++; return { text: 'bad', done: {} }; } }] });
    assert.ok(['max_tokens', 'refusal'].includes(result.stop)); assert.equal(executed, 0);
  }
});

test('malformed tool batches and unknown usage fail before native work while retaining cost reservation', async () => {
  for (const extra of [ { output: [call(), call('submit', 'call_2', '{bad')] }, { output: [call(), call()] },
    { output: [call('not-declared')] }, { output: [call()], usage: undefined }, { output: [call()], model: 'gpt-6.2-astra' },
    { output: [{ ...call(), status: 'in_progress' }] }, { output: [{ type: 'computer_call' }] } ]) {
    let executed = 0;
    const budget = new Budget(1);
    const send = createProviderSend({ provider: 'openai', apiKey: KEY, fetchImpl: mocked(() => reply(extra)) });
    const result = await runAgent({ send, model: 'gpt-6-luna', system: 's', user: 'u', budget, maxTurns: 2, retryDelaysMs: [],
      tools: [{ def: { name: 'submit', input_schema: { type: 'object' } }, run: async () => { executed++; return { text: 'bad' }; } }] });
    assert.equal(result.stop, 'error'); assert.equal(executed, 0); assert.ok(budget.held > 0);
  }
});

test('cache reads, 30-minute writes, 12-hour writes and long-context prices are charged separately', () => {
  const usage = openAiUsage({ input_tokens: 300_000, output_tokens: 10, input_tokens_details: {
    cached_tokens: 10_000, cache_write_tokens: 20_000, cache_write_tokens_details: { ttl_12h_tokens: 5_000, ttl_30m_tokens: 15_000 },
  } });
  const budget = new Budget(10);
  const expected = (270_000 * 4 + 10_000 * 0.2 + 15_000 * 4 * 1.25 + 5_000 * 4 * 2.5 + 10 * 15) / 1e6;
  assert.equal(budget.charge('gpt-6.2-sol', usage), expected);
  for (const invalid of [{}, { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 4 } },
    { input_tokens: 3, output_tokens: -1 }, { input_tokens: 3, output_tokens: 0, input_tokens_details: { cache_write_tokens: 1, cache_write_tokens_details: { ttl_12h_tokens: 2 } } }]) {
    assert.throws(() => openAiUsage(invalid), /사용량/);
  }
});

test('HTTP diagnostics never expose API keys and provider credentials cannot fall back across services', async () => {
  const send = createProviderSend({ provider: 'openai', apiKey: KEY, fetchImpl: (async () => Response.json({ error: { message: KEY } }, { status: 401 })) as typeof fetch });
  await assert.rejects(send(request()), error => (error as any).status === 401 && !(error as Error).message.includes(KEY));
  let received: any;
  const claude = createProviderSend({ provider: 'anthropic', apiKey: 'dedicated-claude-key', anthropicSend: async req => { received = req; return {} as Anthropic.Message; } });
  await claude(request({ model: 'claude-sonnet-5-5' })); assert.equal(received.model, 'claude-sonnet-5-5');
  await assert.rejects(claude(request()), /제공자와 모델/);
  assert.throws(() => createProviderSend({ provider: 'openai', apiKey: '' }), /OPENAI_API_KEY/);
});

test('transient GPT connection failure retries selection before any tool executes, without duplicate actions', async () => {
  let requests = 0, executed = 0;
  const send = createProviderSend({ provider: 'openai', apiKey: KEY, fetchImpl: (async () => {
    requests++;
    if (requests === 1) throw new TypeError('private diagnostic ' + KEY);
    return Response.json(reply({ output: [call()] }));
  }) as typeof fetch });
  const result = await runAgent({ send, model: 'gpt-6-luna', system: 's', user: 'u', budget: new Budget(1), maxTurns: 2, retryDelaysMs: [0],
    tools: [{ def: { name: 'submit', input_schema: { type: 'object' } }, run: async () => { executed++; return { text: 'ok', done: {} }; } }] });
  assert.equal(result.stop, 'done'); assert.equal(requests, 2); assert.equal(executed, 1);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});
