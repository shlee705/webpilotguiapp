import { test, expect, type Page } from '@playwright/test';

async function nativeFixture(page: Page, keyConfigured = true, pdfSize = { width: 400, height: 560 }) {
  await page.addInitScript(({ configured, pdfSize }) => {
    const host = window as any;
    const listeners = new Set<(details: any) => void>();
    const pending = new Map<string, { timers: ReturnType<typeof setTimeout>[]; resolve: (result: any) => void }>();
    const stored = sessionStorage.getItem('native-fixture-settings');
    const settings = stored ? JSON.parse(stored) : { provider: 'openai', profiles: {
      openai: { model: 'gpt-6-luna', keyConfigured: configured, keyHint: configured ? '••••test' : '', storage: 'encrypted', usage: { month: '2026-11', inputTokens: 200, outputTokens: 157, totalTokens: 357, requests: 2, untrackedRequests: 0 } },
      anthropic: { model: 'claude-haiku-5-5', keyConfigured: false, keyHint: '', storage: 'encrypted', usage: { month: '2026-11', inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, untrackedRequests: 0 } },
    } };
    const copy = () => JSON.parse(JSON.stringify({ ...settings, ...settings.profiles[settings.provider] }));
    const emptyBackend = { keyConfigured: false, savedKeyConfigured: false, keyHint: '', storage: 'env-file', source: 'none' };
    const backendStored = sessionStorage.getItem('native-fixture-backend-settings');
    const backendSettings = backendStored ? JSON.parse(backendStored) : { provider: 'anthropic', runDefaults: {
      budgetUsd: 10, exploreMinutes: 40, maxPages: 30, maxTemplates: 8, turnsPerTemplate: 25,
      maxTurns: 40, pagesPerTemplate: 3, concurrency: 1, workers: 1, planEffort: 'medium', sessions: 'template',
    }, profiles: {
      openai: { ...emptyBackend, models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' } },
      anthropic: { ...emptyBackend, models: { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' } },
    } };
    host.__backendSettings = backendSettings;
    const backendCopy = () => JSON.parse(JSON.stringify({ ...backendSettings, ...backendSettings.profiles[backendSettings.provider as 'openai' | 'anthropic'] }));
    const emit = (requestId: string, event: any) => { for (const listener of listeners) listener({ requestId, event }); };
    const calls = host.__native = { requests: [] as any[], cancelled: [] as string[], saved: [] as any[], tested: [] as any[], backendSaved: [] as any[], backendTested: [] as any[], backendReadFails: false, captureReads: [] as string[], overlayStarts: [] as string[], overlayEnds: [] as string[], openedUrls: [] as string[], reportOpens: [] as string[], reportReads: [] as string[], reportRefreshes: 0, reportId: '12345678-1234-4234-8234-123456789abc', staleReportId: '', reportUnavailable: false, openReportFails: false, readReportFails: false, failNext: false, holdActivity: false };
    // A real two-page PDF fixture with deterministic graphics, correct byte
    // offsets and no downloaded assets or user report contents.
    const firstPage = '0.14 0.15 0.18 rg 30 410 340 90 re f\nBT /F1 24 Tf 30 530 Td (WebPilot Report) Tj ET\nBT /F1 14 Tf 30 370 Td (First page - local PDF fixture) Tj ET';
    const secondPage = '0.68 0.72 0.78 rg 30 260 220 180 re f\nBT /F1 24 Tf 30 530 Td (Second page) Tj ET\nBT /F1 14 Tf 30 220 Td (Navigation and zoom fixture) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfSize.width} ${pdfSize.height}] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>`,
      `<< /Length ${firstPage.length} >>\nstream\n${firstPage}\nendstream`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfSize.width} ${pdfSize.height}] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`,
      `<< /Length ${secondPage.length} >>\nstream\n${secondPage}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const pdfBytes = new TextEncoder().encode(pdf);
    const report = () => calls.reportUnavailable ? { status: 'missing', message: 'testReport/report.pdf 파일을 찾을 수 없습니다.' } : { status: 'ready', id: calls.reportId, name: 'report.pdf', size: 2830568, updatedAt: '2026-11-25T09:00:00.000Z' };
    host.pilotDesktop = {
      platform: 'win32', minimize() {}, close() {}, toggleMaximize: async () => false, isMaximized: async () => false,
      onMaximizedChange: () => () => {}, onOverlayStopped: () => () => {},
      openInEdge: async (url: string) => { calls.openedUrls.push(url); return { ok: true }; },
      beginOverlay: async (id: string) => { calls.overlayStarts.push(id); return { ok: true }; },
      endOverlay: async (id: string) => { calls.overlayEnds.push(id); return { ok: true }; },
      getAiSettings: async () => copy(),
      getBackendSettings: async () => { if (calls.backendReadFails) throw new Error('fixture-read-failure'); return backendCopy(); },
      saveBackendSettings: async (options: any) => {
        calls.backendSaved.push(options);
        backendSettings.provider = options.provider ?? backendSettings.provider;
        const profile = backendSettings.profiles[backendSettings.provider as 'openai' | 'anthropic'];
        if (options.models) profile.models = { ...options.models };
        if (options.runDefaults) backendSettings.runDefaults = { ...options.runDefaults };
        if (options.apiKey) { profile.savedKeyConfigured = true; profile.keyConfigured = true; profile.keyHint = '••••back'; if (profile.source !== 'environment') profile.source = 'file'; }
        if (options.forgetKey) { profile.savedKeyConfigured = false; profile.keyHint = ''; if (profile.source !== 'environment') { profile.keyConfigured = false; profile.source = 'none'; } }
        // Persist only public fixture metadata, never supplied API key values.
        sessionStorage.setItem('native-fixture-backend-settings', JSON.stringify(backendSettings));
        return backendCopy();
      },
      testBackendConnection: async (options: any) => { calls.backendTested.push(options); return { ok: true }; },
      refreshReport: async () => { calls.reportRefreshes++; return report(); },
      openReport: async (id: string) => { calls.reportOpens.push(id); return calls.openReportFails ? { ok: false, error: '저장된 보고서를 찾을 수 없습니다.' } : { ok: true }; },
      readReport: async (id: string) => { calls.reportReads.push(id); return calls.readReportFails || id === calls.staleReportId ? { ok: false, error: '저장된 보고서를 찾을 수 없습니다.' } : { ok: true, data: pdfBytes.slice() }; },
      saveAiSettings: async (options: any) => {
        calls.saved.push(options);
        settings.provider = options.provider ?? 'openai';
        const profile = settings.profiles[settings.provider];
        profile.model = options.model;
        if (options.apiKey) { profile.keyConfigured = true; profile.keyHint = settings.provider === 'anthropic' ? '••••anth' : '••••test'; }
        if (options.forgetKey) { profile.keyConfigured = false; profile.keyHint = ''; }
        // Native settings survive reload; even this fixture persists no API key.
        sessionStorage.setItem('native-fixture-settings', JSON.stringify(settings));
        return copy();
      },
      testAiConnection: async (options: any) => { calls.tested.push(options); return { ok: true, models: options.provider === 'anthropic' ? ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] : ['gpt-6-luna', 'gpt-6.2-sol'] }; },
      onAiEvent: (listener: (details: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      getCapture: async (id: string) => {
        calls.captureReads.push(id);
        return { ok: true, imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
      },
      startAiChat: (request: any) => new Promise(resolve => {
        calls.requests.push(request);
        const state = { timers: [] as ReturnType<typeof setTimeout>[], resolve };
        pending.set(request.requestId, state);
        const schedule = (delay: number, action: () => void) => state.timers.push(setTimeout(action, delay));
        emit(request.requestId, { type: 'status', id: 'request', label: 'AI 응답 준비', state: 'running' });
        if (calls.failNext) {
          calls.failNext = false;
          schedule(300, () => { pending.delete(request.requestId); resolve({ ok: false, error: '일시적인 연결 오류입니다. 다시 시도해 주세요.' }); });
          return;
        }
        if (request.targetUrl) {
          schedule(60, () => emit(request.requestId, { type: 'browser', url: request.targetUrl, status: 'opened' }));
          emit(request.requestId, { type: 'activity', phase: 'reading', actionCount: 0, visitedCount: 1, url: request.targetUrl });
          schedule(180, () => emit(request.requestId, { type: 'activity', phase: 'thinking', actionCount: 0, visitedCount: 1, url: request.targetUrl }));
          schedule(350, () => emit(request.requestId, { type: 'activity', phase: 'acting', actionCount: 1, visitedCount: 1, url: request.targetUrl }));
          if (calls.holdActivity) return;
          // This observed fixture total is independent of any request quota.
          schedule(700, () => emit(request.requestId, { type: 'activity', phase: 'finalizing', actionCount: 5, visitedCount: 3, url: request.targetUrl }));
          if (request.messages.at(-1)?.content.includes('정리 중 중단')) return;
          schedule(1600, () => {
            emit(request.requestId, { type: 'report', report: report() });
            emit(request.requestId, { type: 'delta', text: (calls.reportUnavailable ? '웹사이트 버그 탐색을 마쳤지만 보고서를 불러오지 못했어요. 보고서를 다시 확인해 주세요.' : '버그 탐색을 완료했고 보고서를 완성했어요.') + '\n\n확인한 내용을 대화에 정리합니다.' });
          });
        } else {
          schedule(180, () => emit(request.requestId, { type: 'delta', text: '요청한 내용을 확인했습니다. ' }));
          if (request.messages.at(-1)?.content.includes('중단')) return;
          schedule(700, () => emit(request.requestId, { type: 'delta', text: '확인한 내용을 대화에 정리합니다.' }));
        }
        schedule(request.targetUrl ? 1900 : 1000, () => {
          emit(request.requestId, { type: 'status', id: 'request', label: 'AI 응답 완료', state: 'complete' });
          emit(request.requestId, { type: 'usage', usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } });
          const usage = settings.profiles[request.provider ?? 'openai'].usage;
          usage.inputTokens += 40; usage.outputTokens += 20; usage.totalTokens += 60; usage.requests += 1;
          sessionStorage.setItem('native-fixture-settings', JSON.stringify(settings));
          if (request.targetUrl) emit(request.requestId, { type: 'activity', phase: 'complete', actionCount: 5, visitedCount: 3, url: request.targetUrl });
          emit(request.requestId, { type: 'done' });
          pending.delete(request.requestId);
          resolve({ ok: true });
        });
      }),
      cancelAiChat: async (requestId: string) => {
        calls.cancelled.push(requestId);
        const state = pending.get(requestId);
        if (state) { state.timers.forEach(clearTimeout); pending.delete(requestId); state.resolve({ ok: false, cancelled: true }); }
        return { ok: true };
      },
    };
  }, { configured: keyConfigured, pdfSize });
}

async function send(page: Page, content: string) {
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill(content);
  await page.getByRole('button', { name: '메시지 보내기' }).click();
}

async function backendFixture(page: Page) {
  await nativeFixture(page);
  await page.goto('/');
  await page.evaluate(() => {
    const host = window as any;
    let listener: (payload: any) => void;
    let requestId: string;
    let finish: (value: any) => void;
    const runId = 'c2eb104a-6476-4b89-ace1-b2a01bcb9282';
    const report = { status: 'ready', id: host.__native.reportId, name: 'report.pdf', size: 2048, updatedAt: '2026-11-26T00:00:00.000Z', runId, inspectionCompleted: true };
    host.__backend = {
      runId, report, refreshed: [] as string[],
      emit: (event: any) => listener({ requestId, event }),
      finish: (value: any) => finish(value),
    };
    host.pilotDesktop.onAiEvent = (callback: typeof listener) => { listener = callback; return () => {}; };
    host.pilotDesktop.startAiChat = (request: any) => {
      requestId = request.requestId;
      host.__native.requests.push(request);
      return new Promise(resolve => { finish = resolve; });
    };
    host.pilotDesktop.refreshReport = async (id: string) => {
      host.__backend.refreshed.push(id);
      return { ...host.__backend.report };
    };
  });
}

test('legacy partial report shows report generation complete while preserving inspection scope on refresh', async ({ page }) => {
  test.setTimeout(60000);
  await backendFixture(page);
  await send(page, 'https://example.com 검색 기능 확인');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  await page.evaluate(() => {
    const backend = (window as any).__backend;
    backend.emit({ type: 'inspection', phase: 'executing', url: 'https://example.com/search' });
    backend.emit({ type: 'activity', phase: 'acting', actionCount: 1, visitedCount: 1, url: 'https://example.com/search' });
  });
  await expect(page.locator('.inspection-status')).toContainText('검사 계획 실행');
  await expect(page.locator('.inspection-status small')).toHaveAttribute('title', 'https://example.com/search');
  await expect(page.locator('.agent-activity-active')).toBeVisible();
  await expect(page.locator('.agent-activity-location')).toHaveAttribute('title', 'https://example.com/search');
  await expect(page.locator('.agent-activity-stage-current')).toHaveText('실제 조작');
  await expect(page.locator('.agent-activity-copy')).toContainText('선택한 요소를 실제로 클릭하고 입력하고 있습니다');
  await expect(page.locator('.tour-plan-complete, .agent-activity-done-label')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '보고서 열기', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const backend = (window as any).__backend;
    backend.emit({ type: 'inspection', phase: 'judging', url: 'https://example.com/search' });
    backend.emit({ type: 'activity', phase: 'reading', actionCount: 2, visitedCount: 1, url: 'https://example.com/search', detail: '실제 검사 결과를 기다리고 있습니다' });
  });
  await expect(page.locator('.inspection-status')).toContainText('결과 판정·재현');
  await expect(page.locator('.agent-activity-count')).toContainText('화면 표현');
  await expect(page.getByRole('button', { name: '보고서 열기', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const backend = (window as any).__backend;
    backend.report.inspectionCompleted = false;
    backend.emit({ type: 'inspection', phase: 'incomplete', url: 'https://example.com/search' });
    backend.emit({ type: 'report', report: backend.report });
    backend.emit({ type: 'delta', text: '일부 검사를 완료하지 못해 현재까지의 결과 보고서를 첨부했어요.' });
    backend.finish({ ok: false, error: '실제 검사에 미완료 항목이 있습니다.' });
    (window as any).__native.readReportFails = true;
  });
  await expect(page.locator('.inspection-status')).toContainText('보고서 생성 완료');
  await expect(page.locator('.message-content').last()).not.toContainText('완료했고');
  await expect(page.locator('.message-content').last()).toContainText('보고서 생성을 완료했어요.');
  await expect(page.locator('.message-content').last()).not.toContainText('응답을 받지 못했습니다');
  await expect(page.locator('.assistant-message.has-error')).toHaveCount(0);
  await expect(page.locator('.agent-activity-summary h3')).toHaveText('보고서 생성을 완료했습니다');
  await expect(page.locator('.agent-activity-summary')).toContainText('화면 표현 · 방문한 페이지 1곳 · 수행한 동작 2회');
  await page.screenshot({ path: 'screenshots/report-generated-complete.png', animations: 'disabled' });
  await page.getByRole('button', { name: '보고서 열기', exact: true }).click();
  await page.getByRole('button', { name: '보고서 다시 불러오기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__backend.refreshed)).toEqual(['c2eb104a-6476-4b89-ace1-b2a01bcb9282']);
  await expect(page.locator('.message-content').last()).not.toContainText('완료했고');
  await page.reload();
  await page.locator('.history-select').first().click();
  await expect(page.locator('.inspection-status')).toContainText('보고서 생성 완료');
  await expect(page.locator('.report-card')).toContainText('검사 범위는 보고서에서 확인');
  await expect(page.locator('.message-content').last()).not.toContainText('응답을 받지 못했습니다');
  await expect(page.locator('.agent-activity-summary')).toContainText('화면 표현');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!).at(0).messages.at(-1));
  expect(saved.report.inspectionCompleted).toBe(false);
  expect(saved.inspection.phase).toBe('incomplete');
  expect(saved.status).toBe('error');
});

test('new partial run completes report delivery without claiming complete inspection', async ({ page }) => {
  await backendFixture(page);
  await send(page, 'https://example.com 검색 기능 확인');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  await page.evaluate(() => {
    const backend = (window as any).__backend;
    backend.report.inspectionCompleted = false;
    backend.emit({ type: 'report', report: backend.report });
    backend.emit({ type: 'inspection', phase: 'incomplete', url: 'https://example.com/search' });
    backend.emit({ type: 'activity', phase: 'complete', actionCount: 59, visitedCount: 21, url: 'https://example.com/search' });
    backend.emit({ type: 'delta', text: '보고서 생성을 완료했어요. 검사 범위와 상세 결과는 첨부된 보고서에서 확인해 주세요.' });
    backend.finish({ ok: true });
  });
  await expect(page.locator('.message-content').last()).toContainText('보고서 생성을 완료했어요.');
  await expect(page.locator('.agent-activity-summary h3')).toHaveText('보고서 생성을 완료했습니다');
  await expect(page.locator('.assistant-message.has-error')).toHaveCount(0);
  await expect(page.locator('.tour-plan-state')).toHaveText('실행 종료');
  await expect(page.getByRole('button', { name: '보고서 열기', exact: true })).toBeEnabled();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!).at(0).messages.at(-1));
  expect(saved.report.inspectionCompleted).toBe(false);
  expect(saved.inspection.phase).toBe('incomplete');
  expect(saved.status).toBe('complete');
  await page.screenshot({ path: 'screenshots/report-generated-new-run.png', animations: 'disabled' });
  await page.evaluate(() => {
    const host = window as any;
    host.__native.readReportFails = true;
    host.pilotDesktop.refreshReport = async () => ({ status: 'missing', message: '보고서 사본이 없습니다.', runId: host.__backend.runId, inspectionCompleted: false });
  });
  await page.getByRole('button', { name: '보고서 열기', exact: true }).click();
  await page.getByRole('button', { name: '보고서 다시 불러오기', exact: true }).click();
  await expect(page.locator('.agent-activity-summary h3')).toHaveText('보고서를 불러오지 못했습니다');
  await expect(page.locator('.message-content').last()).not.toContainText('생성을 완료');
  await expect(page.locator('.agent-activity-done-label')).toHaveCount(0);
});

