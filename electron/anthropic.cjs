// API contract verified against the current official Claude API documentation:
// https://platform.claude.com/docs/en/api/messages/create
// https://platform.claude.com/docs/en/api/models/retrieve
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// https://platform.claude.com/docs/en/build-with-claude/streaming
const ANTHROPIC_API = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2026-10-21';

function anthropicHeaders(apiKey) {
  return { 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, Authorization: `Bearer ${apiKey}` };
}

function anthropicRequest({ model, messages, maxTokens = 4096, stream = false, schema }) {
  return {
    model, max_tokens: maxTokens,
    system: messages.filter(message => ['developer', 'system'].includes(message.role)).map(message => message.content).join('\n\n'),
    messages: messages.filter(message => ['user', 'assistant'].includes(message.role)),
    ...(stream ? { stream: true } : {}),
    ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {}),
  };
}

function normalizeAnthropicUsage(value) {
  if (!value) return undefined;
  const values = [value.input_tokens, value.output_tokens, value.cache_creation_input_tokens ?? 0, value.cache_read_input_tokens ?? 0];
  if (!values.every(count => Number.isSafeInteger(count) && count >= 0)) return undefined;
  const inputTokens = values[0] + values[2] + values[3];
  const outputTokens = values[1];
  const totalTokens = inputTokens + outputTokens;
  return Number.isSafeInteger(totalTokens) ? { inputTokens, outputTokens, totalTokens } : undefined;
}

function anthropicError(status, type) {
  if (status === 401 || type === 'authentication_error') return 'Anthropic API 키 인증에 실패했습니다. 설정에서 키를 확인해 주세요.';
  if (status === 403 || type === 'permission_error') return '이 Anthropic API 키에 요청 권한이 없습니다. 모델 접근 권한을 확인해 주세요.';
  if (status === 404 || type === 'not_found_error') return '선택한 Claude 모델을 사용할 수 없습니다. 다른 모델을 선택해 주세요.';
  if (status === 408 || type === 'timeout_error') return 'Anthropic API 응답 대기 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.';
  if (status === 429 || type === 'rate_limit_error') return 'Anthropic 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  if (status >= 500 || ['api_error', 'overloaded_error'].includes(type)) return 'Anthropic 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.';
  return 'Anthropic API 요청에 실패했습니다. 모델과 API 설정을 확인해 주세요.';
}

function isTransientAnthropicError(type) {
  return ['api_error', 'overloaded_error', 'rate_limit_error', 'timeout_error'].includes(type);
}

function anthropicText(body) {
  return Array.isArray(body?.content) ? body.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
}

module.exports = { ANTHROPIC_API, ANTHROPIC_VERSION, anthropicHeaders, anthropicRequest, normalizeAnthropicUsage, anthropicError, isTransientAnthropicError, anthropicText };
