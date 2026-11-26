const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_PROVIDER = 'openai';
const PROVIDERS = Object.freeze(['openai', 'anthropic']);
const DEFAULT_MODELS = Object.freeze({ openai: 'gpt-6-luna', anthropic: 'claude-haiku-5-5' });
// Retained for existing OpenAI callers and v1 settings migration.
const DEFAULT_MODEL = DEFAULT_MODELS.openai;

function validateProvider(value) {
  if (!PROVIDERS.includes(value)) throw new Error('GPT 또는 Claude를 선택해 주세요.');
  return value;
}

function validateModel(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error('올바른 모델 이름을 선택해 주세요.');
  }
  return value;
}

function validateKey(value, provider = DEFAULT_PROVIDER) {
  validateProvider(provider);
  if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 1024 || /\s/.test(value.trim())) {
    throw new Error(`올바른 ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API 키를 입력해 주세요.`);
  }
  return value.trim();
}

function monthKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

function freshUsage(month) {
  return { month, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, untrackedRequests: 0 };
}

function validUsage(value, month) {
  if (!value || value.month !== month) return false;
  return ['inputTokens', 'outputTokens', 'totalTokens', 'requests', 'untrackedRequests'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function copyUsage(value) {
  return { month: value.month, inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    totalTokens: value.totalTokens, requests: value.requests, untrackedRequests: value.untrackedRequests };
}

function readProfile(value, provider) {
  const profile = { model: DEFAULT_MODELS[provider], encryptedKey: '', usageByMonth: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return profile;
  try { profile.model = validateModel(value.model); } catch { /* Keep this provider's default model. */ }
  if (typeof value.encryptedKey === 'string') profile.encryptedKey = value.encryptedKey;
  if (value.usageByMonth && typeof value.usageByMonth === 'object' && !Array.isArray(value.usageByMonth)) {
    for (const [month, usage] of Object.entries(value.usageByMonth)) {
      if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) && validUsage(usage, month)) profile.usageByMonth[month] = copyUsage(usage);
    }
  }
  return profile;
}

function createAiSettings({ directory, safeStorage, now = () => new Date(), fileSystem = fs }) {
  const filename = path.join(directory, 'ai-settings.json');
  let state = { version: 2, provider: DEFAULT_PROVIDER,
    profiles: { openai: readProfile(undefined, 'openai'), anthropic: readProfile(undefined, 'anthropic') } };
  const apiKeys = { openai: '', anthropic: '' };
  const keyStorage = { openai: 'session', anthropic: 'session' };
  try {
    const saved = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    if (saved && saved.version === 1) {
      // The old key/model/usage belong only to OpenAI. Loading does not rewrite
      // the file; the next explicit save or usage update atomically writes v2.
      state.profiles.openai = readProfile(saved, 'openai');
    } else if (saved && saved.version === 2) {
      try { state.provider = validateProvider(saved.provider); } catch { /* Keep OpenAI as the migration default. */ }
      for (const provider of PROVIDERS) state.profiles[provider] = readProfile(saved.profiles?.[provider], provider);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('저장된 AI 설정을 읽을 수 없습니다. 설정 파일을 확인해 주세요.');
  }

  function encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  const canEncrypt = encryptionAvailable();
  for (const provider of PROVIDERS) {
    keyStorage[provider] = canEncrypt ? 'encrypted' : 'session';
    if (state.profiles[provider].encryptedKey && canEncrypt) {
      try { apiKeys[provider] = validateKey(safeStorage.decryptString(Buffer.from(state.profiles[provider].encryptedKey, 'base64')), provider); }
      catch { /* Ask for this provider's key again if OS credentials changed. */ }
    }
  }

  function persist(next) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fileSystem.mkdirSync(directory, { recursive: true });
      fileSystem.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      fileSystem.renameSync(temporary, filename);
    } catch {
      try { fileSystem.unlinkSync(temporary); } catch { /* Best-effort cleanup of this write's temporary file. */ }
      throw new Error('AI 설정과 사용량을 저장할 수 없습니다. 저장 공간을 확인해 주세요.');
    }
  }

  function get(provider = state.provider) {
    validateProvider(provider);
    const month = monthKey(now());
    const profiles = Object.fromEntries(PROVIDERS.map(name => [name, {
      model: state.profiles[name].model,
      keyConfigured: Boolean(apiKeys[name]),
      keyHint: apiKeys[name] ? `•••• ${apiKeys[name].slice(-4)}` : '',
      storage: keyStorage[name],
      usage: copyUsage(state.profiles[name].usageByMonth[month] ?? freshUsage(month)),
    }]));
    return { provider, ...profiles[provider], profiles };
  }

  function save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('올바른 AI 설정이 필요합니다.');
    if (input.forgetKey !== undefined && typeof input.forgetKey !== 'boolean') throw new Error('키 삭제 설정이 올바르지 않습니다.');
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('올바른 API 키를 입력해 주세요.');
    const provider = input.provider === undefined ? state.provider : validateProvider(input.provider);
    const profile = { ...state.profiles[provider], model: validateModel(input.model ?? state.profiles[provider].model) };
    const next = { ...state, provider, profiles: { ...state.profiles, [provider]: profile } };
    let nextKey = apiKeys[provider];
    let nextStorage = keyStorage[provider];
    if (input.forgetKey) {
      nextKey = '';
      profile.encryptedKey = '';
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      nextKey = validateKey(input.apiKey, provider);
      profile.encryptedKey = '';
      nextStorage = 'session';
      if (encryptionAvailable()) {
        try {
          profile.encryptedKey = safeStorage.encryptString(nextKey).toString('base64');
          nextStorage = 'encrypted';
        } catch { /* Never persist plaintext if secure storage stops working. */ }
      }
    }
    persist(next);
    state = next;
    apiKeys[provider] = nextKey;
    keyStorage[provider] = nextStorage;
    return get();
  }

  function recordUsage(usage, requestedAt = now(), provider = state.provider) {
    validateProvider(provider);
    if (usage !== undefined && (!usage || ['inputTokens', 'outputTokens', 'totalTokens'].some(key => !Number.isSafeInteger(usage[key]) || usage[key] < 0))) {
      throw new Error('모델 사용량 형식이 올바르지 않습니다.');
    }
    const month = monthKey(requestedAt);
    const profile = state.profiles[provider];
    const previous = profile.usageByMonth[month] ?? freshUsage(month);
    const current = { ...previous, requests: previous.requests + 1 };
    if (usage) {
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.totalTokens += usage.totalTokens;
    } else current.untrackedRequests += 1;
    if (!validUsage(current, month)) throw new Error('모델 사용량을 안전한 범위에서 저장할 수 없습니다.');
    const next = { ...state, profiles: { ...state.profiles,
      [provider]: { ...profile, usageByMonth: { ...profile.usageByMonth, [month]: current } } } };
    state = next;
    persist(next);
    return get();
  }

  return { get, save, recordUsage, getKey: (provider = state.provider) => apiKeys[validateProvider(provider)] };
}

module.exports = { createAiSettings, DEFAULT_PROVIDER, DEFAULT_MODELS, DEFAULT_MODEL, validateProvider, validateModel, validateKey, monthKey };