test('an actual failure after partial PDF attachment retains its error display', async ({ page }) => {
  await backendFixture(page);
  await send(page, 'https://example.com 메뉴 검사');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  await page.evaluate(() => {
    const backend = (window as any).__backend;
    backend.report.inspectionCompleted = false;
    backend.emit({ type: 'report', report: backend.report });
    backend.emit({ type: 'inspection', phase: 'error', url: 'https://example.com/' });
    backend.emit({ type: 'activity', phase: 'finalizing', actionCount: 1, visitedCount: 1, url: 'https://example.com/' });
    backend.finish({ ok: false, error: '실행 결과 검증에 실패했습니다.' });
  });
  await expect(page.locator('.assistant-message.has-error')).toHaveCount(1);
  await expect(page.locator('.message-content').last()).toContainText('실행 결과 검증에 실패했습니다.');
  await expect(page.locator('.agent-activity-summary h3')).toHaveText('버그 탐색을 완료하지 못했습니다');
});

test('verified same-run PDF recovery restores completion after an attachment failure', async ({ page }) => {
  await backendFixture(page);
  await send(page, 'https://example.com 메뉴 검사');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  await page.evaluate(() => {
    const backend = (window as any).__backend;
    backend.emit({ type: 'inspection', phase: 'error', url: 'https://example.com/' });
    backend.emit({ type: 'report', report: { status: 'error', message: '보고서 사본 저장 실패', runId: backend.runId, inspectionCompleted: true } });
    backend.finish({ ok: false, error: '이번 검사 보고서를 첨부하지 못했습니다.' });
  });
  await expect(page.locator('.message-content').last()).toContainText('첨부하지 못');
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(page.locator('.message-content').last()).toHaveText('버그 탐색을 완료했고 보고서를 완성했어요.');
  await expect(page.locator('.inspection-status')).toContainText('보고서 생성 완료');
  await expect(page.locator('.tour-plan-state')).toContainText('실행 종료');
  await expect(page.getByRole('button', { name: '보고서 열기', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__backend.refreshed)).toEqual(['c2eb104a-6476-4b89-ace1-b2a01bcb9282']);
});

async function trackEntryMotion(page: Page) {
  await page.addInitScript(() => {
    const host = window as any;
    host.__motion = { starts: [] as string[], waapiCalls: 0 };
    document.addEventListener('animationstart', event => { host.__motion.starts.push(event.animationName); });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      host.__motion.waapiCalls++;
      return animate.apply(this, args);
    };
  });
}

async function finishEntryMotion(page: Page) {
  await page.locator('.conversation-content').evaluate(async element => {
    const animations = element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
}

async function renderedPdfCanvas(page: Page) {
  const viewer = page.getByRole('dialog', { name: 'PDF 보고서 뷰어', exact: true });
  await expect(viewer).toBeVisible();
  const canvas = viewer.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(viewer.locator('.pdf-viewport')).toHaveAttribute('aria-busy', 'false', { timeout: 10000 });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => {
    if (!element.width || !element.height) return 0;
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let visiblePixels = 0;
    for (let index = 0; index < pixels.length; index += 64) if (pixels[index + 3] && pixels[index] + pixels[index + 1] + pixels[index + 2] < 650) visiblePixels++;
    return visiblePixels;
  }), { timeout: 10000 }).toBeGreaterThan(10);
  return canvas;
}

async function pdfCanvasHash(page: Page) {
  return page.getByRole('dialog', { name: 'PDF 보고서 뷰어', exact: true }).locator('canvas').evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let hash = 0;
    for (let index = 0; index < pixels.length; index += 64) hash = (Math.imul(hash, 31) + pixels[index] + pixels[index + 1] + pixels[index + 2] + pixels[index + 3]) | 0;
    return hash;
  });
}

