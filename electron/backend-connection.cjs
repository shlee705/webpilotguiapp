'use strict';
const { validateProvider, validateModel, validateKey } = require('./ai-settings.cjs');
const { ANTHROPIC_API, anthropicHeaders, anthropicError } = require('./anthropic.cjs');
const { apiError } = require('./openai.cjs');

// Uses only the dedicated backend configuration. Neither GUI Computer Use
// settings nor its saved provider keys are dependencies of this checker.
function createBackendConnectionTest({ settings, fetchImpl = fetch }) {
  return async function testBackendConnection(input = {}) {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['provider', 'models', 'apiKey'].includes(key))) throw new Error();
      const provider = validateProvider(input.provider ?? settings.get().provider);
      const configured = settings.resolveConfig(provider);
      const models = input.models ?? configured.models;
      if (!models || typeof models !== 'object' || Object.keys(models).some(key => !['plan', 'triage'].includes(key))) throw new Error();
      const selected = [...new Set([validateModel(models.plan), validateModel(models.triage)])];
      const key = input.apiKey?.trim() ? validateKey(input.apiKey, provider) : configured.apiKey;
      if (!key) return { ok: false, error: `실제 검사에 사용할 ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} 백엔드 전용 키를 입력해 주세요.` };
      const endpoint = provider === 'anthropic' ? ANTHROPIC_API : 'https://api.openai.com/v1';
      for (const model of selected) {
        const response = await fetchImpl(`${endpoint}/models/${encodeURIComponent(model)}`, {
          headers: provider === 'anthropic' ? anthropicHeaders(key) : { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        if (!response.ok) {
          let body;
          try { body = await response.json(); } catch { /* Expose only sanitized error categories. */ }
          return { ok: false, error: provider === 'anthropic' ? anthropicError(response.status, body?.error?.type) : apiError(response.status, body?.error?.code) };
        }
        const body = await response.json();
        if (typeof body?.id !== 'string' || !body.id.trim()) return { ok: false, error: '백엔드 모델 정보를 확인하지 못했습니다.' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.name === 'TimeoutError' ? '백엔드 연결 확인 시간이 초과되었습니다.' : '백엔드 연결을 확인할 수 없습니다. 제공자·모델·키와 네트워크를 확인해 주세요.' };
    }
  };
}

module.exports = { createBackendConnectionTest };
