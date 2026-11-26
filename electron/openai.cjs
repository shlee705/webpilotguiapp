const { validateProvider, validateModel, validateKey } = require('./ai-settings.cjs');
const { validateBackendRunOptions, validateBackendTask, validateBackendLoginUrl } = require('./backend-run-options.cjs');
const { validateCredentials, createSecretRedactor } = require('./login-secrets.cjs');
const { ANTHROPIC_API, anthropicHeaders, anthropicRequest, normalizeAnthropicUsage, anthropicError, isTransientAnthropicError } = require('./anthropic.cjs');

const DEVELOPER_INSTRUCTION = '당신은 WebPilot의 웹 테스트 도우미입니다. 사용자에게 한국어로 명료하게 답하세요. 현재 이 대화에는 브라우저 제어, 웹 검색, 화면 캡처, 사이트 방문 또는 실제 테스트 실행 도구가 없습니다. URL을 전달받아도 사이트의 내용을 읽었거나 탐색하거나 버그를 발견했다고 주장하지 마세요. 앱이 Edge에서 URL을 여는 기능과 실제 사이트 검사는 별개입니다. 사용자가 제공한 텍스트, 코드, 관찰 결과를 근거로 분석하고, 확인하지 못한 사항은 구분해서 설명하세요. 필요한 경우 테스트 절차나 추가로 필요한 정보를 제안하세요.';

function validateMaxActions(value) {
  if (value === undefined) return 5;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('동작 수는 1 이상의 안전한 정수로 입력해 주세요.');
  return value;
}

class ResponseError extends Error {
  constructor(message, retryable = false) { super(message); this.name = 'ResponseError'; this.retryable = retryable; }
}

function isTransientHttp(status, code) {
  if (['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active', 'usage_limit_reached'].includes(code)) return false;
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function retryResponse(operation, { signal, timeoutMs = 60000, retryDelayMs = 750, onRetry = () => {}, canRetry = () => true }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort('response-timeout'), timeoutMs);
    let failure;
    try { return await operation(controller.signal, attempt); }
    catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      failure = controller.signal.reason === 'response-timeout'
        ? new ResponseError('응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.', true)
        : error instanceof TypeError
          ? new ResponseError('선택한 AI 서비스에 연결할 수 없습니다. 네트워크를 확인해 주세요.', true)
          : error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
    if (!failure.retryable || attempt === 2 || !canRetry()) throw failure;
    onRetry(attempt + 1, failure);
    await abortableDelay(Math.min(8000, retryDelayMs * 2 ** attempt), signal);
  }
}

function requestMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 200) throw new Error('대화 메시지가 없거나 너무 많습니다. 새 채팅을 시작해 주세요.');
  let length = 0;
  const result = messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 32000) {
      throw new Error('전송할 메시지 형식이 올바르지 않습니다.');
    }
    length += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (length > 250000) throw new Error('대화가 너무 깁니다. 새 채팅을 시작해 주세요.');
  return [{ role: 'developer', content: DEVELOPER_INSTRUCTION }, ...result];
}

function normalizeUsage(value) {
  if (!value || !Number.isSafeInteger(value.input_tokens) || value.input_tokens < 0 || !Number.isSafeInteger(value.output_tokens) || value.output_tokens < 0) return undefined;
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: Number.isSafeInteger(value.total_tokens) && value.total_tokens >= 0 ? value.total_tokens : value.input_tokens + value.output_tokens,
  };
}

function apiError(status, code) {
  if (status === 401) return 'API 키 인증에 실패했습니다. 설정에서 키를 확인해 주세요.';
  if (status === 403) return '이 API 키에 요청 권한이 없습니다. 프로젝트와 모델 접근 권한을 확인해 주세요.';
  if (status === 404 || code === 'model_not_found') return '선택한 모델을 사용할 수 없습니다. 다른 모델을 선택해 주세요.';
  if (status === 408) return 'API 응답 대기 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.';
  if (status === 429) return code === 'insufficient_quota' ? 'OpenAI API 사용 한도 또는 결제 잔액을 확인해 주세요.' : '요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  if (status >= 500) return 'OpenAI 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.';
  return 'OpenAI API 요청에 실패했습니다. 모델과 API 설정을 확인해 주세요.';
}

async function* readSse(body) {
  if (!body) throw new ResponseError('응답 스트림을 받지 못했습니다.', true);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('응답 스트림 형식이 올바르지 않습니다.');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line) {
          if (data.length) { yield data.join('\n'); data = []; }
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
        if (data.length) yield data.join('\n');
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* Cancellation or a failed connection may already have closed it. */ }
    reader.releaseLock();
  }
}