async function trackPdfLayout(page: Page) {
  await page.evaluate(() => {
    const host = window as any;
    const ids = new WeakMap<Element, number>();
    let nextId = 0;
    host.__pdfLayouts = [];
    const observer = new MutationObserver(() => {
      const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
      if (!viewport) return;
      const canvas = viewport.querySelector('canvas');
      if (canvas && !ids.has(canvas)) ids.set(canvas, ++nextId);
      const paper = viewport.querySelector<HTMLElement>('.pdf-paper');
      const bounds = canvas?.getBoundingClientRect();
      host.__pdfLayouts.push({
        busy: viewport.getAttribute('aria-busy'), canvas: canvas ? ids.get(canvas) : 0,
        width: viewport.clientWidth, height: viewport.clientHeight,
        scrollWidth: viewport.scrollWidth, scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop, opacity: paper ? getComputedStyle(paper).opacity : null,
        paperWidth: bounds?.width ?? 0, paperHeight: bounds?.height ?? 0,
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
  });
}

test('URL prompts create a local plan before native execution and preserve DOM-tour history', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '오늘 어떤 도움을 드릴까요?' })).toBeVisible();
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeDisabled();
  await send(page, 'https://example.com/test 와 https://example.org 확인');
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.overlayStarts)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.openedUrls)).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!)[0].messages[1].source)).toBe('local');
  await page.screenshot({ path: 'screenshots/tour-plan.png', animations: 'disabled' });
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '응답 중지' })).toBeVisible();
  await expect(page.getByRole('region', { name: '에이전트 버그 탐색 상태' })).toBeVisible();
  await page.screenshot({ path: 'screenshots/tour-activity.png', animations: 'disabled' });
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
  await expect(page.locator('.message-content').last()).toContainText('확인한 내용을 대화에 정리합니다.');
  await expect(page.locator('.conversation-content')).not.toContainText('데모');
  expect(await page.evaluate(() => (window as any).__native.requests[0].targetUrl)).toBe('https://example.com/test');
  expect(await page.evaluate(() => (window as any).__native.requests[0].model)).toBe('gpt-6-luna');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!));
  const assistant = stored[0].messages.find((message: any) => message.source === 'openai');
  expect(assistant.source).toBe('openai');
  expect(assistant.usage.totalTokens).toBe(60);
  expect(assistant.activity).toMatchObject({ phase: 'complete', visitedCount: 3, actionCount: 5 });
  expect(await page.evaluate(() => (window as any).__native.requests[0])).not.toHaveProperty('maxActions');
  expect(assistant.captures).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  await expect(page.locator('.capture-card')).toHaveCount(0);
  expect(JSON.stringify(stored)).not.toContain('data:image');
  await page.getByRole('button', { name: '새 채팅' }).click();
  await send(page, '두 번째 일반 대화');
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(2);
  await page.getByRole('textbox', { name: '대화 검색' }).fill('example.com');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await page.locator('.history-select').click();
  await expect(page.locator('.user-bubble').first()).toContainText('https://example.com/test');
  await page.reload();
  await expect(page.locator('.history-item')).toHaveCount(2);
  await page.locator('.history-select').filter({ hasText: 'https://example.com/test' }).click();
  await expect(page.locator('.message-content').last()).toContainText('확인한 내용을 대화에 정리합니다.');
  await expect(page.locator('.agent-activity-complete')).toBeVisible();
});

test('cancel stops native streaming and history remains recoverable and deletable', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, '중단할 점검');
  await expect(page.locator('.message-content')).toContainText('요청한 내용을 확인했습니다.');
  await page.getByRole('button', { name: '응답 중지' }).click();
  await expect(page.getByText('응답 생성을 중지했습니다.')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__native.cancelled.length)).toBe(1);
  await page.reload();
  await page.locator('.history-select').filter({ hasText: '중단할 점검' }).click();
  await expect(page.getByText('응답 생성을 중지했습니다.')).toBeVisible();
  await page.getByRole('button', { name: '중단할 점검 대화 삭제' }).click();
  await page.getByRole('button', { name: '대화 삭제', exact: true }).click();
  await expect(page.locator('.history-item')).toHaveCount(0);
});

test('QA team profile opens settings; missing key and native test/save preserve credentials and usage', async ({ page }) => {
  await nativeFixture(page, false);
  await page.goto('/');
  await send(page, '연결 후 보낼 메시지');
  await expect(page.getByRole('heading', { name: 'API 및 앱 설정' })).toBeVisible();
  await expect(page.locator('.history-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const profile = page.getByRole('button', { name: 'QA팀 설정', exact: true });
  await expect(profile).toContainText('QA팀');
  await profile.click();
  await expect(page.getByRole('heading', { name: 'API 및 앱 설정' })).toBeVisible();
  const apiKey = 'sk-test-UI-secret-never-persist';
  await page.getByLabel('OpenAI API 키', { exact: true }).fill(apiKey);
  await page.getByRole('combobox', { name: '모델 선택' }).selectOption('gpt-6.2-sol');
  await page.getByRole('button', { name: '연결 확인', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.tested.length)).toBe(1);
  await page.getByRole('button', { name: '연결 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.saved.length)).toBe(1);
  const nativeCall = await page.evaluate(() => (window as any).__native.saved[0]);
  expect(nativeCall).toMatchObject({ apiKey, model: 'gpt-6.2-sol' });
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain(apiKey);
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('연결 후 보낼 메시지');
  await page.getByRole('button', { name: '메시지 보내기' }).click();
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__native.requests[0].model)).toBe('gpt-6.2-sol');
  await expect(page.locator('.sidebar-bottom')).toContainText('QA팀');
  await expect(page.locator('.sidebar-bottom')).not.toContainText('요금제');
  await expect(page.locator('.sidebar-bottom')).not.toContainText('이번 달 사용량');
  await expect(page.locator('.sidebar-bottom')).not.toContainText('토큰');
  await profile.click();
  await expect(page.getByRole('combobox', { name: '모델 선택' })).toHaveValue('gpt-6.2-sol');
  await expect(page.getByRole('dialog')).toContainText('이번 달 OpenAI API 사용량');
  await expect(page.getByRole('dialog')).toContainText('토큰');
  await expect(page.getByRole('checkbox', { name: /전체 화면|촬영 효과/ })).toHaveCount(0);
  await expect(page.getByRole('dialog')).not.toContainText('캡처 화면은 선택한 OpenAI 모델에 전송');
  await expect(page.getByRole('dialog')).toContainText(/검정|검은/);
  await expect(page.getByRole('dialog')).toContainText('Esc');
});

test('provider settings isolate drafts, models, keys and usage and route Claude chat', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  const provider = page.getByRole('combobox', { name: 'AI 선택', exact: true });
  const model = page.getByRole('combobox', { name: '모델 선택', exact: true });
  await expect(provider).toHaveValue('openai');
  await page.getByLabel('OpenAI API 키', { exact: true }).fill('sk-unsaved-openai-do-not-send');
  await model.selectOption('gpt-6.2-sol');
  await provider.selectOption('anthropic');
  await expect(model).toHaveValue('claude-haiku-5-5');
  await expect(model.locator('option[value="gpt-6-luna"]')).toHaveCount(0);
  await expect(page.getByLabel('Anthropic API 키', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '연결 확인', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: '키 발급' })).toHaveAttribute('href', 'https://platform.claude.com/settings/keys');
  await expect(page.getByRole('dialog')).toContainText('실제 검사 백엔드에는 적용되지 않습니다.');
  const fields = await page.locator('#api-provider, #api-model, #api-key').evaluateAll(nodes => nodes.map(node => node.id));
  expect(fields).toEqual(['api-provider', 'api-model', 'api-key']);
  await model.selectOption('claude-sonnet-5-5');
  await page.getByLabel('Anthropic API 키', { exact: true }).fill('sk-ant-test-display-only');
  await page.getByRole('button', { name: '연결 확인', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.tested.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.tested[0])).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-test-display-only' });
  await page.getByRole('button', { name: '연결 저장', exact: true }).click();
  await expect(page.getByLabel('Anthropic API 키', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Anthropic API 키', { exact: true })).toHaveAttribute('placeholder', /••••anth/);
  await page.screenshot({ path: 'screenshots/claude-settings.png', animations: 'disabled' });
  await provider.selectOption('openai');
  await expect(model).toHaveValue('gpt-6.2-sol');
  await expect(page.getByLabel('OpenAI API 키', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('OpenAI API 키', { exact: true })).toHaveAttribute('placeholder', /••••test/);
  await expect(page.locator('.usage-grid')).toContainText('200');
  await provider.selectOption('anthropic');
  await expect(model).toHaveValue('claude-sonnet-5-5');
  expect(await page.evaluate(() => Object.values(localStorage).join('') + Object.values(sessionStorage).join(''))).not.toContain('sk-ant-test-display-only');
  expect(await page.evaluate(() => JSON.stringify((window as any).__native.saved))).not.toContain('sk-unsaved-openai-do-not-send');
  await page.keyboard.press('Escape');
  await send(page, '화면 탐색 준비 방법 알려줘');
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__native.requests[0])).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const storedMessage = await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!)[0].messages.at(-1));
  expect(storedMessage).toMatchObject({ provider: 'anthropic', source: 'anthropic', model: 'claude-sonnet-5-5' });
  await page.reload();
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await expect(provider).toHaveValue('anthropic');
  await expect(model).toHaveValue('claude-sonnet-5-5');
  await expect(page.locator('.usage-grid')).toContainText('40');
  await provider.selectOption('openai');
  await expect(model).toHaveValue('gpt-6-luna');
  await expect(page.locator('.usage-grid')).toContainText('200');
});

test('visual and backend settings use separate roles, credentials and model requests', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  const visualTab = page.getByRole('tab', { name: '화면 표현 AI', exact: true });
  const backendTab = page.getByRole('tab', { name: '실제 검사 백엔드', exact: true });
  await expect(visualTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('combobox', { name: 'AI 선택', exact: true }).selectOption('anthropic');
  await page.getByLabel('Anthropic API 키', { exact: true }).fill('sk-unsaved-visual-only');
  await backendTab.click();
  await expect(page.getByLabel('Anthropic API 키', { exact: true })).toHaveCount(0);
  await expect(page.locator('.backend-key-status')).toContainText('키 설정 필요');
  await expect(page.getByRole('combobox', { name: '계획·탐색 모델', exact: true })).toHaveValue('claude-opus-5-5');
  await expect(page.getByRole('combobox', { name: '판정·보고서 모델', exact: true })).toHaveValue('claude-sonnet-5-5');
  await page.getByRole('combobox', { name: '백엔드 AI 선택', exact: true }).selectOption('openai');
  const backendKey = page.getByLabel('백엔드 전용 OpenAI API 키', { exact: true });
  await expect(backendKey).toHaveValue('');
  await expect(page.getByRole('button', { name: '백엔드 연결 확인', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '계획·탐색 모델', exact: true }).selectOption('gpt-6.2-astra');
  await page.getByRole('combobox', { name: '판정·보고서 모델', exact: true }).selectOption('gpt-6.2-sol');
  await backendKey.fill('sk-backend-openai-only');
  await page.getByRole('button', { name: '백엔드 연결 확인', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.backendTested.length)).toBe(1);
  const expected = { provider: 'openai', models: { plan: 'gpt-6.2-astra', triage: 'gpt-6.2-sol' }, apiKey: 'sk-backend-openai-only' };
  expect(await page.evaluate(() => (window as any).__native.backendTested[0])).toEqual(expected);
  await page.getByRole('button', { name: '백엔드 설정 저장', exact: true }).click();
  await expect(backendKey).toHaveValue('');
  await expect(backendKey).toHaveAttribute('placeholder', /••••back/);
  await expect(page.locator('.backend-key-status')).toContainText('.env · OPENAI_API_KEY');
  await expect(page.getByRole('tabpanel')).toContainText('새 테스트부터 적용됩니다.');
  expect(await page.evaluate(() => (window as any).__native.backendSaved[0])).toEqual({ ...expected, runDefaults: {
    budgetUsd: 10, exploreMinutes: 40, maxPages: 30, maxTemplates: 8, turnsPerTemplate: 25,
    maxTurns: 40, pagesPerTemplate: 3, concurrency: 1, workers: 1, planEffort: 'medium', sessions: 'template',
  } });
  expect(await page.evaluate(() => (window as any).__native.saved.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).__native.tested.length)).toBe(0);
  expect(await page.evaluate(() => Object.values(localStorage).join('') + Object.values(sessionStorage).join(''))).not.toContain('sk-backend-openai-only');
  await page.screenshot({ path: 'screenshots/backend-settings.png', animations: 'disabled' });
  await visualTab.click();
  await expect(page.getByRole('combobox', { name: 'AI 선택', exact: true })).toHaveValue('anthropic');
  await expect(page.getByLabel('Anthropic API 키', { exact: true })).toHaveValue('');
  await page.getByRole('combobox', { name: 'AI 선택', exact: true }).selectOption('openai');
  await expect(page.getByRole('combobox', { name: '모델 선택', exact: true })).toHaveValue('gpt-6-luna');
  await expect(page.getByLabel('OpenAI API 키', { exact: true })).toHaveAttribute('placeholder', /••••test/);
  await page.screenshot({ path: 'screenshots/visual-settings-role.png', animations: 'disabled' });
  await backendTab.click();
  await expect(page.getByRole('combobox', { name: '백엔드 AI 선택', exact: true })).toHaveValue('openai');
  await expect(page.getByRole('combobox', { name: '계획·탐색 모델', exact: true })).toHaveValue('gpt-6.2-astra');
  await expect(page.getByRole('combobox', { name: '판정·보고서 모델', exact: true })).toHaveValue('gpt-6.2-sol');
});

