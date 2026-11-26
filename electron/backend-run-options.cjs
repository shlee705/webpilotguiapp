'use strict';

const { validateBackendProvider, validateBackendModel } = require('./backend-settings.cjs');
const { normalizeHttpUrl } = require('./edge.cjs');
const { createSecretRedactor } = require('./login-secrets.cjs');

const BACKEND_RUN_DEFAULTS = Object.freeze({
  budgetUsd: 10, exploreMinutes: 40, maxPages: 30, maxTemplates: 8,
  turnsPerTemplate: 25, maxTurns: 40, pagesPerTemplate: 3,
  concurrency: 1, workers: 1, planEffort: 'medium', sessions: 'template',
});
const NUMBER_LIMITS = Object.freeze({ budgetUsd: 10000, exploreMinutes: 1440, maxPages: 1000,
  maxTemplates: 100, turnsPerTemplate: 200, maxTurns: 200, pagesPerTemplate: 100, concurrency: 8, workers: 8 });
const FLAGS = Object.freeze({ budgetUsd: 'budget', exploreMinutes: 'explore-minutes', maxPages: 'max-pages',
  maxTemplates: 'max-templates', turnsPerTemplate: 'turns-per-template', maxTurns: 'max-turns',
  pagesPerTemplate: 'pages-per-template', concurrency: 'concurrency', workers: 'workers',
  planEffort: 'plan-effort', sessions: 'sessions' });
const FIELDS = new Set([...Object.keys(BACKEND_RUN_DEFAULTS), 'provider', 'models']);

function validateBackendRunOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !FIELDS.has(key))) throw new Error('허용된 백엔드 테스트 설정만 전달할 수 있습니다.');
  const result = { ...BACKEND_RUN_DEFAULTS };
  for (const [field, maximum] of Object.entries(NUMBER_LIMITS)) {
    const count = value[field] ?? BACKEND_RUN_DEFAULTS[field];
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0 || count > maximum
      || field !== 'budgetUsd' && !Number.isSafeInteger(count) || value[field] === null) {
      throw new Error(`백엔드 ${field} 설정은 ${field === 'budgetUsd' ? '0보다 큰 수' : '1 이상의 정수'}이며 ${maximum} 이하여야 합니다.`);
    }
    result[field] = count;
  }
  for (const [field, accepted] of [['planEffort', ['low', 'medium', 'high']], ['sessions', ['template', 'cluster']]]) {
    const selected = value[field] === undefined ? BACKEND_RUN_DEFAULTS[field] : value[field];
    if (!accepted.includes(selected)) throw new Error(`백엔드 ${field} 설정이 올바르지 않습니다.`);
    result[field] = selected;
  }
  if (value.provider !== undefined) result.provider = validateBackendProvider(value.provider);
  if (value.models !== undefined) {
    if (!result.provider || !value.models || typeof value.models !== 'object' || Array.isArray(value.models)
      || Object.keys(value.models).some(key => !['plan', 'triage'].includes(key))) throw new Error('백엔드 모델과 해당 제공자를 함께 지정해 주세요.');
    result.models = Object.freeze({ plan: validateBackendModel(value.models.plan), triage: validateBackendModel(value.models.triage) });
  }
  return Object.freeze(result);
}

function backendExecutionParameters(value) {
  const validated = validateBackendRunOptions(value);
  return Object.freeze(Object.fromEntries(Object.keys(BACKEND_RUN_DEFAULTS).map(key => [key, validated[key]])));
}

function backendCliArguments(value) {
  const parameters = backendExecutionParameters(value);
  return Object.entries(FLAGS).flatMap(([key, flag]) => [`--${flag}`, String(parameters[key])]);
}

function validateBackendTask(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 16000) throw new Error('백엔드 검사 요구사항은 1~16,000자의 텍스트로 입력해 주세요.');
  return value.trim();
}

function validateBackendLoginUrl(value, targetUrl, credentials) {
  if (!credentials) {
    if (value !== undefined) throw new Error('백엔드 로그인 주소를 사용하려면 로그인 계정을 입력해 주세요.');
    return undefined;
  }
  const target = new URL(normalizeHttpUrl(targetUrl));
  const login = new URL(normalizeHttpUrl(value === undefined ? targetUrl : value));
  const redactPassword = createSecretRedactor({ username: '', password: credentials.password });
  const carriesSecrets = url => {
    // A username such as "admin" is also a common route name. Only parameter
    // values carry a username; a password must not appear in any URL component.
    const components = [url.href];
    if (components.some(value => {
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch { /* Compare the original malformed escape too. */ }
      return redactPassword(value) !== value || redactPassword(decoded) !== decoded;
    })) return true;
    const fragment = url.hash.slice(1);
    let decodedFragment = fragment;
    try { decodedFragment = decodeURIComponent(fragment); } catch { /* Parameter parsing remains tolerant. */ }
    const fragmentQuery = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
    return decodedFragment === credentials.username
      || [...url.searchParams.values(), ...new URLSearchParams(fragmentQuery).values()].includes(credentials.username);
  };
  if (target.username || target.password || login.username || login.password
    || carriesSecrets(target) || carriesSecrets(login)) throw new Error('검사 주소와 로그인 주소에 계정 정보를 포함할 수 없습니다.');
  if (login.origin !== target.origin) throw new Error('백엔드 로그인 주소는 검사 사이트와 같은 출처여야 합니다.');
  return login.href;
}

module.exports = { BACKEND_RUN_DEFAULTS, NUMBER_LIMITS, validateBackendRunOptions, backendExecutionParameters, backendCliArguments, validateBackendTask, validateBackendLoginUrl };
