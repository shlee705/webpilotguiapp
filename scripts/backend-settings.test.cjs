'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackendSettings, BACKEND_DEFAULT_MODELS, parseBackendEnv } = require('../electron/backend-settings.cjs');

const GPT_KEY = 'sk-backend-openai-fixture-1234';
const CLAUDE_KEY = 'sk-ant-backend-fixture-5678';
function fixture(t, options = {}) {
  const backendRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-backend-settings-'));
  assert.equal(path.dirname(path.resolve(backendRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(backendRoot).startsWith('webpilot-backend-settings-'));
  t.after(() => fs.rmSync(backendRoot, { recursive: true, force: true }));
  const filename = path.join(backendRoot, '.env');
  const environment = { ...options.environment };
  if (options.text !== undefined) fs.writeFileSync(filename, options.text);
  const args = { backendRoot, environment, ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}) };
  return { backendRoot, filename, environment, args, settings: createBackendSettings(args), read: () => fs.readFileSync(filename, 'utf8') };
}

test('backend defaults do not create a file or reuse Computer Use settings', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.backendRoot, 'ai-settings.json'), JSON.stringify({ provider: 'anthropic', apiKey: CLAUDE_KEY, model: 'visual-only' }));
  const value = f.settings.get();
  assert.equal(value.provider, 'anthropic');
  assert.deepEqual(value.models, BACKEND_DEFAULT_MODELS.anthropic);
  assert.deepEqual(value.profiles.openai.models, BACKEND_DEFAULT_MODELS.openai);
  assert.equal(value.storage, 'env-file');
  assert.equal(value.keyConfigured, false);
  assert.equal(fs.existsSync(f.filename), false);
  assert.equal(f.settings.resolveConfig().apiKey, '');
});

test('provider keys and two model roles are saved only to backend .env and restored independently', t => {
  const f = fixture(t);
  f.settings.save({ provider: 'anthropic', apiKey: CLAUDE_KEY, models: { plan: 'claude-haiku-5-5', triage: 'claude-sonnet-5-5' } });
  f.settings.save({ provider: 'openai', apiKey: GPT_KEY, models: { plan: 'gpt-6.2-astra', triage: 'gpt-6-luna' } });
  const reopened = createBackendSettings(f.args);
  assert.equal(reopened.get().provider, 'openai');
  assert.equal(reopened.resolveConfig().apiKey, GPT_KEY);
  assert.deepEqual(reopened.resolveConfig('anthropic'), { provider: 'anthropic', apiKey: CLAUDE_KEY, models: { plan: 'claude-haiku-5-5', triage: 'claude-sonnet-5-5' } });
  assert.equal(reopened.get().provider, 'openai');
  assert.deepEqual(fs.readdirSync(f.backendRoot), ['.env']);
  const publicSettings = reopened.get();
  for (const key of [GPT_KEY, CLAUDE_KEY]) assert.equal(JSON.stringify(publicSettings).includes(key), false);
  assert.equal(publicSettings.keyHint, '•••• 1234');
  assert.equal(publicSettings.source, 'file');
  publicSettings.models.plan = 'renderer-edit';
  assert.equal(reopened.get().models.plan, 'gpt-6.2-astra');
  assert.equal(Object.isFrozen(reopened.resolveConfig().models), true);
});

test('saving and deleting one provider preserves comments, other fields and the other provider', t => {
  const text = `# keep this comment\r\nOTHER_TOKEN="unrelated-secret"\r\nANTHROPIC_API_KEY='${CLAUDE_KEY}'\r\n\r\nOPENAI_API_KEY=old-first\r\nOPENAI_API_KEY=old-last\r\n`;
  const f = fixture(t, { text });
  f.settings.save({ provider: 'openai', apiKey: GPT_KEY });
  assert.ok(f.read().startsWith(`# keep this comment\r\nOTHER_TOKEN="unrelated-secret"\r\nANTHROPIC_API_KEY='${CLAUDE_KEY}'\r\n`));
  assert.equal((f.read().match(/^OPENAI_API_KEY=/gm) || []).length, 1);
  assert.equal(f.read().replaceAll('\r\n', '').includes('\n'), false);
  assert.equal(parseBackendEnv(f.read()).OPENAI_API_KEY, GPT_KEY);
  f.settings.save({ provider: 'openai', forgetKey: true });
  assert.equal(f.settings.get().keyConfigured, false);
  assert.equal(f.settings.get().profiles.anthropic.keyConfigured, true);
  assert.equal(f.read().includes(GPT_KEY), false);
  assert.equal(f.read().includes('unrelated-secret'), true);
  assert.equal(f.settings.resolveConfig('anthropic').apiKey, CLAUDE_KEY);
});