test('backend provider switching discards draft keys and preserves independent saved model pairs', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  const provider = page.getByRole('combobox', { name: '백엔드 AI 선택', exact: true });
  await page.getByRole('combobox', { name: '계획·탐색 모델', exact: true }).selectOption('claude-haiku-5-5');
  await page.getByLabel('백엔드 전용 Anthropic API 키', { exact: true }).fill('sk-unsaved-backend-anthropic');
  await provider.selectOption('openai');
  await expect(page.getByLabel('백엔드 전용 OpenAI API 키', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '백엔드 연결 확인', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: '계획·탐색 모델', exact: true }).selectOption('gpt-6.1-terra');
  await page.getByLabel('백엔드 전용 OpenAI API 키', { exact: true }).fill('sk-backend-openai-saved');
  await page.getByRole('button', { name: '백엔드 설정 저장', exact: true }).click();
  await expect(page.getByLabel('백엔드 전용 OpenAI API 키', { exact: true })).toHaveValue('');
  await provider.selectOption('anthropic');
  await expect(page.getByRole('combobox', { name: '계획·탐색 모델', exact: true })).toHaveValue('claude-haiku-5-5');
  await expect(page.getByLabel('백엔드 전용 Anthropic API 키', { exact: true })).toHaveValue('');
  await page.getByLabel('백엔드 전용 Anthropic API 키', { exact: true }).fill('sk-ant-backend-saved');
  await page.getByRole('button', { name: '백엔드 설정 저장', exact: true }).click();
  await expect(page.getByLabel('백엔드 전용 Anthropic API 키', { exact: true })).toHaveValue('');
  await provider.selectOption('openai');
  await expect(page.getByRole('combobox', { name: '계획·탐색 모델', exact: true })).toHaveValue('gpt-6.1-terra');
  await expect(page.getByLabel('백엔드 전용 OpenAI API 키', { exact: true })).toHaveAttribute('placeholder', /••••back/);
  expect(await page.evaluate(() => JSON.stringify((window as any).__native.backendSaved))).not.toContain('sk-unsaved-backend-anthropic');
  expect(await page.evaluate(() => (window as any).__native.saved.length)).toBe(0);
});

test('backend env-file key removal preserves environment credentials and running work disables editing', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.evaluate(() => {
    const profile = (window as any).__backendSettings.profiles.anthropic;
    profile.keyConfigured = true; profile.source = 'environment';
  });
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  await expect(page.locator('.backend-key-status')).toContainText('환경변수 · ANTHROPIC_API_KEY');
  await expect(page.getByRole('button', { name: '백엔드 키 삭제', exact: true })).toHaveCount(0);
  await page.getByLabel('백엔드 전용 Anthropic API 키', { exact: true }).fill('sk-ant-backend-file-only');
  await page.getByRole('button', { name: '백엔드 설정 저장', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('환경변수의 키가 우선 사용됩니다.');
  await page.getByRole('button', { name: '백엔드 키 삭제', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('환경변수의 키는 유지됩니다.');
  await expect(page.locator('.backend-key-status')).toContainText('키 설정됨');
  await expect(page.getByRole('button', { name: '백엔드 연결 확인', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__native.backendSaved.at(-1))).toEqual({ provider: 'anthropic', forgetKey: true });
  await page.keyboard.press('Escape');
  await send(page, '중단 대기 응답');
  await expect(page.getByRole('button', { name: '응답 중지', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '백엔드 AI 선택', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '계획·탐색 모델', exact: true })).toBeDisabled();
  await expect(page.getByLabel('검사 예산 (USD)', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('탐색 시간 (분)', { exact: true })).toBeDisabled();
  await page.getByText('백엔드 고급 검사 설정', { exact: true }).click();
  await expect(page.getByLabel('동시 검사 실행 수', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('백엔드 추론 수준', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('백엔드 전용 Anthropic API 키', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '백엔드 연결 확인', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '백엔드 설정 저장', exact: true })).toBeDisabled();
});

test('QA backend defaults persist and apply only to new plans while per-run overrides stay independent', async ({ page }) => {
  test.setTimeout(60000);
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 기존 검사 계획');
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toBeVisible();
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!)[0].messages.at(-1).plan.backendOptions);
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  await page.getByRole('combobox', { name: '백엔드 AI 선택', exact: true }).selectOption('openai');
  await page.getByRole('combobox', { name: '계획·탐색 모델', exact: true }).selectOption('gpt-6.2-astra');
  await page.getByRole('combobox', { name: '판정·보고서 모델', exact: true }).selectOption('gpt-6.2-sol');
  await page.getByLabel('검사 예산 (USD)', { exact: true }).fill('9.5');
  await page.getByLabel('탐색 시간 (분)', { exact: true }).fill('18');
  await page.getByLabel('최대 방문 페이지', { exact: true }).fill('14');
  await page.getByText('백엔드 고급 검사 설정', { exact: true }).click();
  for (const [label, number] of [['최대 페이지 종류', '6'], ['페이지 종류별 탐색 턴', '11'], ['대화별 최대 턴', '27'], ['종류별 검사 페이지', '2'], ['동시 탐색·판정 수', '2'], ['동시 검사 실행 수', '3']]) {
    await page.getByLabel(label, { exact: true }).fill(number);
  }
  await page.getByLabel('백엔드 추론 수준', { exact: true }).selectOption('high');
  await page.getByLabel('백엔드 탐색 묶음', { exact: true }).selectOption('cluster');
  const defaults = { budgetUsd: 9.5, exploreMinutes: 18, maxPages: 14, maxTemplates: 6, turnsPerTemplate: 11, maxTurns: 27, pagesPerTemplate: 2, concurrency: 2, workers: 3, planEffort: 'high', sessions: 'cluster' };
  const selected = { provider: 'openai', models: { plan: 'gpt-6.2-astra', triage: 'gpt-6.2-sol' } };
  await page.getByRole('button', { name: '백엔드 설정 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.backendSaved)).toEqual([{ ...selected, runDefaults: defaults }]);
  expect(await page.evaluate(() => (window as any).__native.saved)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.backendTested)).toEqual([]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!)[0].messages.at(-1).plan.backendOptions)).toEqual(original);

  await page.reload();
  await page.locator('.history-select').filter({ hasText: '기존 검사 계획' }).click();
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await expect(page.getByLabel('검사 예산 (USD)', { exact: true })).toHaveValue('10');
  await expect(page.getByLabel('백엔드 AI', { exact: true })).toHaveValue('anthropic');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  await expect(page.getByLabel('검사 예산 (USD)', { exact: true })).toHaveValue('9.5');
  await expect(page.getByRole('combobox', { name: '백엔드 AI 선택', exact: true })).toHaveValue('openai');
  await page.getByText('백엔드 고급 검사 설정', { exact: true }).click();
  await expect(page.getByLabel('백엔드 추론 수준', { exact: true })).toHaveValue('high');
  await page.getByRole('group', { name: '새 테스트의 기본 검사 설정', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'screenshots/backend-default-settings-102.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '새 채팅', exact: true }).click();
  await send(page, 'https://example.org 새 기본값 검사');
  const savedPlan = () => page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!)[0].messages.at(-1).plan.backendOptions);
  await expect.poll(savedPlan).toEqual({ ...selected, ...defaults });
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await expect(page.getByLabel('검사 예산 (USD)', { exact: true })).toHaveValue('9.5');
  await page.getByLabel('검사 예산 (USD)', { exact: true }).fill('7.25');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.requests[0])).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', backendOptions: { ...selected, ...defaults, budgetUsd: 7.25 } });
  expect(await page.evaluate(() => (window as any).__backendSettings.runDefaults)).toEqual(defaults);
  expect(await page.evaluate(() => (window as any).__native.backendSaved)).toEqual([]);
});

test('invalid QA backend defaults never reach native storage and drafts are discarded on reopen', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  await page.getByLabel('검사 예산 (USD)', { exact: true }).fill('0');
  await page.getByRole('button', { name: '백엔드 설정 저장', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('검사 예산 (USD)');
  expect(await page.evaluate(() => (window as any).__native.backendSaved)).toEqual([]);
  await page.getByLabel('검사 예산 (USD)', { exact: true }).fill('4');
  await page.getByText('백엔드 고급 검사 설정', { exact: true }).click();
  await page.getByLabel('동시 검사 실행 수', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: '백엔드 설정 저장', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('동시 검사 실행 수');
  expect(await page.evaluate(() => (window as any).__native.backendSaved)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  await expect(page.getByLabel('검사 예산 (USD)', { exact: true })).toHaveValue('10');
  await page.getByText('백엔드 고급 검사 설정', { exact: true }).click();
  await expect(page.getByLabel('동시 검사 실행 수', { exact: true })).toHaveValue('1');
});

test('unreadable backend settings remain unknown and can reload without changing visual settings', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.evaluate(() => { (window as any).__native.backendReadFails = true; });
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('tab', { name: '실제 검사 백엔드', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('백엔드 설정 상태를 확인하지 못했습니다.');
  await expect(page.locator('.backend-key-status')).toHaveCount(0);
  await expect(page.locator('#backend-api-key')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__native.backendReadFails = false; });
  await page.getByRole('button', { name: '상태 다시 확인', exact: true }).click();
  await expect(page.locator('.backend-key-status')).toContainText('키 설정 필요');
  await page.getByRole('tab', { name: '화면 표현 AI', exact: true }).click();
  await expect(page.getByLabel('OpenAI API 키', { exact: true })).toHaveAttribute('placeholder', /••••test/);
  expect(await page.evaluate(() => (window as any).__native.saved.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).__native.backendSaved.length)).toBe(0);
});

test('a saved Claude plan keeps its provider after active settings change and history reload', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('combobox', { name: 'AI 선택', exact: true }).selectOption('anthropic');
  await page.getByRole('combobox', { name: '모델 선택', exact: true }).selectOption('claude-opus-5-5');
  await page.getByLabel('Anthropic API 키', { exact: true }).fill('sk-ant-plan-fixture');
  await page.getByRole('button', { name: '연결 저장', exact: true }).click();
  await expect(page.locator('.settings-notice')).toContainText('저장했습니다');
  await page.keyboard.press('Escape');
  await send(page, 'https://example.com Claude 계획');
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toContainText('Claude Opus 5.5');
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await page.getByRole('combobox', { name: 'AI 선택', exact: true }).selectOption('openai');
  await page.getByRole('button', { name: '연결 저장', exact: true }).click();
  await expect(page.locator('.settings-notice')).toContainText('저장했습니다');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.history-select').first().click();
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.requests[0])).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', targetUrl: 'https://example.com/' });
  await expect(page.locator('.tour-plan-complete')).toBeVisible();
  const message = await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!)[0].messages.at(-1));
  expect(message).toMatchObject({ provider: 'anthropic', source: 'anthropic', model: 'claude-opus-5-5' });
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'AI 선택', exact: true })).toHaveValue('openai');
  await expect(page.locator('.usage-grid')).toContainText('200');
});

