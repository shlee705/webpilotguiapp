'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { _electron } = require('playwright');

async function waitForRenderedPage(page, number) {
  await page.waitForFunction(pageNumber => {
    if (document.querySelector('.pdf-viewer-error')) return true;
    if (document.querySelector('.pdf-viewport')?.getAttribute('aria-busy') !== 'false') return false;
    const canvas = document.querySelector(`canvas[aria-label="PDF ${pageNumber}페이지"]`);
    if (!canvas || !canvas.width || !canvas.height) return false;
    // A sized canvas alone does not prove the PDF worker finished rendering.
    const sample = document.createElement('canvas'); sample.width = 96; sample.height = 96;
    const context = sample.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0, 96, 96);
    const { data } = context.getImageData(0, 0, 96, 96);
    let ink = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] && Math.min(data[index], data[index + 1], data[index + 2]) < 230) ink++;
    }
    return ink > 5;
  }, number, { timeout: 30000 });
  assert.equal(await page.locator('.pdf-viewer-error').isVisible(), false, 'PDF viewer reported a rendering error.');
  return page.locator(`canvas[aria-label="PDF ${number}페이지"]`);
}

async function main() {
  const project = path.resolve(__dirname, '..');
  const source = path.join(project, 'testReport', 'report.pdf');
  const original = fs.statSync(source);
  const digest = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const originalHash = digest(source);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-report-smoke-'));
  const environment = { ...process.env, ELECTRON_DEV: '0' };
  delete environment.ELECTRON_RUN_AS_NODE;
  let desktop;
  let page;
  const rendererDiagnostics = [];
  try {
    desktop = await _electron.launch({
      ...(process.env.WEBPILOT_EXECUTABLE ? { executablePath: process.env.WEBPILOT_EXECUTABLE } : {}),
      args: [...(process.env.WEBPILOT_EXECUTABLE ? [] : [project]), `--user-data-dir=${profile}`], env: environment,
    });
    page = await desktop.firstWindow();
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) rendererDiagnostics.push({ type: message.type(), text: message.text() }); });
    page.on('pageerror', error => rendererDiagnostics.push({ type: 'pageerror', text: error.message }));
    await page.waitForSelector('#root > *');
    const configuration = await desktop.evaluate(({ app, shell }) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const path = require('node:path');
      const { resolveSourceReport } = require(path.join(app.getAppPath(), 'electron', 'reports.cjs'));
      globalThis.__reportSmoke = { originalOpenPath: shell.openPath, opened: [] };
      shell.openPath = async filename => { globalThis.__reportSmoke.opened.push(filename); return ''; };
      return { profile: app.getPath('userData'), packaged: app.isPackaged,
        source: resolveSourceReport({ appPath: app.getAppPath(), exePath: app.getPath('exe'), isPackaged: app.isPackaged }) };
    });
    assert.equal(path.resolve(configuration.profile), profile);
    assert.equal(configuration.source, source);
    if (process.env.WEBPILOT_EXECUTABLE) assert.equal(configuration.packaged, true);
    const first = await page.evaluate(() => window.pilotDesktop.refreshReport());
    assert.equal(first.status, 'ready');
    assert.equal(first.name, 'report.pdf');
    assert.equal(first.size, original.size);
    assert.equal(first.updatedAt, original.mtime.toISOString());
    assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'size', 'status', 'updatedAt']);
    const cached = path.join(profile, 'reports', `${first.id}.pdf`);
    assert.equal(digest(cached), originalHash);
    const read = await page.evaluate(async id => {
      const result = await window.pilotDesktop.readReport(id);
      if (!result.ok) return result;
      const digest = await crypto.subtle.digest('SHA-256', result.data);
      return { ok: true, isByteArray: result.data instanceof Uint8Array, size: result.data.byteLength,
        sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        keys: Object.keys(result).sort() };
    }, first.id);
    assert.deepEqual(read, { ok: true, isByteArray: true, size: original.size, sha256: originalHash, keys: ['data', 'ok'] });
    for (const invalid of [source, '../report.pdf', `${first.id}.pdf`]) {
      assert.equal((await page.evaluate(id => window.pilotDesktop.openReport(id), invalid)).ok, false);
      assert.equal((await page.evaluate(id => window.pilotDesktop.readReport(id), invalid)).ok, false);
    }
    const oversizedId = randomUUID();
    const oversizedCache = path.join(profile, 'reports', `${oversizedId}.pdf`);
    try {
      fs.writeFileSync(oversizedCache, '%PDF-1.7\n');
      fs.truncateSync(oversizedCache, 50 * 1024 * 1024 + 1);
      const oversized = await page.evaluate(id => window.pilotDesktop.readReport(id), oversizedId);
      assert.equal(oversized.ok, false, 'The native IPC must reject cached PDFs above 50MB.');
      assert.equal(Object.hasOwn(oversized, 'data'), false);
    } finally { fs.unlinkSync(oversizedCache); }

    const title = '앱 내부 PDF 보고서 검증';
    await page.evaluate(({ report, title }) => {
      const now = new Date().toISOString();
      localStorage.setItem('webpilot.conversations.v1', JSON.stringify([{
        id: 'report-viewer-smoke-conversation', title, createdAt: now, updatedAt: now,
        messages: [
          { id: 'report-viewer-user', role: 'user', content: '저장된 보고서를 앱 안에서 확인합니다.', createdAt: now, status: 'complete' },
          { id: 'report-viewer-assistant', role: 'assistant', source: 'openai', model: 'gpt-6-luna', status: 'complete', createdAt: now,
            content: '버그 탐색을 완료했고 보고서를 완성했어요.', report },
        ],
      }]));
    }, { report: first, title });
    await page.reload();
    await page.locator('.history-select').filter({ hasText: title }).click();
    await page.getByRole('button', { name: '보고서 열기', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'PDF 보고서 뷰어', exact: true });
    await viewer.waitFor({ state: 'visible' });
    await waitForRenderedPage(page, 1);
    const counter = viewer.locator('.pdf-page-picker > span');
    await counter.waitFor({ state: 'visible' });
    const totalPages = Number((await counter.innerText()).split('/')[1].trim());
    assert.equal(await viewer.getByRole('textbox', { name: '페이지 번호', exact: true }).inputValue(), '1');
    assert.ok(totalPages >= 2, 'The existing root report must have at least two pages for navigation verification.');
    assert.equal(await viewer.getByRole('button', { name: '이전 페이지', exact: true }).isDisabled(), true);
    await viewer.getByRole('button', { name: '다음 페이지', exact: true }).click();
    const secondCanvas = await waitForRenderedPage(page, 2);
    assert.equal(await viewer.getByRole('textbox', { name: '페이지 번호', exact: true }).inputValue(), '2');
    const originalWidth = await secondCanvas.evaluate(canvas => canvas.width);
    await viewer.getByRole('button', { name: '확대', exact: true }).click();
    await page.waitForFunction(width => document.querySelector('canvas[aria-label="PDF 2페이지"]')?.width > width, originalWidth);
    await waitForRenderedPage(page, 2);
    const enlargedWidth = await secondCanvas.evaluate(canvas => canvas.width);
    const screenshots = path.join(project, 'screenshots');
    fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'packaged-report-viewer.png'), animations: 'disabled' });
    await viewer.getByRole('button', { name: '축소', exact: true }).click();
    await page.waitForFunction(width => document.querySelector('canvas[aria-label="PDF 2페이지"]')?.width < width, enlargedWidth);
    await waitForRenderedPage(page, 2);
    await viewer.getByRole('button', { name: '페이지 맞춤', exact: true }).click();
    await waitForRenderedPage(page, 2);
    await viewer.getByRole('button', { name: '이전 페이지', exact: true }).click();
    await waitForRenderedPage(page, 1);
    await viewer.getByRole('button', { name: 'PDF 뷰어 닫기', exact: true }).click();
    await viewer.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '보고서 열기', exact: true }).isVisible(), true);
    const viewerOpenCalls = await desktop.evaluate(() => globalThis.__reportSmoke.opened);
    assert.deepEqual(viewerOpenCalls, [], 'The app PDF viewer must never launch an external PDF app.');

    // Optional legacy compatibility is separate from the zero-external-open viewer check.
    const legacyOpenCompatibility = process.env.WEBPILOT_TEST_EXTERNAL_OPEN_COMPAT === '1';
    if (legacyOpenCompatibility) {
      assert.deepEqual(await page.evaluate(id => window.pilotDesktop.openReport(id), first.id), { ok: true });
    }
    const second = await page.evaluate(() => window.pilotDesktop.refreshReport());
    assert.equal(second.status, 'ready');
    assert.notEqual(second.id, first.id);
    assert.equal(digest(cached), originalHash);
    assert.equal(digest(source), originalHash);
    assert.equal(fs.statSync(source).mtimeMs, original.mtimeMs);
    const opened = await desktop.evaluate(() => globalThis.__reportSmoke.opened);
    assert.deepEqual(opened, legacyOpenCompatibility ? [cached] : []);
    assert.equal(fs.readdirSync(path.join(profile, 'reports')).some(name => name.endsWith('.part')), false);
    console.log(JSON.stringify({ passed: true, packaged: configuration.packaged, reportBytes: first.size,
      ipcAttachment: true, stableSnapshots: true, sourceUnchanged: true, idOnlyOpen: true,
      ipcPdfBytes: true, oversizedCacheRejected: true, internalViewer: true, renderedPages: [1, 2], totalPages, zoom: true,
      internalViewerShellOpenCalls: viewerOpenCalls.length, legacyOpenCompatibility,
      externalViewerOpened: false, paidApiCalls: 0 }));
  } catch (error) {
    if (page) {
      const screenshots = path.join(project, 'screenshots');
      fs.mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: path.join(screenshots, 'packaged-report-viewer-failure.png'), animations: 'disabled' }).catch(() => {});
      const viewerState = await page.evaluate(() => ({
        baseURI: document.baseURI,
        busy: document.querySelector('.pdf-viewport')?.getAttribute('aria-busy'),
        viewerText: document.querySelector('.pdf-viewer')?.textContent,
        canvases: Array.from(document.querySelectorAll('.pdf-viewer canvas'), canvas => ({ label: canvas.getAttribute('aria-label'), width: canvas.width, height: canvas.height })),
      })).catch(() => null);
      console.error(JSON.stringify({ rendererDiagnostics, viewerState }));
    }
    throw error;
  } finally {
    if (desktop) {
      await desktop.evaluate(({ shell }) => {
        if (globalThis.__reportSmoke) { shell.openPath = globalThis.__reportSmoke.originalOpenPath; delete globalThis.__reportSmoke; }
      }).catch(() => {});
      await desktop.close();
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
