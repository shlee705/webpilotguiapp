const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiSettings, DEFAULT_PROVIDER, DEFAULT_MODELS, validateProvider, validateKey } = require('../electron/ai-settings.cjs');

const KEYS = { openai: 'sk-openai-local-fixture-1234', anthropic: 'sk-ant-local-fixture-5678' };
const NOVEMBER = new Date('2026-11-25T01:00:00Z');
const usage = (totalTokens = 15) => ({ inputTokens: totalTokens - 5, outputTokens: 5, totalTokens });

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-provider-settings-'));
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('webpilot-provider-settings-'));
  t.after(() => fs.rmSync(resolved, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value.split('').reverse().join('')),
    decryptString: value => value.toString().split('').reverse().join(''),
    ...options.safeStorage,
  };
  const filename = path.join(directory, 'ai-settings.json');
  if (options.saved) fs.writeFileSync(filename, JSON.stringify(options.saved));
  const args = { directory, safeStorage, now: options.now ?? (() => NOVEMBER), fileSystem: options.fileSystem ?? fs };
  return { ...args, filename, settings: createAiSettings(args), reload: () => createAiSettings(args),
    disk: () => JSON.parse(fs.readFileSync(filename, 'utf8')) };
}

test('provider views expose defaults without changing the saved selection or exposing keys', t => {
  const { settings } = fixture(t);
  assert.equal(DEFAULT_PROVIDER, 'openai');
  assert.equal(settings.get().provider, 'openai');
  for (const provider of ['openai', 'anthropic']) {
    const selected = settings.get(provider);
    assert.equal(selected.provider, provider);
    assert.equal(selected.model, DEFAULT_MODELS[provider]);
    assert.equal(selected.keyConfigured, false);
    assert.deepEqual(selected.usage, selected.profiles[provider].usage);
  }
  assert.equal(settings.get().provider, 'openai');
  settings.save({ provider: 'anthropic', apiKey: KEYS.anthropic });
  const publicSettings = settings.get();
  assert.equal(publicSettings.keyHint, '•••• 5678');
  assert.equal(JSON.stringify(publicSettings).includes(KEYS.anthropic), false);
  assert.equal('apiKey' in publicSettings.profiles.anthropic, false);
  assert.equal('encryptedKey' in publicSettings.profiles.anthropic, false);
  publicSettings.profiles.anthropic.model = 'changed-by-renderer';
  publicSettings.usage.requests = 900;
  assert.equal(settings.get().model, DEFAULT_MODELS.anthropic);
  assert.equal(settings.get().usage.requests, 0);
});

test('switching, updating and forgetting a provider preserves the other encrypted profile', t => {
  const f = fixture(t);
  f.settings.save({ provider: 'openai', model: 'gpt-custom-model', apiKey: KEYS.openai });
  f.settings.recordUsage(usage(), NOVEMBER, 'openai');
  f.settings.save({ provider: 'anthropic', model: 'claude-custom-model', apiKey: KEYS.anthropic });
  f.settings.recordUsage(usage(25), NOVEMBER, 'anthropic');
  f.settings.save({ provider: 'openai', apiKey: '   ' });
  assert.equal(f.settings.getKey(), KEYS.openai);
  assert.equal(f.settings.getKey('anthropic'), KEYS.anthropic);
  assert.equal(f.settings.get('anthropic').model, 'claude-custom-model');
  assert.equal(f.settings.get().provider, 'openai');
  const disk = f.disk();
  assert.equal(disk.version, 2);
  assert.equal(disk.provider, 'openai');
  for (const provider of ['openai', 'anthropic']) {
    assert.ok(disk.profiles[provider].encryptedKey);
    assert.equal(JSON.stringify(disk).includes(KEYS[provider]), false);
    assert.equal(f.reload().getKey(provider), KEYS[provider]);
  }
  f.settings.save({ provider: 'anthropic', forgetKey: true });
  assert.equal(f.settings.get().keyConfigured, false);
  assert.equal(f.settings.get().model, 'claude-custom-model');
  assert.equal(f.settings.get().usage.totalTokens, 25);
  assert.equal(f.settings.getKey('openai'), KEYS.openai);
  assert.equal(f.disk().profiles.openai.encryptedKey, disk.profiles.openai.encryptedKey);
  assert.equal(f.reload().getKey('anthropic'), '');
  assert.equal(f.reload().getKey('openai'), KEYS.openai);
});

