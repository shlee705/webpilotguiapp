import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, createMessage, loadConversations, saveConversations } from '../src/lib/storage';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

test('preserves conversations and marks interrupted streams cancelled on restore', () => {
  const conversation = createConversation('테스트');
  conversation.messages.push({ ...createMessage('assistant', 'partial'), status: 'streaming' });
  assert.equal(saveConversations([conversation]), true);
  const restored = loadConversations();
  assert.equal(restored[0].messages[0].content, 'partial');
  assert.equal(restored[0].messages[0].status, 'cancelled');
  assert.equal(restored[0].id, conversation.id);
});

test('ignores corrupt JSON and invalid records without losing valid history', () => {
  values.set('webpilot.conversations.v1', '{bad');
  assert.deepEqual(loadConversations(), []);
  const valid = createConversation('valid');
  values.set('webpilot.conversations.v1', JSON.stringify([null, {}, valid, valid, { ...valid, id: 'invalid', updatedAt: 'bad' }]));
  assert.equal(loadConversations().length, 1);
});

test('reports storage write failure to UI and falls back safely when reading is blocked', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  assert.equal(saveConversations([]), false);
  assert.deepEqual(loadConversations(), []);
});

test('preserves actual model and token usage and labels older assistant history legacy', () => {
  const conversation = createConversation('AI');
  conversation.messages = [
    { ...createMessage('assistant', 'old preview') },
    { ...createMessage('assistant', 'API output'), source: 'openai', model: 'gpt-6.2-sol', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
    createMessage('user', 'question'),
  ];
  saveConversations([conversation]);
  const messages = loadConversations()[0].messages;
  assert.equal(messages[0].content, 'old preview');
  assert.equal(messages[0].source, 'legacy');
  assert.equal(messages[1].source, 'openai');
  assert.equal(messages[1].model, 'gpt-6.2-sol');
  assert.deepEqual(messages[1].usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  assert.equal(messages[2].source, undefined);
});

test('drops invalid token metadata without discarding message text', () => {
  const conversation = createConversation('AI');
  const message = createMessage('assistant', 'preserved');
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages: [
    { ...message, model: 'gpt-6.2-sol', usage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 } },
    { ...message, id: 'second', model: 42, source: 'openai', usage: { inputTokens: 1.5, outputTokens: 2, totalTokens: 3.5 } },
  ] }]));
  const messages = loadConversations()[0].messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].usage, undefined);
  assert.equal(messages[1].usage, undefined);
  assert.equal(messages[1].model, undefined);
  assert.equal(messages[1].source, 'legacy');
});

test('persists browser launch result and restores interrupted launches as errors', () => {
  const conversation = createConversation('Edge');
  conversation.messages = [
    { ...createMessage('user', 'first'), browserAction: { url: 'https://example.com/', status: 'opened' } },
    { ...createMessage('user', 'second'), browserAction: { url: 'http://localhost:3000/', status: 'opening' } },
  ];
  saveConversations([conversation]);
  const messages = loadConversations()[0].messages;
  assert.deepEqual(messages[0].browserAction, { url: 'https://example.com/', status: 'opened' });
  assert.equal(messages[1].browserAction?.status, 'error');
  assert.match(messages[1].browserAction?.error ?? '', /앱이 종료/);
});

test('drops malformed or non-web browser actions while retaining message history', () => {
  const conversation = createConversation('Edge');
  const message = createMessage('user', 'kept');
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages: [
    { ...message, browserAction: { url: 'javascript:alert(1)', status: 'opened' } },
    { ...message, id: 'second', browserAction: { url: 'https://example.com', status: 'invalid' } },
  ] }]));
  assert.equal(loadConversations()[0].messages.length, 2);
  assert.equal(loadConversations()[0].messages[0].browserAction, undefined);
  assert.equal(loadConversations()[0].messages[1].browserAction, undefined);
});

test('persists screenshot metadata without image data and rejects malformed captures', () => {
  const conversation = createConversation('Capture');
  const capture = { id: 'capture-1', url: 'https://example.com/', index: 1, createdAt: new Date().toISOString() };
  conversation.messages = [{ ...createMessage('assistant', 'Screenshot observed'), captures: [
    { ...capture, imageUrl: 'data:image/png;base64,SECRET_IMAGE_BYTES' } as typeof capture,
    { ...capture, id: 'invalid', url: 'data:image/png;base64,SECRET_IMAGE_BYTES' },
    { ...capture, id: 'invalid-index', index: -1 },
  ] }];
  saveConversations([conversation]);
  assert.deepEqual(loadConversations()[0].messages[0].captures, [capture]);
  assert.equal(values.get('webpilot.conversations.v1')?.includes('SECRET_IMAGE_BYTES'), false);
});

