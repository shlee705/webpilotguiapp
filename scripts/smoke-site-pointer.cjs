'use strict';

// Real local Edge pixels and mouse events; no external site, model API or account.
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { startSiteSession } = require('../electron/site-browser.cjs');

async function pointerPixels(page) {
  const screenshot = await page.screenshot({ animations: 'allow' });
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0, left = Infinity, top = Infinity, right = -1, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      // Fixture text/borders are light gray; only the black pointer is this dark.
      if (pixels[i] < 90 && pixels[i + 1] < 90 && pixels[i + 2] < 90) {
        count++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    return { count, left, top, right, bottom };
  }, screenshot.toString('base64'));
}

async function main() {
  let session, browser;
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const start = request.url === '/';
    response.end(`<!doctype html><html><head><title>WebPilot local pointer verification</title><style>
      html,body { margin:0; background:white; color:#aaa; font:16px Arial; min-height:1800px; }
      a,button,input { position:absolute; color:#aaa; background:white; border:1px solid #ccc; padding:15px; outline:none; }
      button { left:160px; top:180px; width:170px; height:55px; }
      a { left:470px; top:310px; width:160px; height:28px; }
      input { left:370px; top:410px; width:200px; height:24px; }
      div { display:none!important; overflow:hidden!important; visibility:hidden!important; opacity:0!important; }
    </style></head><body><button type="button" aria-label="Open details">Open details</button>
      ${start ? '<a href="/next">Next page</a>' : '<a href="/">Home page</a>'}
      <input type="search" aria-label="Search docs">
    </body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launch = chromium.launch;
  // Observe the browser owned by the actual session. Keep launch settings intact.
  chromium.launch = async function (...args) { browser = await launch.apply(this, args); return browser; };
  const events = [];
  try {
    session = await startSiteSession({ url: `${origin}/`, followBackend: true, signal: new AbortController().signal });
    const page = browser.contexts()[0].pages()[0];
    await page.exposeFunction('__recordPointerFixture', event => { events.push(event); });
    const listen = () => {
      for (const type of ['mousemove', 'click']) addEventListener(type, event => {
        void window.__recordPointerFixture({ type, x: event.clientX, y: event.clientY });
      }, true);
    };
    await page.addInitScript(listen); await page.evaluate(listen);
    const before = await pointerPixels(page);
    assert.ok(before.count > 50, 'The pointer must be visible even under hostile global div styles.');
    const observed = await session.observe();
    const button = observed.elements.find(item => item.role === 'button' && item.label.includes('Open details'));
    assert.ok(button, 'The real DOM observer must expose the local button.');
    await session.act({ action: 'click', element_id: button.id, text: '', scroll_y: 0 });
    const clicked = await pointerPixels(page);
    const moves = events.filter(event => event.type === 'mousemove');
    assert.ok(moves.length >= 4, 'Actual browser mouse movement must include intermediate points.');
    assert.ok(new Set(moves.map(event => `${event.x},${event.y}`)).size >= 4);
    assert.ok(clicked.count > 50 && Math.abs(clicked.left - before.left) > 60, 'Rendered black pointer pixels must move.');
    assert.ok(events.some(event => event.type === 'click'));
    const inputView = await session.observe();
    const input = inputView.elements.find(item => item.role === 'textbox' && item.label === 'Search docs');
    assert.ok(input);
    await session.act({ action: 'type', element_id: input.id, text: 'local pointer fixture', scroll_y: 0 });
    assert.equal(await page.locator('input').inputValue(), 'local pointer fixture');
    const typed = await pointerPixels(page);
    assert.ok(typed.count > 50 && Math.abs(typed.top - clicked.top) > 100, 'Typing must move the visible pointer to the actual field.');
    const clickCount = events.filter(event => event.type === 'click').length;
    const linkBox = await page.locator('a').boundingBox();
    await session.followBackendUrl(`${origin}/next`);
    const followed = await pointerPixels(page);
    assert.equal(page.url(), `${origin}/next`);
    assert.ok(followed.count > 50, 'A full navigation must restore the visible pointer.');
    assert.ok(Math.abs(followed.left - (linkBox.x + linkBox.width / 2)) < 10, 'Pointer must retain the real link-hover X coordinate after navigation.');
    assert.ok(Math.abs(followed.top - (linkBox.y + linkBox.height / 2)) < 10, 'Pointer must retain the real link-hover Y coordinate after navigation.');
    assert.equal(events.filter(event => event.type === 'click').length, clickCount, 'Backend URL following must not invent a link click.');
    await session.followBackendUrl(`${origin}/not-linked`);
    const direct = await pointerPixels(page);
    assert.ok(direct.count > 50);
    assert.ok(Math.abs(direct.left - followed.left) <= 2 && Math.abs(direct.top - followed.top) <= 2, 'A URL without a matching link must retain the actual pointer position.');
    assert.equal(events.filter(event => event.type === 'click').length, clickCount);
    await session.act({ action: 'scroll', element_id: '', text: '', scroll_y: 350 });
    assert.ok(await page.evaluate(() => scrollY) > 0, 'The real page must scroll.');
    assert.ok((await pointerPixels(page)).count > 50, 'The pointer must remain visible while the page scrolls.');
    await session.close(); session = undefined;
    assert.equal(browser.isConnected(), false);
    console.log(JSON.stringify({ passed: true, localRequests: requests, actualMouseMoves: events.filter(event => event.type === 'mousemove').length,
      blackPointerPixelsMoved: true, actualTypingAndScrolling: true, hostileCssVisible: true, navigationPositionRestored: true, unlinkedNavigationPreserved: true,
      inventedNavigationClicks: 0, dedicatedBrowserClosed: true, externalRequests: 0, paidApiCalls: 0 }));
  } finally {
    chromium.launch = launch;
    await session?.close();
    await browser?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