test('v1 settings migrate only to OpenAI and preserve their encrypted key, model and history', t => {
  const legacyUsage = { month: '2026-11', ...usage(35), requests: 3, untrackedRequests: 1 };
  const encryptedKey = Buffer.from(KEYS.openai.split('').reverse().join('')).toString('base64');
  const f = fixture(t, { saved: { version: 1, model: 'gpt-existing-model', encryptedKey,
    usageByMonth: { '2026-11': legacyUsage } } });
  assert.equal(f.disk().version, 1);
  assert.equal(f.settings.get().provider, 'openai');
  assert.equal(f.settings.get().model, 'gpt-existing-model');
  assert.equal(f.settings.getKey(), KEYS.openai);
  assert.deepEqual(f.settings.get().usage, legacyUsage);
  assert.equal(f.settings.get('anthropic').keyConfigured, false);
  assert.equal(f.settings.get('anthropic').usage.requests, 0);
  f.settings.save({ provider: 'anthropic', apiKey: KEYS.anthropic });
  const saved = f.disk();
  assert.equal(saved.version, 2);
  assert.equal(saved.profiles.openai.encryptedKey, encryptedKey);
  assert.deepEqual(saved.profiles.openai.usageByMonth['2026-11'], legacyUsage);
  assert.equal(f.reload().getKey('openai'), KEYS.openai);
  assert.equal(f.reload().get().provider, 'anthropic');
});

test('both keys stay only in memory when OS encryption is unavailable or insecure', async t => {
  for (const safeStorage of [
    { isEncryptionAvailable: () => false },
    { getSelectedStorageBackend: () => 'basic_text' },
    { encryptString: () => { throw new Error('storage failure'); } },
  ]) {
    await t.test('unavailable, basic_text or failed encryption', subtest => {
      const f = fixture(subtest, { safeStorage });
      for (const provider of ['openai', 'anthropic']) {
        f.settings.save({ provider, apiKey: KEYS[provider] });
        assert.equal(f.settings.get(provider).storage, 'session');
        assert.equal(f.settings.getKey(provider), KEYS[provider]);
        assert.equal(f.disk().profiles[provider].encryptedKey, '');
        assert.equal(JSON.stringify(f.disk()).includes(KEYS[provider]), false);
        assert.equal(f.reload().getKey(provider), '');
      }
      f.settings.save({ provider: 'openai', forgetKey: true });
      assert.equal(f.settings.getKey('openai'), '');
      assert.equal(f.settings.getKey('anthropic'), KEYS.anthropic);
    });
  }
});

test('a failed decryption does not discard the other provider key or either model', t => {
  const f = fixture(t);
  for (const provider of ['openai', 'anthropic']) f.settings.save({ provider, apiKey: KEYS[provider] });
  const decrypt = f.safeStorage.decryptString;
  f.safeStorage.decryptString = value => {
    const key = decrypt(value);
    if (key === KEYS.openai) throw new Error('private OS storage details');
    return key;
  };
  const restored = f.reload();
  assert.equal(restored.getKey('openai'), '');
  assert.equal(restored.getKey('anthropic'), KEYS.anthropic);
  assert.equal(restored.get('openai').model, DEFAULT_MODELS.openai);
  assert.equal(restored.get('anthropic').model, DEFAULT_MODELS.anthropic);
});

test('in-flight usage belongs to the original provider and request month after a settings switch', t => {
  let instant = new Date('2026-11-30T14:59:00Z');
  const f = fixture(t, { now: () => instant });
  const startedAt = instant;
  f.settings.save({ provider: 'anthropic' });
  instant = new Date('2026-11-30T15:01:00Z');
  f.settings.recordUsage(usage(45), startedAt, 'openai');
  f.settings.recordUsage(undefined, instant, 'anthropic');
  assert.equal(f.settings.get().provider, 'anthropic');
  assert.equal(f.settings.get('openai').usage.requests, 0);
  assert.equal(f.settings.get('anthropic').usage.untrackedRequests, 1);
  assert.deepEqual(f.disk().profiles.openai.usageByMonth['2026-11'], {
    month: '2026-11', ...usage(45), requests: 1, untrackedRequests: 0,
  });
  assert.equal(f.reload().get('anthropic').usage.untrackedRequests, 1);
});

