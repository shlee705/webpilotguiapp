'use strict';

const { chromium } = require('playwright-core');
const { randomUUID } = require('node:crypto');
const { focusManagedEdge } = require('./focus-edge.cjs');
const { validateCredentials, createSecretRedactor } = require('./login-secrets.cjs');

const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const MUTATING_PATH = /(?:^|[\/_.?=&-])(?:logout|logoff|signout|sign-out|delete|destroy|remove|unsubscribe|checkout|purchase|payment|pay|order|transfer|withdraw|reset|confirm|approve|submit|publish|send|invite|revoke)(?:$|[\/_.?=&-])/i;
const SENSITIVE_LABEL = /(?:log\s*out|sign\s*out|delete|destroy|remove|unsubscribe|checkout|purchase|payment|\bpay\b|\border\b|transfer|withdraw|reset|confirm|approve|submit|publish|send|invite|revoke|로그아웃|탈퇴|삭제|제거|결제|구매|주문|송금|이체|출금|초기화|승인|제출|게시|발행|전송|초대|구독\s*해지|파일\s*선택|업로드)/i;
const SENSITIVE_INPUT = /(?:password|passwd|\bpwd\b|secret|token|api[\s_-]*key|credential|auth|login|sign[\s_-]*in|account|user[\s_-]*name|first[\s_-]*name|last[\s_-]*name|full[\s_-]*name|e[\s_-]*mail|phone|telephone|mobile|address|postal|zip[\s_-]*code|card|cc-|cvc|cvv|payment|billing|bank|iban|\bssn\b|social[\s_-]*security|birth|credit|debit|비밀번호|암호|인증|토큰|API\s*키|로그인|계정|아이디|이름|성명|이메일|메일|전화|연락처|주소|우편|카드|결제|계좌|주민|생년)/i;
const LOGIN_LABEL = /(?:log\s*in|sign[\s_-]*in|로그인)/i;
const LOGIN_DANGER = /(?:register|registration|sign[\s_-]*up|create[\s_-]*account|reset|forgot|change[\s_-]*password|checkout|payment|purchase|delete|회원\s*가입|가입|비밀번호\s*(?:변경|찾기|재설정)|결제|구매|삭제)/i;
const AUTH_PATH = /(?:^|\/)(?:login|signin|sign-in|authenticate|auth|session)(?:\/|$)/i;

function validateDomAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new SitePolicyError('허용된 사이트 동작이 아닙니다.');
  if (!['click', 'type', 'scroll', 'login'].includes(action.action) || Object.keys(action).some(key => !['action', 'element_id', 'text', 'scroll_y'].includes(key))) throw new SitePolicyError('허용된 사이트 동작이 아닙니다.');
  if (['click', 'type'].includes(action.action) && (typeof action.element_id !== 'string' || !/^[a-f0-9-]{36}$/.test(action.element_id))) throw new SitePolicyError('현재 페이지에서 제공한 요소 ID가 필요합니다.');
  if (action.action === 'type') validateAction({ type: 'type', x: 1, y: 1, text: action.text });
  if (action.action === 'scroll' && (!Number.isFinite(action.scroll_y) || Math.abs(action.scroll_y) > 1200)) throw new SitePolicyError('스크롤 범위가 허용 한도를 초과했습니다.');
  return action;
}

function matchesLoginRequest(request, permit, credentials, now = Date.now()) {
  if (!permit || permit.used || now > permit.expires || request.method !== 'POST' || !request.mainFrame || !credentials) return false;
  if (permit.mode === 'spa') {
    let destination;
    try { destination = new URL(request.url); } catch { return false; }
    if (request.navigation || destination.origin !== permit.allowedOrigin || destination.username || destination.password || !AUTH_PATH.test(destination.pathname) || isBlockedPath(destination) || LOGIN_DANGER.test(destination.pathname + destination.search)) return false;
  } else if (!request.navigation || request.url !== permit.url) return false;
  let body;
  if (/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType ?? '')) body = new URLSearchParams(request.body ?? '');
  else if (permit.mode === 'spa' && /^application\/json(?:;|$)/i.test(request.contentType ?? '')) {
    let parsed;
    try { parsed = JSON.parse(request.body); } catch { return false; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => !['string', 'boolean', 'number'].includes(typeof value))) return false;
    body = new URLSearchParams(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  } else return false;
  return body.getAll(permit.usernameField).length === 1 && body.get(permit.usernameField) === credentials.username
    && body.getAll(permit.passwordField).length === 1 && body.get(permit.passwordField) === credentials.password
    && [...body.keys()].every(key => permit.fields.includes(key));
}

class SitePolicyError extends Error {
  constructor(message) { super(message); this.name = 'SitePolicyError'; }
}

function validateTargetUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new SitePolicyError('올바른 웹사이트 URL이 필요합니다.');
  let url;
  try { url = new URL(value); } catch { throw new SitePolicyError('올바른 웹사이트 URL이 필요합니다.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SitePolicyError('계정 정보가 없는 HTTP(S) 주소만 사용할 수 있습니다.');
  if (isBlockedPath(url)) throw new SitePolicyError('상태를 변경할 수 있는 주소는 탐색할 수 없습니다.');
  return url;
}

function isBlockedPath(value) {
  const url = value instanceof URL ? value : new URL(value);
  let text = `${url.pathname}${url.search}`;
  try { text = decodeURIComponent(text); } catch { /* Keep encoded text if malformed. */ }
  return MUTATING_PATH.test(text) || /(?:삭제|탈퇴|결제|구매|송금|로그아웃)/.test(text);
}

function validateAction(action, viewport = VIEWPORT) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new SitePolicyError('허용된 화면 동작이 아닙니다.');
  const keys = action.type === 'click' ? ['type', 'x', 'y', 'button'] : action.type === 'scroll' ? ['type', 'x', 'y', 'scroll_x', 'scroll_y'] : action.type === 'type' ? ['type', 'x', 'y', 'text'] : [];
  if (!keys.length || Object.keys(action).some(key => !keys.includes(key))) throw new SitePolicyError('클릭, 스크롤, 제한된 텍스트 입력만 허용됩니다.');
  for (const [coordinate, limit] of [['x', viewport.width], ['y', viewport.height]]) {
    if (!Number.isFinite(action[coordinate]) || action[coordinate] < 0 || action[coordinate] >= limit) throw new SitePolicyError('동작 좌표가 브라우저 화면 밖입니다.');
  }
  if (action.type === 'click' && action.button !== undefined && action.button !== 'left') throw new SitePolicyError('왼쪽 클릭만 허용됩니다.');
  if (action.type === 'scroll') {
    if (!Number.isFinite(action.scroll_x) || !Number.isFinite(action.scroll_y) || Math.abs(action.scroll_x) > 640 || Math.abs(action.scroll_y) > 1200) throw new SitePolicyError('스크롤 범위가 허용 한도를 초과했습니다.');
  }
  if (action.type === 'type' && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(action.text))) {
    throw new SitePolicyError('입력은 줄바꿈과 제어 문자가 없는 200자 이하의 텍스트만 허용됩니다.');
  }
  return action;
}

function requestPolicy({ url, method, navigation, ownedPage }, allowedOrigin) {
  let target;
  try { target = new URL(url); } catch { return '잘못된 요청 주소'; }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return '외부 프로토콜 또는 계정 정보가 포함된 요청';
  if (!['GET', 'HEAD'].includes(method)) return '상태를 변경하는 네트워크 요청';
  if (isBlockedPath(target)) return '상태를 변경할 수 있는 경로';
  if (navigation && (!ownedPage || target.origin !== allowedOrigin)) return '허용된 사이트 밖으로 이동하는 요청';
  return null;
}

