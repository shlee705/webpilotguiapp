// Provider transport for the real inspector. Display-only GUI credentials never enter this module.
// Verified 2026-11-26: https://developers.openai.com/api/docs/guides/function-calling
// https://developers.openai.com/api/reference/resources/responses/methods/create
import Anthropic from '@anthropic-ai/sdk';
import { PRICES, type Send } from './agent.ts';
import { privateData, privateText } from './privacy.ts';

export type Provider = 'anthropic' | 'openai';
export const DEFAULT_MODELS = Object.freeze({
  anthropic: { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' },
  openai: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' },
});
export const KEY_NAMES = Object.freeze({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' });

export function validateProvider(value: string): Provider {
  if (value !== 'anthropic' && value !== 'openai') throw new Error('백엔드 제공자는 anthropic 또는 openai여야 합니다.');
  return value;
}

export function validateProviderModel(provider: Provider, model: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(model)
    || !model.startsWith(provider === 'openai' ? 'gpt-' : 'claude-')) throw new Error('백엔드 제공자와 모델이 일치하지 않습니다.');
  if (!PRICES[model]) throw new Error(`비용 한도를 적용할 가격 정보가 없는 백엔드 모델입니다: ${model}. 지원 모델을 선택해 주세요.`);
  return model;
}

export function providerConfiguration(environment: Record<string, string | undefined>, file: Record<string, string>,
  options: { provider?: string; planModel?: string; triageModel?: string } = {}) {
  const read = (key: string) => environment[key]?.trim() || file[key]?.trim();
  const provider = validateProvider(options.provider ?? read('WEBPILOT_BACKEND_PROVIDER') ?? 'anthropic');
  const prefix = `WEBPILOT_BACKEND_${provider.toUpperCase()}_`;
  const models = {
    plan: validateProviderModel(provider, options.planModel ?? read(prefix + 'PLAN_MODEL') ?? DEFAULT_MODELS[provider].plan),
    triage: validateProviderModel(provider, options.triageModel ?? read(prefix + 'TRIAGE_MODEL') ?? DEFAULT_MODELS[provider].triage),
  };
  return { provider, models, apiKey: read(KEY_NAMES[provider]) ?? '' };
}

type Json = Record<string, any>;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const failure = (message: string, status?: number) => Object.assign(new Error(message), status ? { status } : {});

function inputContent(blocks: unknown): Json[] {
  if (typeof blocks === 'string') return [{ type: 'input_text', text: blocks }];
  if (!Array.isArray(blocks)) throw failure('백엔드 모델 입력 형식이 올바르지 않습니다.');
  return blocks.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return { type: 'input_text', text: block.text };
    if (block?.type === 'image' && block.source?.type === 'base64'
      && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.source.media_type)
      && typeof block.source.data === 'string') return { type: 'input_image', image_url: `data:${block.source.media_type};base64,${block.source.data}`, detail: 'high' };
    throw failure('지원하지 않는 백엔드 모델 입력 형식입니다.');
  });
}

/** Keep complete reasoning output in memory for the next turn; do not persist opaque reasoning in QA logs. */
function openAiInput(messages: Anthropic.MessageParam[], outputHistory: WeakMap<object, Json[]>) {
  const input: Json[] = [];
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    if (message.role === 'assistant') {
      const previous = typeof message.content === 'object' ? outputHistory.get(message.content) : undefined;
      if (previous) {
        // reasoning 암호문·call id는 그대로 두고, 모델이 재전송하는 가시 텍스트/인자만 정제한다.
        input.push(...previous.map(item => item.type === 'message' ? { ...item, content: item.content.map((c: Json) => c.type === 'output_text' ? { ...c, text: privateText(c.text) } : c) }
          : item.type === 'function_call' ? { ...item, arguments: JSON.stringify(privateData(JSON.parse(item.arguments), 'toolInput')) } : item));
        continue;
      }
      for (const block of blocks) {
        if (block.type === 'text') input.push({ role: 'assistant', content: block.text });
        else if (block.type === 'tool_use') input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
        else throw failure('복원할 수 없는 GPT 응답 기록입니다. 새 검사로 다시 시작해 주세요.');
      }
    } else {
      let content: Json[] = [];
      const flush = () => { if (content.length) input.push({ role: 'user', content }); content = []; };
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          flush();
          const output = inputContent(block.content ?? '');
          if (block.is_error) output.unshift({ type: 'input_text', text: 'Tool failed; this result is not a successful action.' });
          input.push({ type: 'function_call_output', call_id: block.tool_use_id, output });
        } else content.push(...inputContent([block]));
      }
      flush();
    }
  }
  return input;
}

export function openAiUsage(value: Json | undefined): Anthropic.Usage {
  const cached = value?.input_tokens_details?.cached_tokens ?? 0;
  const written = value?.input_tokens_details?.cache_write_tokens ?? 0;
  const written12h = value?.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens ?? 0;
  if (!value || !integer(value.input_tokens) || !integer(value.output_tokens) || !integer(cached) || !integer(written)
    || !integer(written12h) || written12h > written || cached + written > value.input_tokens) {
    throw failure('GPT 응답의 사용량을 확인하지 못했습니다. 비용 예약을 유지하고 검사를 중단합니다.');
  }
  // OpenAI input_tokens includes cached input; the canonical ledger counts these separately.
  return { input_tokens: value.input_tokens - cached - written, output_tokens: value.output_tokens,
    cache_read_input_tokens: cached, cache_creation_input_tokens: written,
    ...(written12h ? { openai_cache_write_tokens_12h: written12h } : {}) } as Anthropic.Usage;
}

