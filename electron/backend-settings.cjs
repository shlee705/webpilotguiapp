'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const BACKEND_PROVIDERS = Object.freeze(['openai', 'anthropic']);
const BACKEND_DEFAULT_MODELS = Object.freeze({
  anthropic: Object.freeze({ plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' }),
  openai: Object.freeze({ plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' }),
});
const BACKEND_KEY_NAMES = Object.freeze({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' });
const BACKEND_RUN_DEFAULT_VARIABLES = Object.freeze({
  budgetUsd: 'WEBPILOT_BACKEND_BUDGET_USD', exploreMinutes: 'WEBPILOT_BACKEND_EXPLORE_MINUTES',
  maxPages: 'WEBPILOT_BACKEND_MAX_PAGES', maxTemplates: 'WEBPILOT_BACKEND_MAX_TEMPLATES',
  turnsPerTemplate: 'WEBPILOT_BACKEND_TURNS_PER_TEMPLATE', maxTurns: 'WEBPILOT_BACKEND_MAX_TURNS',
  pagesPerTemplate: 'WEBPILOT_BACKEND_PAGES_PER_TEMPLATE', concurrency: 'WEBPILOT_BACKEND_CONCURRENCY',
  workers: 'WEBPILOT_BACKEND_WORKERS', planEffort: 'WEBPILOT_BACKEND_PLAN_EFFORT', sessions: 'WEBPILOT_BACKEND_SESSIONS',
});
const MAX_ENV_BYTES = 64 * 1024;

function validateRunDefaults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(name => !Object.hasOwn(BACKEND_RUN_DEFAULT_VARIABLES, name))) {
    throw new Error('백엔드 검사 기본값에는 허용된 예산·시간·페이지·턴·동시 실행 옵션만 저장할 수 있습니다.');
  }
  // Run options also import provider/model validators from this module. Load
  // them after initialization to keep one validation contract without a cycle.
  return require('./backend-run-options.cjs').validateBackendRunOptions(value);
}
function readRunDefaults(values) {
  const defaults = {};
  for (const [field, variable] of Object.entries(BACKEND_RUN_DEFAULT_VARIABLES)) {
    if (!Object.hasOwn(values, variable)) continue;
    defaults[field] = ['planEffort', 'sessions'].includes(field) ? values[variable] : Number(values[variable]);
    try { validateRunDefaults({ [field]: defaults[field] }); }
    catch { throw new Error(`백엔드 .env의 ${variable} 검사 기본값이 올바르지 않습니다. 해당 값을 수정하거나 삭제해 주세요.`); }
  }
  return validateRunDefaults(defaults);
}

function validateBackendProvider(value) {
  if (!BACKEND_PROVIDERS.includes(value)) throw new Error('실제 검사 백엔드의 GPT 또는 Claude를 선택해 주세요.');
  return value;
}
function validateBackendModel(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error('올바른 백엔드 모델 ID를 입력해 주세요.');
  return value;
}
function validateBackendKey(value) {
  // .env values must stay on one line and cannot introduce quotes or comments.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{10,1024}$/.test(value.trim())) throw new Error('올바른 백엔드 전용 API 키를 입력해 주세요.');
  return value.trim();
}
function parseBackendEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => /^\s*[A-Z_]+=/.test(line)).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, '')];
  }));
}
function modelVariable(provider, role) { return `WEBPILOT_BACKEND_${provider.toUpperCase()}_${role.toUpperCase()}_MODEL`; }