function createOpenAiService({ settings, fetchImpl = fetch, now = () => new Date(), timeoutMs = 60000, retryDelayMs = 750, siteAgent, reportProvider }) {
  const active = new Map();

  async function testConnection(input = {}) {
    let key;
    let model;
    try {
      const provider = validateProvider(input.provider ?? settings.get().provider ?? 'openai');
      key = input.apiKey?.trim() ? validateKey(input.apiKey, provider) : settings.getKey(provider);
      model = validateModel(input.model ?? settings.get(provider).model);
      if (!key) return { ok: false, error: `${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API 키를 입력해 주세요.` };
      // Metadata retrieval is free and accepts provider model aliases. Never send
      // keys through a redirect or fall back to another provider's saved key.
      // https://developers.openai.com/api/reference/resources/models/methods/retrieve
      const endpoint = provider === 'anthropic' ? ANTHROPIC_API : 'https://api.openai.com/v1';
      const response = await fetchImpl(`${endpoint}/models/${encodeURIComponent(model)}`, {
        headers: provider === 'anthropic' ? anthropicHeaders(key) : { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) {
        let error;
        try { error = await response.json(); } catch { /* Use the HTTP status only. */ }
        return { ok: false, error: provider === 'anthropic' ? anthropicError(response.status, error?.error?.type) : apiError(response.status, error?.error?.code) };
      }
      const body = await response.json();
      return typeof body?.id === 'string' && body.id.trim()
        ? { ok: true, models: [...new Set([model, body.id])] }
        : { ok: false, error: '선택한 모델의 정보를 확인하지 못했습니다. 모델 이름을 확인해 주세요.' };
    } catch (error) {
      return { ok: false, error: error.name === 'TimeoutError' ? '연결 확인 시간이 초과되었습니다.' : '연결을 확인할 수 없습니다. 네트워크와 API 키를 확인해 주세요.' };
    }
  }

  async function start(input, emit) {
    let key;
    let model;
    let provider;
    let messages;
    let credentials;
    let backendOptions;
    let backendTask;
    let backendLoginUrl;
    let redact = value => value;
    try {
      if (!input || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 128) throw new Error('올바른 요청 ID가 필요합니다.');
      if (active.has(input.requestId)) throw new Error('같은 요청이 이미 실행 중입니다.');
      if (active.size >= 8) throw new Error('동시 요청이 너무 많습니다. 진행 중인 응답을 기다려 주세요.');
      provider = validateProvider(input.provider ?? settings.get().provider ?? 'openai');
      model = validateModel(input.model ?? settings.get(provider).model);
      credentials = validateCredentials(input.credentials);
      redact = createSecretRedactor(credentials);
      messages = requestMessages(input.messages);
      if (typeof input.targetUrl === 'string' && input.targetUrl) {
        // The site loop uses only the latest user task. Do not repeatedly scrub
        // or retain old assistant summaries that cannot affect that request.
        const task = messages.findLast(message => message.role === 'user');
        if (!task) throw new Error('사이트 버그 탐색 요청을 입력해 주세요.');
        messages = [messages[0], task];
      }
      messages = messages.map((message, index) => index === 0 ? message : { ...message, content: redact(message.content) });
      if (input.backendOptions !== undefined || input.backendTask !== undefined) {
        if (!(typeof input.targetUrl === 'string' && input.targetUrl)) throw new Error('백엔드 테스트 설정은 사이트 검사에서만 사용할 수 있습니다.');
        backendOptions = validateBackendRunOptions(input.backendOptions);
        const task = validateBackendTask(input.backendTask);
        backendTask = task === undefined ? undefined : redact(task);
      }
      if (credentials && !(typeof input.targetUrl === 'string' && input.targetUrl)) throw new Error('로그인 정보는 사이트 버그 탐색 요청에서만 사용할 수 있습니다.');
      backendLoginUrl = validateBackendLoginUrl(input.backendLoginUrl, input.targetUrl, credentials);
      key = settings.getKey(provider);
      if (!key) throw new Error(`설정에서 ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API 키를 먼저 입력해 주세요.`);
    } catch (error) { return { ok: false, error: error.message }; }
    const controller = new AbortController();
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    active.set(input.requestId, { controller, finished });
    let result;
    let accountingError = false;
    const cumulative = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const siteMode = typeof input.targetUrl === 'string' && Boolean(input.targetUrl);
    function publish(event) {
      const safeEvent = { ...event };
      for (const field of ['text', 'label', 'url', 'detail', 'error']) {
        if (typeof safeEvent[field] === 'string') safeEvent[field] = redact(safeEvent[field]);
      }
      try { emit(safeEvent); } catch { /* Renderer may have closed. */ }
    }
    const recordRequestUsage = (requestUsage, requestedAt = now()) => {
      try { settings.recordUsage(requestUsage, requestedAt, provider); } catch { accountingError = true; }
      if (requestUsage) {
        cumulative.inputTokens += requestUsage.inputTokens;
        cumulative.outputTokens += requestUsage.outputTokens;
        cumulative.totalTokens += requestUsage.totalTokens;
        publish({ type: 'usage', usage: { ...cumulative } });
      }
    };
    try {
      publish({ type: 'status', id: `${provider}-response`, label: `${provider === 'anthropic' ? 'Claude' : 'OpenAI'}가 응답을 생성하고 있습니다`, state: 'running' });
      if (siteMode) {
        const runSiteAgent = siteAgent ?? require('./site-agent.cjs').runSiteAgent;
        await runSiteAgent({
          apiKey: key,
          model,
          provider,
          messages: messages.slice(1),
          targetUrl: input.targetUrl,
          credentials,
          ...(backendOptions ? { backendOptions } : {}),
          ...(backendTask !== undefined ? { backendTask } : {}),
          ...(backendLoginUrl !== undefined ? { backendLoginUrl } : {}),
          reportProvider,
          fetchImpl,
          requestTimeoutMs: timeoutMs,
          retryDelayMs,
          signal: controller.signal,
          onEvent: publish,
          onUsage: recordRequestUsage,
        });
      } else if (provider === 'anthropic') {
        let visibleOutput = false;
        await retryResponse(async requestSignal => {
          const requestedAt = now();
          let usageFields, stopReason, completed = false, finalUsageReceived = false;
          try {
            const response = await fetchImpl(`${ANTHROPIC_API}/messages`, {
              method: 'POST', headers: anthropicHeaders(key), redirect: 'error', signal: requestSignal,
              body: JSON.stringify(anthropicRequest({ model, messages, stream: true })),
            });
            if (!response.ok) {
              let body;
              try { body = await response.json(); } catch { /* Only expose sanitized status. */ }
              usageFields = body?.usage;
              finalUsageReceived = Boolean(usageFields);
              throw new ResponseError(anthropicError(response.status, body?.error?.type), isTransientHttp(response.status, body?.error?.type));
            }
            for await (const data of readSse(response.body)) {
              controller.signal.throwIfAborted();
              let event;
              try { event = JSON.parse(data); } catch { throw new ResponseError('Claude 응답 형식을 읽을 수 없습니다.', true); }
              if (event.type === 'message_start') {
                usageFields = event.message?.usage;
              } else if (event.type === 'message_delta') {
                // message_delta usage is cumulative: replace present counters,
                // preserving initial input/cache counters that may be omitted.
                if (event.usage) usageFields = { ...usageFields, ...event.usage };
                if (event.delta?.stop_reason) {
                  stopReason = event.delta.stop_reason;
                  finalUsageReceived = Number.isSafeInteger(event.usage?.output_tokens) && event.usage.output_tokens >= 0;
                }
              } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta'
                || event.type === 'content_block_start' && event.content_block?.type === 'text') {
                const value = event.type === 'content_block_delta' ? event.delta.text : event.content_block.text;
                if (typeof value === 'string' && value) { visibleOutput = true; publish({ type: 'delta', text: value }); }
              } else if (event.type === 'error') {
                throw new ResponseError(anthropicError(400, event.error?.type), isTransientAnthropicError(event.error?.type));
              } else if (event.type === 'message_stop') {
                completed = true;
                break;
              }
            }
            if (!completed) throw new ResponseError('Claude 응답 연결이 완료 전에 끊겼습니다. 다시 시도해 주세요.', true);
            if (stopReason !== 'end_turn') throw new ResponseError(stopReason === 'refusal'
              ? 'Claude가 요청을 거절했습니다. 요청 내용을 확인해 주세요.'
              : 'Claude 응답이 끝까지 생성되지 않았습니다. 표시된 내용을 확인하고 다시 요청해 주세요.', stopReason === 'max_tokens');
            if (!visibleOutput) throw new ResponseError('Claude가 빈 응답을 반환했습니다. 다시 시도해 주세요.', true);
          } finally { recordRequestUsage(finalUsageReceived ? normalizeAnthropicUsage(usageFields) : undefined, requestedAt); }
        }, { signal: controller.signal, timeoutMs, retryDelayMs, canRetry: () => !visibleOutput,
          onRetry: retry => publish({ type: 'status', id: 'anthropic-retry', label: `일시적인 응답 오류로 다시 연결하고 있습니다 (${retry}/2)`, state: 'running' }) });
      } else {
      let visibleOutput = false;
      await retryResponse(async requestSignal => {
      const requestedAt = now();
      let usage;
      let completed = false;
      try {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: messages, stream: true, store: false }),
        signal: requestSignal,
        redirect: 'error',
      });
      if (!response.ok) {
        let error;
        try { error = await response.json(); } catch { /* Use the HTTP status only. */ }
        usage = normalizeUsage(error?.usage);
        throw new ResponseError(apiError(response.status, error?.error?.code), isTransientHttp(response.status, error?.error?.code));
      }
      for await (const data of readSse(response.body)) {
        if (controller.signal.aborted) throw new Error('cancelled');
        if (data === '[DONE]') break;
        let event;
        try { event = JSON.parse(data); } catch { throw new ResponseError('OpenAI 응답 형식을 읽을 수 없습니다.', true); }
        if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
          if (typeof event.delta === 'string' && event.delta) { visibleOutput = true; publish({ type: 'delta', text: event.delta }); }
        } else if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
          usage = normalizeUsage(event.response?.usage);
          if (event.type === 'response.failed') throw new ResponseError(apiError(400, event.response?.error?.code), ['server_error', 'rate_limit_exceeded'].includes(event.response?.error?.code));
          if (event.type === 'response.incomplete') throw new ResponseError('응답이 끝까지 생성되지 않았습니다. 표시된 내용을 확인하고 다시 요청해 주세요.', true);
          if (!visibleOutput && Array.isArray(event.response?.output)) {
            const text = event.response.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('');
            if (text.trim()) { visibleOutput = true; publish({ type: 'delta', text }); }
          }
          completed = true;
          break;
        } else if (event.type === 'error') throw new ResponseError(apiError(400, event.code), ['server_error', 'rate_limit_exceeded'].includes(event.code));
      }
      if (!completed) throw new ResponseError('응답 연결이 완료 전에 끊겼습니다. 다시 시도해 주세요.', true);
      if (!visibleOutput) throw new ResponseError('OpenAI가 빈 응답을 반환했습니다. 다시 시도해 주세요.', true);
      } finally { recordRequestUsage(usage, requestedAt); }
      }, { signal: controller.signal, timeoutMs, retryDelayMs, canRetry: () => !visibleOutput,
        onRetry: retry => publish({ type: 'status', id: 'openai-retry', label: `일시적인 응답 오류로 다시 연결하고 있습니다 (${retry}/2)`, state: 'running' }) });
      }
      if (controller.signal.aborted) throw new Error('cancelled');
      result = { ok: true };
    } catch (error) {
      result = error.name === 'BackendTerminationError'
        ? { ok: false, error: '백엔드 프로세스 종료를 확인하지 못했습니다. 새 검사를 시작하기 전에 작업 관리자에서 해당 검사 프로세스를 확인해 주세요.', terminationFailure: true }
        : controller.signal.aborted
        ? controller.signal.reason === 'timeout'
          ? { ok: false, error: '응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.' }
          : { ok: false, cancelled: true }
        : { ok: false, error: error instanceof TypeError ? '선택한 AI 서비스에 연결할 수 없습니다. 네트워크를 확인해 주세요.' : redact(error.message) };
    } finally {
      if (accountingError && !result?.terminationFailure) result = { ok: false, error: '응답 사용량을 저장하지 못했습니다. 저장 공간을 확인해 주세요.' };
      active.delete(input.requestId);
      resolveFinished();
    }
    if (result.ok) {
      publish({ type: 'status', id: `${provider}-response`, label: `${provider === 'anthropic' ? 'Claude' : 'OpenAI'} 응답 완료`, state: 'complete' });
      publish({ type: 'done' });
    }
    return result;
  }

  return {
    start,
    testConnection,
    cancel(requestId) { active.get(requestId)?.controller.abort('cancelled'); },
    hasActive: () => active.size > 0,
    cancelAll() {
      const requests = [...active.values()];
      for (const request of requests) request.controller.abort('cancelled');
      return Promise.all(requests.map(request => request.finished));
    },
  };
}

module.exports = { createOpenAiService, createAiService: createOpenAiService, normalizeUsage, requestMessages, readSse, apiError, validateMaxActions, ResponseError, isTransientHttp, retryResponse, abortableDelay };
