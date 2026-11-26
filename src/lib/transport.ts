import type { AgentEvent, ApiProvider, BackendRunOptions, ChatMessage, LoginCredentials } from '../types';
import { newId } from './storage';
import { loginCredentialsError, parsePromptCredentials, redactKnownCredentials } from './credentials';
import { parseReportResult } from './reports';
import { parseInspection } from './inspection';
import { normalizeBackendLoginUrl, normalizeBackendOptions } from './backend-options';

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 180_000;

export interface SendChatOptions {
  conversationId: string;
  messages: ChatMessage[];
  model: string;
  provider?: ApiProvider;
  targetUrl?: string;
  backendOptions?: BackendRunOptions;
  backendTask?: string;
  backendLoginUrl?: string;
  credentials?: LoginCredentials;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /** No overall run limit: a matching progress event restarts this inactivity clock. */
  inactivityTimeoutMs?: number;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('응답 생성을 중단했습니다.', 'AbortError');
}

/** All network requests and API credentials stay in the desktop main process. */
export async function sendChat({ messages, model, provider = 'openai', targetUrl, backendOptions, backendTask, backendLoginUrl, credentials, signal, onEvent, inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS }: SendChatOptions): Promise<void> {
  signal.throwIfAborted();
  const desktop = typeof window === 'undefined' ? undefined : window.pilotDesktop;
  if (!desktop?.startAiChat || !desktop.onAiEvent || !desktop.cancelAiChat) {
    throw new Error('AI 응답은 WebPilot 데스크톱 앱에서 사용할 수 있습니다. 데스크톱 앱을 실행하고 API 키를 설정해 주세요.');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(model.trim())) throw new Error('올바른 AI 모델 ID를 선택해 주세요.');
  if (provider !== 'openai' && provider !== 'anthropic') throw new Error('올바른 AI 제공자를 선택해 주세요.');
  if (!Number.isSafeInteger(inactivityTimeoutMs) || inactivityTimeoutMs < 1 || inactivityTimeoutMs > 2_147_483_647) throw new Error('응답 대기 시간 설정이 올바르지 않습니다.');
  if ((backendOptions !== undefined || backendTask !== undefined) && !targetUrl) throw new Error('백엔드 검사 설정에는 대상 URL이 필요합니다.');
  const runOptions = backendOptions === undefined ? undefined : normalizeBackendOptions(backendOptions);
  if (backendTask !== undefined && (typeof backendTask !== 'string' || !backendTask.trim() || backendTask.length > 16000)) throw new Error('백엔드 검사 요구사항은 1~16,000자로 입력해 주세요.');
  if (credentials) {
    const error = loginCredentialsError(credentials);
    if (error) throw new Error(error);
    if (!targetUrl) throw new Error('로그인 정보를 사용할 사이트 주소를 함께 지정해 주세요.');
  }
  if (backendLoginUrl !== undefined && !credentials) throw new Error('로그인 URL을 사용할 계정을 함께 입력해 주세요.');
  const loginUrl = targetUrl ? normalizeBackendLoginUrl(backendLoginUrl, targetUrl, credentials) : undefined;
  const requestId = newId();
  const knownCredentials = [credentials, parsePromptCredentials(backendTask ?? '').credentials, ...messages.map(message => parsePromptCredentials(message.content).credentials)].filter((value): value is LoginCredentials => !!value);
  const backendPrompt = backendTask === undefined ? undefined : knownCredentials.reduce((safe, known) => redactKnownCredentials(safe, known), parsePromptCredentials(backendTask).text).trim();
  if (backendPrompt !== undefined && !backendPrompt) throw new Error('백엔드 검사 요구사항을 입력해 주세요.');
  const context = messages
    .filter((message) => message.content.trim() && !(message.role === 'assistant' && (message.source === 'legacy' || message.source === 'local')))
    .map(({ role, content }) => ({ role, content: knownCredentials.reduce((safe, known) => redactKnownCredentials(safe, known), parsePromptCredentials(content).text) }));
  if (!context.some((message) => message.role === 'user')) throw new Error('보낼 메시지를 입력해 주세요.');

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let started = false;
    let done = false;
    let unsubscribe: (() => void) | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(inactivityTimer);
      unsubscribe?.();
      unsubscribe = undefined;
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const cancelNative = () => {
      if (!started) return;
      try { void Promise.resolve(desktop.cancelAiChat(requestId)).catch(() => {}); }
      catch { /* Local cancellation still completes if the desktop has closed. */ }
    };
    const onAbort = () => { cancelNative(); finish(abortError(signal)); };
    const resetWatchdog = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (settled) return;
        cancelNative();
        const error = new Error('에이전트의 응답이 오랫동안 없어 버그 탐색을 중단했습니다. 연결 상태를 확인하고 다시 시작해 주세요.');
        error.name = 'TimeoutError';
        finish(error);
      }, inactivityTimeoutMs);
    };
    const emit = (event: AgentEvent) => {
      if (settled || signal.aborted) return;
      if (event.type === 'report') {
        const report = parseReportResult(event.report);
        if (!report) return;
        event = { type: 'report', report };
      }
      if (event.type === 'inspection') {
        const inspection = parseInspection(event);
        if (!inspection) return;
        event = { type: 'inspection', ...inspection };
      }
      if (event.type === 'done') {
        if (done) return;
        done = true;
      }
      // Final accounting/report metadata may arrive just after the final text event.
      if (done && event.type !== 'done' && event.type !== 'usage' && event.type !== 'report') return;
      resetWatchdog();
      try { onEvent(event); }
      catch (error) { cancelNative(); finish(error); }
    };

    try {
      unsubscribe = desktop.onAiEvent((details) => {
        if (details.requestId === requestId) emit(details.event);
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      started = true;
      resetWatchdog();
      void desktop.startAiChat({ requestId, messages: context, provider, model: model.trim(), ...(targetUrl ? { targetUrl } : {}), ...(runOptions ? { backendOptions: runOptions } : {}), ...(backendPrompt !== undefined ? { backendTask: backendPrompt } : {}), ...(loginUrl ? { backendLoginUrl: loginUrl } : {}), ...(credentials ? { credentials: { username: credentials.username, password: credentials.password } } : {}) }).then((result) => {
        if (settled) return;
        if (signal.aborted || result.cancelled) {
          finish(signal.aborted ? abortError(signal) : new DOMException('응답 생성을 중단했습니다.', 'AbortError'));
          return;
        }
        if (!result.ok) { finish(new Error(result.error || 'AI 응답을 받지 못했습니다. 연결 설정을 확인해 주세요.')); return; }
        if (!done) emit({ type: 'done' });
        finish();
      }, (error: unknown) => finish(error instanceof Error ? error : new Error('AI 연결 중 오류가 발생했습니다.')));
    } catch (error) { finish(error); }
  });
}
