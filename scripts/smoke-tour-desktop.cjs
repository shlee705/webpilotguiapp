'use strict';

// Real isolated Edge + local fixture, mocked model decisions. No paid API calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { _electron } = require('playwright');

async function main() {
  const harnessStarted = performance.now();
  const project = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-dom-tour-'));
  const credentials = { username: 'tour-fixture-user', password: 'tour-fixture-password' };
  const draft = {
    title: '요청한 글쓰기 초안 제목',
    body: `첫째 줄: 사용자 요청의 순서대로 내용을 작성합니다.\r\n둘째 줄: 저장하거나 게시하지 않습니다.\r\n${'본문 입력과 줄바꿈을 확인하는 로컬 테스트입니다. '.repeat(20)}`,
    editor: `편집기 첫째 줄\n편집기 둘째 줄\n${'일반 콘텐츠 초안을 입력합니다. '.repeat(260)}`.slice(0, 4000),
  };
  const expectedActions = ['click', 'login', 'click', 'type', 'type', 'type', 'click', 'scroll'];
  const stats = { loginPosts: 0, authenticatedPages: 0, authenticatedDetails: 0, unexpectedPosts: 0, acceptedCredentials: false };
  const style = '<style>body{font:16px Arial;padding:24px;background:#f8faf5;color:#34452d}h1{font-size:23px;margin:10px 0 16px}form{display:grid;gap:6px;max-width:650px}form[hidden],section[hidden],button[hidden]{display:none}input,textarea,button,[contenteditable]{font:inherit;padding:8px;box-sizing:border-box}input,textarea,[contenteditable]{width:640px;max-width:100%;background:white;border:1px solid #8d9787}textarea,[contenteditable]{height:70px;overflow:auto;white-space:pre-wrap}button{display:block;margin:10px 0}p{line-height:1.6}</style>';
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${style}</head><body>${body}</body></html>`;
  const fixture = http.createServer(async (request, response) => {
    response.setHeader('Connection', 'close');
    if (request.method === 'POST') {
      if (request.url !== '/session') { stats.unexpectedPosts += 1; response.writeHead(405); response.end(); return; }
      stats.loginPosts += 1;
      let body = '';
      for await (const chunk of request) body += chunk;
      const values = new URLSearchParams(body);
      stats.acceptedCredentials = values.get('username') === credentials.username && values.get('password') === credentials.password;
      if (!stats.acceptedCredentials) { response.writeHead(401); response.end('Fixture login rejected'); return; }
      response.writeHead(303, { Location: '/dashboard', 'Set-Cookie': 'webpilot_fixture=verified; HttpOnly; SameSite=Lax; Path=/' });
      response.end(); return;
    }
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const authenticated = (request.headers.cookie ?? '').includes('webpilot_fixture=verified');
    if (['/dashboard', '/compose'].includes(request.url) && !authenticated) {
      response.writeHead(401); response.end('Session cookie required'); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/dashboard') {
      stats.authenticatedPages += 1;
      response.end(page('Local dashboard', `<h1>Signed in local fixture</h1><p>Welcome ${credentials.username}</p><button id="writing-entry" onclick="location.href='/compose'">게시글 작성</button>`));
    } else if (request.url === '/compose') {
      stats.authenticatedDetails += 1;
      response.end(page('Local writing fixture', '<h1>글쓰기 초안</h1><form id="draft-editor" action="/article" method="post"><label for="draft-title">제목</label><input id="draft-title" name="draft_title" type="text" aria-label="제목"><label for="draft-body">본문 초안</label><textarea id="draft-body" name="draft_body" aria-label="본문 초안"></textarea><label id="editor-label">본문 편집기</label><div id="draft-rich" contenteditable="true" role="textbox" aria-label="본문 편집기" aria-multiline="true"></div></form><button id="preview-button" onclick="document.getElementById(\'preview\').hidden=false">초안 미리보기</button><section id="preview" hidden><h2>초안 미리보기를 열었습니다</h2><div style="height:1300px">추가 화면을 살펴볼 수 있는 로컬 미리보기입니다.</div></section>'));
    } else {
      response.end(page('Local login fixture', '<h1>Local login fixture</h1><button id="login-entry" onclick="document.getElementById(\'login-form\').hidden=false;this.hidden=true">로그인 화면 열기</button><form id="login-form" hidden action="/session" method="post" aria-label="Login"><label for="account">Username</label><input id="account" name="username" type="text" autocomplete="username"><label for="secret">Password</label><input id="secret" name="password" type="password" autocomplete="current-password"><button type="submit">Log in</button></form>'));
    }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  let desktop;
  let report;
  let applicationReadyMs;
  let applicationCloseMs;
  try {
    const environment = { ...process.env, ELECTRON_DEV: '0' };
    delete environment.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({
      ...(process.env.WEBPILOT_EXECUTABLE ? { executablePath: process.env.WEBPILOT_EXECUTABLE } : {}),
      args: [...(process.env.WEBPILOT_EXECUTABLE ? [] : [project]), `--user-data-dir=${profile}`], env: environment,
    });
    const window = await desktop.firstWindow();
    await window.waitForSelector('#root > *');
    applicationReadyMs = performance.now() - harnessStarted;
    const actualProfile = await desktop.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(path.resolve(actualProfile).toLowerCase(), path.resolve(profile).toLowerCase(), 'Only the isolated test profile may be used.');
    report = await desktop.evaluate(async ({ app, BrowserWindow, globalShortcut }, input) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const { performance } = require('node:perf_hooks');
      const focusModule = require(path.join(app.getAppPath(), 'electron', 'focus-edge.cjs'));
      const originalFocus = focusModule.focusManagedEdge;
      const originalCreateFocus = focusModule.createManagedEdgeFocus;
      const focusDiagnostics = [];
      const timings = { operations: [], diagnosticProbes: [], nativeActionErrors: [], foregroundVerified: false, runMs: 0 };
      const clockStart = performance.now();
      const round = value => Math.round(value * 100) / 100;
      const probeForeground = () => {
        const started = performance.now();
        try {
          const command = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class FocusProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); }\'; $activeProcessId=[uint32]0; [void][FocusProbe]::GetWindowThreadProcessId([FocusProbe]::GetForegroundWindow(),[ref]$activeProcessId); @{pid=$activeProcessId;process=(Get-Process -Id $activeProcessId).ProcessName} | ConvertTo-Json -Compress';
          return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 8000 }).trim());
        } finally { timings.diagnosticProbes.push({ kind: 'foreground-pid', durationMs: round(performance.now() - started) }); }
      };
      const measureFocus = async (browserPid, operation) => {
        const started = performance.now();
        const record = { browserPid, ok: false, startMs: round(started - clockStart), durationMs: 0 };
        focusDiagnostics.push(record);
        try {
          // Do not inject an execute implementation: it can bypass the real
          // persistent-helper optimization that this benchmark must measure.
          const result = await operation();
          record.ok = true;
          return result;
        } catch (error) {
          try { record.foreground = probeForeground(); } catch { record.foreground = { unavailable: true }; }
          throw new Error(`${error.message} Native focus diagnostic: ${JSON.stringify(focusDiagnostics)}`);
        } finally { record.durationMs = round(performance.now() - started); }
      };
      focusModule.focusManagedEdge = browserPid => measureFocus(browserPid, () => originalFocus(browserPid));
      if (originalCreateFocus) focusModule.createManagedEdgeFocus = (...args) => {
        const control = originalCreateFocus(...args);
        const focus = control.focus.bind(control);
        return { ...control, focus: (...focusArgs) => measureFocus(args[0], () => focus(...focusArgs)) };
      };
      const measure = async (kind, detail, operation) => {
        const started = performance.now();
        const focusIndex = focusDiagnostics.length;
        let ok = false;
        try { const result = await operation(); ok = true; return result; }
        finally { timings.operations.push({ kind, detail, ok, startMs: round(started - clockStart), durationMs: round(performance.now() - started), focusCalls: focusDiagnostics.length - focusIndex, focusMs: round(focusDiagnostics.slice(focusIndex).reduce((sum, entry) => sum + entry.durationMs, 0)) }); }
      };
      const { runSiteAgent } = require(path.join(app.getAppPath(), 'electron', 'site-agent.cjs'));
      const { attachReport, getReport } = require(path.join(app.getAppPath(), 'electron', 'reports.cjs'));
      const { startSiteSession } = require(path.join(app.getAppPath(), 'electron', 'site-browser.cjs'));
      const { chromium } = require('playwright-core');
      const originalLaunch = chromium.launch;
      let managedBrowser;
      chromium.launch = async options => {
        managedBrowser = await originalLaunch.call(chromium, options);
        return managedBrowser;
      };
      const { createOverlayManager } = require(path.join(app.getAppPath(), 'electron', 'overlay.cjs'));
      const mainWindow = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith('/index.html'));
      assert.ok(mainWindow);
      const overlay = createOverlayManager(() => mainWindow);
      const controller = new AbortController();
      const events = [], requests = [], usages = [], observedUrls = [], completedActions = [];
      let silentControlChecks = 0;
      let browserClosed = false;
      let modelStep = 0;
      let modelAttempts = 0;
      let reportProviderCalls = 0;
      let pointerVerified = false;
      const fixtureChecks = { loginUiOpened: false, titleEntered: false, multilineBodyEntered: false, contentEditableEntered: false, previewOpened: false, continuedAfterFinish: false, scrolled: false };
      const assertNoSecrets = value => {
        const text = JSON.stringify(value);
        for (const secret of [input.credentials.username, input.credentials.password, encodeURIComponent(input.credentials.username), encodeURIComponent(input.credentials.password)]) {
          assert.equal(text.includes(secret), false, 'Native login values must never appear in model input or public output.');
        }
      };
      const sessionId = 'native-dom-tour-fixture';
      try {
        assert.deepEqual(await overlay.begin(sessionId), { ok: true });
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'Starting stop controls must not create an overlay window.');
        assert.equal(globalShortcut.isRegistered('Escape'), true);
        assert.deepEqual(await overlay.begin('concurrent-fixture'), { ok: true });
        assert.deepEqual(overlay.end('concurrent-fixture'), { ok: true });
        assert.equal(globalShortcut.isRegistered('Escape'), true, 'Finishing one session must preserve Escape for another.');
        const runStarted = performance.now();
        const result = await runSiteAgent({
          apiKey: 'fixture-key-never-sent-to-network', model: 'gpt-6-luna', targetUrl: input.url,
          messages: [{ role: 'user', content: `로그인 화면을 열고 제공한 계정으로 로그인하세요. 그다음 게시글 작성 화면에 들어가 제목과 여러 줄 본문을 채우고 본문 편집기에도 입력하세요. 초안 미리보기를 열고 남은 동작은 페이지를 살펴보세요. 저장하거나 게시하지 마세요. 제목: ${input.draft.title}\n본문: ${input.draft.body}\n편집기 내용: ${input.draft.editor}\n계정 ${input.credentials.username}, 비밀번호 ${input.credentials.password}` }],
          credentials: input.credentials, signal: controller.signal, maxActions: input.expectedActions.length, finalizePauseMs: 0,
          retryDelayMs: 0,
          ...(input.verifyReport ? { reportProvider: async ({ signal }) => {
            assert.equal(signal, controller.signal);
            assert.equal(browserClosed, true);
            reportProviderCalls += 1;
            return measure('attach-report', 'existing-pdf', () => attachReport({ signal }));
          } } : {}),
          onUsage: usage => usages.push(usage),
          onEvent: event => {
            assertNoSecrets(event);
            assert.notEqual(event.type, 'screenshot');
            events.push(event);
            if (event.type === 'activity') {
              overlay.updateActivity(event);
              if (event.phase === 'finalizing') { assert.equal(browserClosed, true); overlay.end(sessionId); }
            }
          },
          sessionFactory: async options => {
            assert.deepEqual(options.credentials, input.credentials);
            const session = await measure('start-session', 'isolated-edge', () => startSiteSession(options));
            if (session.perform) {
              const perform = session.perform.bind(session);
              session.perform = async (...args) => {
                try { return await perform(...args); }
                catch (error) {
                  let message = String(error.message ?? error);
                  for (const secret of [input.credentials.username, input.credentials.password, encodeURIComponent(input.credentials.username), encodeURIComponent(input.credentials.password)]) message = message.split(secret).join('[redacted]');
                  timings.nativeActionErrors.push({ name: error.name, action: args[0]?.type, message: message.slice(0, 1200) });
                  throw error;
                }
              };
            }
            return {
              observe: async () => {
                const context = await measure('observe', String(observedUrls.length + 1), () => session.observe());
                assertNoSecrets(context); observedUrls.push(context.url); return context;
              },
              act: async action => {
                assertNoSecrets(action);
                const result = await measure('act', action.action, () => session.act(action));
                completedActions.push(action.action);
                const page = managedBrowser.contexts()[0].pages()[0];
                if (completedActions.length === 1) {
                  assert.equal(await page.locator('#login-form').isVisible(), true);
                  fixtureChecks.loginUiOpened = true;
                } else if (completedActions.length === 4) {
                  assert.equal(await page.locator('#draft-title').inputValue(), input.draft.title);
                  fixtureChecks.titleEntered = true;
                } else if (completedActions.length === 5) {
                  assert.equal(await page.locator('#draft-body').inputValue(), input.draft.body.replace(/\r\n/g, '\n'));
                  fixtureChecks.multilineBodyEntered = true;
                } else if (completedActions.length === 6) {
                  assert.equal(await page.locator('#draft-rich').innerText(), input.draft.editor);
                  fixtureChecks.contentEditableEntered = true;
                } else if (completedActions.length === 7) {
                  assert.equal(await page.locator('#preview').isVisible(), true);
                  fixtureChecks.previewOpened = true;
                  fixtureChecks.continuedAfterFinish = true;
                } else if (completedActions.length === input.expectedActions.length) {
                  assert.ok(await page.evaluate(() => scrollY) > 0, 'The remaining successful action must actually scroll the fixture.');
                  fixtureChecks.scrolled = true;
                }
                if (input.verifyForeground && completedActions.length === input.expectedActions.length) {
                  const foreground = probeForeground();
                  timings.finalForeground = foreground;
                  assert.equal(foreground.pid, focusDiagnostics.at(-1).browserPid, `Actual OS foreground must be the owned Edge process: ${JSON.stringify(foreground)}`);
                  timings.foregroundVerified = true;
                }
                if (input.verifyPointer && completedActions.length === input.expectedActions.length) {
                  const client = await page.context().newCDPSession(page);
                  try {
                    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
                    const allNodes = node => [node, ...(node.children ?? []).flatMap(allNodes), ...(node.shadowRoots ?? []).flatMap(allNodes)];
                    const attrs = node => Object.fromEntries((node.attributes ?? []).reduce((items, value, index, values) => index % 2 ? items : [...items, [value, values[index + 1]]], []));
                    const host = allNodes(root).find(node => attrs(node)['data-webpilot-visual-pointer'] === 'true');
                    assert.ok(host, 'The managed browser must display its visual pointer.');
                    const nodes = allNodes(host);
                    const shape = nodes.find(node => node.nodeName.toLowerCase() === 'path');
                    assert.equal(attrs(shape).fill, '#19191d');
                    assert.equal(attrs(shape).stroke, '#ffffff');
                    assert.equal(nodes.filter(node => node.nodeType === 3).map(node => node.nodeValue).join('').trim(), '');
                    await page.screenshot({ path: input.pointerScreenshot });
                    pointerVerified = true;
                  } finally { await client.detach(); }
                }
                return result;
              },
              close: async () => { await measure('close-session', 'isolated-edge', () => session.close()); browserClosed = true; },
              capture: async () => assert.fail('The DOM tour must never capture a screenshot.'),
            };
          },
          fetchImpl: async (endpoint, options) => measure('mock-model', String(modelAttempts + 1), async () => {
            assert.equal(endpoint, 'https://api.openai.com/v1/responses');
            const body = JSON.parse(options.body);
            assertNoSecrets(body);
            assert.equal(options.body.includes('input_image'), false);
            assert.equal(options.body.includes('data:image/'), false);
            assert.equal(body.store, false);
            modelAttempts += 1;
            if (input.verifyRetry && modelAttempts === 1) return Response.json({ error: { code: 'server_error' } }, { status: 503 });
            const content = body.input[1].content;
            assert.equal(typeof content, 'string');
            const marker = '\nCurrent page: ';
            const contextText = content.slice(content.lastIndexOf(marker) + marker.length);
            const historyMarker = contextText.indexOf('\nRecent outcomes:');
            const context = JSON.parse(historyMarker < 0 ? contextText : contextText.slice(0, historyMarker));
            requests.push({ step: modelStep, url: context.url, elementCount: context.elements.length });
            assert.ok(content.includes('로그인 화면을 열고 제공한 계정으로 로그인하세요.'));
            assert.ok(content.includes('저장하거나 게시하지 마세요.'));
            assert.equal(Number(content.match(/\nActions remaining: (\d+)/)?.[1]), input.expectedActions.length - completedActions.length);
            assert.equal(Number(content.match(/\nCompleted actions: (\d+)/)?.[1]), completedActions.length);
            assert.equal(BrowserWindow.getAllWindows().length, 1, 'Only the main app window may exist during the tour.');
            assert.equal(globalShortcut.isRegistered('Escape'), true);
            silentControlChecks += 1;
            const next = { action: 'finish', element_id: '', text: '', scroll_y: 0, reason: '요청한 초안 입력을 완료했으므로 일찍 종료 제안' };
            const select = (label, role) => {
              const element = context.elements.find(element => (!role || element.role === role) && element.label.includes(label));
              assert.ok(element, `The observed DOM must expose the requested ${label} control.`);
              return element.id;
            };
            if (modelStep === 0) {
              assert.equal(context.loginAvailable, false);
              next.action = 'click'; next.element_id = select('로그인 화면 열기', 'button'); next.reason = '요청한 로그인 화면을 먼저 열기';
            } else if (modelStep === 1) {
              assert.equal(context.loginAvailable, true);
              next.action = 'login'; next.reason = '사용자가 제공한 계정으로 로그인';
            } else if (modelStep === 2) {
              assert.ok(context.url.endsWith('/dashboard'));
              next.action = 'click'; next.element_id = select('게시글 작성', 'button'); next.reason = '요청한 글쓰기 화면으로 이동';
            } else if (modelStep === 3) {
              assert.ok(context.url.endsWith('/compose'));
              next.action = 'type'; next.element_id = select('제목', 'textbox'); next.text = input.draft.title; next.reason = '지시한 제목 입력';
            } else if (modelStep === 4) {
              next.action = 'type'; next.element_id = select('본문 초안', 'textbox'); next.text = input.draft.body; next.reason = '일반 본문에 여러 줄 초안 입력';
            } else if (modelStep === 5) {
              next.action = 'type'; next.element_id = select('본문 편집기', 'textbox'); next.text = input.draft.editor; next.reason = '리치 텍스트 편집기에 4000자 초안 입력';
            } else if (modelStep === 6) {
              assert.equal(completedActions.length, 6, `Native draft entry failed: ${JSON.stringify({ nativeActionErrors: timings.nativeActionErrors, failedOperations: timings.operations.filter(operation => !operation.ok) })}`);
              // A premature model finish is not a successful browser action.
              // Native orchestration must continue until the chosen N is met.
            } else if (modelStep === 7) {
              assert.equal(completedActions.length, 6, 'The rejected finish must not consume the successful-action budget.');
              next.action = 'click'; next.element_id = select('초안 미리보기', 'button'); next.reason = '남은 지시인 초안 미리보기 열기';
            } else if (modelStep === 8) {
              assert.match(context.text, /초안 미리보기를 열었습니다/);
              next.action = 'scroll'; next.scroll_y = 500; next.reason = '설정된 남은 동작으로 미리보기 아래 화면 탐색';
            } else {
              assert.fail('No further model call is allowed after all eight successful actions.');
            }
            modelStep += 1;
            return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(next) }] }] });
          }),
        });
        timings.runMs = round(performance.now() - runStarted);
        assertNoSecrets(result);
        assert.deepEqual(completedActions, input.expectedActions, `Unexpected action outcomes: ${JSON.stringify({ observations: result.observations, nativeActionErrors: timings.nativeActionErrors, failedOperations: timings.operations.filter(operation => !operation.ok) })}`);
        assert.equal(result.actionCount, input.expectedActions.length);
        assert.equal(result.visitedCount, 3);
        assert.equal(result.pages.length, 3);
        assert.equal(requests.length, input.expectedActions.length + 1);
        assert.equal(observedUrls.length, input.expectedActions.length + 1);
        assert.equal(result.observations.filter(outcome => outcome.action === 'finish' && outcome.blocked).length, 1);
        assert.ok(Object.values(fixtureChecks).every(Boolean), JSON.stringify(fixtureChecks));
        assert.equal(usages.length, input.expectedActions.length + 1 + Number(input.verifyRetry));
        assert.equal(modelAttempts, input.expectedActions.length + 1 + Number(input.verifyRetry));
        if (input.verifyRetry) assert.equal(events.filter(event => event.id === 'site-response-retry').length, 1);
        if (input.verifyReport) {
          assert.equal(reportProviderCalls, 1);
          assert.equal(result.report.status, 'ready');
          assert.equal(result.report.name, 'report.pdf');
          assert.deepEqual(await getReport(result.report.id), result.report);
          assert.deepEqual(events.filter(event => event.type === 'report').map(event => event.report), [result.report]);
        }
        assert.deepEqual([...new Set(events.filter(event => event.type === 'activity').map(event => event.phase))], ['reading', 'thinking', 'acting', 'finalizing', 'complete']);
        assert.equal(events.at(-1).phase, 'complete');
        assert.equal(browserClosed, true);
        if (input.verifyPointer) assert.equal(pointerVerified, true);
        assert.equal(BrowserWindow.getAllWindows().length, 1);
        assert.equal(globalShortcut.isRegistered('Escape'), false);
        assert.ok(focusDiagnostics.length > 0 && focusDiagnostics.every(record => record.ok));
        const captureDirectory = path.join(app.getPath('userData'), 'captures');
        assert.equal(fs.existsSync(captureDirectory) && fs.readdirSync(captureDirectory).length > 0, false, 'No capture files may be generated.');
        const diagnosticsMs = timings.diagnosticProbes.reduce((sum, item) => sum + item.durationMs, 0);
        const focusMs = focusDiagnostics.reduce((sum, item) => sum + item.durationMs, 0);
        return { version: app.getVersion(), packaged: app.getAppPath().endsWith('app.asar'), actions: completedActions, maxActions: input.expectedActions.length, actionCount: result.actionCount, ignoredPrematureFinishes: 1, fixtureChecks, visitedCount: result.visitedCount,
          modelCalls: requests.length, modelAttempts, reportAttached: result.report?.status === 'ready', phases: [...new Set(events.filter(event => event.type === 'activity').map(event => event.phase))],
          silentControlChecks, overlayWindows: 0, pointerVerified, nativeFocusChecks: focusDiagnostics.length, browserClosed, screenshotEvents: 0, captureFiles: 0,
          timings: { ...timings, diagnosticProbeMs: round(diagnosticsMs), runExcludingDiagnosticMs: round(timings.runMs - diagnosticsMs), nativeFocusMs: round(focusMs), focusCalls: focusDiagnostics, focusImplementation: originalCreateFocus ? 'session-controller' : 'one-shot-helper' } };
      } finally {
        controller.abort(); overlay.dispose(); focusModule.focusManagedEdge = originalFocus;
        if (originalCreateFocus) focusModule.createManagedEdgeFocus = originalCreateFocus;
        chromium.launch = originalLaunch;
      }
    }, { url, credentials, draft, expectedActions, verifyReport: process.env.VERIFY_REPORT === '1', verifyRetry: process.env.VERIFY_RETRY === '1',
      verifyPointer: process.env.VERIFY_POINTER === '1', verifyForeground: process.env.VERIFY_FOREGROUND === '1', pointerScreenshot: path.join(project, 'screenshots', 'packaged-pointer-only.png') });
    if (process.env.WEBPILOT_EXECUTABLE) assert.equal(report.packaged, true);
    assert.equal(stats.loginPosts, 1);
    assert.equal(stats.unexpectedPosts, 0);
    assert.equal(stats.acceptedCredentials, true);
    assert.ok(stats.authenticatedPages >= 1);
    assert.ok(stats.authenticatedDetails >= 1);
  } finally {
    const closingAt = performance.now();
    await desktop?.close();
    applicationCloseMs = performance.now() - closingAt;
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
  const output = { passed: true, ...report, loginPosts: stats.loginPosts, cookieSessionVerified: true, paidApiCalls: 0,
    benchmark: { measuredAt: new Date().toISOString(), applicationReadyMs: Math.round(applicationReadyMs * 100) / 100, applicationCloseMs: Math.round(applicationCloseMs * 100) / 100, totalHarnessMs: Math.round((performance.now() - harnessStarted) * 100) / 100,
      options: { report: process.env.VERIFY_REPORT === '1', retry: process.env.VERIFY_RETRY === '1', pointerScreenshot: process.env.VERIFY_POINTER === '1', foregroundProbe: process.env.VERIFY_FOREGROUND === '1' }, fixture: 'local-login-ui-cookie-writing-title-multiline-contenteditable-eight-actions', modelNetwork: 'mocked, no API latency', samples: 1 } };
  if (process.env.CU_BENCHMARK_LABEL) {
    const label = process.env.CU_BENCHMARK_LABEL;
    assert.match(label, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
    const directory = path.join(project, 'artifacts');
    fs.mkdirSync(directory, { recursive: true });
    const artifact = path.join(directory, `cu-timing-${label}.json`);
    fs.writeFileSync(artifact, JSON.stringify(output, null, 2) + '\n');
    output.benchmark.artifact = artifact;
  }
  console.log(JSON.stringify(output));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
