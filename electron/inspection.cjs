'use strict';
const { validateBackendRunOptions, validateBackendTask, validateBackendLoginUrl } = require('./backend-run-options.cjs');
const { validateCredentials } = require('./login-secrets.cjs');

const PHASE_LABELS = {
  starting: '실제 검사 준비 중', mapping: '사이트 구조 확인 중', exploring: '검사 대상 탐색·계획 중',
  executing: '검사 계획 실행 중', judging: '결과 판정·재현 중', reporting: '검사 보고서 생성 중',
};

function createProgressFeed() {
  let current;
  let finished = false;
  const waiters = new Set();
  const notify = () => { for (const waiter of [...waiters]) waiter(); };
  return {
    current: () => current,
    isFinished: () => finished,
    update(value) { if (!finished) { current = { ...value }; notify(); } },
    finish() { finished = true; notify(); },
    waitForChange(afterSequence, signal) {
      signal?.throwIfAborted();
      if (finished) return Promise.resolve(null);
      if (current && current.sequence > afterSequence) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        const cleanup = () => { waiters.delete(changed); signal?.removeEventListener('abort', abort); };
        const changed = () => {
          if (!finished && (!current || current.sequence <= afterSequence)) return;
          cleanup(); resolve(finished ? null : current);
        };
        const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
        waiters.add(changed);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else changed();
      });
    },
  };
}

function createInspectionAgent({ backendRunner, attachBackendReport, siteAgent, heartbeatMs = 15000 }) {
  return async function runInspection(options) {
    const { signal, targetUrl, messages, onEvent, maxActions: _legacyMaxActions, backendOptions: requestedBackendOptions, backendTask: requestedBackendTask, backendLoginUrl: requestedBackendLoginUrl,
      ...visualOptions } = options;
    const backendOptions = validateBackendRunOptions(requestedBackendOptions);
    const backendTask = validateBackendTask(requestedBackendTask);
    const credentials = validateCredentials(options.credentials);
    const backendLoginUrl = validateBackendLoginUrl(requestedBackendLoginUrl, targetUrl, credentials);
    signal.throwIfAborted();
    onEvent({ type: 'status', id: 'backend-setup', label: '실제 검사 프로그램의 실행 환경을 확인하고 있습니다', state: 'running' });
    await backendRunner.preflight(backendOptions);
    signal.throwIfAborted();
    onEvent({ type: 'status', id: 'backend-setup', label: '실제 검사 실행 환경 확인', state: 'complete' });
    if (credentials) onEvent({ type: 'status', id: 'backend-login-scope', label: '입력한 계정으로 실제 검사 백엔드와 화면 표현용 Edge에서 각각 로그인합니다.', state: 'complete' });

    const feed = createProgressFeed();
    const visualController = new AbortController();
    const visualSignal = AbortSignal.any([signal, visualController.signal]);
    let phase = 'starting';
    let currentUrl = targetUrl;
    let lastActivity = { actionCount: 0, visitedCount: 0, url: targetUrl };
    let visualFailure = false;
    const progress = event => {
      phase = event.phase;
      if (event.url) currentUrl = event.url;
      feed.update(event);
      onEvent({ type: 'inspection', phase, url: currentUrl });
      onEvent({ type: 'status', id: 'backend-inspection', label: PHASE_LABELS[phase], state: 'running' });
    };
    const heartbeat = setInterval(() => {
      if (!signal.aborted) onEvent({ type: 'status', id: 'backend-inspection', label: PHASE_LABELS[phase], state: 'running' });
    }, heartbeatMs);
    const visual = siteAgent ?? require('./site-agent.cjs').runSiteAgent;
    let visualRun;
    try {
      // Explicit backend test options and authorized login credentials enter the
      // backend. Visual model/key settings remain outside this call and environment.
      const backendRun = backendRunner.run({
        targetUrl, task: backendTask ?? messages.findLast(message => message.role === 'user')?.content ?? '', backendOptions, signal, onProgress: progress,
        ...(credentials ? { credentials, backendLoginUrl } : {}),
      });
      visualRun = Promise.resolve().then(() => visual({ ...visualOptions, targetUrl, messages, signal: visualSignal,
        reportProvider: undefined, backendProgress: feed,
        ...(credentials ? { credentials, loginUrl: backendLoginUrl } : {}),
        onEvent: event => {
          if (visualSignal.aborted) return;
          if (['report', 'delta', 'done', 'finding'].includes(event.type)) return;
          if (event.type === 'activity') {
            if (event.phase === 'complete') return;
            lastActivity = { actionCount: event.actionCount, visitedCount: event.visitedCount, url: event.url };
          }
          onEvent(event);
        },
      })).catch(() => {
        if (!visualSignal.aborted) {
          visualFailure = true;
          onEvent({ type: 'status', id: 'visual-unavailable', label: '화면 표현이 중단되었습니다. 실제 검사는 계속 진행하고 있습니다.', state: 'complete' });
        }
      });
      const result = await backendRun;
      signal.throwIfAborted();
      feed.finish();
      visualController.abort('backend-finished');
      await visualRun;
      signal.throwIfAborted();
      onEvent({ type: 'activity', ...lastActivity, phase: 'finalizing', detail: '이번 검사에서 생성한 PDF를 확인하고 첨부하고 있습니다' });
      const report = await attachBackendReport(result, { signal });
      signal.throwIfAborted();
      onEvent({ type: 'report', report: { ...report, runId: result.runId, inspectionCompleted: result.completed } });
      if (report.status !== 'ready') throw new Error('이번 검사 보고서를 첨부하지 못했습니다. 보고서 카드에서 다시 불러와 주세요.');
      onEvent({ type: 'inspection', phase: result.completed ? 'complete' : 'incomplete', url: currentUrl });
      if (!result.completed) {
        // The verified PDF is a completed deliverable even when its inspection
        // scope is partial. Preserve that scope in inspection/report metadata;
        // do not turn a successfully attached report into a transport error.
        onEvent({ type: 'status', id: 'backend-inspection', label: '보고서 생성 및 첨부 완료', state: 'complete' });
        onEvent({ type: 'activity', ...lastActivity, phase: 'complete', detail: '보고서 생성 및 첨부를 완료했습니다' });
        onEvent({ type: 'delta', text: '보고서 생성을 완료했어요. 검사 범위와 상세 결과는 첨부된 보고서에서 확인해 주세요.'
          + (visualFailure ? '\n\n화면 표현은 중간에 중단되었으며, 보고서는 실제 백엔드 검사 결과입니다.' : '') });
        return result;
      }
      onEvent({ type: 'status', id: 'backend-inspection', label: '실제 검사와 보고서 첨부 완료', state: 'complete' });
      onEvent({ type: 'activity', ...lastActivity, phase: 'complete' });
      onEvent({ type: 'delta', text: '버그 탐색을 완료했고 보고서를 완성했어요.' + (visualFailure ? '\n\n화면 표현은 중간에 중단되었으며, 보고서는 실제 백엔드 검사 결과입니다.' : '') });
      return result;
    } catch (error) {
      onEvent({ type: 'inspection', phase: signal.aborted && error.name !== 'BackendTerminationError' ? 'cancelled' : 'error', url: currentUrl });
      throw error;
    } finally {
      clearInterval(heartbeat);
      feed.finish();
      visualController.abort('inspection-finished');
      await visualRun;
    }
  };
}

module.exports = { createInspectionAgent, createProgressFeed, PHASE_LABELS };
