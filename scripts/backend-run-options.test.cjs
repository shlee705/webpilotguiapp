'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BACKEND_RUN_DEFAULTS, validateBackendRunOptions, backendCliArguments, validateBackendTask, validateBackendLoginUrl } = require('../electron/backend-run-options.cjs');

test('backend options reject unbounded numbers and privileged/injected fields before CLI serialization', () => {
  for (const value of [null, [], 'flags', { budgetUsd: 0 }, { budgetUsd: Infinity }, { budgetUsd: '10' }, { maxPages: null },
    { maxPages: 1001 }, { exploreMinutes: 0.5 }, { workers: 9 }, { concurrency: NaN }, { planEffort: 'unlimited' },
    { sessions: 'all' }, { apiKey: 'do-not-forward' }, { env: { TOKEN: 'secret' } }, { allowWrites: true },
    { origins: ['https://other.test'] }, { app: '../private.json' }, { maxPages: '--allow-writes' },
    { models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna' } },
    { provider: 'openai', models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna', key: 'secret' } }]) {
    assert.throws(() => validateBackendRunOptions(value));
  }
});

test('backend login URL requires a memory account, matching origin, and no account values', () => {
  const credentials = { username: 'private-user-123', password: 'private-pass&456' };
  const target = 'https://example.test/';
  assert.equal(validateBackendLoginUrl(undefined, target), undefined);
  assert.equal(validateBackendLoginUrl(undefined, target, credentials), target);
  assert.equal(validateBackendLoginUrl('https://example.test/login', target, credentials), 'https://example.test/login');
  assert.throws(() => validateBackendLoginUrl('https://example.test/login', target));
  for (const value of ['', null, '/login', 'https://other.test/login', 'http://example.test/login', 'https://example.test:8443/login',
    'https://user:pass@example.test/login', `https://example.test/?password=${encodeURIComponent(credentials.password)}`,
    `https://example.test/login/${encodeURIComponent(credentials.password)}`]) assert.throws(() => validateBackendLoginUrl(value, target, credentials));
  assert.throws(() => validateBackendLoginUrl(undefined, 'https://private-pass.example.test/', { ...credentials, password: 'private-pass' }));
});

test('admin usernames may coincide with routes but actual URL credential values stay forbidden', () => {
  const credentials = { username: 'admin', password: 'private-password&456' };
  const target = 'https://example.test/admin';
  assert.equal(validateBackendLoginUrl(undefined, target, credentials), target);
  for (const value of ['https://example.test/admin/login', 'https://example.test/#/admin/login',
    'https://example.test/login?next=%2Fadmin%2Flogin', 'https://example.test/login?role=administrator']) {
    assert.equal(validateBackendLoginUrl(value, target, credentials), value);
  }
  for (const value of ['https://example.test/login?username=admin', 'https://example.test/login?username=%61dmin',
    'https://example.test/#admin', 'https://example.test/#/login?username=admin', 'https://example.test/#username=admin',
    'https://example.test/private-password%26456', 'https://example.test/login?password=private-password%26456',
    'https://example.test/#/private-password%26456']) assert.throws(() => validateBackendLoginUrl(value, target, credentials));
});

test('legacy options use unchanged backend defaults and task text cannot become flags', () => {
  assert.deepEqual(validateBackendRunOptions(), BACKEND_RUN_DEFAULTS);
  assert.equal(validateBackendTask('  검색 기능\n--allow-writes  '), '검색 기능\n--allow-writes');
  for (const value of ['', '   ', null, {}, 'x'.repeat(16001)]) assert.throws(() => validateBackendTask(value));
  const source = { provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' }, budgetUsd: 0.75 };
  const options = validateBackendRunOptions(source);
  source.models.plan = 'changed';
  assert.equal(options.models.plan, 'gpt-6.2-sol');
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options.models), true);
  assert.deepEqual(backendCliArguments(options), ['--budget', '0.75', '--explore-minutes', '40', '--max-pages', '30',
    '--max-templates', '8', '--turns-per-template', '25', '--max-turns', '40', '--pages-per-template', '3',
    '--concurrency', '1', '--workers', '1', '--plan-effort', 'medium', '--sessions', 'template']);
});