test('a plan requiring a Claude key opens that provider instead of borrowing the OpenAI key', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 키 분리 확인');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await page.getByLabel('화면 표현 AI', { exact: true }).selectOption('anthropic');
  await expect(page.getByLabel('화면 표현 모델', { exact: true })).toHaveValue('claude-haiku-5-5');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'AI 선택', exact: true })).toHaveValue('anthropic');
  await expect(page.getByRole('button', { name: '연결 확인', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  await page.getByLabel('Anthropic API 키', { exact: true }).fill('sk-ant-only-for-plan');
  await page.getByRole('button', { name: '연결 저장', exact: true }).click();
  await expect(page.locator('.settings-notice')).toContainText('저장했습니다');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.requests[0])).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
});

test('URL dialog, multiline input and Korean IME do not send prematurely', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: '웹사이트 URL 추가' }).click();
  await page.getByLabel('살펴볼 웹사이트 주소').fill('example.com');
  await page.getByRole('button', { name: '메시지에 추가' }).click();
  const input = page.getByRole('textbox', { name: '메시지', exact: true });
  await expect(input).toHaveValue('https://example.com/');
  await input.press('End');
  await input.press('Shift+Enter');
  await input.press('a');
  await expect(input).toHaveValue('https://example.com/\na');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(page.locator('.history-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'QA팀 설정', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'API 및 앱 설정' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('simultaneous chat streams stay isolated when switching conversations', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, '첫 번째 대화');
  await page.getByRole('button', { name: '새 채팅' }).click();
  await send(page, '두 번째 대화');
  await expect(page.locator('.user-bubble')).toHaveText('두 번째 대화');
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
  await page.locator('.history-select').filter({ hasText: '첫 번째 대화' }).click();
  await expect(page.locator('.user-bubble')).toHaveText('첫 번째 대화');
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
  await expect(page.locator('.assistant-message')).toHaveCount(1);
  expect(await page.evaluate(() => new Set((window as any).__native.requests.map((request: any) => request.requestId)).size)).toBe(2);
});

test('pending tour settings update URL and model with backend following; login controls remain optional and masked', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 메뉴를 둘러봐 줘');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await page.getByLabel('대상 URL', { exact: true }).fill('https://example.org/updated');
  await page.getByLabel('실제 백엔드 검사 요구사항', { exact: true }).fill('새 사이트의 메뉴를 확인해 줘');
  await page.getByLabel('화면 표현 모델', { exact: true }).selectOption('gpt-6.2-sol');
  await expect(page.getByLabel('탐색 횟수', { exact: true })).toHaveCount(0);
  const login = page.getByRole('checkbox', { name: '로그인 계정 사용' });
  await login.check();
  await expect(page.getByLabel('사이트 비밀번호', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByLabel('사이트 아이디', { exact: true }).fill('unused-account-744');
  await page.getByLabel('사이트 비밀번호', { exact: true }).fill('unused-secret-388');
  await login.uncheck();
  await expect(login).not.toBeChecked();
  await expect(page.getByLabel('사이트 비밀번호', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const plan = page.getByRole('region', { name: '버그 탐색 계획' });
  await expect(plan).toContainText('https://example.org/updated');
  await expect(plan).toContainText('백엔드 진행 따라가기');
  await expect(plan).toContainText('계정 미지정 · 로그인 화면 확인 가능');
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.requests[0])).toMatchObject({ targetUrl: 'https://example.org/updated', model: 'gpt-6.2-sol' });
  expect(await page.evaluate(() => (window as any).__native.requests[0].messages.at(-1).content)).toContain('새 사이트의 메뉴를 확인해 줘');
  expect(await page.evaluate(() => (window as any).__native.requests[0].credentials)).toBeUndefined();
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
});

test('per-run backend parameters reach native execution exactly and survive history and retry independently of visual settings', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 실제 검사 설정');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await page.getByLabel('실제 백엔드 검사 요구사항', { exact: true }).fill('검색 결과와 상세 화면을 확인해 주세요.');
  await page.getByLabel('백엔드 AI', { exact: true }).selectOption('openai');
  await page.getByLabel('백엔드 계획·탐색 모델', { exact: true }).selectOption('gpt-6.2-astra');
  await page.getByLabel('백엔드 판정·보고서 모델', { exact: true }).selectOption('gpt-6.2-sol');
  await page.getByLabel('검사 예산 (USD)', { exact: true }).fill('2.5');
  await page.getByLabel('탐색 시간 (분)', { exact: true }).fill('9');
  await page.getByLabel('최대 방문 페이지', { exact: true }).fill('7');
  await page.getByText('백엔드 고급 검사 설정', { exact: true }).click();
  for (const [label, number] of [['최대 페이지 종류', '4'], ['페이지 종류별 탐색 턴', '12'], ['대화별 최대 턴', '31'], ['종류별 검사 페이지', '2'], ['동시 탐색·판정 수', '2'], ['동시 검사 실행 수', '3']]) await page.getByLabel(label, { exact: true }).fill(number);
  await page.getByLabel('백엔드 추론 수준', { exact: true }).selectOption('high');
  await page.getByLabel('백엔드 탐색 묶음', { exact: true }).selectOption('cluster');
  await expect(page.getByLabel('탐색 횟수', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  const expected = { provider: 'openai', models: { plan: 'gpt-6.2-astra', triage: 'gpt-6.2-sol' }, budgetUsd: 2.5, exploreMinutes: 9, maxPages: 7, maxTemplates: 4, turnsPerTemplate: 12, maxTurns: 31, pagesPerTemplate: 2, concurrency: 2, workers: 3, planEffort: 'high', sessions: 'cluster' };
  const plan = page.getByRole('region', { name: '버그 탐색 계획' });
  await expect(plan).toContainText('예산 $2.5 · 탐색 9분 · 최대 7페이지');
  await page.screenshot({ path: 'screenshots/backend-test-plan.png', animations: 'disabled' });
  await page.reload();
  await page.locator('.history-select').filter({ hasText: 'https://example.com' }).click();
  await page.evaluate(() => { (window as any).__native.failNext = true; });
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible();
  const first = await page.evaluate(() => (window as any).__native.requests[0]);
  expect(first).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', backendTask: '검색 결과와 상세 화면을 확인해 주세요.', backendOptions: expected });
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__native.requests[1].backendOptions)).toEqual(expected);
  expect(await page.evaluate(() => (window as any).__native.backendSaved)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.saved)).toEqual([]);
});

test('invalid backend settings do not apply and a delayed settings read cannot create duplicate plans', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.evaluate(() => {
    const host = window as any;
    const read = host.pilotDesktop.getBackendSettings;
    host.__reads = 0;
    host.pilotDesktop.getBackendSettings = () => new Promise(resolve => { host.__reads++; host.__releaseBackend = async () => resolve(await read()); });
  });
  const input = page.getByRole('textbox', { name: '메시지', exact: true });
  await input.fill('https://example.com 지연된 설정 확인');
  await input.press('Enter');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as any).__reads)).toBe(1);
  await page.evaluate(() => (window as any).__releaseBackend());
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toHaveCount(1);
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await page.getByLabel('검사 예산 (USD)', { exact: true }).fill('0');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByLabel('검사 예산 (USD)', { exact: true }).evaluate((node: HTMLInputElement) => node.validity.valid)).toBe(false);
  await page.getByLabel('검사 예산 (USD)', { exact: true }).fill('4');
  await page.getByLabel('백엔드 계획·탐색 모델', { exact: true }).selectOption('__custom');
  await page.getByLabel('백엔드 계획·탐색 모델 ID', { exact: true }).fill('../private');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('백엔드 AI와 계획·판정 모델 ID');
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
});

test('Markdown URL and multiple priority instructions reach the native agent with draft text intact', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  const prompt = '[http://127.0.0.1:5173/](http://127.0.0.1:5173/)에서 로그인 화면을 먼저 확인해 줘.\n그다음 공지사항과 글쓰기 입력을 확인해 줘.\n제목은 QA 입력 확인, 본문은 다음 두 줄로 입력해 줘:\n첫 번째 줄\n두 번째 줄';
  await send(page, prompt);
  const plan = page.getByRole('region', { name: '버그 탐색 계획' });
  await expect(plan.locator('.tour-plan-url')).toHaveText('http://127.0.0.1:5173/');
  await expect(plan).toContainText('읽기·검색·화면 조작');
  await expect(plan).toContainText('백엔드 진행 따라가기');
  await expect(plan).toContainText('검사 종료까지 현재 위치·단계 표시');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__native.requests[0]);
  expect(request.targetUrl).toBe('http://127.0.0.1:5173/');
  expect(request).not.toHaveProperty('maxActions');
  expect(request.messages.at(-1).content).toContain(prompt);
  expect(request.credentials).toBeUndefined();
});

test('prompt credentials stay transient and are sent only in the dedicated native field', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  const credentials = { username: 'account-744', password: 'secret-388' };
  await send(page, `https://example.com 로그인해서 메뉴를 둘러봐 줘\n아이디: ${credentials.username}\n비밀번호: ${credentials.password}`);
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toContainText('실제 검사와 화면 표현에 적용');
  await expect(page.locator('.conversation-content')).not.toContainText(credentials.password);
  await expect(page.locator('.conversation-content')).not.toContainText(credentials.username);
  const before = await page.evaluate(() => localStorage.getItem('webpilot.conversations.v1')!);
  expect(before).not.toContain(credentials.password);
  expect(before).not.toContain(credentials.username);
  expect(before).not.toContain('"credentials"');
  expect(JSON.parse(before)[0].messages.find((message: any) => message.plan).plan.loginEnabled).toBe(true);
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__native.requests[0]);
  expect(request.credentials).toEqual(credentials);
  expect(JSON.stringify(request.messages)).not.toContain(credentials.password);
  expect(JSON.stringify(request.messages)).not.toContain(credentials.username);
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('webpilot.conversations.v1')!)).not.toContain(credentials.password);
});

