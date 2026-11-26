// 데스크톱 표시 전용 IPC. 페이지 자료와 검사 결과는 이 채널로 보내지 않는다.
import { isAbsolute } from 'node:path';
import type { Page } from 'playwright';
import { validateProviderModel, type Provider } from './providers.ts';
import { progressUrl } from './progress-url.ts';
export { progressUrl } from './progress-url.ts';

export const DESKTOP_MODELS = Object.freeze({ plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' });
export type BackendPhase = 'starting' | 'mapping' | 'exploring' | 'executing' | 'judging' | 'reporting';
export type BackendAction = 'navigate' | 'snapshot' | 'click' | 'fill' | 'select' | 'press' | 'inspect' | 'plan';
export type BackendProgress = { type: 'backend-progress'; phase: BackendPhase; sequence: number; url?: string; action?: BackendAction };
export type BackendResult = { type: 'backend-result'; runDir: string; pdf: boolean; pdfError?: 'report-generation-failed' };
type Event = BackendProgress | BackendResult;
type Sink = (event: Event) => void;

export function assertDesktopOptions(o: { enabled: boolean; hasIpc: boolean; outputDir?: string; startUrl: string; origins?: string; provider?: Provider; planModel: string; triageModel: string }): void {
  if (!o.enabled) {
    if (o.outputDir !== undefined) throw new Error('--output-dir는 데스크톱 실행 전용입니다.');
    return;
  }
  if (!o.hasIpc) throw new Error('데스크톱 실행에는 부모 프로세스 IPC 연결이 필요합니다.');
  if (!o.outputDir || !isAbsolute(o.outputDir)) throw new Error('데스크톱 실행에는 고유한 절대 출력 경로가 필요합니다.');
  validateProviderModel(o.provider ?? 'anthropic', o.planModel);
  validateProviderModel(o.provider ?? 'anthropic', o.triageModel);
  const url = new URL(o.startUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('올바른 HTTP(S) 시작 주소가 필요합니다.');
  if (o.origins && o.origins.split(',').some(origin => origin !== url.origin)) throw new Error('데스크톱 실행은 시작 주소와 같은 origin만 허용합니다.');
}

export function createProgressReporter(startUrl: string, sink: Sink) {
  const origin = new URL(startUrl).origin;
  let sequence = 0;
  const send = (event: Event) => { try { sink(event); } catch { /* 표시 채널 실패가 검사 판정을 바꾸지 않는다. */ } };
  return {
    progress(phase: BackendPhase, value?: string, action?: BackendAction) {
      const url = progressUrl(value, origin);
      send({ type: 'backend-progress', phase, sequence: ++sequence, ...(url ? { url } : {}), ...(action ? { action } : {}) });
    },
    result(runDir: string, pdf: boolean) {
      send({ type: 'backend-result', runDir, pdf, ...(!pdf ? { pdfError: 'report-generation-failed' as const } : {}) });
    },
  };
}

let reporter: ReturnType<typeof createProgressReporter> | undefined;
export function configureDesktopProgress(enabled: boolean, startUrl: string): void {
  reporter = enabled ? createProgressReporter(startUrl, event => {
    if (process.connected && process.send) process.send(event, () => {});
  }) : undefined;
}
export function desktopProgress(phase: BackendPhase, url?: string, action?: BackendAction): void { reporter?.progress(phase, url, action); }
export function desktopResult(runDir: string, pdf: boolean): void { reporter?.result(runDir, pdf); }

/** iframe·새 창이 아니라 현재 백엔드 작업 페이지의 실제 이동만 관측한다. */
export function watchProgressPage(page: Page, phase: BackendPhase): void {
  if (!reporter) return;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) desktopProgress(phase, frame.url(), 'navigate'); });
}

export function toolProgressAction(name: string): BackendAction {
  if (['snapshot', 'click', 'fill', 'select', 'press'].includes(name)) return name as BackendAction;
  if (name === 'navigate' || name === 'restart') return 'navigate';
  return 'inspect';
}