function canonicalResponse(body: Json, request: Anthropic.MessageCreateParamsNonStreaming, history: WeakMap<object, Json[]>): Anthropic.Message {
  const usage = openAiUsage(body.usage);
  if (body.model !== request.model && !(request.model === 'gpt-5.4-mini' && body.model === 'gpt-5.4-mini-2026-03-17')) {
    throw failure('요청한 백엔드 모델과 다른 모델이 응답했습니다.');
  }
  if (!['completed', 'incomplete'].includes(body.status) || !Array.isArray(body.output)) throw failure('GPT 응답이 정상 완료되지 않았습니다.');
  const content: Anthropic.ContentBlock[] = [];
  let refused = false;
  for (const item of body.output) {
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) throw failure('GPT 메시지 형식이 올바르지 않습니다.');
      for (const block of item.content) {
        if (block.type === 'refusal') refused = true;
        else if (block.type === 'output_text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text, citations: null });
      }
    }
  }
  const incomplete = body.status === 'incomplete';
  if (incomplete && body.incomplete_details?.reason !== 'max_output_tokens') throw failure('GPT 응답이 정상 완료되지 않았습니다.');
  // Validate every call before exposing any native action. Never execute partial/refused tool calls.
  if (!incomplete && !refused) {
    const ids = new Set<string>();
    for (const item of body.output) {
      if (item.type === 'function_call') {
        if (item.status !== undefined && item.status !== 'completed' || typeof item.call_id !== 'string' || !item.call_id || ids.has(item.call_id)
          || typeof item.name !== 'string' || !request.tools?.some(tool => 'name' in tool && tool.name === item.name)
          || typeof item.arguments !== 'string') throw failure('GPT가 올바르지 않은 도구 호출을 반환했습니다.');
        let args;
        try { args = JSON.parse(item.arguments); } catch { throw failure('GPT 도구 인자를 읽을 수 없습니다.'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('GPT 도구 인자는 객체여야 합니다.');
        ids.add(item.call_id);
        content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: args, caller: { type: 'direct' } });
      } else if (!['message', 'reasoning'].includes(item.type)) throw failure('GPT가 허용되지 않은 실행 도구를 반환했습니다.');
    }
    history.set(content, body.output);
  }
  return { id: body.id, type: 'message', role: 'assistant', model: request.model, content, usage, stop_sequence: null,
    stop_reason: refused ? 'refusal' : incomplete ? 'max_tokens' : content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' } as Anthropic.Message;
}

export function createProviderSend({ provider, apiKey, fetchImpl = fetch, timeoutMs = 120_000,
  anthropicSend }: { provider: Provider; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; anthropicSend?: Send }): Send {
  validateProvider(provider);
  if (!apiKey || /\s/.test(apiKey)) throw failure(`${KEY_NAMES[provider]}가 없습니다. 백엔드 전용 키를 설정해 주세요.`);
  if (provider === 'anthropic') {
    const client = anthropicSend ? undefined : new Anthropic({ apiKey });
    const send: Send = anthropicSend ?? (req => client!.messages.create(req));
    return async req => {
      validateProviderModel(provider, req.model);
      try { return await send(req); }
      catch (error) { const status = (error as { status?: number }).status; throw failure(status ? `Anthropic API 요청 실패 (${status})` : 'Anthropic API Connection error', status); }
    };
  }
  const history = new WeakMap<object, Json[]>();
  return async req => {
    validateProviderModel(provider, req.model);
    const tools = req.tools?.map(tool => {
      if (!('input_schema' in tool)) throw failure('지원하지 않는 백엔드 도구입니다.');
      // Existing QA schemas have optional properties. strict:false preserves their contracts;
      // the native QA validators still validate each tool before any operation.
      return { type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false };
    });
    const system = typeof req.system === 'string' ? req.system : req.system?.map(block => block.text).join('\n\n');
    const forcedName = req.tool_choice?.type === 'tool' ? req.tool_choice.name : undefined;
    const choice = forcedName ? { type: 'function', name: forcedName }
      : req.tool_choice?.type === 'any' ? 'required' : req.tool_choice?.type;
    if (forcedName && !tools?.some(tool => tool.name === forcedName)) throw failure('요청한 백엔드 도구를 찾을 수 없습니다.');
    const body = { model: req.model, input: openAiInput(req.messages, history), instructions: system,
      max_output_tokens: req.max_tokens, store: false, include: ['reasoning.encrypted_content'],
      ...(req.model.startsWith('gpt-6') ? { prompt_cache_options: { ttl: '30m' } } : {}),
      reasoning: { effort: req.output_config?.effort ?? 'medium' }, ...(tools?.length ? { tools, parallel_tool_calls: false } : {}),
      ...(choice ? { tool_choice: choice } : {}),
    };
    let response: Response;
    try { response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    }); } catch { throw failure('GPT API Connection error: 연결이 실패하거나 응답 시간이 초과되었습니다.'); }
    if (!response.ok) throw failure(`OpenAI API 요청 실패 (${response.status})`, response.status);
    let result;
    try { result = await response.json(); } catch { throw failure('GPT 응답 형식을 읽을 수 없습니다.'); }
    return canonicalResponse(result, req, history);
  };
}