test('account-bearing URLs are rejected before plan storage while ordinary admin routes remain usable', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com/login?token=%73ecret-912 로그인해 줘\nusername: admin\npassword: secret-912');
  await expect(page.getByRole('alert')).toContainText('계정 정보를 포함할 수 없습니다');
  await expect(page.locator('.history-item')).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('ecret-912');
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('');
  await send(page, 'https://example.com/admin/login 로그인해 줘\nusername: admin\npassword: secret-912');
  await expect(page.locator('.tour-plan-url')).toHaveText('https://example.com/admin/login');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  for (const url of ['/login?account=admin', '/login#account=admin', '/%73ecret-912/login']) {
    await page.getByLabel('로그인 URL', { exact: true }).fill(url);
    await page.getByRole('button', { name: '설정 적용', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('계정 정보를 포함할 수 없습니다');
  }
  await page.getByLabel('로그인 URL', { exact: true }).fill('/admin/login');
  await page.getByLabel('대상 URL', { exact: true }).fill('https://example.com/login?account=admin');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('계정 정보를 포함할 수 없습니다');
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('account=admin');
  await page.getByLabel('대상 URL', { exact: true }).fill('https://example.com/admin/login');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__native.requests[0]);
  expect(request.targetUrl).toBe('https://example.com/admin/login');
  expect(request.backendLoginUrl).toBe('https://example.com/admin/login');
  expect(request.credentials).toEqual({ username: 'admin', password: 'secret-912' });
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('secret-912');
});

test('reloading a pending login plan requires account re-entry before native execution', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 로그인해 줘\nusername: old-account-745\npassword: old-secret-389');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await page.getByLabel('로그인 URL', { exact: true }).fill('https://external.test/login');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('동일한 출처');
  await page.getByLabel('로그인 URL', { exact: true }).fill('/login');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await page.reload();
  await page.locator('.history-select').filter({ hasText: 'https://example.com' }).click();
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toContainText('계정 다시 입력 필요');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '버그 탐색 설정 바꾸기' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('로그인 계정을 다시 입력');
  await expect(page.getByRole('checkbox', { name: '로그인 계정 사용' })).toBeChecked();
  await expect(page.getByLabel('사이트 아이디', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('사이트 비밀번호', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('사이트 비밀번호', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('로그인 URL', { exact: true })).toHaveValue('https://example.com/login');
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  await page.getByLabel('사이트 아이디', { exact: true }).fill('new-account-746');
  await page.getByLabel('사이트 비밀번호', { exact: true }).fill('new-secret-390');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.requests[0].credentials)).toEqual({ username: 'new-account-746', password: 'new-secret-390' });
  expect(await page.evaluate(() => (window as any).__native.requests[0].backendLoginUrl)).toBe('https://example.com/login');
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('new-secret-390');
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
});

test('finalizing tour can be stopped and cannot emit a late summary', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 둘러보고 정리 중 중단');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.locator('.agent-activity-finalizing')).toBeVisible();
  await expect(page.getByText('버그 탐색 보고서를 준비하고 있습니다...')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__native.overlayEnds.length)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '응답 중지' }).click();
  await expect(page.locator('.agent-activity-cancelled')).toContainText('버그 탐색을 중지했습니다');
  await expect(page.locator('.tour-plan-cancelled')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__native.cancelled.length)).toBe(1);
  await expect(page.locator('.conversation-content')).not.toContainText('확인한 내용을 대화에 정리합니다.');
});

test('partial credentials are removed from the composer and never create history or an API request', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 로그인해 줘\npassword: partial-secret-947');
  await expect(page.getByRole('alert')).toContainText('아이디와 비밀번호를 함께');
  await expect(page.getByRole('textbox', { name: '메시지', exact: true })).not.toHaveValue(/partial-secret-947/);
  await expect(page.locator('.history-item')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('partial-secret-947');
});

test('changing a login plan origin clears the original account and requires new credentials', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 로그인해 줘\nid: origin-a-account\npassword: origin-a-secret');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await expect(page.getByLabel('사이트 아이디', { exact: true })).toHaveValue('origin-a-account');
  await page.getByLabel('로그인 URL', { exact: true }).fill('/login');
  await page.getByLabel('대상 URL', { exact: true }).fill('https://example.org/new-origin');
  await expect(page.getByLabel('로그인 URL', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('사이트 아이디', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('사이트 비밀번호', { exact: true })).toHaveValue('');
  await expect(page.getByRole('alert')).toContainText('대상 사이트가 변경');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('아이디와 비밀번호를 함께');
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  await page.getByLabel('사이트 아이디', { exact: true }).fill('origin-b-account');
  await page.getByLabel('사이트 비밀번호', { exact: true }).fill('origin-b-secret');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__native.requests[0]);
  expect(request.targetUrl).toBe('https://example.org/new-origin');
  expect(request.credentials).toEqual({ username: 'origin-b-account', password: 'origin-b-secret' });
  expect(JSON.stringify(request)).not.toContain('origin-a-account');
  expect(JSON.stringify(request)).not.toContain('origin-a-secret');
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
});

test('custom model whitespace is trimmed and the pending plan survives reload', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 메뉴를 둘러봐 줘');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await page.getByLabel('화면 표현 모델', { exact: true }).selectOption('custom');
  await page.getByLabel('모델 ID', { exact: true }).fill('  gpt-6-luna  ');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!));
  expect(stored[0].messages.find((message: any) => message.plan).plan.model).toBe('gpt-6-luna');
  await page.reload();
  await page.locator('.history-select').filter({ hasText: 'https://example.com' }).click();
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toBeVisible();
  await expect(page.getByRole('button', { name: '시작하기', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.requests[0].model)).toBe('gpt-6-luna');
  await expect(page.locator('.assistant-message .message-actions')).toBeVisible();
});

test('legacy visual quota is removed on reload and retry follows the backend without a count setting', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 버그를 탐색해 줘');
  await page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem('webpilot.conversations.v1')!);
    history[0].messages.find((message: any) => message.plan).plan.maxActions = 1;
    localStorage.setItem('webpilot.conversations.v1', JSON.stringify(history));
  });
  await page.reload();
  await page.locator('.history-select').filter({ hasText: 'https://example.com' }).click();
  const plan = page.getByRole('region', { name: '버그 탐색 계획' });
  await expect(plan).toContainText('백엔드 진행 따라가기');
  await expect(plan).not.toContainText('화면 표현 횟수');
  await page.getByRole('button', { name: '설정 바꾸기', exact: true }).click();
  await expect(page.getByLabel('탐색 횟수', { exact: true })).toHaveCount(0);
  await expect(page.getByText('횟수를 정하지 않고 백엔드의 현재 탐색 위치와 단계를 따라갑니다.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('최대 방문 페이지', { exact: true })).toHaveValue('30');
  await page.getByRole('button', { name: '설정 적용', exact: true }).click();
  await page.screenshot({ path: 'screenshots/backend-follow-plan.png', animations: 'disabled' });
  expect(await page.evaluate(() => localStorage.getItem('webpilot.conversations.v1'))).not.toContain('maxActions');
  await page.evaluate(() => { (window as any).__native.failNext = true; });
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__native.requests.length)).toBe(2);
  const requests = await page.evaluate(() => (window as any).__native.requests);
  expect(requests.every((request: any) => !Object.hasOwn(request, 'maxActions'))).toBe(true);
  expect(requests.every((request: any) => request.backendOptions.maxPages === 30)).toBe(true);
});

test('completed report opens an in-app PDF viewer with rendering, pages and zoom without another request', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await nativeFixture(page);
  await page.goto('/');
  await send(page, 'https://example.com 버그 탐색');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.locator('.agent-activity-active h3')).toContainText('웹사이트 버그 탐색중...');
  const open = page.getByRole('button', { name: '보고서 열기', exact: true });
  await expect(open).toBeEnabled();
  await expect(page.locator('.message-content').last()).toContainText('버그 탐색을 완료했고 보고서를 완성했어요.');
  await expect(page.getByRole('region', { name: '버그 탐색 보고서' })).toContainText('testReport/report.pdf');
  await expect(page.locator('.conversation-content')).not.toContainText('탐방');
  await page.screenshot({ path: 'screenshots/reference-report.png', animations: 'disabled' });
  await open.click();
  const canvas = await renderedPdfCanvas(page);
  const viewer = page.getByRole('dialog', { name: 'PDF 보고서 뷰어', exact: true });
  await expect(viewer.getByText('1 / 2', { exact: true })).toBeVisible();
  await expect(viewer.getByRole('button', { name: '이전 페이지', exact: true })).toBeDisabled();
  const firstPageHash = await pdfCanvasHash(page);
  await viewer.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(viewer.getByText('2 / 2', { exact: true })).toBeVisible();
  await renderedPdfCanvas(page);
  await expect.poll(() => pdfCanvasHash(page)).not.toBe(firstPageHash);
  await expect(viewer.getByRole('button', { name: '다음 페이지', exact: true })).toBeDisabled();
  await viewer.getByRole('button', { name: '이전 페이지', exact: true }).click();
  await expect(viewer.getByText('1 / 2', { exact: true })).toBeVisible();
  await expect.poll(() => pdfCanvasHash(page)).toBe(firstPageHash);
  const initialWidth = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
  await viewer.getByRole('button', { name: '확대', exact: true }).click();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(initialWidth);
  const zoomedWidth = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
  await viewer.getByRole('button', { name: '축소', exact: true }).click();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeLessThan(zoomedWidth);
  await viewer.getByRole('button', { name: '확대', exact: true }).click();
  await viewer.getByRole('button', { name: '페이지 맞춤', exact: true }).click();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement, width: number) => Math.abs(element.width - width), initialWidth)).toBeLessThanOrEqual(2);
  await renderedPdfCanvas(page);
  await page.screenshot({ path: 'screenshots/reference-pdf-viewer.png', animations: 'disabled' });
  const reads = await page.evaluate(() => (window as any).__native.reportReads as string[]);
  expect(reads.length).toBeGreaterThan(0);
  expect(new Set(reads)).toEqual(new Set(['12345678-1234-4234-8234-123456789abc']));
  expect(await page.evaluate(() => (window as any).__native.reportOpens)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('webpilot.conversations.v1')!)).not.toContain('%PDF');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeEnabled();
  await page.reload();
  await page.locator('.history-select').filter({ hasText: 'https://example.com' }).click();
  await expect(open).toBeEnabled();
  await open.click();
  await renderedPdfCanvas(page);
  expect(await page.evaluate(() => (window as any).__native.reportReads.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__native.reportOpens)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.requests)).toEqual([]);
  await page.getByRole('button', { name: 'PDF 뷰어 닫기', exact: true }).click();
  await expect(viewer).toHaveCount(0);
});