test('preserves a pending local tour plan and defaults an omitted action limit to five', () => {
  const conversation = createConversation('Plan');
  const message = { ...createMessage('assistant', '사이트 탐색 계획'), source: 'local' };
  const plan = { targetUrl: 'https://example.com', prompt: '메뉴를 살펴봐 줘', model: 'gpt-6-luna', state: 'pending' };
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages: [{ ...message, plan }] }]));
  const restored = loadConversations()[0].messages[0];
  assert.equal(restored.source, 'local');
  assert.equal(restored.model, undefined);
  assert.deepEqual(restored.plan, { ...plan, targetUrl: 'https://example.com/', maxActions: 5 });
  assert.equal(restored.status, 'complete');
});

test('saving keeps a running plan active, but restarting restores it as cancelled with partial activity', () => {
  const conversation = createConversation('Interrupted plan');
  conversation.messages = [{
    ...createMessage('assistant', '계획 실행 중'), source: 'local',
    plan: { targetUrl: 'http://localhost:3000/', prompt: '메뉴 탐색', model: 'gpt-6-luna', maxActions: 3, state: 'running' },
    activity: { phase: 'finalizing', visitedCount: 4, actionCount: 3, url: 'http://localhost:3000/page' },
  }];
  saveConversations([conversation]);
  assert.equal(JSON.parse(values.get('webpilot.conversations.v1')!)[0].messages[0].plan.state, 'running');
  const restored = loadConversations()[0].messages[0];
  assert.equal(restored.plan?.state, 'cancelled');
  assert.equal(restored.status, 'cancelled');
  assert.deepEqual(restored.activity, conversation.messages[0].activity);
});

test('completed plan, completed activity and screenshot metadata survive together', () => {
  const conversation = createConversation('Completed plan');
  conversation.messages = [{
    ...createMessage('assistant', '탐색 완료'), source: 'openai', model: 'gpt-6-luna',
    plan: { targetUrl: 'https://example.com/', prompt: '메뉴 탐색', model: 'gpt-6-luna', maxActions: 5, state: 'complete' },
    activity: { phase: 'complete', visitedCount: 6, actionCount: 5, url: 'https://example.com/page' },
    captures: [{ id: 'capture-finished', index: 6, url: 'https://example.com/page', createdAt: new Date().toISOString() }],
  }];
  saveConversations([conversation]);
  assert.deepEqual(loadConversations()[0].messages[0], conversation.messages[0]);
});

test('rejects malformed plan URL, state, model and action limit without losing history', () => {
  const conversation = createConversation('Invalid plans');
  const validPlan = { targetUrl: 'https://example.com/', prompt: '메뉴 탐색', model: 'gpt-6-luna', maxActions: 5, state: 'pending' };
  const invalidParts = [
    { targetUrl: 'javascript:alert(1)' }, { targetUrl: 'https://user:pass@example.com/' }, { targetUrl: 'https://example.com/\npath' },
    { state: 'unknown' }, { model: ' ' }, { model: 'model name' }, { maxActions: 0 }, { maxActions: Number.MAX_SAFE_INTEGER + 1 }, { maxActions: -1 }, { maxActions: 1.5 }, { prompt: '' },
  ];
  const messages = invalidParts.map((part, index) => ({ ...createMessage('assistant', `preserved ${index}`), source: 'local', plan: { ...validPlan, ...part } }));
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages }]));
  const restored = loadConversations()[0].messages;
  assert.equal(restored.length, invalidParts.length);
  restored.forEach((message, index) => { assert.equal(message.plan, undefined); assert.equal(message.content, `preserved ${index}`); assert.equal(message.source, 'local'); });
});

test('rejects malformed activity counts, phase and URL while preserving the message', () => {
  const conversation = createConversation('Invalid activity');
  const activity = { phase: 'reading', visitedCount: 1, actionCount: 0, url: 'https://example.com/' };
  const invalidParts = [{ phase: 'unknown' }, { visitedCount: -1 }, { actionCount: 1.5 }, { visitedCount: '1' }, { url: 'data:image/png;base64,abc' }];
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages: invalidParts.map(part => ({ ...createMessage('assistant', 'preserved'), activity: { ...activity, ...part } })) }]));
  const messages = loadConversations()[0].messages;
  assert.equal(messages.length, invalidParts.length);
  messages.forEach(message => assert.equal(message.activity, undefined));
});

test('migrates legacy capture activity without presenting captures as visited pages', () => {
  const conversation = createConversation('Legacy');
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages: [{ ...createMessage('assistant', 'preserved'), activity: { phase: 'capturing', captureCount: 6, actionCount: 5, url: 'https://example.com/' } }] }]));
  assert.deepEqual(loadConversations()[0].messages[0].activity, { phase: 'reading', visitedCount: 0, actionCount: 5, url: 'https://example.com/' });
});

