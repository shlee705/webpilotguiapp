import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBackendLoginUrl, normalizeBackendOptions, normalizeBackendDefaults, backendOptionsFromSettings, hasShortBackendTurnLimit, BACKEND_RUN_DEFAULTS } from '../src/lib/backend-options';

test('backend options preserve exact per-run limits independently from visual configuration', () => {
  const input = { provider: 'openai', models: { plan: 'gpt-6.2-astra', triage: 'gpt-5.4-mini' }, budgetUsd: 2.5, exploreMinutes: 9,
    maxPages: 7, maxTemplates: 4, maxTurns: 31, turnsPerTemplate: 12, pagesPerTemplate: 2, concurrency: 2, workers: 3, planEffort: 'high', sessions: 'cluster' };
  assert.deepEqual(normalizeBackendOptions(input), input);
  assert.deepEqual(normalizeBackendOptions(), BACKEND_RUN_DEFAULTS);
  assert.equal(normalizeBackendOptions({}).provider, undefined);
});

test('invalid limits and unknown fields cannot become CLI arguments', () => {
  for (const value of [{ apiKey: 'secret' }, { credentials: {} }, { allowWrites: true }, { origins: ['https://other.test'] },
    { budgetUsd: 0 }, { budgetUsd: 10001 }, { budgetUsd: Infinity }, { maxPages: null }, { maxPages: 1.5 }, { workers: 9 },
    { exploreMinutes: -1 }, { sessions: 'anything' }, { planEffort: 'maximum' }, { provider: 'other' },
    { models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna' } }, { provider: 'openai', models: { plan: '../secret', triage: 'gpt-6-luna' } }]) {
    assert.throws(() => normalizeBackendOptions(value));
  }
});

test('capturing backend settings keeps only selected provider and models, never key metadata or credentials', () => {
  const options = backendOptionsFromSettings({ provider: 'anthropic', models: { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' }, apiKey: 'not-allowed', keyHint: 'private' } as any);
  assert.equal(options.provider, 'anthropic');
  assert.deepEqual(options.models, { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' });
  assert.equal(JSON.stringify(options).includes('private'), false);
  assert.equal(JSON.stringify(options).includes('not-allowed'), false);
});

test('new plans snapshot saved defaults and remain independent of later settings changes', () => {
  const settings = { provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' },
    runDefaults: { ...BACKEND_RUN_DEFAULTS, budgetUsd: 2.5, maxPages: 12, planEffort: 'high', sessions: 'cluster' } } as any;
  const first = backendOptionsFromSettings(settings);
  settings.runDefaults.budgetUsd = 9;
  settings.models.plan = 'gpt-6.2-astra';
  const second = backendOptionsFromSettings(settings);
  assert.equal(first.budgetUsd, 2.5);
  assert.equal(first.models?.plan, 'gpt-6.2-sol');
  assert.equal(first.maxPages, 12);
  assert.equal(first.planEffort, 'high');
  assert.equal(first.sessions, 'cluster');
  assert.equal(second.budgetUsd, 9);
  second.maxPages = 5;
  assert.equal(settings.runDefaults.maxPages, 12);
});

test('saved defaults allow only numeric and enum inspection limits with legacy fallback', () => {
  assert.deepEqual(normalizeBackendDefaults(undefined), BACKEND_RUN_DEFAULTS);
  for (const value of [{ apiKey: 'private' }, { credentials: {} }, { provider: 'openai' }, { models: {} }, { maxPages: 0 }, { workers: 1.5 }, { budgetUsd: NaN }]) {
    assert.throws(() => normalizeBackendDefaults(value));
  }
});

test('short turn guidance covers both exploration modes without raising a user limit', () => {
  assert.equal(hasShortBackendTurnLimit({}), false);
  assert.equal(hasShortBackendTurnLimit({ maxTurns: 1 }), true);
  assert.equal(hasShortBackendTurnLimit({ turnsPerTemplate: 3 }), true);
  assert.equal(hasShortBackendTurnLimit({ maxTurns: 0, turnsPerTemplate: NaN }), false);
  assert.equal(hasShortBackendTurnLimit({ maxTurns: 4, turnsPerTemplate: 5 }), false);
  const options = normalizeBackendOptions({ maxTurns: 1, turnsPerTemplate: 2 });
  assert.equal(hasShortBackendTurnLimit(options), true);
  assert.equal(options.maxTurns, 1);
  assert.equal(options.turnsPerTemplate, 2);
});

test('login URL accepts relative same-origin paths and rejects other origins or embedded account values', () => {
  assert.equal(normalizeBackendLoginUrl('/login', 'https://example.test/app'), 'https://example.test/login');
  assert.equal(normalizeBackendLoginUrl('', 'https://example.test/app'), undefined);
  for (const value of ['https://other.test/login', 'http://example.test/login', 'https://user:password@example.test/login', 'javascript:alert(1)', '/login\n', {}]) {
    assert.throws(() => normalizeBackendLoginUrl(value, 'https://example.test/app'));
  }
});

test('credential URL validation rejects secret representations without rejecting an admin route', () => {
  const credentials = { username: 'admin', password: 's3cret 417' };
  const target = 'https://example.test/admin/login';
  assert.equal(normalizeBackendLoginUrl('/admin/login', target, credentials), target);
  assert.equal(normalizeBackendLoginUrl('/login?role=admin-tools', target, credentials), 'https://example.test/login?role=admin-tools');
  for (const route of ['/login?account=admin', '/login?account=%61dmin', '/login#admin', '/login#/?account=admin',
    '/s3cret%20417/login', '/login?token=s3cret+417', '/login#s3cret%2520417']) {
    assert.throws(() => normalizeBackendLoginUrl(route, target, credentials), /계정 정보를 포함/);
    assert.throws(() => normalizeBackendLoginUrl(undefined, `https://example.test${route}`, credentials), /계정 정보를 포함/);
  }
  assert.throws(() => normalizeBackendLoginUrl(undefined, 'https://secret417.example.test/', { username: 'admin', password: 'secret417' }), /계정 정보를 포함/);
});
