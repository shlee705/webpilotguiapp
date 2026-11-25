const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright');

async function verifyLongConversationLayout({ desktop, page, project, profile, screenshotDirectory }) {
  const dataDirectory = await desktop.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(path.resolve(dataDirectory), path.resolve(profile), 'Layout fixture must use only its isolated temporary profile.');
  const fixturePath = [
    path.join(project, 'artifacts', 'site-browser-fixture.png'),
    path.join(project, 'screenshots', 'packaged-site-capture.png'),
  ].find(filename => fs.existsSync(filename));
  assert.ok(fixturePath, 'A generated local fixture PNG is required; user screenshots are never used.');
  const imageDataUrl = `data:image/png;base64,${fs.readFileSync(fixturePath).toString('base64')}`;
  const captures = await desktop.evaluate(({ app }, image) => {
    const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
    const { saveCapture } = require(`${app.getAppPath()}/electron/captures.cjs`);
    return Array.from({ length: 6 }, (_, index) => saveCapture(image, {
      url: `http://127.0.0.1/layout-fixture/page-${index + 1}`,
      index: index + 1,
    }));
  }, imageDataUrl);
  const title = '레이아웃 검증 · 긴 대화';
  await page.evaluate(({ captures, title }) => {
    const timestamp = new Date().toISOString();
    const conversation = {
      id: 'layout-fixture-conversation', title, createdAt: timestamp, updatedAt: timestamp,
      messages: [
        { id: 'layout-fixture-user', role: 'user', content: '로컬 fixture의 긴 대화와 여섯 장의 캡처를 표시합니다. API 호출은 수행하지 않습니다.', createdAt: timestamp, status: 'complete' },
        {
          id: 'layout-fixture-assistant', role: 'assistant', source: 'openai', model: 'gpt-6-luna', status: 'complete', createdAt: timestamp,
          content: Array.from({ length: 12 }, (_, index) => `레이아웃 확인 ${index + 1}: 대화 내용이 길어져도 왼쪽 기록과 하단 입력창은 화면 안에 유지되어야 합니다.`).join('\n'),
          steps: Array.from({ length: 18 }, (_, index) => ({ id: `layout-step-${index}`, label: `로컬 화면 ${index + 1} 확인 완료`, state: 'complete' })),
          captures,
        },
      ],
    };
    localStorage.setItem('webpilot.conversations.v1', JSON.stringify([conversation]));
  }, { captures, title });
  await page.reload();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.waitForSelector('.conversation-scroll .capture-gallery img');
  await page.waitForFunction(() => document.querySelectorAll('.capture-gallery img').length === 6);
  await page.locator('.capture-gallery img').evaluateAll(images => Promise.all(images.map(image => {
    image.loading = 'eager';
    return image.decode();
  })));
  const measure = () => page.evaluate(() => {
    const rectangle = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
      return { top, bottom, left, right, width, height };
    };
    const scroller = document.querySelector('.conversation-scroll');
    return {
      viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      conversation: { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop },
      sidebar: rectangle('.sidebar'), sidebarTop: rectangle('.sidebar-brand'), sidebarBottom: rectangle('.sidebar-bottom'),
      composer: rectangle('.composer-area.docked'),
    };
  });
  const assertLayout = (geometry, stage) => {
    const diagnostic = `${stage}: ${JSON.stringify(geometry)}`;
    assert.ok(geometry.documentHeight <= geometry.viewportHeight + 1, `Document must not create a second vertical scrollbar. ${diagnostic}`);
    assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1, `Document must not scroll horizontally. ${diagnostic}`);
    assert.equal(geometry.scrollY, 0, `Window must remain at scrollY=0. ${diagnostic}`);
    assert.ok(geometry.conversation.scrollHeight > geometry.conversation.clientHeight + 200, `Fixture must overflow the conversation pane. ${diagnostic}`);
    for (const name of ['sidebar', 'sidebarTop', 'sidebarBottom', 'composer']) {
      const box = geometry[name];
      assert.ok(box && box.width > 0 && box.height > 0, `${name} must be rendered. ${diagnostic}`);
      assert.ok(box.top >= -1 && box.bottom <= geometry.viewportHeight + 1 && box.left >= -1 && box.right <= geometry.viewportWidth + 1,
        `${name} must remain fully inside the viewport. ${diagnostic}`);
    }
    assert.ok(geometry.viewportHeight - geometry.composer.bottom <= 32, `Composer must not leave a large blank bottom region. ${diagnostic}`);
    assert.ok(geometry.viewportHeight - geometry.sidebarBottom.bottom <= 32, `Sidebar footer must remain near the window bottom. ${diagnostic}`);
  };
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
  assertLayout(await measure(), 'conversation top');
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const bottom = await measure();
  assertLayout(bottom, 'conversation bottom');
  assert.ok(bottom.conversation.scrollTop > 0, 'Only the conversation pane must have scrolled.');
  await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-layout-fixed.png') });
  console.log('Layout smoke passed: six persisted fixture captures, independent conversation scrolling, no document overflow, visible sidebar and bottom composer; no API settings or keys read.');
}

