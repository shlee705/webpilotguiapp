import type { AgentActivity, AgentStep, BrowserAction, Capture, ChatMessage, Conversation, Finding, LoginCredentials, MessageRole, TokenUsage, TourPlan } from '../types';
import { parsePromptCredentials, redactKnownCredentials } from './credentials';
import { parseReportResult } from './reports';
import { parseInspection } from './inspection';
import { normalizeBackendLoginUrl, normalizeBackendOptions } from './backend-options';

const CONVERSATIONS_KEY = 'webpilot.conversations.v1';

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createConversation(title = '새 채팅'): Conversation {
  const now = new Date().toISOString();
  return { id: newId(), title, createdAt: now, updatedAt: now, messages: [] };
}

export function createMessage(role: MessageRole, content = ''): ChatMessage {
  return { id: newId(), role, content, createdAt: new Date().toISOString(), status: 'complete' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value);
}

function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16000 || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) return url.href;
  } catch { return; }
}

function safeText(value: string, known: Partial<LoginCredentials>[] = []): string {
  return known.reduce((safe, credentials) => redactKnownCredentials(safe, credentials), parsePromptCredentials(value).text);
}

function knownCredentials(value: Record<string, unknown>): Partial<LoginCredentials>[] {
  const known: Partial<LoginCredentials>[] = [];
  const records = [value, ...(Array.isArray(value.messages) ? value.messages.filter(isObject) : [])];
  for (const record of records) {
    const plan = isObject(record.plan) ? record.plan : undefined;
    for (const credentials of [record.credentials, plan?.credentials]) {
      if (isObject(credentials)) known.push({
        ...(typeof credentials.username === 'string' ? { username: credentials.username } : {}),
        ...(typeof credentials.password === 'string' ? { password: credentials.password } : {}),
      });
    }
    for (const content of [record.content, record.title, plan?.prompt]) {
      if (typeof content !== 'string') continue;
      const parsed = parsePromptCredentials(content);
      if (parsed.credentials) known.push(parsed.credentials);
    }
  }
  return known;
}

function parsePlan(value: unknown, restoring = false, known: Partial<LoginCredentials>[] = []): TourPlan | undefined {
  if (!isObject(value)) return;
  const targetUrl = webUrl(value.targetUrl);
  if (!targetUrl || !validModel(value.model) || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000) return;
  if (value.provider !== undefined && value.provider !== 'openai' && value.provider !== 'anthropic') return;
  const state = value.state;
  if (state !== 'pending' && state !== 'running' && state !== 'complete' && state !== 'cancelled' && state !== 'error') return;
  let backendOptions;
  try { if (value.backendOptions !== undefined) backendOptions = normalizeBackendOptions(value.backendOptions); } catch { return; }
  let backendLoginUrl;
  try {
    const loginUrl = value.loginEnabled === true ? value.backendLoginUrl : undefined;
    for (const credentials of known) normalizeBackendLoginUrl(loginUrl, targetUrl, credentials);
    backendLoginUrl = normalizeBackendLoginUrl(loginUrl, targetUrl);
  } catch { return; }
  return { targetUrl, prompt: safeText(value.prompt, known), model: value.model, state: restoring && state === 'running' ? 'cancelled' : state,
    ...(backendOptions ? { backendOptions } : {}),
    ...(backendLoginUrl ? { backendLoginUrl } : {}),
    ...(value.provider ? { provider: value.provider } : {}),
    ...(typeof value.loginEnabled === 'boolean' ? { loginEnabled: value.loginEnabled } : {}) };
}

function parseActivity(value: unknown): AgentActivity | undefined {
  if (!isObject(value)) return;
  const legacy = value.phase === 'exploring' || value.phase === 'capturing' || (value.visitedCount === undefined && typeof value.captureCount === 'number');
  const phase = value.phase === 'exploring' || value.phase === 'capturing' ? 'reading' : value.phase;
  if (phase !== 'reading' && phase !== 'thinking' && phase !== 'acting' && phase !== 'finalizing' && phase !== 'complete') return;
  const url = webUrl(value.url);
  const visitedCount = value.visitedCount === undefined && legacy ? 0 : value.visitedCount;
  if (legacy && (!Number.isSafeInteger(value.captureCount) || (value.captureCount as number) < 0)) return;
  if (!url || ![visitedCount, value.actionCount].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return;
  return { phase, visitedCount: visitedCount as number, actionCount: value.actionCount as number, url,
    ...(typeof value.detail === 'string' ? { detail: safeText(value.detail) } : {}) };
}

function parseStep(value: unknown): AgentStep | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.label !== 'string') return;
  if (value.state !== 'running' && value.state !== 'complete') return;
  return { id: value.id, label: value.label, state: value.state };
}

export function parseFinding(value: unknown): Finding | undefined {
  if (!isObject(value) || typeof value.title !== 'string' || typeof value.description !== 'string') return;
  const severity = value.severity;
  if (severity !== 'critical' && severity !== 'high' && severity !== 'medium' && severity !== 'low' && severity !== 'info') return;
  return {
    id: typeof value.id === 'string' ? value.id : newId(),
    title: value.title,
    severity,
    description: value.description,
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
  };
}