async function startSiteSession({ url: input, signal, onStatus = () => {}, credentials: suppliedCredentials }) {
  const target = validateTargetUrl(input);
  const credentials = validateCredentials(suppliedCredentials);
  const redact = createSecretRedactor(credentials);
  signal?.throwIfAborted();
  const allowedOrigin = target.origin;
  let browser;
  let context;
  let page;
  let windowSession;
  let browserWindowId;
  let browserPid;
  let capturedViewport;
  let closed = false;
  let closePromise;
  let lastBlocked = '';
  let consecutiveRedirects = 0;
  let pendingNavigation;
  let loginPermit;
  let loginAttempted = false;
  let privateInputStarted = false;
  let loginInputInProgress = false;
  const elementSnapshot = new Map();
  const status = label => { try { onStatus(redact(label)); } catch { /* Observers cannot widen session privileges. */ } };
  const blocked = reason => { lastBlocked = reason; status(`차단: ${reason}`); };
  const assertActive = () => {
    signal?.throwIfAborted();
    if (closed || !page || page.isClosed()) throw new SitePolicyError('사이트 탐색 세션이 종료되었습니다.');
    if (page.url() !== 'about:blank' && new URL(page.url()).origin !== allowedOrigin) throw new SitePolicyError('허용된 사이트 범위를 벗어났습니다.');
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    loginPermit = undefined;
    elementSnapshot.clear();
    signal?.removeEventListener('abort', onAbort);
    closePromise = (async () => {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    })();
    return closePromise;
  };
  const onAbort = () => { void close(); };

  try {
    status('분리된 Microsoft Edge 탐색 창을 여는 중');
    browser = await chromium.launch({ channel: 'msedge', headless: false, chromiumSandbox: true, args: ['--start-maximized'] });
    if (process.platform === 'win32') {
      const browserSession = await browser.newBrowserCDPSession();
      const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
      browserPid = processInfo.find(info => info.type === 'browser')?.id;
      await browserSession.detach();
    }
    if (signal?.aborted) { await close(); signal.throwIfAborted(); }
    context = await browser.newContext({ viewport: null, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { await close(); signal.throwIfAborted(); }
    context.on('page', candidate => {
      if (!page) { page = candidate; return; }
      blocked('새 창 또는 새 탭 열기');
      void candidate.close().catch(() => {});
    });
    await context.route('**/*', async route => {
      const request = route.request();
      let ownedPage = false;
      let mainFrame = false;
      try { ownedPage = request.frame().page() === page; } catch { /* No worker requests are trusted. */ }
      try { mainFrame = request.frame() === page.mainFrame(); } catch { /* Worker requests cannot authenticate. */ }
      const loginRequest = ownedPage && matchesLoginRequest({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), mainFrame, contentType: request.headers()['content-type'], body: request.postData() }, loginPermit, credentials);
      let reason = loginRequest ? null : requestPolicy({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), ownedPage }, allowedOrigin);
      if (loginInputInProgress && !loginRequest) reason = '로그인 입력 중 부가 네트워크 요청';
      if (privateInputStarted && new URL(request.url()).origin !== allowedOrigin) reason = '로그인 입력 이후 외부 연결';
      if (credentials && redact(request.url()) !== request.url()) reason = '계정 정보가 포함된 URL 요청';
      if (reason) { if (request.isNavigationRequest()) pendingNavigation = undefined; blocked(reason); await route.abort('blockedbyclient').catch(() => {}); return; }
      let finishLogin;
      const loginMode = loginRequest ? loginPermit.mode : undefined;
      const matchedLoginPermit = loginRequest ? loginPermit : undefined;
      if (loginRequest) {
        loginPermit.used = true;
        loginInputInProgress = false;
        loginPermit.completion = new Promise(resolve => { finishLogin = resolve; });
      }
      if (!request.isNavigationRequest() && !loginRequest) { await route.continue().catch(() => {}); return; }
      try {
        // Chromium's normal redirect chain bypasses subsequent Playwright routes.
        // Fetch one hop only, then turn an allowed redirect into a fresh navigation.
        const response = await route.fetch({ maxRedirects: 0, timeout: 20000 });
        const location = response.headers().location;
        if ([301, 302, 303, 307, 308].includes(response.status()) && location) {
          if (loginMode === 'spa') {
            matchedLoginPermit.failure = 'SPA 인증 응답이 리디렉션을 요구하여 로그인을 중지했습니다. 이 인증 흐름은 지원하지 않습니다.';
            blocked('SPA 인증 요청의 리디렉션은 지원하지 않습니다');
            await route.abort('blockedbyclient');
            return;
          }
          const destination = new URL(location, request.url());
          const redirectReason = requestPolicy({ url: destination.href, method: 'GET', navigation: true, ownedPage }, allowedOrigin);
          if (redirectReason || ++consecutiveRedirects > 10) {
            pendingNavigation = undefined;
            blocked(redirectReason || '리디렉션 횟수 초과');
            await route.abort('blockedbyclient');
            return;
          }
          pendingNavigation = destination.href;
          const escaped = destination.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escaped}"><title>사이트 내부 이동 중</title>` });
          return;
        }
        consecutiveRedirects = 0;
        pendingNavigation = undefined;
        if (/attachment/i.test(response.headers()['content-disposition'] ?? '')) {
          blocked('파일 다운로드');
          await route.abort('blockedbyclient');
          return;
        }
        await route.fulfill({ response });
      } catch (error) {
        if (matchedLoginPermit) matchedLoginPermit.failure = '로그인 요청의 응답을 완료하지 못했습니다.';
        pendingNavigation = undefined;
        if (!closed) blocked('탐색 요청을 완료할 수 없음');
        await route.abort('failed').catch(() => {});
      } finally { finishLogin?.(); }
    });
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket('**/*', socket => { blocked('WebSocket 연결'); socket.close(); });
    }
    await context.addInitScript(() => {
      // Fixed, local containment logic. No model-supplied JavaScript is executed.
      Object.defineProperty(window, 'open', { value: () => null, writable: false, configurable: false });
      let loginForm;
      let loginExpiry = 0;
      let loginMode;
      Object.defineProperty(window, '__webpilotLoginForm', { value: Object.freeze({
        arm(form, mode) { loginForm = form; loginMode = mode; loginExpiry = Date.now() + 5000; },
        clear() { loginForm = undefined; loginExpiry = 0; loginMode = undefined; },
      }), configurable: false, writable: false });
      document.addEventListener('submit', event => {
        const allowed = event.target === loginForm && Date.now() < loginExpiry;
        const mode = loginMode;
        loginForm = undefined; loginExpiry = 0;
        // Permit one native HTML submission; page submit handlers never receive
        // a reusable privilege. Network policy independently validates the body.
        if (!allowed) event.preventDefault();
        if (!allowed || mode !== 'spa') event.stopImmediatePropagation();
      }, true);
      document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest('input[type="file"],a[download]') : null;
        if (target) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
      for (const name of ['submit', 'requestSubmit']) Object.defineProperty(HTMLFormElement.prototype, name, { value() {}, writable: false, configurable: false });
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
        Object.defineProperty(window, name, { value: () => Promise.reject(new DOMException('Blocked by site policy', 'NotAllowedError')), writable: false, configurable: false });
      }
    });
    await context.addInitScript(() => {
      // A fixed visual pointer accompanies real page mouse events. It is not an
      // OS cursor and is removed from screenshots sent to the model.
      if (window !== window.top) return;
      let host;
      let pointer;
      let ring;
      let hidden = false;
      const style = (element, values) => { for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value); };
      function mount() {
        if (host?.isConnected || !document.documentElement) return;
        if (host) { document.documentElement.append(host); return; }
        host = document.createElement('div');
        host.setAttribute('data-webpilot-visual-pointer', 'true');
        host.setAttribute('aria-hidden', 'true');
        style(host, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', 'z-index': '2147483647', 'pointer-events': 'none', display: hidden ? 'none' : 'block' });
        const shadow = host.attachShadow({ mode: 'closed' });
        pointer = document.createElement('div');
        style(pointer, { position: 'absolute', transform: 'translate(24px, 24px)', transition: 'transform 550ms cubic-bezier(.22,.8,.3,1)', 'pointer-events': 'none' });
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '25'); svg.setAttribute('height', '31'); svg.setAttribute('viewBox', '0 0 25 31');
        style(svg, { display: 'block', filter: 'drop-shadow(0 2px 3px #00000035)' });
        const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shape.setAttribute('d', 'M3 2.5v23.8l6.2-6 4.5 9 4.2-2.2-4.5-8.7 8.4-.8L3 2.5Z');
        shape.setAttribute('fill', '#19191d'); shape.setAttribute('stroke', '#ffffff'); shape.setAttribute('stroke-width', '1.6'); shape.setAttribute('stroke-linejoin', 'round');
        svg.append(shape);
        ring = document.createElement('span');
        style(ring, { position: 'absolute', left: '-13px', top: '-13px', width: '34px', height: '34px', border: '1px solid #30303655', 'border-radius': '50%', background: '#1d1d2210', opacity: '0' });
        pointer.append(ring, svg); shadow.append(pointer); document.documentElement.append(host);
      }
      const api = Object.freeze({
        move(x, y) { mount(); if (pointer) pointer.style.transform = `translate(${x}px, ${y}px)`; },
        click() { mount(); ring?.animate([{ opacity: .85, transform: 'scale(.2)' }, { opacity: 0, transform: 'scale(1.8)' }], { duration: 700, easing: 'ease-out' }); },
        visible(value) { hidden = !value; mount(); if (host) host.style.display = hidden ? 'none' : 'block'; },
      });
      Object.defineProperty(window, '__webpilotVisualPointer', { value: api, writable: false, configurable: false });
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
      else mount();
    });
    await context.newPage();
    windowSession = await context.newCDPSession(page);
    const initialWindow = await windowSession.send('Browser.getWindowForTarget');
    browserWindowId = initialWindow.windowId;
    if (initialWindow.bounds.windowState !== 'maximized') {
      await windowSession.send('Browser.setWindowBounds', { windowId: browserWindowId, bounds: { windowState: 'maximized' } });
    }
    await page.bringToFront();
    if (process.platform === 'win32') await focusManagedEdge(browserPid);
    page.on('download', download => { blocked('파일 다운로드'); void download.cancel().catch(() => {}); });
    page.on('dialog', dialog => { blocked('사이트 대화상자'); void dialog.dismiss().catch(() => {}); });
    page.on('filechooser', () => blocked('파일 선택 창'));
    page.setDefaultTimeout(5000);
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const settleNavigation = async () => {
      const deadline = Date.now() + 15000;
      do {
        await page.waitForTimeout(100);
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        if (!pendingNavigation) return;
      } while (Date.now() < deadline);
      throw new SitePolicyError('사이트 이동이 제한 시간 안에 완료되지 않았습니다.');
    };
    await settleNavigation();
    assertActive();
    status('허용된 사이트에서 탐색 준비 완료');
    const foreground = async () => {
      assertActive();
      const { bounds } = await windowSession.send('Browser.getWindowBounds', { windowId: browserWindowId });
      if (bounds.windowState === 'minimized') {
        await windowSession.send('Browser.setWindowBounds', { windowId: browserWindowId, bounds: { windowState: 'normal' } });
        await windowSession.send('Browser.setWindowBounds', { windowId: browserWindowId, bounds: { windowState: 'maximized' } });
      }
      await page.bringToFront();
      if (process.platform === 'win32') await focusManagedEdge(browserPid);
      await page.waitForTimeout(180);
      assertActive();
    };
    const viewportSize = () => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const movePointer = async (x, y) => {
      await page.evaluate(({ x, y }) => window.__webpilotVisualPointer?.move(x, y), { x, y });
      await page.mouse.move(x, y, { steps: 20 });
      await page.waitForTimeout(560);
      assertActive();
    };
    const clickPointer = async () => { await page.evaluate(() => window.__webpilotVisualPointer?.click()); };

    const clearSnapshot = async () => {
      const handles = [...elementSnapshot.values()];
      elementSnapshot.clear();
      await Promise.allSettled(handles.map(handle => handle.dispose()));
    };
    const challengePresent = () => page.evaluate(() => {
      const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      return [...document.querySelectorAll('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="verification_code" i],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]')].some(visible)
        || /(?:enter (?:the |your )?(?:verification|security|authentication) code|two.factor authentication|multi.factor authentication|인증\s*코드.{0,12}입력|보안\s*문자.{0,12}입력|로봇이 아닙니다)/i.test(document.body?.innerText ?? '');
    });
    const visiblePasswordPresent = () => page.evaluate(() => [...document.querySelectorAll('input[type="password"]')].some(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight && getComputedStyle(element).visibility !== 'hidden';
    }));
    const detectLoginForm = async () => {
      const forms = await page.$$('form');
      const found = [];
      for (const form of forms) {
        const metadata = await form.evaluate(element => {
          const visible = field => { const box = field.getBoundingClientRect(); return Boolean(box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight && getComputedStyle(field).visibility !== 'hidden' && !field.disabled && !field.readOnly && !field.closest('[inert]')); };
          const controls = Array.from(element.elements);
          const passwords = controls.filter(field => field instanceof HTMLInputElement && field.type === 'password' && visible(field));
          const users = controls.filter(field => field instanceof HTMLInputElement && ['text', 'email'].includes(field.type) && visible(field));
          const submits = controls.filter(field => (field instanceof HTMLButtonElement && field.type === 'submit' || field instanceof HTMLInputElement && field.type === 'submit') && visible(field));
          if (passwords.length !== 1 || users.length !== 1 || submits.length !== 1 || !visible(element)) return null;
          const [password] = passwords, [user] = users, [submit] = submits;
          if (!user.name || !password.name || user.name === password.name || password.autocomplete === 'new-password') return null;
          if (element.enctype !== 'application/x-www-form-urlencoded' || element.target && element.target.toLowerCase() !== '_self') return null;
          if (submit.hasAttribute('formaction') || submit.hasAttribute('formmethod') || submit.hasAttribute('formtarget') || submit.hasAttribute('formenctype') || submit.formNoValidate) return null;
          const mode = element.getAttribute('action') && element.method.toLowerCase() === 'post' ? 'html' : 'spa';
          const fields = controls.filter(field => field === user || field === password || field instanceof HTMLInputElement && (field.type === 'hidden' && /^(?:_?csrf(?:[_-]?token)?|_?xsrf(?:[_-]?token)?|authenticity_token|__RequestVerificationToken)$/i.test(field.name) || field.type === 'checkbox' && /^remember(?:[_-]?(?:me|login))?$/i.test(field.name))).map(field => field.name).filter(Boolean);
          return {
            url: element.action, mode, method: element.method, description: [element.id, element.name, element.getAttribute('aria-label'), element.action, password.autocomplete].join(' '),
            label: [submit.textContent, submit.getAttribute('aria-label'), submit instanceof HTMLInputElement ? submit.value : ''].filter(Boolean).join(' ').trim(),
            usernameField: user.name, passwordField: password.name, fields,
            userIndex: controls.indexOf(user), passwordIndex: controls.indexOf(password), submitIndex: controls.indexOf(submit),
          };
        }).catch(() => null);
        if (metadata && LOGIN_LABEL.test(metadata.label) && !LOGIN_DANGER.test(`${metadata.description} ${metadata.label}`)) {
          let destination;
          try { destination = validateTargetUrl(metadata.url); } catch { /* A login cannot widen the navigation policy. */ }
          if (destination?.origin === allowedOrigin) found.push({ form, metadata });
          else await form.dispose();
        } else await form.dispose();
      }
      if (found.length !== 1) { await Promise.all(found.map(item => item.form.dispose())); return null; }
      return found[0];
    };
    const checkedPoint = async handle => {
      assertActive();
      if (!await handle.isVisible() || !await handle.isEnabled()) throw new SitePolicyError('선택한 요소가 더 이상 표시되지 않습니다. 페이지를 다시 읽어 주세요.');
      const box = await handle.boundingBox();
      const viewport = await viewportSize();
      if (!box || box.width <= 0 || box.height <= 0) throw new SitePolicyError('선택한 요소의 위치를 확인할 수 없습니다.');
      const x = Math.max(0, box.x) + (Math.min(viewport.width, box.x + box.width) - Math.max(0, box.x)) / 2;
      const y = Math.max(0, box.y) + (Math.min(viewport.height, box.y + box.height) - Math.max(0, box.y)) / 2;
      if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height || box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= viewport.width || box.y >= viewport.height) throw new SitePolicyError('선택한 요소가 현재 화면 밖에 있습니다.');
      if (!await handle.evaluate((element, point) => { const hit = document.elementFromPoint(point.x, point.y); return hit === element || element.contains(hit); }, { x, y })) throw new SitePolicyError('선택한 요소가 다른 화면 요소에 가려져 있습니다.');
      return { x, y };
    };
    const typeValue = async (field, value) => {
      const point = await checkedPoint(field);
      await movePointer(point.x, point.y);
      const current = await checkedPoint(field);
      if (Math.abs(current.x - point.x) > 2 || Math.abs(current.y - point.y) > 2) throw new SitePolicyError('로그인 입력란이 이동하여 로그인을 중지했습니다.');
      await clickPointer();
      await page.mouse.click(point.x, point.y, { button: 'left' });
      await field.fill('');
      await field.type(value, { delay: 35, timeout: 5000 + value.length * 40 });
    };

    const login = async () => {
      if (!credentials) throw new SitePolicyError('로그인 계정이 제공되지 않았습니다. 계정을 입력한 뒤 다시 시작해 주세요.');
      if (loginAttempted) throw new SitePolicyError('이번 작업에서는 로그인 시도를 한 번만 허용합니다.');
      if (await challengePresent()) throw new SitePolicyError('CAPTCHA 또는 추가 인증이 필요하여 자동 로그인을 중지했습니다.');
      const detected = await detectLoginForm();
      if (!detected) throw new SitePolicyError('지원되는 동일 사이트 로그인 폼을 찾지 못했습니다. 외부 SSO 또는 복잡한 로그인 흐름은 지원하지 않습니다.');
      const { form, metadata } = detected;
      let user, password, submit;
      try {
        user = (await form.evaluateHandle((element, index) => element.elements[index], metadata.userIndex)).asElement();
        password = (await form.evaluateHandle((element, index) => element.elements[index], metadata.passwordIndex)).asElement();
        submit = (await form.evaluateHandle((element, index) => element.elements[index], metadata.submitIndex)).asElement();
        if (!user || !password || !submit) throw new SitePolicyError('로그인 폼이 변경되어 로그인을 중지했습니다.');
        loginAttempted = true;
        privateInputStarted = true;
        loginInputInProgress = true;
        status('제공된 계정으로 사이트 안에서 로그인하는 중');
        await typeValue(user, credentials.username);
        await typeValue(password, credentials.password);
        const unchanged = await form.evaluate((element, expected) => element.action === expected.url && element.method === expected.method && element.elements[expected.userIndex]?.name === expected.usernameField && element.elements[expected.passwordIndex]?.name === expected.passwordField, metadata);
        if (!unchanged) throw new SitePolicyError('로그인 폼이 변경되어 로그인을 중지했습니다.');
        const point = await checkedPoint(submit);
        await movePointer(point.x, point.y);
        const current = await checkedPoint(submit);
        if (Math.abs(current.x - point.x) > 2 || Math.abs(current.y - point.y) > 2) throw new SitePolicyError('로그인 버튼이 이동하여 로그인을 중지했습니다.');
        loginPermit = { ...metadata, allowedOrigin, used: false, expires: Date.now() + 5000 };
        await form.evaluate((element, mode) => window.__webpilotLoginForm.arm(element, mode), metadata.mode);
        await clickPointer();
        await page.mouse.click(point.x, point.y, { button: 'left' });
        while (!loginPermit.used && Date.now() < loginPermit.expires) { await page.waitForTimeout(100); assertActive(); }
        await loginPermit.completion;
        await page.waitForTimeout(450);
        await settleNavigation();
        const used = loginPermit?.used;
        const failure = loginPermit?.failure;
        loginPermit = undefined;
        assertActive();
        if (failure) throw new SitePolicyError(failure);
        if (!used) throw new SitePolicyError('허용된 로그인 요청이 발생하지 않았습니다. 일반 HTML 또는 표준 JSON/form 인증 요청만 지원합니다.');
        if (await challengePresent()) throw new SitePolicyError('추가 인증 또는 CAPTCHA가 필요하여 자동 탐색을 중지했습니다.');
        return { message: '제공된 계정으로 동일 사이트의 로그인 폼을 제출했습니다. 로그인 결과는 페이지에 표시된 내용을 확인합니다.', url: redact(page.url()) };
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        throw new SitePolicyError(error instanceof SitePolicyError ? redact(error.message) : '로그인 입력 또는 제출을 완료하지 못했습니다. 로그인 페이지 구성을 확인해 주세요.');
      } finally {
        loginPermit = undefined;
        loginInputInProgress = false;
        await page.evaluate(() => window.__webpilotLoginForm?.clear()).catch(() => {});
        await Promise.allSettled([user, password, submit, form].filter(Boolean).map(handle => handle.dispose()));
      }
    };

    const session = {
      async observe() {
        assertActive();
        await foreground();
        await settleNavigation();
        await clearSnapshot();
        if (credentials && await challengePresent()) throw new SitePolicyError('추가 인증 또는 CAPTCHA가 필요하여 자동 탐색을 중지했습니다.');
        const view = await page.evaluate(() => {
          const visible = element => {
            if (!element || element.closest('input,textarea,select,script,style,noscript,[aria-hidden="true"],[contenteditable="true"],[data-webpilot-visual-pointer]')) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
          };
          const parts = [];
          const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
          let node, total = 0, inspected = 0;
          while ((node = walker.nextNode()) && total < 10000 && inspected++ < 6000) {
            if (!visible(node.parentElement)) continue;
            const text = node.textContent?.replace(/\s+/g, ' ').trim();
            if (text) { parts.push(text); total += text.length + 1; }
          }
          return { title: document.title.slice(0, 300), text: parts.join('\n').slice(0, 10000), viewport: { width: innerWidth, height: innerHeight } };
        });
        const elements = [];
        const candidates = await page.$$('a[href],button,input,textarea');
        for (const handle of candidates) {
          if (elements.length >= 60) { await handle.dispose(); continue; }
          const metadata = await handle.evaluate(element => {
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight || getComputedStyle(element).visibility === 'hidden' || element.closest('[inert]') || element.disabled || element.getAttribute('aria-disabled') === 'true') return null;
            const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
            // Never expose control values, password fields, or credential metadata.
            if (input && (element.readOnly || element instanceof HTMLInputElement && !['text', 'search', 'url'].includes(element.type))) return null;
            if (!input && (element.closest('form') || element instanceof HTMLButtonElement && (element.type !== 'button' || element.form))) return null;
            if (element instanceof HTMLAnchorElement && (element.download || element.hasAttribute('download') || element.target && element.target.toLowerCase() !== '_self')) return null;
            const label = [element.getAttribute('aria-label'), element.getAttribute('title'), input ? element.placeholder : element.textContent, ...Array.from(element.labels ?? []).map(label => label.textContent)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
            return { role: input ? 'textbox' : element instanceof HTMLAnchorElement ? 'link' : 'button', label, type: input ? element.type : 'click', href: element instanceof HTMLAnchorElement ? element.href : undefined,
              description: input ? [element.type, element.name, element.id, element.placeholder, element.autocomplete, label, element.form?.action, element.form?.id, element.form?.name].filter(Boolean).join(' ') : label };
          }).catch(() => null);
          let permitted = metadata && !(metadata.role === 'textbox' ? SENSITIVE_INPUT.test(metadata.description) : SENSITIVE_LABEL.test(metadata.description));
          if (metadata?.href) {
            try { permitted &&= validateTargetUrl(metadata.href).origin === allowedOrigin && redact(metadata.href) === metadata.href; } catch { permitted = false; }
          }
          if (!permitted) { await handle.dispose(); continue; }
          const id = randomUUID();
          elementSnapshot.set(id, handle);
          elements.push({ id, role: metadata.role, label: redact(metadata.label), type: metadata.type, ...(metadata.href ? { href: redact(metadata.href) } : {}) });
        }
        const form = credentials && !loginAttempted && !await challengePresent() ? await detectLoginForm() : null;
        const loginAvailable = Boolean(form);
        await form?.form.dispose();
        if (credentials && !loginAttempted && !loginAvailable && await visiblePasswordPresent()) throw new SitePolicyError('로그인 입력란이 있지만 지원되는 동일 사이트 로그인 폼을 확인하지 못해 탐색을 중지했습니다. 외부 SSO·복잡한 인증 화면은 지원하지 않습니다.');
        return { url: redact(page.url()), title: redact(view.title), text: redact(view.text), viewport: view.viewport, elements, loginAvailable };
      },
      async act(rawAction) {
        const action = validateDomAction(rawAction);
        assertActive();
        await foreground();
        lastBlocked = '';
        try {
          if (action.action === 'login') return await login();
          if (action.action === 'scroll') {
            const viewport = await viewportSize();
            return await session.perform({ type: 'scroll', x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2), scroll_x: 0, scroll_y: action.scroll_y });
          }
          const handle = elementSnapshot.get(action.element_id);
          if (!handle) throw new SitePolicyError('요소 ID가 만료되었거나 이 페이지에서 제공되지 않았습니다. 페이지를 다시 읽어 주세요.');
          const point = await checkedPoint(handle);
          // DOM actions are based on a fresh element handle, not an old screenshot.
          capturedViewport = undefined;
          return await session.perform({ type: action.action, ...point, ...(action.action === 'type' ? { text: action.text } : {}) }, handle);
        } catch (error) {
          if (signal?.aborted) signal.throwIfAborted();
          if (privateInputStarted && !(error instanceof SitePolicyError)) throw new SitePolicyError('페이지 동작을 완료하지 못했습니다. 페이지를 다시 읽어 주세요.');
          throw error;
        } finally { await clearSnapshot(); }
      },
      async capture() {
        assertActive();
        await foreground();
        await settleNavigation();
        await page.evaluate(() => window.__webpilotVisualPointer?.visible(false));
        try {
          const screenshot = await page.screenshot({ type: 'png', scale: 'css', fullPage: false, timeout: 15000 });
          assertActive();
          // Report the PNG's exact CSS-pixel dimensions, including native window
          // changes, rather than a fixed emulated viewport.
          capturedViewport = { width: screenshot.readUInt32BE(16), height: screenshot.readUInt32BE(20) };
          return { imageDataUrl: `data:image/png;base64,${screenshot.toString('base64')}`, ...capturedViewport, url: page.url() };
        } finally { await page.evaluate(() => window.__webpilotVisualPointer?.visible(true)).catch(() => {}); }
      },
      async perform(rawAction, expectedHandle) {
        assertActive();
        await foreground();
        const viewport = await viewportSize();
        if (capturedViewport && (capturedViewport.width !== viewport.width || capturedViewport.height !== viewport.height)) {
          throw new SitePolicyError('브라우저 화면 크기가 변경되었습니다. 새 화면을 캡처한 뒤 다시 동작을 선택해 주세요.');
        }
        const action = validateAction(rawAction, viewport);
        lastBlocked = '';
        if (action.type === 'click') {
          await movePointer(action.x, action.y);
          if (expectedHandle) {
            const current = await checkedPoint(expectedHandle);
            if (Math.abs(current.x - action.x) > 2 || Math.abs(current.y - action.y) > 2) throw new SitePolicyError('요소가 이동했습니다. 페이지를 다시 읽어 주세요.');
          }
          const element = await page.evaluate(({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            const candidate = hit?.closest('a[href],button');
            if (!(candidate instanceof HTMLAnchorElement || candidate instanceof HTMLButtonElement)) return { allowed: false, reason: '링크와 일반 버튼만 클릭할 수 있습니다.' };
            if (candidate.closest('form') || candidate.closest('[inert]') || candidate.getAttribute('aria-disabled') === 'true') return { allowed: false, reason: '폼 또는 비활성 요소는 조작할 수 없습니다.' };
            if (candidate instanceof HTMLButtonElement && (candidate.disabled || candidate.type !== 'button' || candidate.form)) return { allowed: false, reason: '제출 버튼과 폼 버튼은 조작할 수 없습니다.' };
            const label = [candidate.textContent, candidate.getAttribute('aria-label'), candidate.getAttribute('title'), candidate.getAttribute('name')].filter(Boolean).join(' ').slice(0, 1000);
            if (candidate instanceof HTMLAnchorElement) {
              if (candidate.download || candidate.hasAttribute('download') || (candidate.target && candidate.target.toLowerCase() !== '_self')) return { allowed: false, reason: '새 창과 다운로드 링크는 허용되지 않습니다.' };
              return { allowed: true, label, href: candidate.href };
            }
            return { allowed: true, label };
          }, { x: action.x, y: action.y });
          if (!element.allowed) { blocked(element.reason); throw new SitePolicyError(element.reason); }
          if (SENSITIVE_LABEL.test(element.label)) { blocked('민감하거나 상태를 변경할 수 있는 버튼'); throw new SitePolicyError('민감하거나 상태를 변경할 수 있는 버튼은 클릭하지 않습니다.'); }
          if (element.href) {
            const destination = validateTargetUrl(element.href);
            if (destination.origin !== allowedOrigin) { blocked('허용된 사이트 밖의 링크'); throw new SitePolicyError('허용된 사이트 밖의 링크는 클릭하지 않습니다.'); }
          }
          await clickPointer();
          await page.mouse.click(action.x, action.y, { button: 'left' });
        } else if (action.type === 'type') {
          await movePointer(action.x, action.y);
          if (expectedHandle) {
            const current = await checkedPoint(expectedHandle);
            if (Math.abs(current.x - action.x) > 2 || Math.abs(current.y - action.y) > 2) throw new SitePolicyError('입력란이 이동했습니다. 페이지를 다시 읽어 주세요.');
          }
          const handle = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), { x: action.x, y: action.y });
          try {
            const field = handle.asElement();
            if (!field) throw new SitePolicyError('입력할 수 있는 텍스트 필드가 아닙니다.');
            const metadata = await field.evaluate(element => {
              if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return { allowed: false };
              if (element instanceof HTMLInputElement && !['text', 'search', 'url'].includes(element.type)) return { allowed: false };
              if (element.disabled || element.readOnly || element.closest('[inert]') || element.getAttribute('aria-disabled') === 'true') return { allowed: false };
              return {
                allowed: true,
                description: [element.type, element.name, element.id, element.placeholder, element.autocomplete, element.getAttribute('aria-label'), element.getAttribute('title'), ...Array.from(element.labels ?? []).map(label => label.textContent), element.form?.action, element.form?.id, element.form?.name].filter(Boolean).join(' '),
              };
            });
            if (!metadata.allowed || SENSITIVE_INPUT.test(metadata.description ?? '') || !(await field.isVisible()) || !(await field.isEnabled())) {
              blocked('민감하거나 지원하지 않는 입력란');
              throw new SitePolicyError('검색 등 일반 텍스트 입력란만 사용할 수 있습니다. 계정·비밀번호·개인정보·결제 필드는 입력하지 않습니다.');
            }
            await clickPointer();
            await page.mouse.click(action.x, action.y, { button: 'left' });
            assertActive();
            await field.fill('');
            const marker = randomUUID();
            await field.evaluate((element, marker) => element.setAttribute('data-webpilot-input-target', marker), marker);
            try { await page.locator(`[data-webpilot-input-target="${marker}"]`).pressSequentially(action.text, { delay: 35, timeout: 15000 }); }
            finally { await field.evaluate(element => element.removeAttribute('data-webpilot-input-target')).catch(() => {}); }
          } finally { await handle.dispose(); }
        } else {
          await movePointer(action.x, action.y);
          await page.mouse.wheel(action.scroll_x, action.scroll_y);
        }
        await page.waitForTimeout(450);
        await settleNavigation();
        assertActive();
        return { message: lastBlocked ? `차단: ${lastBlocked}` : action.type === 'click' ? '허용된 사이트 안에서 링크 또는 일반 버튼을 클릭했습니다.' : action.type === 'type' ? '일반 입력란에 텍스트를 입력했습니다. 제출하지 않았습니다.' : '허용된 사이트 화면을 스크롤했습니다.', url: redact(page.url()) };
      },
      close,
    };
    return session;
  } catch (error) {
    await close();
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  }
}

module.exports = { startSiteSession, validateTargetUrl, validateAction, validateDomAction, matchesLoginRequest, requestPolicy, isBlockedPath, SitePolicyError, VIEWPORT };