test('invalid providers and keys fail without changing existing settings', t => {
  const { settings } = fixture(t);
  settings.save({ provider: 'anthropic', apiKey: KEYS.anthropic });
  const before = settings.get();
  for (const provider of ['claude', 'gpt', '__proto__', '', null, {}, 1]) {
    assert.throws(() => validateProvider(provider));
    assert.throws(() => settings.get(provider));
    assert.throws(() => settings.getKey(provider));
    assert.throws(() => settings.save({ provider, apiKey: KEYS.openai }));
    assert.throws(() => settings.recordUsage(usage(), NOVEMBER, provider));
  }
  assert.throws(() => validateKey('bad', 'openai'), /OpenAI/);
  assert.throws(() => validateKey('bad', 'anthropic'), /Anthropic/);
  assert.throws(() => settings.save({ provider: 'openai', apiKey: 'bad key' }));
  assert.throws(() => settings.save({ provider: 'openai', model: 'bad model' }));
  assert.throws(() => settings.save({ provider: 'openai', forgetKey: 'yes' }));
  assert.throws(() => settings.save([]));
  assert.deepEqual(settings.get(), before);
  assert.equal(settings.getKey('anthropic'), KEYS.anthropic);
});

test('failed atomic save preserves active provider and both keys and cleans its temporary file', t => {
  let failWrites = false;
  const fileSystem = { ...fs, renameSync: (...args) => {
    if (failWrites) throw new Error(`private ${KEYS.anthropic}`);
    return fs.renameSync(...args);
  } };
  const f = fixture(t, { fileSystem });
  f.settings.save({ provider: 'openai', apiKey: KEYS.openai });
  f.settings.save({ provider: 'anthropic', apiKey: KEYS.anthropic });
  const before = f.settings.get();
  const fileBefore = fs.readFileSync(f.filename, 'utf8');
  failWrites = true;
  assert.throws(() => f.settings.save({ provider: 'openai', apiKey: 'sk-replacement-fixture-9012' }), error => {
    assert.match(error.message, /저장할 수 없습니다/);
    assert.equal(error.message.includes(KEYS.anthropic), false);
    return true;
  });
  assert.deepEqual(f.settings.get(), before);
  assert.equal(f.settings.getKey('openai'), KEYS.openai);
  assert.equal(f.settings.getKey('anthropic'), KEYS.anthropic);
  assert.equal(fs.readFileSync(f.filename, 'utf8'), fileBefore);
  assert.deepEqual(fs.readdirSync(f.directory), ['ai-settings.json']);
});

test('settings writes stay in their own file and never modify backend environment configuration', t => {
  const writes = [];
  const fileSystem = { ...fs, writeFileSync: (filename, ...args) => {
    writes.push(filename);
    return fs.writeFileSync(filename, ...args);
  } };
  const environmentBefore = { ...process.env };
  const f = fixture(t, { fileSystem });
  const backend = path.join(f.directory, 'webtestpilot-backend');
  fs.mkdirSync(backend);
  const envPath = path.join(backend, '.env');
  const backendEnvironment = 'ANTHROPIC_API_KEY=backend-only-fixture\n';
  fs.writeFileSync(envPath, backendEnvironment);
  for (const provider of ['openai', 'anthropic']) f.settings.save({ provider, apiKey: KEYS[provider] });
  assert.deepEqual({ ...process.env }, environmentBefore);
  assert.equal(fs.readFileSync(envPath, 'utf8'), backendEnvironment);
  assert.equal(writes.length, 2);
  for (const filename of writes) {
    assert.equal(path.dirname(filename), f.directory);
    assert.match(path.basename(filename), /^ai-settings\.json\.[a-z0-9-]+\.tmp$/);
  }
});
