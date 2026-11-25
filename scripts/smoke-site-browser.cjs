'use strict';

// Uses only local fixtures. Launches an isolated Edge window and never calls AI.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { focusManagedEdge } = require('../electron/focus-edge.cjs');
const { startSiteSession, SitePolicyError } = require('../electron/site-browser.cjs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stop = server => new Promise(resolve => server.close(resolve));
const click = y => ({ type: 'click', x: 90, y });
let outsideRequests = 0;
let mutationRequests = 0;
const typedValues = [];
const pointerStates = [];
let observedMoves = 0;
let session;
let challenger;

function foregroundWindow() {
  if (process.platform !== 'win32') return null;
  const command = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class WebPilotForegroundInfo { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int count); [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h); }'; $windowHandle=[WebPilotForegroundInfo]::GetForegroundWindow(); $windowTitle=[System.Text.StringBuilder]::new(512); [void][WebPilotForegroundInfo]::GetWindowText($windowHandle,$windowTitle,512); @{title=$windowTitle.ToString();maximized=[WebPilotForegroundInfo]::IsZoomed($windowHandle)} | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }));
}

const outside = http.createServer((_request, response) => {
  outsideRequests++;
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<h1>Outside origin: must not be reached</h1>');
});

async function main() {
  await listen(outside);
  const otherOrigin = `http://127.0.0.1:${outside.address().port}`;
  const fixture = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') mutationRequests++;
    if (request.url.startsWith('/evidence?')) {
      const values = new URL(request.url, 'http://fixture.invalid').searchParams;
      if (values.has('typed')) typedValues.push(values.get('typed'));
      if (values.has('pointer')) pointerStates.push(values.get('pointer'));
      if (values.has('moves')) observedMoves = Math.max(observedMoves, Number(values.get('moves')));
      response.writeHead(204); response.end(); return;
    }
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/redirect-next' }); response.end(); return; }
    if (request.url === '/redirect-next') { response.writeHead(302, { Location: `${otherOrigin}/redirect-target` }); response.end(); return; }
    if (request.url === '/redirect-inside') { response.writeHead(302, { Location: '/inside' }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/inside') {
      response.end('<!doctype html><html><head><title>WebPilot same-origin site</title><style>body{font-family:Arial;padding:25px;color:#41543a}a{position:absolute;left:40px;top:80px;padding:8px;width:180px;height:20px;background:#edf4e5}</style></head><body><h1>Allowed same-origin page</h1><a href="/">Return to fixture</a></body></html>');
      return;
    }
    response.end(`<!doctype html><html><head><title>WebPilot managed site fixture</title><style>body{font-family:Arial;color:#41543a;background:#fafcf7;padding:25px}a,button,input{position:absolute;left:40px;width:220px;height:32px;box-sizing:border-box;padding:6px 10px;border:1px solid #ccd8bd;border-radius:5px;background:#f0f5e9;color:#41543a;text-align:left;font-size:13px}h1{font-size:22px}p{position:absolute;left:320px;top:88px;max-width:400px;line-height:1.8;color:#859772}iframe{position:absolute;left:320px;top:230px;width:100px;height:40px;opacity:.1}</style></head><body>
      <h1>WebPilot · Local boundary verification</h1>
      <a style="top:80px" href="/inside">Same-origin navigation</a>
      <a style="top:128px" href="${otherOrigin}/outside">External navigation</a>
      <a style="top:176px" href="${otherOrigin}/new" target="_blank">New tab navigation</a>
      <button style="top:224px" type="button" onclick="fetch('/write',{method:'POST',body:'test'}).catch(()=>{})">Network action</button>
      <form action="/form" method="get"><button style="top:272px" type="submit">Form action</button></form>
      <button style="top:320px" type="button">Delete account</button>
      <a style="top:368px" href="/redirect">Redirect navigation</a>
      <button style="top:416px" type="button" onclick="window.open('${otherOrigin}/popup')">Open auxiliary window</button>
      <a style="top:464px" href="/download" download>Download file</a>
      <a style="top:512px" href="/redirect-inside">Same-origin redirect</a>
      <form action="/search"><input id="safe-query" type="search" aria-label="Search docs" style="left:340px;top:380px;width:280px" oninput="fetch('/evidence?typed='+encodeURIComponent(this.value))"></form>
      <input type="password" aria-label="Password" style="left:340px;top:430px;width:280px">
      <input type="email" aria-label="Email" style="left:340px;top:480px;width:280px">
      <input type="text" name="accountName" style="left:340px;top:530px;width:280px">
      <p>This is a controlled local fixture.<br>Only the same-origin navigation should succeed.<br>Other origins, forms, POST, downloads and sensitive actions must remain blocked.</p>
      <iframe src="${otherOrigin}/frame"></iframe>
      <script>
        let moves=0;document.addEventListener('mousemove',()=>{moves++;if(moves%20===0)fetch('/evidence?moves='+moves)});
        document.addEventListener('DOMContentLoaded',()=>{
          const host=document.querySelector('[data-webpilot-visual-pointer]');
          if(host)new MutationObserver(()=>fetch('/evidence?pointer='+host.style.display)).observe(host,{attributes:true,attributeFilter:['style']});
        });
      </script>
    </body></html>`);
  });
  await listen(fixture);
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const statuses = [];
  try {
    session = await startSiteSession({ url: `${origin}/`, signal: new AbortController().signal, onStatus: status => statuses.push(status) });
    const initialWindow = foregroundWindow();
    if (initialWindow) {
      assert.match(initialWindow.title, /WebPilot managed site fixture/);
      assert.equal(initialWindow.maximized, true, 'managed Edge starts maximized');
    }
    const before = await session.capture();
    const png = Buffer.from(before.imageDataUrl.split(',')[1], 'base64');
    assert.equal(before.width, png.readUInt32BE(16));
    assert.equal(before.height, png.readUInt32BE(20));
    assert.ok(before.width > 600 && before.height > 550);
    assert.ok(before.imageDataUrl.startsWith('data:image/png;base64,'));
    challenger = await chromium.launch({ channel: 'msedge', headless: false, chromiumSandbox: true });
    const challengerSession = await challenger.newBrowserCDPSession();
    const challengerProcesses = await challengerSession.send('SystemInfo.getProcessInfo');
    const challengerPid = challengerProcesses.processInfo.find(info => info.type === 'browser').id;
    await challengerSession.detach();
    const challengerPage = await challenger.newPage({ viewport: { width: 800, height: 600 } });
    await challengerPage.setContent('<!doctype html><title>WebPilot focus challenger</title><h1>Temporary focus test window</h1>');
    await challengerPage.bringToFront();
    await focusManagedEdge(challengerPid);
    if (process.platform === 'win32') assert.match(foregroundWindow().title, /WebPilot focus challenger/);
    await session.capture();
    if (process.platform === 'win32') assert.match(foregroundWindow().title, /WebPilot managed site fixture/, 'capture restores the managed site to OS foreground');
    await session.perform(click(94));
    const inside = await session.capture();
    assert.equal(inside.url, `${origin}/inside`);
    const artifactDirectory = path.resolve(__dirname, '..', 'artifacts');
    fs.mkdirSync(artifactDirectory, { recursive: true });
    fs.writeFileSync(path.join(artifactDirectory, 'site-browser-fixture.png'), Buffer.from(inside.imageDataUrl.split(',')[1], 'base64'));
    await session.perform(click(94));
    assert.equal((await session.capture()).url, `${origin}/`);
    await challengerPage.bringToFront();
    await focusManagedEdge(challengerPid);
    if (process.platform === 'win32') assert.match(foregroundWindow().title, /WebPilot focus challenger/);
    const typed = await session.perform({ type: 'type', x: 410, y: 397, text: 'WebPilot search' });
    if (process.platform === 'win32') assert.match(foregroundWindow().title, /WebPilot managed site fixture/, 'typing restores the managed site to OS foreground');
    assert.match(typed.message, /입력했습니다/);
    assert.ok(typedValues.includes('WebPilot search'), 'real input events produce the requested search text');
    const typedScreen = await session.capture();
    fs.writeFileSync(path.join(artifactDirectory, 'site-browser-typing.png'), Buffer.from(typedScreen.imageDataUrl.split(',')[1], 'base64'));
    assert.ok(pointerStates.includes('none'), 'the visible agent pointer is hidden during screenshot capture');
    assert.ok(pointerStates.includes('block'), 'the visible agent pointer is restored after capture');
    assert.ok(observedMoves >= 20, 'the browser receives actual pointer movement events');
    for (const y of [446, 496, 546]) await assert.rejects(session.perform({ type: 'type', x: 410, y, text: 'do not type' }), SitePolicyError);
    await assert.rejects(session.perform({ type: 'type', x: typedScreen.width + 1, y: 397, text: 'outside' }), SitePolicyError);
    await session.perform(click(526));
    assert.equal((await session.capture()).url, `${origin}/inside`, 'same-origin redirect retains the real destination URL');
    await session.perform(click(94));

    for (const y of [142, 190, 286, 334, 478]) await assert.rejects(session.perform(click(y)), SitePolicyError);
    const post = await session.perform(click(238));
    assert.match(post.message, /차단/);
    await session.perform(click(430));
    assert.equal(outsideRequests, 0, 'external page, popup, and iframe requests never reach the other server');
    assert.equal(mutationRequests, 0, 'POST is blocked before it reaches the fixture server');

    // A same-origin redirect must not reach its cross-origin destination.
    await session.perform(click(382)).catch(error => { assert.ok(error instanceof Error); });
    assert.equal(outsideRequests, 0, 'cross-origin redirect is blocked before network');
    await session.close();
    await assert.rejects(session.capture(), /종료/);
    session = undefined;

    const controller = new AbortController();
    session = await startSiteSession({ url: `${origin}/`, signal: controller.signal });
    controller.abort();
    await session.close();
    await assert.rejects(session.capture(), { name: 'AbortError' });
    console.log(JSON.stringify({ passed: true, screenshots: ['artifacts/site-browser-fixture.png', 'artifacts/site-browser-typing.png'], viewport: { width: before.width, height: before.height }, startsMaximized: initialWindow?.maximized, restoresNativeForeground: process.platform === 'win32', outsideRequests, mutationRequests, typed: typedValues.includes('WebPilot search'), actualPointerMoves: observedMoves, pointerHiddenForCapture: pointerStates.includes('none'), blockedActions: statuses.filter(status => status.startsWith('차단:')).length }));
  } finally {
    await session?.close();
    await challenger?.close();
    await stop(fixture);
    await stop(outside);
  }
}

main().catch(async error => { console.error(error); await session?.close(); await challenger?.close(); outside.close(); process.exitCode = 1; });