for (const layout of [
  { name: 'portrait', width: 400, height: 560 },
  { name: 'landscape', width: 1200, height: 560 },
]) test(`PDF ${layout.name} layout settles without loading flicker and preserves a scrolled page during zoom`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await nativeFixture(page, true, layout);
  await page.goto('/');
  await trackPdfLayout(page);
  await send(page, 'https://example.com PDF 안정성 확인');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '응답 중지', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '보고서 열기', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'PDF 보고서 뷰어', exact: true });
  const canvas = await renderedPdfCanvas(page);
  const viewport = viewer.locator('.pdf-viewport');
  // Observe an idle frame window: no user action may trigger fresh canvas
  // replacement, busy cycling, scrollbar-width oscillation or paper dimming.
  await page.evaluate(() => { (window as any).__pdfLayouts = []; });
  await page.evaluate(async () => { for (let frame = 0; frame < 60; frame++) await new Promise(requestAnimationFrame); });
  const idle = await page.evaluate(() => (window as any).__pdfLayouts as { busy: string; canvas: number; width: number; opacity: string; scrollHeight: number; height: number }[]);
  await testInfo.attach(`pdf-${layout.name}-idle-layout`, { body: JSON.stringify(idle, null, 2), contentType: 'application/json' });
  expect.soft(new Set(idle.filter(sample => sample.canvas).map(sample => sample.canvas)).size, 'Idle PDF must not continuously replace its canvas.').toBeLessThanOrEqual(1);
  expect.soft(new Set(idle.map(sample => sample.width)).size, 'Loading status must not toggle the viewport scrollbar width.').toBeLessThanOrEqual(1);
  expect.soft(idle.filter(sample => sample.canvas && sample.opacity !== '1').length, 'A rendered page must stay fully visible while its replacement is prepared.').toBe(0);
  await expect(viewport).toHaveAttribute('aria-busy', 'false');
  // Grow the page beyond the viewport, then retain the reader's position as
  // both zoom and viewport size change. Page navigation still starts at top.
  for (let step = 0; step < 4; step++) {
    const width = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
    await viewer.getByRole('button', { name: '확대', exact: true }).click();
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(width);
    await expect(viewport).toHaveAttribute('aria-busy', 'false');
  }
  await viewport.evaluate(element => { element.scrollTop = 130; });
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(130);
  const width = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
  await viewer.getByRole('button', { name: '확대', exact: true }).click();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(width);
  await expect(viewport).toHaveAttribute('aria-busy', 'false');
  expect.soft(await viewport.evaluate(element => element.scrollTop), 'Zoom must not return a scrolled document to its top.').toBeGreaterThan(100);
  await viewport.evaluate(element => { element.scrollTop = 130; });
  await page.setViewportSize({ width: 980, height: 650 });
  await page.evaluate(async () => { for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame); });
  await expect(viewport).toHaveAttribute('aria-busy', 'false');
  expect.soft(await viewport.evaluate(element => element.scrollTop), 'Resizing must not return a scrolled document to its top.').toBeGreaterThan(100);
  await viewer.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(viewer.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-label', 'PDF 2페이지');
  await expect(viewport).toHaveAttribute('aria-busy', 'false');
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBe(0);
  const finalLayouts = await page.evaluate(() => (window as any).__pdfLayouts as { busy: string; canvas: number; opacity: string }[]);
  expect.soft(finalLayouts.filter(sample => sample.busy === 'true' && sample.canvas && sample.opacity !== '1').length, 'Zoom and page transitions must retain the previous page without flashing it dim.').toBe(0);
  await testInfo.attach(`pdf-${layout.name}-final-layout`, { body: JSON.stringify(finalLayouts, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: `screenshots/reference-pdf-stable-${layout.name}.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('missing report loads later and an in-app PDF read failure can retry without another AI request', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.evaluate(() => { (window as any).__native.reportUnavailable = true; });
  await send(page, 'https://example.com 버그 탐색');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  const reloadReport = page.getByRole('button', { name: '다시 불러오기', exact: true });
  await expect(reloadReport).toBeEnabled();
  await expect(page.locator('.message-content').last()).not.toContainText('보고서를 완성했어요');
  await expect(page.getByRole('button', { name: '보고서 열기', exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__native.reportUnavailable = false; });
  await reloadReport.click();
  const open = page.getByRole('button', { name: '보고서 열기', exact: true });
  await expect(open).toBeEnabled();
  await expect(page.locator('.message-content').last()).toContainText('버그 탐색을 완료했고 보고서를 완성했어요.');
  await expect(page.locator('.message-content').last()).not.toContainText('보고서를 불러오지 못했어요');
  await page.evaluate(() => { (window as any).__native.readReportFails = true; });
  await open.click();
  const viewer = page.getByRole('dialog', { name: 'PDF 보고서 뷰어', exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('alert')).toContainText('저장된 보고서를 찾을 수 없습니다');
  await expect(viewer.getByRole('button', { name: '다시 시도', exact: true })).toBeEnabled();
  const readsBeforeRetry = await page.evaluate(() => (window as any).__native.reportReads.length);
  await page.screenshot({ path: 'screenshots/reference-pdf-error.png', animations: 'disabled' });
  await page.evaluate(() => { (window as any).__native.readReportFails = false; });
  await viewer.getByRole('button', { name: '다시 시도', exact: true }).click();
  await renderedPdfCanvas(page);
  await expect(viewer.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  expect((await page.locator('.message-content').last().innerText()).split('버그 탐색을 완료했고 보고서를 완성했어요.')).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).__native.reportReads.length)).toBe(readsBeforeRetry + 1);
  expect(await page.evaluate(() => (window as any).__native.reportOpens)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.reportRefreshes)).toBe(1);
  // The saved snapshot may disappear while the original report still exists.
  // Reattaching must replace its ID, rather than retrying the unavailable ID.
  const replacementId = '87654321-4321-4321-8321-cba987654321';
  await page.evaluate(id => {
    const native = (window as any).__native;
    native.staleReportId = native.reportId;
    native.reportId = id;
  }, replacementId);
  await open.click();
  await expect(viewer.getByRole('alert')).toContainText('저장된 보고서를 찾을 수 없습니다');
  await viewer.getByRole('button', { name: '보고서 다시 불러오기', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(open).toBeEnabled();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('webpilot.conversations.v1')!)[0].messages.find((message: any) => message.report)?.report.id)).toBe(replacementId);
  await open.click();
  await renderedPdfCanvas(page);
  expect(await page.evaluate(() => (window as any).__native.reportReads.at(-1))).toBe(replacementId);
  expect(await page.evaluate(() => (window as any).__native.reportRefreshes)).toBe(2);
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__native.reportOpens)).toEqual([]);
  await page.getByRole('button', { name: 'PDF 뷰어 닫기', exact: true }).click();
});

test('failed work can restart with the same settings and attach a report only after success', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.evaluate(() => { (window as any).__native.failNext = true; });
  await send(page, 'https://example.com 버그 탐색');
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.locator('.tour-plan-error')).toBeVisible();
  await expect(page.locator('.message-content').last()).toContainText('응답을 받지 못했습니다. 일시적인 연결 오류입니다. 다시 시도해 주세요.');
  await expect(page.getByRole('region', { name: '버그 탐색 보고서' })).toHaveCount(0);
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.getByRole('button', { name: '보고서 열기', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__native.requests.map((request: any) => [request.targetUrl, request.model, Object.hasOwn(request, 'maxActions')]))).toEqual(Array(2).fill(['https://example.com/', 'gpt-6-luna', false]));
  await expect(page.locator('.tour-plan-complete')).toBeVisible();
});

test('long saved conversation keeps the window fixed while scrolling, expanding captures and resizing', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 850 });
  await nativeFixture(page);
  await page.addInitScript(() => {
    const now = new Date().toISOString();
    const assistant = {
      id: 'long-assistant', role: 'assistant', status: 'complete', source: 'openai', model: 'gpt-6-luna', createdAt: now,
      content: Array.from({ length: 28 }, (_, index) => `${index + 1}. 사이트 내부 메뉴를 탐색하며 관찰한 화면과 동작을 기록했습니다. 긴 대화를 다시 열어도 상단 도구와 입력창은 화면 안에 유지되어야 합니다.`).join('\n\n'),
      steps: Array.from({ length: 18 }, (_, index) => ({ id: `step-${index}`, label: `탐색 단계 ${index + 1}: 내부 페이지 확인 및 화면 수집 완료`, state: 'complete' })),
      captures: Array.from({ length: 6 }, (_, index) => ({ id: `layout-capture-${index + 1}`, url: `https://example.com/section/${index + 1}?path=${'long-page-name-'.repeat(12)}`, index: index + 1, createdAt: now })),
      usage: { inputTokens: 800, outputTokens: 600, totalTokens: 1400 },
    };
    localStorage.setItem('webpilot.conversations.v1', JSON.stringify([{
      id: 'long-conversation', title: '여섯 장의 캡처가 있는 긴 대화', createdAt: now, updatedAt: now,
      messages: [{ id: 'long-user', role: 'user', content: '사이트를 탐색한 전체 결과를 보여 주세요.', createdAt: now }, assistant],
    }]));
  });
  await page.goto('/');
  await page.locator('.history-select').filter({ hasText: '여섯 장의 캡처가 있는 긴 대화' }).click();
  await expect(page.locator('.capture-card')).toHaveCount(6);
  await expect(page.locator('.agent-step')).toHaveCount(18);
  await expect(page.getByRole('button', { name: '스크린샷 1 확대', exact: true })).toBeEnabled();

  const geometry = () => page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right };
    };
    const scroll = document.querySelector('.conversation-scroll')!;
    const liveRegion = document.querySelector('.conversation-content > [aria-live]') as HTMLElement;
    return {
      viewport: { width: innerWidth, height: innerHeight }, documentHeight: document.documentElement.scrollHeight, documentWidth: document.documentElement.scrollWidth,
      windowScrollY: scrollY, topbar: rect('.topbar'), sidebar: rect('.sidebar'), composer: rect('.composer-area.docked'),
      scroller: { ...rect('.conversation-scroll'), scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight },
      liveRegion: { offsetParent: liveRegion?.offsetParent?.className || liveRegion?.offsetParent?.tagName, top: liveRegion?.getBoundingClientRect().top },
    };
  });
  const checkLayout = async (stage: string) => {
    const measured = await geometry();
    await testInfo.attach(stage, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
    expect.soft(measured.documentHeight, `${stage}: only the conversation should scroll`).toBeLessThanOrEqual(measured.viewport.height + 1);
    expect.soft(measured.documentWidth, `${stage}: no horizontal document overflow`).toBeLessThanOrEqual(measured.viewport.width + 1);
    expect.soft(measured.windowScrollY, `${stage}: window must not scroll`).toBe(0);
    for (const [name, bounds] of [['topbar', measured.topbar], ['sidebar', measured.sidebar], ['composer', measured.composer]] as const) {
      expect.soft(bounds.y, `${stage}: ${name} stays above the viewport bottom`).toBeGreaterThanOrEqual(-1);
      expect.soft(bounds.bottom, `${stage}: ${name} stays inside viewport`).toBeLessThanOrEqual(measured.viewport.height + 1);
      expect.soft(bounds.right, `${stage}: ${name} stays inside viewport width`).toBeLessThanOrEqual(measured.viewport.width + 1);
    }
    expect.soft(measured.scroller.scrollHeight).toBeGreaterThan(measured.scroller.clientHeight);
    return measured;
  };

  const initial = await checkLayout('opened-1440x850');
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.mouse.move(initial.scroller.x + initial.scroller.width / 2, initial.scroller.y + 70);
  await page.mouse.wheel(0, 100000);
  await expect.poll(() => page.locator('.conversation-scroll').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(2);
  // A second wheel at the bottom catches scroll chaining into the document.
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(150);
  const bottom = await checkLayout('wheel-bottom-1440x850');
  expect.soft(bottom.topbar.y).toBe(initial.topbar.y);
  expect.soft(bottom.sidebar.y).toBe(initial.sidebar.y);
  expect.soft(bottom.composer.bottom).toBe(initial.composer.bottom);

  // Reset an already-broken outer scroll so expansion is still measured in baseline runs.
  await page.evaluate(() => window.scrollTo(0, 0));
  const firstCard = page.locator('.capture-card').first();
  await page.getByRole('button', { name: '스크린샷 1 확대', exact: true }).scrollIntoViewIfNeeded();
  const collapsedWidth = (await firstCard.boundingBox())!.width;
  await page.getByRole('button', { name: '스크린샷 1 확대', exact: true }).click();
  await expect(firstCard).toHaveClass(/expanded/);
  await expect.poll(async () => (await firstCard.boundingBox())!.width).toBeGreaterThan(collapsedWidth * 1.5);
  await checkLayout('expanded-1440x850');

  await page.setViewportSize({ width: 900, height: 650 });
  await page.getByRole('button', { name: '스크린샷 1 축소', exact: true }).scrollIntoViewIfNeeded();
  await checkLayout('expanded-900x650');
  await page.getByRole('button', { name: '스크린샷 1 축소', exact: true }).click();
  await expect(firstCard).not.toHaveClass(/expanded/);
  await checkLayout('collapsed-900x650');
  await page.getByRole('textbox', { name: '메시지', exact: true }).fill('축소한 창에서도 이어서 입력할 수 있습니다.');
  await expect(page.getByRole('button', { name: '메시지 보내기' })).toBeEnabled();
});