/** Only the backend's .env is read or written; Computer Use settings are never consulted. */
function createBackendSettings({ backendRoot, environment = process.env, fileSystem = fs }) {
  if (!path.isAbsolute(backendRoot || '')) throw new Error('백엔드 설정 폴더에는 절대 경로가 필요합니다.');
  const filename = path.join(backendRoot, '.env');
  function readSnapshot() {
    try {
      const root = fileSystem.lstatSync(backendRoot);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('invalid backend root');
      let stat;
      try { stat = fileSystem.lstatSync(filename); } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, text: '', values: {} };
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ENV_BYTES) throw new Error('invalid env file');
      // Open the observed file, not a later path replacement. O_NOFOLLOW is an
      // extra defense where supported; identity checks also apply on Windows.
      const handle = fileSystem.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const before = fileSystem.fstatSync(handle);
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw new Error('env replaced');
        const text = fileSystem.readFileSync(handle, 'utf8');
        const after = fileSystem.fstatSync(handle);
        const current = fileSystem.lstatSync(filename);
        if (Buffer.byteLength(text) > MAX_ENV_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs
          || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) throw new Error('env changed');
        return { exists: true, text, values: parseBackendEnv(text) };
      } finally { fileSystem.closeSync(handle); }
    } catch { throw new Error('백엔드 .env 설정을 안전하게 읽을 수 없습니다. 일반 파일인지와 파일 크기·권한을 확인해 주세요.'); }
  }
  function readConfiguration(snapshot = readSnapshot()) {
    const provider = validateBackendProvider(snapshot.values.WEBPILOT_BACKEND_PROVIDER || 'anthropic');
    const profiles = Object.fromEntries(BACKEND_PROVIDERS.map(name => {
      const models = Object.fromEntries(['plan', 'triage'].map(role => [role,
        validateBackendModel(snapshot.values[modelVariable(name, role)] || BACKEND_DEFAULT_MODELS[name][role]) ]));
      const savedKey = (snapshot.values[BACKEND_KEY_NAMES[name]] || '').trim();
      const external = environment[BACKEND_KEY_NAMES[name]];
      const environmentKey = typeof external === 'string' ? external.trim() : '';
      const apiKey = environmentKey || savedKey;
      return [name, { models, apiKey, savedKey, source: environmentKey ? 'environment' : savedKey ? 'file' : 'none' }];
    }));
    return { provider, profiles };
  }
  function get() {
    const snapshot = readSnapshot();
    const { provider, profiles: privateProfiles } = readConfiguration(snapshot);
    const runDefaults = readRunDefaults(snapshot.values);
    const profiles = Object.fromEntries(BACKEND_PROVIDERS.map(name => {
      const item = privateProfiles[name];
      return [name, { models: { ...item.models }, keyConfigured: Boolean(item.apiKey), savedKeyConfigured: Boolean(item.savedKey),
        keyHint: item.savedKey ? `•••• ${item.savedKey.slice(-4)}` : '', storage: 'env-file', source: item.source }];
    }));
    return { provider, ...profiles[provider], profiles, runDefaults: { ...runDefaults } };
  }
  function save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(name => !['provider', 'models', 'apiKey', 'forgetKey', 'runDefaults'].includes(name))) throw new Error('올바른 백엔드 전용 설정이 필요합니다.');
    if (input.forgetKey !== undefined && typeof input.forgetKey !== 'boolean') throw new Error('백엔드 키 삭제 설정이 올바르지 않습니다.');
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('올바른 백엔드 전용 API 키를 입력해 주세요.');
    if (input.forgetKey && input.apiKey?.trim()) throw new Error('백엔드 키 저장과 삭제를 동시에 요청할 수 없습니다.');
    const snapshot = readSnapshot();
    const provider = validateBackendProvider(input.provider ?? snapshot.values.WEBPILOT_BACKEND_PROVIDER ?? 'anthropic');
    const updates = { WEBPILOT_BACKEND_PROVIDER: provider };
    if (input.runDefaults !== undefined) {
      const runDefaults = validateRunDefaults(input.runDefaults);
      for (const [field, variable] of Object.entries(BACKEND_RUN_DEFAULT_VARIABLES)) updates[variable] = String(runDefaults[field]);
    } else {
      // Reject an already-invalid snapshot before changing keys/models. A save
      // with explicit defaults can still repair it atomically.
      readRunDefaults(snapshot.values);
    }
    if (input.models !== undefined) {
      if (!input.models || typeof input.models !== 'object' || Array.isArray(input.models)
        || Object.keys(input.models).some(role => !['plan', 'triage'].includes(role))) throw new Error('백엔드 계획·분류 모델 설정이 올바르지 않습니다.');
      for (const role of ['plan', 'triage']) updates[modelVariable(provider, role)] = validateBackendModel(input.models[role]);
    }
    if (input.forgetKey) updates[BACKEND_KEY_NAMES[provider]] = null;
    else if (input.apiKey?.trim()) updates[BACKEND_KEY_NAMES[provider]] = validateBackendKey(input.apiKey);
    const chunks = snapshot.text.split(/(\r\n|\n|\r)/);
    const written = new Set();
    for (let index = 0; index < chunks.length; index += 2) {
      const match = /^\s*([A-Z_]+)=/.exec(chunks[index]);
      const name = match?.[1];
      if (!name || !Object.hasOwn(updates, name)) continue;
      chunks[index] = updates[name] === null || written.has(name) ? '' : `${name}=${updates[name]}`;
      written.add(name);
    }
    let text = chunks.join('');
    const newline = snapshot.text.includes('\r\n') ? '\r\n' : '\n';
    for (const [name, value] of Object.entries(updates)) {
      if (written.has(name) || value === null) continue;
      if (text && !/[\r\n]$/.test(text)) text += newline;
      text += `${name}=${value}${newline}`;
    }
    if (Buffer.byteLength(text) > MAX_ENV_BYTES) throw new Error('백엔드 .env 설정 파일이 너무 큽니다.');
    const temporary = path.join(backendRoot, `.env.${randomUUID()}.tmp`);
    try {
      fileSystem.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const latest = readSnapshot();
      if (latest.exists !== snapshot.exists || latest.text !== snapshot.text) throw new Error('env changed');
      fileSystem.renameSync(temporary, filename);
    } catch {
      try { fileSystem.unlinkSync(temporary); } catch { /* Only this attempted write's temporary file is removed. */ }
      throw new Error('백엔드 .env 설정을 저장하지 못했습니다. 파일 변경 여부와 저장 권한을 확인해 주세요.');
    }
    return get();
  }
  function resolveConfig(requestedProvider) {
    const { provider: selected, profiles } = readConfiguration();
    const provider = requestedProvider === undefined ? selected : validateBackendProvider(requestedProvider);
    const current = profiles[provider];
    return Object.freeze({ provider, models: Object.freeze({ ...current.models }), apiKey: current.apiKey });
  }
  return { get, save, resolveConfig, resolveKey: provider => resolveConfig(provider).apiKey, getKey: provider => resolveConfig(provider).apiKey };
}

module.exports = { createBackendSettings, validateBackendKey, validateBackendModel, validateBackendProvider,
  parseBackendEnv, BACKEND_DEFAULT_MODELS, BACKEND_KEY_NAMES, BACKEND_RUN_DEFAULT_VARIABLES };