function parseBrowserAction(value: unknown, restoring = true): BrowserAction | undefined {
  if (!isObject(value) || typeof value.url !== 'string') return;
  if (value.status !== 'opening' && value.status !== 'opened' && value.status !== 'error') return;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  } catch { return; }
  if (value.status === 'opening' && restoring) {
    return { url: value.url, status: 'error', error: '앱이 종료되어 브라우저 실행 결과를 확인하지 못했습니다. 다시 열어 주세요.' };
  }
  return { url: value.url, status: value.status, ...(typeof value.error === 'string' ? { error: value.error } : {}) };
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return;
  const counts = [value.inputTokens, value.outputTokens, value.totalTokens];
  if (!counts.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return;
  return { inputTokens: value.inputTokens as number, outputTokens: value.outputTokens as number, totalTokens: value.totalTokens as number };
}

function parseCapture(value: unknown): Capture | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.url !== 'string' || !isDate(value.createdAt)) return;
  if (typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0) return;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  } catch { return; }
  // Only metadata belongs in localStorage; image bytes remain in native capture files.
  return { id: value.id, url: value.url, index: value.index, createdAt: value.createdAt };
}

function parseCaptures(value: unknown): Capture[] | undefined {
  return Array.isArray(value) ? value.map(parseCapture).filter((capture): capture is Capture => !!capture) : undefined;
}

function parseMessage(value: unknown, restoring = true, known: Partial<LoginCredentials>[] = []): ChatMessage | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.content !== 'string' || !isDate(value.createdAt)) return;
  if (value.role !== 'user' && value.role !== 'assistant') return;
  const status = value.status;
  // A process restart cannot resume a stream; preserve its partial output honestly.
  const plan = parsePlan(value.plan, restoring, known);
  const interruptedPlan = plan && isObject(value.plan) && value.plan.state === 'running';
  const restoredStatus = restoring && (status === 'streaming' || interruptedPlan) ? 'cancelled' : status === 'complete' || status === 'error' || status === 'cancelled' || status === 'streaming' ? status : 'complete';
  const browserAction = parseBrowserAction(value.browserAction, restoring);
  const model = validModel(value.model) ? value.model : undefined;
  const usage = parseUsage(value.usage);
  const captures = parseCaptures(value.captures);
  const activity = parseActivity(value.activity);
  const report = parseReportResult(value.report);
  const inspection = parseInspection(value.inspection);
  // Previous demo messages remain available, but cannot be mistaken for API output.
  const provider = value.provider === 'anthropic' || value.source === 'anthropic' ? 'anthropic' : 'openai';
  const source = value.role === 'assistant' ? (value.source === 'local' ? 'local' : !model || value.source === 'legacy' ? 'legacy' : provider) : undefined;
  return {
    id: value.id, role: value.role, content: safeText(value.content, known), createdAt: value.createdAt, status: restoredStatus,
    ...(Array.isArray(value.steps) ? { steps: value.steps.map(parseStep).filter((step): step is AgentStep => !!step).map(step => ({ ...step, label: safeText(step.label, known) })) } : {}),
    ...(Array.isArray(value.findings) ? { findings: value.findings.map(parseFinding).filter((finding): finding is Finding => !!finding).map(finding => ({ ...finding, title: safeText(finding.title, known), description: safeText(finding.description, known) })) } : {}),
    ...(browserAction ? { browserAction: { ...browserAction, ...(browserAction.error ? { error: safeText(browserAction.error, known) } : {}) } } : {}),
    ...(model ? { model } : {}),
    ...(model && (value.provider !== undefined || source === 'anthropic') ? { provider } : {}),
    ...(inspection ? { inspection: restoring && !['complete', 'incomplete', 'error', 'cancelled'].includes(inspection.phase) ? { ...inspection, phase: 'cancelled' as const } : inspection } : {}),
    ...(usage ? { usage } : {}),
    ...(source ? { source } : {}),
    ...(captures ? { captures } : {}),
    ...(plan ? { plan } : {}),
    ...(activity ? { activity: { ...activity, ...(activity.detail ? { detail: safeText(activity.detail, known) } : {}) } } : {}),
    ...(report ? { report: report.status === 'ready' ? report : { ...report, message: safeText(report.message, known) } } : {}),
  };
}

function read(key: string): unknown {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value ? JSON.parse(value) : undefined;
  } catch { return undefined; }
}

export function loadConversations(): Conversation[] {
  const data = read(CONVERSATIONS_KEY);
  if (!Array.isArray(data)) return [];
  const ids = new Set<string>();
  return data.flatMap((item): Conversation[] => {
    if (!isObject(item) || typeof item.id !== 'string' || ids.has(item.id) || typeof item.title !== 'string' || !isDate(item.createdAt) || !isDate(item.updatedAt) || !Array.isArray(item.messages)) return [];
    ids.add(item.id);
    const known = knownCredentials(item);
    return [{ id: item.id, title: safeText(item.title, known), createdAt: item.createdAt, updatedAt: item.updatedAt, messages: item.messages.map(message => parseMessage(message, true, known)).filter((message): message is ChatMessage => !!message) }];
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function write(key: string, value: unknown): boolean {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

export function saveConversations(conversations: Conversation[]): boolean {
  return write(CONVERSATIONS_KEY, conversations.map(conversation => {
    const known = knownCredentials(conversation as unknown as Record<string, unknown>);
    return {
      id: conversation.id, title: safeText(conversation.title, known), createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
      // Explicit allowlists prevent transient credential objects from ever reaching storage.
      messages: conversation.messages.map(message => parseMessage(message, false, known)).filter((message): message is ChatMessage => !!message),
    };
  }));
}

