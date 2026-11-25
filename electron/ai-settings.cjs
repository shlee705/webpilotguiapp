const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_MODEL = 'gpt-6-luna';

function validateModel(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error('올바른 모델 이름을 선택해 주세요.');
  }
  return value;
}

function validateKey(value) {
  if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 1024 || /\s/.test(value.trim())) {
    throw new Error('올바른 OpenAI API 키를 입력해 주세요.');
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

function createAiSettings({ directory, safeStorage, now = () => new Date(), fileSystem = fs }) {
  const filename = path.join(directory, 'ai-settings.json');
  let state = { version: 1, model: DEFAULT_MODEL, encryptedKey: '', usageByMonth: {} };
  let apiKey = '';
  let keyStorage;
  try {
    const saved = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    if (saved && saved.version === 1) {
      try { state.model = validateModel(saved.model); } catch { /* Keep the default model. */ }
      if (typeof saved.encryptedKey === 'string') state.encryptedKey = saved.encryptedKey;
      if (saved.usageByMonth && typeof saved.usageByMonth === 'object') {
        for (const [month, usage] of Object.entries(saved.usageByMonth)) {
          if (/^\d{4}-\d{2}$/.test(month) && validUsage(usage, month)) state.usageByMonth[month] = usage;
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('저장된 AI 설정을 읽을 수 없습니다. 설정 파일을 확인해 주세요.');
  }

  function encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  if (state.encryptedKey && encryptionAvailable()) {
    try { apiKey = safeStorage.decryptString(Buffer.from(state.encryptedKey, 'base64')); } catch { /* Ask for a key again if OS credentials changed. */ }
  }
  keyStorage = encryptionAvailable() ? 'encrypted' : 'session';

  function persist(next) {
    fileSystem.mkdirSync(directory, { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      fileSystem.renameSync(temporary, filename);
    } catch {
      try { fileSystem.unlinkSync(temporary); } catch { /* Best-effort cleanup of this write's temporary file. */ }
      throw new Error('AI 설정과 사용량을 저장할 수 없습니다. 저장 공간을 확인해 주세요.');
    }
  }

  function get() {
    const month = monthKey(now());
    return {
      model: state.model,
      keyConfigured: Boolean(apiKey),
      keyHint: apiKey ? `•••• ${apiKey.slice(-4)}` : '',
      storage: keyStorage,
      usage: { ...(state.usageByMonth[month] ?? freshUsage(month)) },
    };
  }

  function save(input) {
    if (!input || typeof input !== 'object') throw new Error('올바른 AI 설정이 필요합니다.');
    const next = { ...state, model: validateModel(input.model ?? state.model) };
    let nextKey = apiKey;
    let nextStorage = keyStorage;
    if (input.forgetKey) {
      nextKey = '';
      next.encryptedKey = '';
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      nextKey = validateKey(input.apiKey);
      next.encryptedKey = '';
      nextStorage = 'session';
      if (encryptionAvailable()) {
        try {
          next.encryptedKey = safeStorage.encryptString(nextKey).toString('base64');
          nextStorage = 'encrypted';
        } catch { /* Never persist plaintext if secure storage stops working. */ }
      }
    }
    persist(next);
    state = next;
    apiKey = nextKey;
    keyStorage = nextStorage;
    return get();
  }

  function recordUsage(usage, requestedAt = now()) {
    const month = monthKey(requestedAt);
    const previous = state.usageByMonth[month] ?? freshUsage(month);
    const current = { ...previous, requests: previous.requests + 1 };
    if (usage) {
      current.inputTokens += usage.inputTokens;
      current.outputTokens += usage.outputTokens;
      current.totalTokens += usage.totalTokens;
    } else current.untrackedRequests += 1;
    const next = { ...state, usageByMonth: { ...state.usageByMonth, [month]: current } };
    state = next;
    persist(next);
    return get();
  }

  return { get, save, recordUsage, getKey: () => apiKey };
}

module.exports = { createAiSettings, DEFAULT_MODEL, validateModel, validateKey, monthKey };