test('credential objects and assigned secrets are never persisted in messages or plans', () => {
  const conversation = createConversation('Login account-744 secret-388');
  const credentials = { username: 'account-744', password: 'secret-388' };
  const prompt = '로그인해 줘\nid: account-744\npassword: secret-388';
  conversation.messages = [{
    ...createMessage('assistant', prompt), source: 'local', credentials,
    plan: { targetUrl: 'https://example.com/', prompt, model: 'gpt-6-luna', maxActions: 5, state: 'pending', loginEnabled: true, credentials },
  } as any];
  (conversation as any).credentials = credentials;
  saveConversations([conversation]);
  const raw = values.get('webpilot.conversations.v1')!;
  assert.equal(raw.includes('secret-388'), false);
  assert.equal(raw.includes('account-744'), false);
  assert.equal(raw.includes('"credentials"'), false);
  const restored = loadConversations()[0].messages[0];
  assert.equal(restored.plan?.loginEnabled, true);
  assert.equal(restored.source, 'local');
});

test('restored contaminated history is sanitized and loginEnabled accepts booleans only', () => {
  const conversation = createConversation('Login');
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages: [
    { ...createMessage('user', '비밀번호: partial-secret-811') },
    { ...createMessage('assistant', 'plan'), source: 'local', plan: { targetUrl: 'https://example.com/', prompt: 'id: account-744\npassword: full-secret-922', model: 'gpt-6-luna', maxActions: 5, state: 'pending', loginEnabled: 'yes' } },
  ] }]));
  const restored = loadConversations();
  assert.equal(JSON.stringify(restored).includes('partial-secret-811'), false);
  assert.equal(JSON.stringify(restored).includes('full-secret-922'), false);
  assert.equal(restored[0].messages[1].plan?.loginEnabled, undefined);
});

test('persists action limits above five without truncation and rejects unsafe precision', () => {
  for (const maxActions of [6, 1000, Number.MAX_SAFE_INTEGER]) {
    const conversation = createConversation('Large limit');
    conversation.messages = [{ ...createMessage('assistant', '버그 탐색 계획'), source: 'local', plan: { targetUrl: 'https://example.com/', prompt: '버그를 탐색해 줘', model: 'gpt-6-luna', maxActions, state: 'pending' } }];
    saveConversations([conversation]);
    assert.equal(loadConversations()[0].messages[0].plan?.maxActions, maxActions);
  }
});

test('round-trips report states and strips paths or binary fields from persisted metadata', () => {
  const conversation = createConversation('Report');
  const ready = { status: 'ready' as const, id: 'c1f75f37-1698-45de-82cf-df6c8b4c0fd5', name: 'report.pdf' as const, size: 2841, updatedAt: '2026-11-25T12:00:00.000Z' };
  conversation.messages = [
    { ...createMessage('assistant', '버그 탐색 완료'), model: 'gpt-6-luna', source: 'openai', report: { ...ready, path: 'C:/private/report.pdf', bytes: 'SECRET_PDF_BYTES' } as typeof ready },
    { ...createMessage('assistant', '보고서 대기'), report: { status: 'missing', message: '아직 report.pdf가 없습니다.' } },
    { ...createMessage('assistant', '보고서 오류'), report: { status: 'error', message: '보고서를 읽지 못했습니다.' } },
  ];
  saveConversations([conversation]);
  const restored = loadConversations()[0].messages;
  assert.deepEqual(restored[0].report, ready);
  assert.deepEqual(restored[1].report, conversation.messages[1].report);
  assert.deepEqual(restored[2].report, conversation.messages[2].report);
  assert.equal(values.get('webpilot.conversations.v1')?.includes('C:/private'), false);
  assert.equal(values.get('webpilot.conversations.v1')?.includes('SECRET_PDF_BYTES'), false);
});

test('drops malformed report metadata without losing its conversation message', () => {
  const conversation = createConversation('Invalid report');
  const report = { status: 'ready', id: 'c1f75f37-1698-45de-82cf-df6c8b4c0fd5', name: 'report.pdf', size: 1000, updatedAt: '2026-11-25T12:00:00.000Z' };
  const malformed = [{ id: '../report.pdf' }, { name: 'other.pdf' }, { size: 0 }, { size: -1 }, { size: 2.5 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { updatedAt: '2026-11-25' }];
  values.set('webpilot.conversations.v1', JSON.stringify([{ ...conversation, messages: malformed.map(patch => ({ ...createMessage('assistant', 'kept'), report: { ...report, ...patch } })) }]));
  const messages = loadConversations()[0].messages;
  assert.equal(messages.length, malformed.length);
  assert.equal(messages.every(message => message.report === undefined && message.content === 'kept'), true);
});
