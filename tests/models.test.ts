import test from 'node:test';
import assert from 'node:assert/strict';
import { profileForProvider } from '../src/lib/models';
import type { AiSettings } from '../src/types';

test('legacy settings belong only to OpenAI and never supply a Claude key status', () => {
  const legacy: AiSettings = { model: 'gpt-6-luna', keyConfigured: true, keyHint: '••••old', storage: 'encrypted', usage: { month: '2026-11', inputTokens: 100, outputTokens: 20, totalTokens: 120, requests: 1, untrackedRequests: 0 } };
  assert.equal(profileForProvider(legacy, 'openai'), legacy);
  assert.equal(profileForProvider(legacy, 'anthropic'), undefined);
  const claude = { ...legacy, model: 'claude-haiku-5-5', keyConfigured: false, keyHint: '' };
  const settings: AiSettings = { ...legacy, provider: 'openai', profiles: { openai: legacy, anthropic: claude } };
  assert.equal(profileForProvider(settings, 'anthropic'), claude);
  assert.equal(profileForProvider(settings, 'anthropic')?.keyConfigured, false);
  assert.equal(profileForProvider({ ...settings, ...claude, provider: 'anthropic' }, 'openai'), legacy);
});