test('reference welcome, plan and active views render at 1280x720 without opening a real site', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await nativeFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '오늘 어떤 도움을 드릴까요?' })).toBeVisible();
  await expect(page.getByRole('button', { name: '새 채팅', exact: true })).toContainText('새로 만들기');
  await page.screenshot({ path: 'screenshots/reference-welcome.png', animations: 'disabled' });
  await send(page, 'https://example.com 웹사이트의 주요 메뉴와 검색을 확인해 주세요.');
  await expect(page.getByRole('table', { name: '테스트 설정', exact: true })).toBeVisible();
  await finishEntryMotion(page);
  await page.screenshot({ path: 'screenshots/reference-plan.png', animations: 'disabled' });
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(0);
  await page.evaluate(() => { (window as any).__native.holdActivity = true; });
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.locator('.agent-activity-active')).toBeVisible();
  await expect(page.locator('.user-bubble').last()).toContainText('네, 시작해 주세요.');
  await expect(page.locator('.agent-activity-acting')).toBeVisible();
  await page.screenshot({ path: 'screenshots/reference-active.png', animations: 'disabled' });
  await page.getByRole('button', { name: '응답 중지' }).click();
  await expect(page.locator('.agent-activity-cancelled')).toBeVisible();
});

test('new plans animate once while history revisits and reloads remain static', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await nativeFixture(page);
  await trackEntryMotion(page);
  await page.goto('/');
  await send(page, 'https://example.com/first 새 계획');
  await expect(page.locator('.reference-plan--animate')).toBeVisible();
  await expect(page.locator('.assistant-message.message-enter')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__motion.starts.includes('plan-card-enter'))).toBe(true);
  await finishEntryMotion(page);
  const firstStarts = await page.evaluate(() => (window as any).__motion.starts.filter((name: string) => name.startsWith('plan-')).length);
  expect(firstStarts).toBeGreaterThan(1);
  await page.getByRole('button', { name: '새 채팅', exact: true }).click();
  await page.locator('.history-select').filter({ hasText: 'https://example.com/first' }).click();
  await expect(page.locator('.reference-plan')).toBeVisible();
  await expect(page.locator('.reference-plan--animate')).toHaveCount(0);
  await expect(page.locator('.message-enter')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__motion.starts.filter((name: string) => name.startsWith('plan-')).length)).toBe(firstStarts);
  await page.getByRole('button', { name: '새 채팅', exact: true }).click();
  await send(page, 'https://example.org/second 두 번째 계획');
  await expect(page.locator('.reference-plan--animate')).toBeVisible();
  await finishEntryMotion(page);
  const secondStarts = await page.evaluate(() => (window as any).__motion.starts.filter((name: string) => name.startsWith('plan-')).length);
  expect(secondStarts).toBeGreaterThan(firstStarts);
  await page.locator('.history-select').filter({ hasText: 'https://example.com/first' }).click();
  await expect(page.locator('.reference-plan--animate')).toHaveCount(0);
  await expect(page.locator('.message-enter')).toHaveCount(0);
  await page.reload();
  await page.locator('.history-select').filter({ hasText: 'https://example.com/first' }).click();
  await expect(page.locator('.reference-plan')).toBeVisible();
  await expect(page.locator('.reference-plan--animate')).toHaveCount(0);
  await expect(page.locator('.message-enter')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__motion.starts.filter((name: string) => name.startsWith('plan-') || name.startsWith('message-')))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(0);
});

test('reduced motion disables entry and active animations including WAAPI transitions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await nativeFixture(page);
  await trackEntryMotion(page);
  await page.goto('/');
  await send(page, 'https://example.com 움직임 줄이기 검증');
  await expect(page.getByRole('region', { name: '버그 탐색 계획' })).toBeVisible();
  const activeAnimations = () => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' || animation.pending).length);
  expect(await activeAnimations()).toBe(0);
  expect(await page.locator('.reference-plan-frame').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.evaluate(() => { (window as any).__native.holdActivity = true; });
  await page.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.locator('.agent-activity-active')).toBeVisible();
  expect(await activeAnimations()).toBe(0);
  expect(await page.locator('.agent-activity-thinking-dots i').evaluateAll(elements => elements.map(element => getComputedStyle(element).animationName))).toEqual(['none', 'none', 'none']);
  expect(await page.evaluate(() => (window as any).__motion.waapiCalls)).toBe(0);
  await page.getByRole('button', { name: '응답 중지' }).click();
  await expect(page.locator('.agent-activity-cancelled')).toBeVisible();
  expect(await activeAnimations()).toBe(0);
});

test('entry transforms and resizing never create an outer scrollbar or move fixed controls off screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await nativeFixture(page);
  await trackEntryMotion(page);
  await page.goto('/');
  await page.evaluate(() => {
    const host = window as any;
    const start = performance.now();
    const probe = host.__entryLayout = { samples: 0, maxHeightOverflow: 0, maxWidthOverflow: 0, maxWindowScroll: 0, minControlTop: 0, maxControlBottomOverflow: 0, done: false };
    const sample = () => {
      probe.samples++;
      probe.maxHeightOverflow = Math.max(probe.maxHeightOverflow, document.documentElement.scrollHeight - innerHeight, document.body.scrollHeight - innerHeight);
      probe.maxWidthOverflow = Math.max(probe.maxWidthOverflow, document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth);
      probe.maxWindowScroll = Math.max(probe.maxWindowScroll, Math.abs(scrollY));
      for (const element of document.querySelectorAll('.topbar,.sidebar,.composer-area')) {
        const rect = element.getBoundingClientRect();
        probe.minControlTop = Math.min(probe.minControlTop, rect.top);
        probe.maxControlBottomOverflow = Math.max(probe.maxControlBottomOverflow, rect.bottom - innerHeight);
      }
      if (performance.now() - start < 1900) requestAnimationFrame(sample); else probe.done = true;
    };
    requestAnimationFrame(sample);
  });
  await send(page, `https://example.com/${'long-page-segment-'.repeat(80)} 긴 주소와 진입 효과 검증`);
  await expect(page.locator('.reference-plan--animate')).toBeVisible();
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(page.getByRole('button', { name: '시작하기', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => page.evaluate(() => (window as any).__entryLayout.done)).toBe(true);
  const measurements = await page.evaluate(() => (window as any).__entryLayout);
  await testInfo.attach('entry-layout-per-frame', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  expect(measurements.samples).toBeGreaterThan(5);
  expect(measurements.maxHeightOverflow).toBeLessThanOrEqual(1);
  expect(measurements.maxWidthOverflow).toBeLessThanOrEqual(1);
  expect(measurements.maxWindowScroll).toBe(0);
  expect(measurements.minControlTop).toBeGreaterThanOrEqual(-1);
  expect(measurements.maxControlBottomOverflow).toBeLessThanOrEqual(1);
});

test('report sidebar filters ready and missing reports and narrow report cards stay within bounds', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await nativeFixture(page);
  await page.addInitScript(() => {
    const now = '2026-11-25T09:00:00.000Z';
    const ready = { status: 'ready', id: '12345678-1234-4234-8234-123456789abc', name: 'report.pdf', size: 2830568, updatedAt: now };
    const missing = { status: 'missing', message: 'testReport/report.pdf 파일을 찾을 수 없습니다.' };
    const conversation = (id: string, title: string, report?: any) => ({ id, title, createdAt: now, updatedAt: now, messages: [
      { id: id + '-user', role: 'user', content: title, createdAt: now },
      { id: id + '-assistant', role: 'assistant', status: 'complete', source: 'openai', model: 'gpt-6-luna', content: report?.status === 'ready' ? '버그 탐색을 완료했고 보고서를 완성했어요.' : report ? '보고서를 불러오지 못했어요.' : '일반 질문에 대한 응답입니다.', createdAt: now, ...(report ? { report } : {}) },
    ] });
    localStorage.setItem('webpilot.conversations.v1', JSON.stringify([
      conversation('ready-chat', 'https://example.com 완료 보고서', ready),
      conversation('missing-chat', 'https://example.org 보고서 대기', missing),
      conversation('plain-chat', '보고서가 없는 일반 질문'),
    ]));
  });
  await page.goto('/');
  await expect(page.locator('.history-item')).toHaveCount(3);
  await page.getByRole('button', { name: '보고서', exact: true }).click();
  await expect(page.locator('.history-item')).toHaveCount(2);
  await expect(page.locator('.history-list')).not.toContainText('보고서가 없는 일반 질문');
  await page.getByRole('textbox', { name: '대화 검색' }).fill('example.org');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await page.locator('.history-select').click();
  await expect(page.getByRole('button', { name: '다시 불러오기', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '대화 검색' }).fill('');
  await page.locator('.history-select').filter({ hasText: 'https://example.com' }).click();
  await expect(page.getByRole('button', { name: '보고서 열기', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 900, height: 650 });
  const bounds = await page.locator('.report-card').evaluate(element => {
    const card = element.getBoundingClientRect();
    const button = element.querySelector('button')!.getBoundingClientRect();
    return { cardLeft: card.left, cardRight: card.right, cardWidth: card.width, scrollWidth: element.scrollWidth, buttonLeft: button.left, buttonRight: button.right, width: innerWidth, pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight, height: innerHeight };
  });
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.cardWidth + 1);
  expect(bounds.cardLeft).toBeGreaterThanOrEqual(0);
  expect(bounds.cardRight).toBeLessThanOrEqual(bounds.width);
  expect(bounds.buttonLeft).toBeGreaterThanOrEqual(bounds.cardLeft);
  expect(bounds.buttonRight).toBeLessThanOrEqual(bounds.cardRight);
  expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.width);
  expect(bounds.pageHeight).toBeLessThanOrEqual(bounds.height);
  await page.screenshot({ path: 'screenshots/reference-report-narrow.png', animations: 'disabled' });
  await page.getByRole('button', { name: '검사 기록', exact: true }).click();
  await expect(page.locator('.history-item')).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).__native.requests.length)).toBe(0);
});
