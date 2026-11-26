import type { BackendRunOptions, BackendSettings, LoginCredentials } from '../types';

export const BACKEND_RUN_DEFAULTS = {
  budgetUsd: 10, exploreMinutes: 40, maxPages: 30, maxTemplates: 8,
  turnsPerTemplate: 25, maxTurns: 40, pagesPerTemplate: 3,
  concurrency: 1, workers: 1, planEffort: 'medium', sessions: 'template',
} as const;

export const BACKEND_NUMBER_FIELDS = {
  budgetUsd: { label: '검사 예산 (USD)', max: 10000, integer: false },
  exploreMinutes: { label: '탐색 시간 (분)', max: 1440, integer: true },
  maxPages: { label: '최대 방문 페이지', max: 1000, integer: true },
  maxTemplates: { label: '최대 페이지 종류', max: 100, integer: true },
  turnsPerTemplate: { label: '페이지 종류별 탐색 턴', max: 200, integer: true },
  maxTurns: { label: '대화별 최대 턴', max: 200, integer: true },
  pagesPerTemplate: { label: '종류별 검사 페이지', max: 100, integer: true },
  concurrency: { label: '동시 탐색·판정 수', max: 8, integer: true },
  workers: { label: '동시 검사 실행 수', max: 8, integer: true },
} as const;
export type BackendNumberField = keyof typeof BACKEND_NUMBER_FIELDS;
const allowed = new Set([...Object.keys(BACKEND_RUN_DEFAULTS), 'provider', 'models']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validModel = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);

/** Whitelist only per-run inspection options; keys, credentials and arbitrary CLI flags never belong here. */
export function normalizeBackendOptions(value: unknown = {}): BackendRunOptions {
  if (!object(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error('백엔드 검사 설정에 허용되지 않은 항목이 있습니다.');
  const result: BackendRunOptions = { ...BACKEND_RUN_DEFAULTS };
  if (value.provider !== undefined) {
    if (value.provider !== 'openai' && value.provider !== 'anthropic') throw new Error('백엔드 AI를 선택해 주세요.');
    result.provider = value.provider;
  }
  if (value.models !== undefined) {
    if (!result.provider || !object(value.models) || Object.keys(value.models).some(key => !['plan', 'triage'].includes(key))
      || !validModel(value.models.plan) || !validModel(value.models.triage)) throw new Error('백엔드 AI와 계획·판정 모델 ID를 확인해 주세요.');
    result.models = { plan: value.models.plan, triage: value.models.triage };
  }
  for (const name of Object.keys(BACKEND_NUMBER_FIELDS) as BackendNumberField[]) {
    const number = value[name] === undefined ? BACKEND_RUN_DEFAULTS[name] : value[name];
    const field = BACKEND_NUMBER_FIELDS[name];
    if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0 || number > field.max || field.integer && !Number.isSafeInteger(number)) {
      throw new Error(`${field.label}은 0보다 크고 ${field.max.toLocaleString()} 이하인 ${field.integer ? '정수' : '숫자'}로 입력해 주세요.`);
    }
    result[name] = number;
  }
  if (value.planEffort !== undefined && !['low', 'medium', 'high'].includes(value.planEffort as string)) throw new Error('백엔드 추론 수준을 선택해 주세요.');
  if (value.sessions !== undefined && !['template', 'cluster'].includes(value.sessions as string)) throw new Error('백엔드 탐색 묶음 방식을 선택해 주세요.');
  result.planEffort = value.planEffort as BackendRunOptions['planEffort'] ?? BACKEND_RUN_DEFAULTS.planEffort;
  result.sessions = value.sessions as BackendRunOptions['sessions'] ?? BACKEND_RUN_DEFAULTS.sessions;
  return result;
}

export function backendOptionsFromSettings(settings?: BackendSettings): BackendRunOptions {
  return normalizeBackendOptions(settings ? { provider: settings.provider, models: { ...settings.models } } : {});
}

function assertNoUrlCredentials(url: URL, credentials?: Partial<LoginCredentials>) {
  if (!credentials) return;
  const password = credentials.password;
  const variants = new Set<string>();
  if (password) {
    variants.add(password);
    variants.add(JSON.stringify(password).slice(1, -1));
    try {
      variants.add(encodeURIComponent(password)); variants.add(encodeURI(password));
      variants.add(encodeURIComponent(password).replace(/%20/g, '+'));
    } catch { /* Exact matching still handles malformed Unicode. */ }
    variants.add(password.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  }
  let decoded = url.href;
  try { decoded = decodeURIComponent(url.href); } catch { /* Check the original malformed escape too. */ }
  const fragment = url.hash.slice(1);
  let decodedFragment = fragment;
  try { decodedFragment = decodeURIComponent(fragment); } catch { /* Query parsing remains tolerant. */ }
  const fragmentQuery = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
  const username = credentials.username?.trim();
  const carriesUsername = !!username && (decodedFragment === username
    || [...url.searchParams.values(), ...new URLSearchParams(fragmentQuery).values()].includes(username));
  if (url.username || url.password || [...variants].some(secret => url.href.includes(secret) || decoded.includes(secret)) || carriesUsername) {
    throw new Error('검사 주소와 로그인 주소에 계정 정보를 포함할 수 없습니다.');
  }
}

/** Login routing is public plan metadata; account values remain in transient credentials. */
export function normalizeBackendLoginUrl(value: unknown, targetUrl: string, credentials?: Partial<LoginCredentials>): string | undefined {
  if (credentials) assertNoUrlCredentials(new URL(targetUrl), credentials);
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('로그인 URL을 올바르게 입력해 주세요.');
  let target: URL, login: URL;
  try { target = new URL(targetUrl); login = new URL(value, target); }
  catch { throw new Error('로그인 URL을 올바르게 입력해 주세요.'); }
  if (!['http:', 'https:'].includes(login.protocol) || login.username || login.password || login.origin !== target.origin) {
    throw new Error('로그인 URL은 대상 사이트와 동일한 출처의 HTTP(S) 주소여야 합니다.');
  }
  assertNoUrlCredentials(login, credentials);
  return login.href;
}
