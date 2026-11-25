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
  const stats = { loginPosts: 0, authenticatedPages: 0, authenticatedDetails: 0, unexpectedPosts: 0, acceptedCredentials: false };
  const style = '<style>body{font:18px Arial;padding:45px;background:#f8faf5;color:#34452d}form{display:grid;gap:15px;max-width:380px}input,button,a{font:inherit;padding:12px;display:block}a{margin-top:25px}input{width:340px}p{line-height:1.8}</style>';
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
    if (['/dashboard', '/inside'].includes(request.url) && !authenticated) {
      response.writeHead(401); response.end('Session cookie required'); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/dashboard') {
      stats.authenticatedPages += 1;
      response.end(page('Local dashboard', `<h1>Signed in local fixture</h1><p>Welcome ${credentials.username}</p><a href="/inside">Open internal details</a>`));
    } else if (request.url === '/inside') {
      stats.authenticatedDetails += 1;
      response.end(page('Local details', '<h1>Local details</h1><label for="tour-query">Fixture search</label><input type="search" id="tour-query" name="tour_query" aria-label="Fixture search" oninput="document.getElementById(\'typed-result\').textContent=\'Typed: \'+this.value"><p id="typed-result">Waiting for ordinary text</p>'));
    } else {
      response.end(page('Local login fixture', '<h1>Local login fixture</h1><form action="/session" method="post" aria-label="Login"><label for="account">Username</label><input id="account" name="username" type="text" autocomplete="username"><label for="secret">Password</label><input id="secret" name="password" type="password" autocomplete="current-password"><button type="submit">Log in</button></form>'));
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
      if (input.verifyPointer) chromium.launch = async options => {
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
          messages: [{ role: 'user', content: `로그인 후 내부 페이지로 이동해서 검색란에 ordinary tour text를 입력해 주세요. 계정 ${input.credentials.username}, 비밀번호 ${input.credentials.password}` }],
          credentials: input.credentials, signal: controller.signal, maxActions: 5, finalizePauseMs: 0,
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
                  timings.nativeActionErrors.push({ name: error.name, action: args[0]?.type, message });
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
                if (input.verifyForeground && action.action === 'type') {
                  const foreground = probeForeground();
                  timings.finalForeground = foreground;
                  assert.equal(foreground.pid, focusDiagnostics.at(-1).browserPid, `Actual OS foreground must be the owned Edge process: ${JSON.stringify(foreground)}`);
                  timings.foregroundVerified = true;
                }
                if (input.verifyPointer && action.action === 'type') {
                  const page = managedBrowser.contexts()[0].pages()[0];
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
            assert.equal(BrowserWindow.getAllWindows().length, 1, 'Only the main app window may exist during the tour.');
            assert.equal(globalShortcut.isRegistered('Escape'), true);
            silentControlChecks += 1;
            const next = { action: 'finish', element_id: '', text: '', scroll_y: 0, reason: '로컬 탐방 완료' };
            if (modelStep === 0) {
              assert.equal(context.loginAvailable, true);
              next.action = 'login';
            } else if (modelStep === 1) {
              assert.ok(context.url.endsWith('/dashboard'));
              const link = context.elements.find(element => element.role === 'link' && element.label.includes('Open internal details'));
              assert.ok(link, 'The current DOM must expose the internal link.');
              next.action = 'click'; next.element_id = link.id;
            } else if (modelStep === 2) {
              assert.ok(context.url.endsWith('/inside'));
              const field = context.elements.find(element => element.role === 'textbox' && element.label.includes('Fixture search'));
              assert.ok(field, 'The current DOM must expose the ordinary search field.');
              next.action = 'type'; next.element_id = field.id; next.text = 'ordinary tour text';
            } else {
              assert.match(context.text, /Typed: ordinary tour text/);
            }
            modelStep += 1;
            return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(next) }] }] });
          }),
        });
        timings.runMs = round(performance.now() - runStarted);
        assertNoSecrets(result);
        assert.deepEqual(completedActions, ['login', 'click', 'type'], `Unexpected action outcomes: ${JSON.stringify({ observations: result.observations, nativeActionErrors: timings.nativeActionErrors, failedOperations: timings.operations.filter(operation => !operation.ok) })}`);
        assert.equal(result.actionCount, 3);
        assert.equal(result.visitedCount, 3);
        assert.equal(result.pages.length, 3);
        assert.equal(requests.length, 4);
        assert.equal(usages.length, input.verifyRetry ? 5 : 4);
        assert.equal(modelAttempts, input.verifyRetry ? 5 : 4);
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
        return { version: app.getVersion(), packaged: app.getAppPath().endsWith('app.asar'), actions: completedActions, visitedCount: result.visitedCount,
          modelCalls: requests.length, modelAttempts, reportAttached: result.report?.status === 'ready', phases: [...new Set(events.filter(event => event.type === 'activity').map(event => event.phase))],
          silentControlChecks, overlayWindows: 0, pointerVerified, nativeFocusChecks: focusDiagnostics.length, browserClosed, screenshotEvents: 0, captureFiles: 0,
          timings: { ...timings, diagnosticProbeMs: round(diagnosticsMs), runExcludingDiagnosticMs: round(timings.runMs - diagnosticsMs), nativeFocusMs: round(focusMs), focusCalls: focusDiagnostics, focusImplementation: originalCreateFocus ? 'session-controller' : 'one-shot-helper' } };
      } finally {
        controller.abort(); overlay.dispose(); focusModule.focusManagedEdge = originalFocus;
        if (originalCreateFocus) focusModule.createManagedEdgeFocus = originalCreateFocus;
        chromium.launch = originalLaunch;
      }
    }, { url, credentials, verifyReport: process.env.VERIFY_REPORT === '1', verifyRetry: process.env.VERIFY_RETRY === '1',
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
      options: { report: process.env.VERIFY_REPORT === '1', retry: process.env.VERIFY_RETRY === '1', pointerScreenshot: process.env.VERIFY_POINTER === '1', foregroundProbe: process.env.VERIFY_FOREGROUND === '1' }, fixture: 'local-login-cookie-internal-click-search-type', modelNetwork: 'mocked, no API latency', samples: 1 } };
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