async function main() {
  const project = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(project, 'dist', 'index.html')), 'Run npm run build before this check.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-smoke-'));
  const environment = { ...process.env, ELECTRON_DEV: '0' };
  delete environment.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({
    ...(process.env.WEBPILOT_EXECUTABLE ? { executablePath: process.env.WEBPILOT_EXECUTABLE } : {}),
    args: [...(process.env.WEBPILOT_EXECUTABLE ? [] : [project]), `--user-data-dir=${profile}`],
    env: environment,
  });
  let closed = false;
  try {
    const page = await desktop.firstWindow();
    await page.waitForSelector('#root > *');
    const screenshotDirectory = path.join(project, 'screenshots');
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    if (process.env.VERIFY_LAYOUT === '1') {
      await verifyLongConversationLayout({ desktop, page, project, profile, screenshotDirectory });
      return;
    }
    await page.screenshot({ path: path.join(screenshotDirectory, 'desktop.png') });
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('heading', { name: 'API 및 앱 설정', exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-settings.png') });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    assert.ok(page.url().startsWith('file://'), 'Production window must load bundled files.');
    const state = await page.evaluate(async () => ({
      bridge: typeof window.pilotDesktop?.openInEdge,
      nodeAccess: typeof window.require,
      maximized: await window.pilotDesktop?.isMaximized(),
      unsafeUrl: await window.pilotDesktop?.openInEdge('file:///C:/Windows'),
    }));
    assert.equal(state.bridge, 'function');
    assert.equal(state.nodeAccess, 'undefined');
    assert.equal(state.maximized, false);
    assert.equal(state.unsafeUrl.ok, false);
    await page.evaluate(() => window.pilotDesktop.toggleMaximize());
    assert.equal(await page.evaluate(() => window.pilotDesktop.isMaximized()), true);
    await page.evaluate(() => window.pilotDesktop.toggleMaximize());
    assert.equal(await page.evaluate(() => window.pilotDesktop.isMaximized()), false);
    const security = await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = window.webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, isolation: preferences.contextIsolation, node: preferences.nodeIntegration };
    });
    assert.deepEqual(security, { sandbox: true, isolation: true, node: false });
    const settingsBefore = await page.evaluate(() => window.pilotDesktop.getAiSettings());
    assert.equal(settingsBefore.model, 'gpt-6-luna');
    assert.equal(settingsBefore.keyConfigured, false);
    const testKey = 'sk-local-smoke-fixture-not-a-real-key';
    const savedSettings = await page.evaluate(apiKey => window.pilotDesktop.saveAiSettings({ model: 'gpt-6-luna', apiKey }), testKey);
    assert.equal(savedSettings.keyConfigured, true);
    assert.equal(savedSettings.storage, 'encrypted');
    assert.equal(JSON.stringify(savedSettings).includes(testKey), false);
    const dataDirectory = await desktop.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(fs.readFileSync(path.join(dataDirectory, 'ai-settings.json'), 'utf8').includes(testKey), false);
    await page.evaluate(() => window.pilotDesktop.saveAiSettings({ model: 'gpt-6-luna', forgetKey: true }));
    const missingKey = await page.evaluate(() => window.pilotDesktop.startAiChat({ requestId: 'no-key-smoke', model: 'gpt-6-luna', messages: [{ role: 'user', content: 'test' }] }));
    assert.equal(missingKey.ok, false);
    assert.equal((await page.evaluate(() => window.pilotDesktop.getCapture('../ai-settings'))).ok, false);
    console.log('AI bridge smoke passed: native encrypted key save/forget, no secret returned, missing-key rejection, capture path rejection; no API call made.');
    if (process.env.VERIFY_SITE === '1') {
      const fixture = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(request.url === '/next'
          ? '<!doctype html><html><body style="font-family:Arial;padding:30px"><h1>Packaged Edge navigation succeeded</h1><p>Local fixture only. No API call.</p></body></html>'
          : '<!doctype html><html><body><a style="position:absolute;left:40px;top:60px;width:220px;height:40px;background:#dde8db;padding:8px" href="/next">Explore the next local page</a></body></html>');
      });
      await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
      const targetUrl = `http://127.0.0.1:${fixture.address().port}/`;
      try {
        const observation = await desktop.evaluate(async ({ app, BrowserWindow }, url) => {
          const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
          const path = require('node:path');
          const { execFile } = require('node:child_process');
          const focusModule = require(path.join(app.getAppPath(), 'electron', 'focus-edge.cjs'));
          const originalFocus = focusModule.focusManagedEdge;
          let expectedEdgePid;
          focusModule.focusManagedEdge = (pid, options) => {
            expectedEdgePid = pid;
            return originalFocus(pid, options);
          };
          const probeCommand = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class FocusProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); public static void FocusOwned(IntPtr target,uint expectedPid) { uint pid; uint targetThread=GetWindowThreadProcessId(target,out pid); if(pid!=expectedPid)throw new Exception("Test HWND is not owned by the expected app"); uint current=GetCurrentThreadId(); uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid); bool a=false,b=false; try { if(foreground!=0 && foreground!=current)a=AttachThreadInput(current,foreground,true); if(targetThread!=current && targetThread!=foreground)b=AttachThreadInput(current,targetThread,true); BringWindowToTop(target); SetForegroundWindow(target); } finally { if(b)AttachThreadInput(current,targetThread,false); if(a)AttachThreadInput(current,foreground,false); } } }'; __FOCUS_OWNED__ $handle=[FocusProbe]::GetForegroundWindow(); $title=[Text.StringBuilder]::new(512); [void][FocusProbe]::GetWindowText($handle,$title,512); $activeProcessId=[uint32]0; [void][FocusProbe]::GetWindowThreadProcessId($handle,[ref]$activeProcessId); @{title=$title.ToString();pid=$activeProcessId;process=(Get-Process -Id $activeProcessId).ProcessName} | ConvertTo-Json -Compress`;
          const probeForeground = ownedHandle => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probeCommand.replace('__FOCUS_OWNED__', ownedHandle ? `[FocusProbe]::FocusOwned([IntPtr]::new([long]${ownedHandle}),[uint32]${process.pid});` : '')],
            { windowsHide: true, shell: false, encoding: 'utf8', timeout: 8000 }, (error, stdout) => {
              if (error) { reject(error); return; }
              try { resolve(JSON.parse(stdout.trim())); } catch (parseError) { reject(parseError); }
            }));
          const { startSiteSession } = require(path.join(app.getAppPath(), 'electron', 'site-browser.cjs'));
          const { saveCapture } = require(path.join(app.getAppPath(), 'electron', 'captures.cjs'));
          const session = await startSiteSession({ url, signal: new AbortController().signal });
          try {
            const mainWindow = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
            if (!mainWindow) throw new Error('Expected the WebPilot main window for foreground regression checks.');
            const handle = mainWindow.getNativeWindowHandle();
            const ownedHandle = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
            const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
            const focusRecords = [];
            const coverEdgeWithWebPilot = async stage => {
              mainWindow.show();
              mainWindow.focus();
              await wait(150);
              const native = await probeForeground(ownedHandle);
              focusRecords.push({ stage: `before-${stage}`, electronFocused: mainWindow.isFocused(), native });
              if (native.pid !== process.pid) throw new Error(`WebPilot did not become the native foreground window before ${stage}: ${JSON.stringify(native)}`);
              return native.pid === process.pid;
            };
            const focusedBeforeCapture = await coverEdgeWithWebPilot('capture');
            const before = await session.capture();
            await wait(100);
            const focusedAfterCapture = mainWindow.isFocused();
            const nativeAfterCapture = await probeForeground();
            focusRecords.push({ stage: 'after-capture', electronFocused: focusedAfterCapture, native: nativeAfterCapture });
            if (nativeAfterCapture.pid !== expectedEdgePid) throw new Error(`Capturing the site did not foreground the managed Edge PID ${expectedEdgePid}: ${JSON.stringify(focusRecords)}`);
            const focusedBeforeClick = await coverEdgeWithWebPilot('click');
            await session.perform({ type: 'click', x: 100, y: 80 });
            await wait(100);
            const focusedAfterClick = mainWindow.isFocused();
            const nativeAfterClick = await probeForeground();
            focusRecords.push({ stage: 'after-click', electronFocused: focusedAfterClick, native: nativeAfterClick });
            if (nativeAfterClick.pid !== expectedEdgePid) throw new Error(`Clicking the site did not foreground the managed Edge PID ${expectedEdgePid}: ${JSON.stringify(focusRecords)}`);
            const after = await session.capture();
            const capture = saveCapture(after.imageDataUrl, { url: after.url, index: 1 });
            return { before: before.url, after: after.url, width: after.width, height: after.height, capture, appPath: app.getAppPath(),
              focusedBeforeCapture, focusedAfterCapture, focusedBeforeClick, focusedAfterClick, expectedEdgePid, focusRecords };
          } finally { focusModule.focusManagedEdge = originalFocus; await session.close(); }
        }, targetUrl);
        assert.equal(observation.before, targetUrl);
        assert.equal(observation.after, `${targetUrl}next`);
        assert.equal(observation.focusedBeforeCapture, true);
        assert.equal(observation.focusedBeforeClick, true);
        for (const record of observation.focusRecords.filter(record => record.stage.startsWith('after-'))) {
          assert.equal(record.native.pid, observation.expectedEdgePid, 'Native foreground must match the owned Edge process; Electron focus flags may be stale.');
          assert.equal(record.native.process, 'msedge');
        }
        console.log(`Native foreground observations: ${JSON.stringify(observation.focusRecords)}`);
        assert.ok(Number.isInteger(observation.width) && observation.width > 0, 'Captured browser viewport must have a positive width.');
        assert.ok(Number.isInteger(observation.height) && observation.height > 0, 'Captured browser viewport must have a positive height.');
        if (process.env.WEBPILOT_EXECUTABLE) assert.ok(observation.appPath.endsWith('app.asar'));
        const captureImage = await page.evaluate(id => window.pilotDesktop.getCapture(id), observation.capture.id);
        assert.equal(captureImage.ok, true);
        assert.ok(captureImage.imageUrl.startsWith('data:image/png;base64,'));
        const capturedPng = Buffer.from(captureImage.imageUrl.split(',')[1], 'base64');
        assert.ok(capturedPng.length >= 24, 'Saved capture must include a PNG IHDR header.');
        assert.deepEqual(capturedPng.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        assert.equal(capturedPng.toString('ascii', 12, 16), 'IHDR');
        assert.equal(capturedPng.readUInt32BE(16), observation.width, 'Saved PNG width must match the actual captured viewport.');
        assert.equal(capturedPng.readUInt32BE(20), observation.height, 'Saved PNG height must match the actual captured viewport.');
        fs.writeFileSync(path.join(screenshotDirectory, 'packaged-site-capture.png'), capturedPng);
        console.log('Real browser module smoke passed: WebPilot foreground restored to Edge before capture and click, local navigation, actual PNG dimensions, persistent capture IPC; no AI API call.');
      } finally { await new Promise(resolve => fixture.close(resolve)); }
    }
    if (process.env.VERIFY_OVERLAY === '1') {
      assert.deepEqual(await page.evaluate(() => window.pilotDesktop.beginOverlay('smoke-a')), { ok: true });
      assert.deepEqual(await page.evaluate(() => window.pilotDesktop.beginOverlay('smoke-b')), { ok: true });
      const overlayState = await desktop.evaluate(({ BrowserWindow, globalShortcut }) => ({
        windowCount: BrowserWindow.getAllWindows().length,
        escapeRegistered: globalShortcut.isRegistered('Escape'),
      }));
      assert.equal(overlayState.windowCount, 1, 'Stop controls must never create an overlay window.');
      assert.equal(overlayState.escapeRegistered, true);
      await page.evaluate(() => window.pilotDesktop.endOverlay('smoke-a'));
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape')), true);
      await page.evaluate(() => window.pilotDesktop.endOverlay('smoke-b'));
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape')), false);
      console.log('Silent stop controls passed: no overlay windows, concurrent sessions, final Escape cleanup.');
      if (process.env.VERIFY_ESCAPE === '1') {
        await page.evaluate(() => {
          window.__overlayStopped = null;
          window.pilotDesktop.onOverlayStopped(details => { window.__overlayStopped = details; });
        });
        assert.deepEqual(await page.evaluate(() => window.pilotDesktop.beginOverlay('smoke-escape')), { ok: true });
        console.log('Waiting up to 60 seconds for native Escape key to validate the global shortcut.');
        await page.waitForFunction(() => window.__overlayStopped?.reason === 'escape', undefined, { timeout: 60000 });
        assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
        assert.equal(await desktop.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape')), false);
        console.log('Native Escape stopped the session and released the shortcut without an overlay window.');
      }
    }
    if (process.env.VERIFY_EDGE === '1') {
      await page.getByRole('textbox', { name: '메시지', exact: true }).fill('https://example.com 사이트를 열어 줘.');
      await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
      await page.getByText('Microsoft Edge에 사이트 열기 요청을 보냈어요', { exact: true }).waitFor();
      await page.getByRole('button', { name: '메시지 보내기', exact: true }).waitFor();
      await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-chat.png') });
      console.log('Edge launch confirmed by real UI submission and IPC response (page load not asserted).');
    }
    console.log('Electron smoke passed: bundled renderer, secure bridge, maximize/restore, unsafe URL rejection.');
    if (process.env.VERIFY_OVERLAY === '1') {
      assert.deepEqual(await page.evaluate(() => window.pilotDesktop.beginOverlay('smoke-close')), { ok: true });
      const closing = desktop.waitForEvent('close', { timeout: 15000 });
      await page.evaluate(() => window.pilotDesktop.close());
      await closing;
      closed = true;
      console.log('Closing the main app with active stop controls shut down the app.');
    }
  } finally {
    if (!closed) await desktop.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