test('external keys take precedence without modifying environment or masking saved-file deletion', t => {
  const f = fixture(t, { environment: { OPENAI_API_KEY: 'external-openai-key' } });
  const original = { ...f.environment };
  f.settings.save({ provider: 'openai', apiKey: GPT_KEY });
  assert.equal(f.settings.resolveConfig().apiKey, 'external-openai-key');
  assert.equal(f.settings.get().source, 'environment');
  assert.equal(f.settings.get().savedKeyConfigured, true);
  assert.equal(f.settings.get().keyHint, '•••• 1234');
  f.settings.save({ forgetKey: true });
  assert.equal(f.settings.get().keyConfigured, true);
  assert.equal(f.settings.get().savedKeyConfigured, false);
  assert.deepEqual(f.environment, original);
  assert.equal(f.read().includes('external-openai-key'), false);
});

test('empty-key model edits preserve saved keys and custom model IDs stay data', t => {
  const f = fixture(t);
  f.settings.save({ provider: 'openai', apiKey: GPT_KEY });
  f.settings.save({ models: { plan: 'custom-model', triage: 'gpt-6-luna' }, apiKey: '  ' });
  assert.equal(f.settings.resolveConfig().apiKey, GPT_KEY);
  assert.equal(f.settings.get().models.plan, 'custom-model');
});

test('invalid providers, models, keys and extra fields cannot alter backend files', t => {
  const f = fixture(t, { text: '# unchanged\n' });
  for (const input of [null, [], { provider: 'other' }, { apiKey: 12 }, { apiKey: 'short' },
    { apiKey: 'valid-key\nOPENAI_API_KEY=escape' }, { apiKey: 'quoted-key"inject' },
    { models: { plan: 'gpt-6-luna', triage: 'bad\nMODEL=x' } }, { models: { plan: 'gpt-6-luna' } },
    { models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna', budget: 999 } }, { path: '/arbitrary', apiKey: GPT_KEY },
    { apiKey: GPT_KEY, forgetKey: true }, { forgetKey: 'yes' }]) {
    assert.throws(() => f.settings.save(input));
    assert.equal(f.read(), '# unchanged\n');
  }
});

test('atomic write failure preserves the prior file and cleans only its own temporary file', t => {
  const f = fixture(t, { text: `ANTHROPIC_API_KEY=${CLAUDE_KEY}\n` });
  const settings = createBackendSettings({ ...f.args, fileSystem: { ...fs, renameSync() { throw new Error('raw secret disk error'); } } });
  assert.throws(() => settings.save({ provider: 'openai', apiKey: GPT_KEY }), error => /저장하지 못/.test(error.message) && !/raw secret/.test(error.message));
  assert.equal(f.read(), `ANTHROPIC_API_KEY=${CLAUDE_KEY}\n`);
  assert.deepEqual(fs.readdirSync(f.backendRoot), ['.env']);
});

test('concurrent .env edits are not overwritten by an older settings snapshot', t => {
  const f = fixture(t, { text: '# original\n' });
  const settings = createBackendSettings({ ...f.args, fileSystem: { ...fs, writeFileSync(...args) {
    fs.writeFileSync(...args);
    fs.writeFileSync(f.filename, '# concurrent change\n');
  } } });
  assert.throws(() => settings.save({ provider: 'openai', apiKey: GPT_KEY }), /저장하지 못/);
  assert.equal(f.read(), '# concurrent change\n');
  assert.deepEqual(fs.readdirSync(f.backendRoot), ['.env']);
});

test('non-file, oversized and redirected .env paths fail without reading or overwriting them', t => {
  const f = fixture(t);
  fs.mkdirSync(f.filename);
  assert.throws(() => f.settings.get(), /안전하게 읽을 수/);
  assert.throws(() => f.settings.save({ apiKey: CLAUDE_KEY }), /안전하게 읽을 수/);
  fs.rmdirSync(f.filename);
  fs.writeFileSync(f.filename, 'x'.repeat(65 * 1024));
  assert.throws(() => f.settings.get(), /안전하게 읽을 수/);
  let read = false;
  const linked = createBackendSettings({ ...f.args, fileSystem: { ...fs,
    lstatSync(filename) { const stat = fs.lstatSync(filename); if (filename === f.filename) stat.isSymbolicLink = () => true; return stat; },
    readFileSync() { read = true; throw new Error('must not read target'); },
  } });
  assert.throws(() => linked.get(), /안전하게 읽을 수/);
  assert.equal(read, false);
});
