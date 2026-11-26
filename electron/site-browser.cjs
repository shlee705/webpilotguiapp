'use strict';

const { chromium } = require('playwright-core');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { createManagedEdgeFocus } = require('./focus-edge.cjs');
const { validateCredentials, createSecretRedactor } = require('./login-secrets.cjs');

const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const MUTATING_PATH = /(?:^|[\/_.?=&-])(?:logout|logoff|signout|sign-out|delete|destroy|remove|unsubscribe|checkout|purchase|payment|pay|order|transfer|withdraw|reset|confirm|approve|submit|publish|send|invite|revoke)(?:$|[\/_.?=&-])/i;
const SENSITIVE_LABEL = /(?:log\s*out|sign\s*out|delete|destroy|remove|unsubscribe|checkout|purchase|payment|\bpay\b|\border\b|transfer|withdraw|reset|confirm|approve|submit|publish|send|invite|revoke|로그아웃|탈퇴|삭제|제거|결제|구매|주문|송금|이체|출금|초기화|승인|제출|게시|발행|전송|초대|구독\s*해지|파일\s*선택|업로드)/i;
const SENSITIVE_INPUT = /(?:password|passwd|\bpwd\b|secret|token|api[\s_-]*key|credential|auth|login|sign[\s_-]*in|account|user[\s_-]*name|first[\s_-]*name|last[\s_-]*name|full[\s_-]*name|e[\s_-]*mail|phone|telephone|mobile|address|postal|zip[\s_-]*code|card|cc-|cvc|cvv|payment|billing|bank|iban|\bssn\b|social[\s_-]*security|birth|credit|debit|비밀번호|암호|인증|토큰|API\s*키|로그인|계정|아이디|이름|성명|이메일|메일|전화|연락처|주소|우편|카드|결제|계좌|주민|생년)/i;
const LOGIN_LABEL = /(?:log\s*in|sign[\s_-]*in|로그인)/i;
const LOGIN_DANGER = /(?:register|registration|sign[\s_-]*up|create[\s_-]*account|reset|forgot|change[\s_-]*password|checkout|payment|purchase|delete|회원\s*가입|가입|비밀번호\s*(?:변경|찾기|재설정)|결제|구매|삭제)/i;
const AUTH_PATH = /(?:^|\/)(?:login|signin|sign-in|authenticate|auth|session)(?:\/|$)/i;
const CONTENT_ENDPOINT = /\/(posts|articles|notices)\/?$/i;
const CONTENT_SUBMIT_LABEL = /(?:공지|게시글|글|내용)?\s*(?:등록|게시|발행)|(?:publish|submit|create|post)(?:\s+(?:a\s+)?(?:post|article|notice))?/i;
const CONTENT_DANGER = /(?:delete|remove|destroy|payment|purchase|checkout|transfer|withdraw|account|profile|password|login|sign[ -]?up|삭제|제거|결제|구매|송금|계정|비밀번호|로그인|회원|수정)|(?:^|[\/\s_-])(?:update|edit)(?=$|[\/\s_-])/i;
const CONTENT_KINDS = Object.freeze(['notice', 'post', 'article']);

function isForbiddenContentContext(description) { return CONTENT_DANGER.test(description); }

function validateTaskPermissions(value) {
  if (value === undefined) return { allowContentSubmission: false, contentKinds: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.allowContentSubmission !== 'boolean'
    || !Array.isArray(value.contentKinds) || value.contentKinds.some(kind => !CONTENT_KINDS.includes(kind))
    || Object.keys(value).some(key => !['allowContentSubmission', 'contentKinds'].includes(key))) throw new SitePolicyError('올바른 콘텐츠 등록 권한이 필요합니다.');
  return { allowContentSubmission: value.allowContentSubmission, contentKinds: [...new Set(value.contentKinds)] };
}

function matchesContentSubmission(request, permit, now = Date.now()) {
  if (!permit || permit.used || now > permit.expires || request.method !== 'POST' || !request.mainFrame || !permit.submitted) return false;
  let target;
  try { target = new URL(request.url); } catch { return false; }
  if (target.origin !== permit.allowedOrigin || target.username || target.password || !CONTENT_ENDPOINT.test(target.pathname)
    || isBlockedPath(target) || isForbiddenContentContext(target.pathname + target.search) || target.search || target.hash) return false;
  if (permit.mode === 'html' ? !request.navigation || request.url !== permit.url : request.navigation) return false;
  if (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 32768) return false;
  let values;
  const formEncoded = /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.contentType ?? '');
  if (formEncoded) {
    const fields = new URLSearchParams(request.body);
    if ([...fields.keys()].some(key => fields.getAll(key).length !== 1)) return false;
    values = Object.fromEntries(fields);
  } else if (permit.mode === 'spa' && /^application\/json(?:;|$)/i.test(request.contentType ?? '')) {
    try { values = JSON.parse(request.body); } catch { return false; }
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => !['string', 'boolean'].includes(typeof value))) return false;
  } else return false;
  const expected = permit.fields;
  if (Object.keys(values).some(key => !Object.hasOwn(expected, key) && key !== 'board')) return false;
  const aliases = { notice: ['notice', 'notices'], post: ['post', 'posts'], article: ['article', 'articles'] };
  if (!Object.hasOwn(expected, 'board') && Object.hasOwn(values, 'board') && !aliases[permit.contentKind]?.includes(values.board)) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (formEncoded && typeof value === 'boolean') {
      if (value ? values[key] !== permit.checkboxValues?.[key] : Object.hasOwn(values, key)) return false;
    } else if (typeof value === 'string') {
      if (typeof values[key] !== 'string' || values[key].replace(/\r\n?/g, '\n') !== value.replace(/\r\n?/g, '\n')) return false;
    } else if (values[key] !== value) return false;
  }
  return true;
}

// Fixed browser-side inspection; values remain in the native one-shot permit.
function readContentForm(element) {
  const visible = field => field?.isConnected && field.getClientRects().length > 0 && getComputedStyle(field).visibility !== 'hidden' && !field.disabled && !field.readOnly && !field.closest('[inert]');
  if (!(element instanceof HTMLFormElement) || !visible(element) || element.target && element.target.toLowerCase() !== '_self' || element.enctype !== 'application/x-www-form-urlencoded') return null;
  const controls = Array.from(element.elements);
  if (controls.some(field => !field.disabled && field.validity && !field.validity.valid)) return null;
  const titles = controls.filter(field => field instanceof HTMLInputElement && field.type === 'text' && /^(?:title|subject|headline)$/i.test(field.name) && visible(field));
  const bodies = controls.filter(field => field instanceof HTMLTextAreaElement && /^(?:body|content|message|text)$/i.test(field.name) && visible(field));
  const submits = controls.filter(field => (field instanceof HTMLButtonElement || field instanceof HTMLInputElement) && field.type === 'submit' && visible(field));
  if (titles.length !== 1 || bodies.length !== 1 || submits.length !== 1) return null;
  const [title] = titles, [body] = bodies, [submit] = submits;
  if (!title.value.trim() || !body.value.trim() || title.value.length > 1000 || body.value.length > 4000 || !title.validity.valid || !body.validity.valid) return null;
  if (['formaction', 'formmethod', 'formtarget', 'formenctype', 'formnovalidate'].some(name => submit.hasAttribute(name))) return null;
  const fields = {}, checkboxValues = {};
  for (const field of controls) {
    if (field.disabled || field instanceof HTMLButtonElement || field instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(field.type)) continue;
    if (!field.name || Object.hasOwn(fields, field.name)) return null;
    if (field === title || field === body) fields[field.name] = field.value;
    else if (field instanceof HTMLSelectElement && field.type === 'select-one' && /^(?:category|board|section)$/i.test(field.name) && visible(field)) fields[field.name] = field.value;
    else if (field instanceof HTMLInputElement && field.type === 'checkbox' && /^(?:secret|pinned)$/i.test(field.name) && visible(field)) { fields[field.name] = field.checked; checkboxValues[field.name] = field.value; }
    else if (field instanceof HTMLInputElement && field.type === 'hidden' && /^(?:board|category|_?csrf(?:[_-]?token)?|_?xsrf(?:[_-]?token)?|authenticity_token|__RequestVerificationToken)$/i.test(field.name)) fields[field.name] = field.value;
    else return null;
  }
  const label = (submit.getAttribute('aria-label') || submit.textContent || submit.value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const description = [location.pathname, element.id, element.name, element.getAttribute('aria-label'), label].join(' ');
  const contentKind = /notice|공지/i.test(description) ? 'notice' : /article|기사/i.test(description) ? 'article' : 'post';
  return { url: element.action, mode: element.getAttribute('action') && element.method.toLowerCase() === 'post' ? 'html' : 'spa', method: element.method,
    label, description, contentKind, title: title.value, fields, checkboxValues, submitIndex: controls.indexOf(submit) };
}
const SAMPLE_ACCOUNT = /(?:예시|샘플|체험|데모)\s*계정|(?:sample|demo|example)\s*(?:account|credentials)|^(?:관리자|학생)\s*계정(?:\s*(?:사용|입력|로그인))?$|^(?:관리자|학생)\s+\d{4,}\s*\/\s*\S+|(?:user(?:name)?|아이디|\bID)\s*[:：]\s*\S+\s*(?:\/|[,;])\s*(?:pass(?:word)?|비밀번호)\s*[:：]/i;

function isSensitiveControl(label) {
  // Opening an editor is a read-only UI transition; publishing it is not.
  const withoutEditorEntry = String(label).replace(/게시글\s*(?:작성|쓰기)|게시판|글쓰기|새\s*게시글|(?:create|write|new)\s+(?:a\s+)?post/gi, '');
  return SAMPLE_ACCOUNT.test(String(label).trim()) || SENSITIVE_LABEL.test(withoutEditorEntry);
}

function normalizeInputText(text) {
  if (typeof text !== 'string') throw new SitePolicyError('입력할 텍스트가 필요합니다.');
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.trim() || normalized.length > 4000 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized.replace(/\n/g, ''))) {
    throw new SitePolicyError('입력은 줄바꿈을 제외한 제어 문자가 없는 4000자 이하의 텍스트만 허용됩니다.');
  }
  return normalized;
}

// Evaluated in the page, both while observing and immediately before typing.
function readPageElement(element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight || getComputedStyle(element).visibility === 'hidden' || element.closest('[inert]') || element.disabled || element.getAttribute('aria-disabled') === 'true') return null;
  const native = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  const editable = element instanceof HTMLElement && element.isContentEditable && !element.parentElement?.isContentEditable;
  if (!native && !editable) {
    if (!(element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) || element.closest('form')) return null;
    if (element instanceof HTMLAnchorElement && (element.download || element.hasAttribute('download') || element.target && element.target.toLowerCase() !== '_self')) return null;
    const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    return { role: element instanceof HTMLAnchorElement ? 'link' : 'button', label, description: label, type: 'click', href: element instanceof HTMLAnchorElement ? element.href : undefined,
      button: element instanceof HTMLButtonElement ? { type: element.type, disabled: element.disabled, hasFormOwner: Boolean(element.form), inForm: Boolean(element.closest('form')),
        hasFormAttribute: element.hasAttribute('form'), hasSubmitOverrides: ['formaction', 'formmethod', 'formtarget', 'formenctype', 'formnovalidate'].some(name => element.hasAttribute(name)) } : undefined };
  }
  if (element instanceof HTMLInputElement && !['text', 'search', 'url'].includes(element.type)) return null;
  if (element.disabled || element.readOnly || element.closest('[inert]') || element.getAttribute('aria-disabled') === 'true' || element.getAttribute('aria-readonly') === 'true') return null;
  const labelText = label => {
    const parts = [];
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && parts.join(' ').length < 240) {
      if (!node.parentElement?.isContentEditable && !node.parentElement?.closest('input,textarea,select,script,style,[aria-hidden="true"]')) parts.push(node.textContent);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const label = (element.getAttribute('aria-label')?.trim() || Array.from(element.labels ?? []).map(labelText).filter(Boolean).join(' ')
    || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const form = element.form ?? element.closest('form');
  return { role: 'textbox', label, type: editable ? 'contenteditable' : element.type, multiline: editable || element instanceof HTMLTextAreaElement,
    description: [element.type, element.name, element.id, element.getAttribute('placeholder'), element.getAttribute('data-placeholder'), element.autocomplete, label, form?.action, form?.id, form?.name].filter(Boolean).join(' ') };
}

function typingDelay(length) { return Math.min(6, Math.floor(120 / Math.max(1, length))); }
function inputChunks(text) {
  const points = Array.from(text);
  const chunks = [];
  for (let index = 0; index < points.length; index += 100) chunks.push(points.slice(index, index + 100).join(''));
  return chunks;
}

function isStandaloneButton(button) {
  return Boolean(button && ['button', 'submit'].includes(button.type)
    && button.disabled === false && button.hasFormOwner === false && button.inForm === false
    && button.hasFormAttribute === false && button.hasSubmitOverrides === false);
}

async function readWithNavigationRecovery({ read, recover, assertActive = () => {}, signal }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    assertActive();
    try { return await read(); }
    catch (error) {
      signal?.throwIfAborted();
      const lostContext = error.name !== 'SitePolicyError'
        && /execution context was destroyed|cannot find context with (?:specified )?id|execution context is not available in detached frame/i.test(error.message ?? '');
      if (!lostContext || attempt === 2) throw error;
      // Only repeat observation of the newly committed document. The input or
      // click that triggered navigation has already happened and is not retried.
      await recover();
      signal?.throwIfAborted();
      assertActive();
    }
  }
}

async function waitForPageReady({ read, signal, expectChange = false, now = Date.now, wait = milliseconds => sleep(milliseconds, undefined, { signal }) }) {
  const started = now();
  let idleSince;
  while (true) {
    signal?.throwIfAborted();
    const state = await read();
    signal?.throwIfAborted();
    const elapsed = now() - started;
    const responseObserved = !expectChange || state.changed || elapsed >= 350;
    if (state.ready && !state.pending && !state.busy && state.quietForMs >= 90 && responseObserved) return true;
    if (state.pending || state.busy || !state.ready) idleSince = undefined;
    else idleSince ??= now();
    // Never wait indefinitely on polling requests, timers or animated content.
    const limit = state.busy ? 3000 : state.pending || !state.ready ? 1500 : responseObserved ? 180 : 350;
    const spent = idleSince === undefined ? elapsed : now() - idleSince;
    if (spent >= limit) return false;
    await wait(Math.min(30, limit - spent));
  }
}

function validateDomAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new SitePolicyError('허용된 사이트 동작이 아닙니다.');
  if (!['click', 'type', 'scroll', 'login', 'submit'].includes(action.action) || Object.keys(action).some(key => !['action', 'element_id', 'text', 'scroll_y'].includes(key))) throw new SitePolicyError('허용된 사이트 동작이 아닙니다.');
  if (['click', 'type', 'submit'].includes(action.action) && (typeof action.element_id !== 'string' || !/^[a-f0-9-]{36}$/.test(action.element_id))) throw new SitePolicyError('현재 페이지에서 제공한 요소 ID가 필요합니다.');
  if (action.action === 'type') return { ...action, text: normalizeInputText(action.text) };
  if (action.action === 'scroll' && (!Number.isFinite(action.scroll_y) || action.scroll_y === 0 || Math.abs(action.scroll_y) > 1200)) throw new SitePolicyError('0이 아닌 허용 범위의 스크롤 값이 필요합니다.');
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

function matchesLoginPreparationRequest(request, permit, submitted, now = Date.now()) {
  if (!permit || permit.used || now > permit.expires || !submitted || permit.mode !== 'spa'
    || !request.mainFrame || request.navigation || !['GET', 'HEAD'].includes(request.method)) return false;
  let destination;
  try { destination = new URL(request.url); } catch { return false; }
  // Some login clients obtain their CSRF cookie/token immediately before the
  // credential POST. Permit that read only after the guarded native submission;
  // keystroke handlers and arbitrary reads remain blocked while typing secrets.
  return destination.origin === permit.allowedOrigin && !destination.username && !destination.password
    && !destination.search && !destination.hash && /(?:^|\/)(?:csrf|xsrf)(?:[-_]token)?(?:\.json)?\/?$/i.test(destination.pathname);
}

class SitePolicyError extends Error {
  constructor(message) { super(message); this.name = 'SitePolicyError'; }
}

class SiteInteractionError extends Error {
  constructor(message = '페이지 입력 또는 동작의 완료 여부를 확인할 수 없어 중지했습니다. 같은 동작을 자동으로 다시 실행하지 않습니다.') { super(message); this.name = 'SiteInteractionError'; }
}

function sanitizeInteractionError(error, { inputStarted = false, privateInputStarted = false } = {}) {
  if (error?.name === 'AbortError') return error;
  if (inputStarted || privateInputStarted && !(error instanceof SitePolicyError)) return new SiteInteractionError();
  return error;
}

function validateTargetUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new SitePolicyError('올바른 웹사이트 URL이 필요합니다.');
  let url;
  try { url = new URL(value); } catch { throw new SitePolicyError('올바른 웹사이트 URL이 필요합니다.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SitePolicyError('계정 정보가 없는 HTTP(S) 주소만 사용할 수 있습니다.');
  if (isBlockedPath(url)) throw new SitePolicyError('상태를 변경할 수 있는 주소는 탐색할 수 없습니다.');
  return url;
}

// Only native backend progress can request this synchronization. It has the same
// navigation boundary as a normal tour and is never a model action.
function validateBackendFollowUrl(value, startUrl) {
  const target = validateTargetUrl(value);
  if (target.origin !== validateTargetUrl(startUrl).origin) throw new SitePolicyError('백엔드 표시 화면은 처음 지정한 사이트 안에서만 이동할 수 있습니다.');
  return target;
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
    if (!Number.isFinite(action.scroll_x) || !Number.isFinite(action.scroll_y) || action.scroll_x === 0 && action.scroll_y === 0 || Math.abs(action.scroll_x) > 640 || Math.abs(action.scroll_y) > 1200) throw new SitePolicyError('0이 아닌 허용 범위의 스크롤 값이 필요합니다.');
  }
  if (action.type === 'type') return { ...action, text: normalizeInputText(action.text) };
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

function installVisualPointer() {
  // This page-only pointer follows real mouse events, never a progress timer.
  if (window !== window.top) return;
  let host;
  let pointer;
  let ring;
  let hidden = false;
  let position = { x: 24, y: 24 };
  const style = (element, values, important = false) => { for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value, important ? 'important' : ''); };
  function mount() {
    if (host?.isConnected || !document.documentElement) return;
    if (host) { document.documentElement.append(host); return; }
    host = document.createElement('div');
    host.setAttribute('data-webpilot-visual-pointer', 'true');
    host.setAttribute('aria-hidden', 'true');
    // Shadow DOM protects the SVG, but page styles still apply to the host.
    // In particular, overflow:hidden on div used to clip this zero-size host.
    style(host, { all: 'initial', position: 'fixed', top: '0', left: '0', right: 'auto', bottom: 'auto', width: '0', height: '0',
      margin: '0', padding: '0', border: '0', overflow: 'visible', visibility: 'visible', opacity: '1', transform: 'none',
      'clip-path': 'none', clip: 'auto', contain: 'none', 'z-index': '2147483647', 'pointer-events': 'none', display: hidden ? 'none' : 'block' }, true);
    const shadow = host.attachShadow({ mode: 'closed' });
    pointer = document.createElement('div');
    style(pointer, { position: 'absolute', transform: `translate(${position.x}px, ${position.y}px)`, 'pointer-events': 'none' });
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
    move(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      position = { x: Math.max(0, Math.min(innerWidth - 1, x)), y: Math.max(0, Math.min(innerHeight - 1, y)) };
      mount();
      if (pointer) pointer.style.transform = `translate(${position.x}px, ${position.y}px)`;
    },
    position: () => ({ ...position }),
    click() { mount(); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) ring?.animate([{ opacity: .85, transform: 'scale(.2)' }, { opacity: 0, transform: 'scale(1.8)' }], { duration: 500, easing: 'ease-out' }); },
    visible(value) { hidden = !value; mount(); if (host) host.style.setProperty('display', hidden ? 'none' : 'block', 'important'); },
  });
  Object.defineProperty(window, '__webpilotVisualPointer', { value: api, writable: false, configurable: false });
  addEventListener('mousemove', event => api.move(event.clientX, event.clientY), { capture: true, passive: true });
  addEventListener('resize', () => api.move(position.x, position.y), { passive: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

async function startSiteSession({ url: input, signal, onStatus = () => {}, credentials: suppliedCredentials, taskPermissions: suppliedTaskPermissions, followBackend = false }) {
  const target = validateTargetUrl(input);
  const credentials = validateCredentials(suppliedCredentials);
  const redact = createSecretRedactor(credentials);
  const taskPermissions = validateTaskPermissions(suppliedTaskPermissions);
  signal?.throwIfAborted();
  const allowedOrigin = target.origin;
  let browser;
  let context;
  let page;
  let windowSession;
  let browserWindowId;
  let browserPid;
  let focusController;
  let capturedViewport;
  let pointerPosition = { x: 24, y: 24 };
  let closed = false;
  let closePromise;
  let lastBlocked = '';
  let consecutiveRedirects = 0;
  let pendingNavigation;
  let loginPermit;
  let contentPermit;
  let submissionAttempted = false;
  let submissionResult;
  const submissionElements = new Set();
  let loginAttempted = false;
  let privateInputStarted = false;
  let loginInputInProgress = false;
  let lastLoginResponse;
  let readinessDirty = true;
  let expectPageChange = false;
  let activitySince = Date.now();
  const activeRequests = new Map();
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
    contentPermit = undefined;
    submissionElements.clear();
    elementSnapshot.clear();
    activeRequests.clear();
    focusController?.close();
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
      focusController = createManagedEdgeFocus(browserPid);
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
    context.on('request', request => {
      try {
        if (request.frame() === page?.mainFrame() && ['document', 'script', 'xhr', 'fetch'].includes(request.resourceType())) {
          activeRequests.set(request, Date.now());
        }
      } catch { /* Worker and unrelated page requests do not delay observation. */ }
    });
    context.on('requestfinished', request => activeRequests.delete(request));
    context.on('requestfailed', request => activeRequests.delete(request));
    await context.route('**/*', async route => {
      const request = route.request();
      let ownedPage = false;
      let mainFrame = false;
      try { ownedPage = request.frame().page() === page; } catch { /* No worker requests are trusted. */ }
      try { mainFrame = request.frame() === page.mainFrame(); } catch { /* Worker requests cannot authenticate. */ }
      const requestDetails = { url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), mainFrame, contentType: request.headers()['content-type'], body: request.postData() };
      const loginRequest = ownedPage && matchesLoginRequest(requestDetails, loginPermit, credentials);
      const preparationCandidate = loginInputInProgress && ownedPage && matchesLoginPreparationRequest(requestDetails, loginPermit, true);
      const loginPreparation = preparationCandidate && await page.evaluate(() => window.__webpilotLoginForm?.submitted()).catch(() => false);
      if (ownedPage && mainFrame && request.method() === 'POST' && contentPermit && !contentPermit.used) {
        contentPermit.submitted ||= await page.evaluate(() => window.__webpilotContentForm?.submitted()).catch(() => false);
      }
      const contentRequest = ownedPage && matchesContentSubmission(requestDetails, contentPermit);
      let reason = loginRequest || contentRequest ? null : requestPolicy({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), ownedPage }, allowedOrigin);
      if (loginInputInProgress && !loginRequest && !loginPreparation) reason = '로그인 입력 중 부가 네트워크 요청';
      if (privateInputStarted && new URL(request.url()).origin !== allowedOrigin) reason = '로그인 입력 이후 외부 연결';
      if (credentials && redact(request.url()) !== request.url()) reason = '계정 정보가 포함된 URL 요청';
      if (reason) { if (request.isNavigationRequest()) pendingNavigation = undefined; blocked(reason); await route.abort('blockedbyclient').catch(() => {}); return; }
      let finishLogin;
      let finishContent;
      const loginMode = loginRequest ? loginPermit.mode : undefined;
      const matchedLoginPermit = loginRequest ? loginPermit : undefined;
      const matchedContentPermit = contentRequest ? contentPermit : undefined;
      if (loginRequest) {
        loginPermit.used = true;
        loginInputInProgress = false;
        loginPermit.completion = new Promise(resolve => { finishLogin = resolve; });
      }
      if (contentRequest) {
        contentPermit.used = true;
        contentPermit.completion = new Promise(resolve => { finishContent = resolve; });
      }
      if (!request.isNavigationRequest() && !loginRequest && !loginPreparation && !contentRequest) { await route.continue().catch(() => {}); return; }
      try {
        // Chromium's normal redirect chain bypasses subsequent Playwright routes.
        // Fetch one hop only, then turn an allowed redirect into a fresh navigation.
        const response = await route.fetch({ maxRedirects: 0, timeout: 20000 });
        if (matchedLoginPermit) {
          matchedLoginPermit.httpStatus = response.status();
          if (/application\/json/i.test(response.headers()['content-type'] ?? '')) {
            const bytes = await response.body();
            if (bytes.length <= 1048576) {
              try {
                const result = JSON.parse(bytes.toString('utf8'));
                matchedLoginPermit.rejected = result?.ok === false || result?.success === false || Boolean(result?.error)
                  || ['error', 'failed', 'rejected'].includes(result?.status);
              } catch { /* The response body alone never confirms authentication. */ }
            }
          }
        }
        if (matchedContentPermit) {
          matchedContentPermit.httpStatus = response.status();
          if (/application\/json/i.test(response.headers()['content-type'] ?? '')) {
            const bytes = await response.body();
            if (bytes.length <= 1048576) {
              try {
                const data = JSON.parse(bytes.toString('utf8'));
                const created = data?.post ?? data?.article ?? data?.notice ?? data;
                const id = typeof created?.id === 'number' || typeof created?.id === 'string' ? String(created.id) : '';
                if (/^[a-zA-Z0-9_-]{1,128}$/.test(id)) matchedContentPermit.createdId = id;
              } catch { /* HTTP response is known; malformed JSON is not proof of success. */ }
            }
          }
        }
        const location = response.headers().location;
        if ([301, 302, 303, 307, 308].includes(response.status()) && location) {
          if (loginPreparation) {
            blocked('로그인 준비 요청의 리디렉션은 지원하지 않습니다');
            await route.abort('blockedbyclient'); return;
          }
          if (matchedContentPermit?.mode === 'spa') {
            matchedContentPermit.failure = '등록 요청 뒤 리디렉션 응답이 발생하여 완료 여부를 확인할 수 없습니다.';
            await route.abort('blockedbyclient'); return;
          }
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
        if (matchedContentPermit) matchedContentPermit.failure = '등록 요청의 응답을 확인하지 못했습니다. 중복 등록을 막기 위해 다시 제출하지 않습니다.';
        pendingNavigation = undefined;
        if (!closed) blocked('탐색 요청을 완료할 수 없음');
        await route.abort('failed').catch(() => {});
      } finally { finishLogin?.(); finishContent?.(); }
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
      let loginSubmitted = false;
      let contentForm;
      let contentSubmitter;
      let contentExpiry = 0;
      let contentMode;
      let contentSubmitted = false;
      Object.defineProperty(window, '__webpilotLoginForm', { value: Object.freeze({
        arm(form, mode) { loginForm = form; loginMode = mode; loginExpiry = Date.now() + 5000; loginSubmitted = false; },
        submitted: () => loginSubmitted,
        clear() { loginForm = undefined; loginExpiry = 0; loginMode = undefined; loginSubmitted = false; },
      }), configurable: false, writable: false });
      Object.defineProperty(window, '__webpilotContentForm', { value: Object.freeze({
        arm(form, submitter, mode) { contentForm = form; contentSubmitter = submitter; contentMode = mode; contentExpiry = Date.now() + 5000; contentSubmitted = false; },
        submitted: () => contentSubmitted,
        clear() { contentForm = undefined; contentSubmitter = undefined; contentExpiry = 0; contentMode = undefined; contentSubmitted = false; },
      }), configurable: false, writable: false });
      document.addEventListener('submit', event => {
        const allowedLogin = event.target === loginForm && Date.now() < loginExpiry;
        const allowedContent = event.target === contentForm && event.submitter === contentSubmitter && Date.now() < contentExpiry;
        const allowed = allowedLogin || allowedContent;
        const mode = allowedContent ? contentMode : loginMode;
        loginForm = undefined; loginExpiry = 0;
        contentForm = undefined; contentSubmitter = undefined; contentExpiry = 0;
        if (allowedLogin) loginSubmitted = true;
        if (allowedContent) contentSubmitted = true;
        // Permit one native HTML submission; page submit handlers never receive
        // a reusable privilege. Network policy independently validates the body.
        // SPA handlers may handle this one submit, but native GET submission
        // must never put credentials in the URL.
        if (!allowed || mode === 'spa') event.preventDefault();
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
      let changedAt = Date.now();
      const ignored = node => {
        const element = node instanceof Element ? node : node.parentElement;
        return Boolean(element?.closest('time,[role="timer"],[data-clock],[data-webpilot-visual-pointer]'));
      };
      const observer = new MutationObserver(records => {
        if (records.some(record => !ignored(record.target) && (record.type !== 'childList'
          || [...record.addedNodes, ...record.removedNodes].some(node => !ignored(node))))) changedAt = Date.now();
      });
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'hidden', 'disabled'] });
      addEventListener('scroll', () => { changedAt = Date.now(); }, { passive: true, capture: true });
      Object.defineProperty(window, '__webpilotPageActivity', { configurable: false, writable: false, value: Object.freeze({
        read: () => ({ ready: document.readyState !== 'loading', changedAt, quietForMs: Math.max(0, Date.now() - changedAt),
          busy: [...document.querySelectorAll('[aria-busy="true"]')].some(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden') }),
      }) });
    });
    await context.addInitScript(installVisualPointer);
    await context.newPage();
    windowSession = await context.newCDPSession(page);
    const initialWindow = await windowSession.send('Browser.getWindowForTarget');
    browserWindowId = initialWindow.windowId;
    if (initialWindow.bounds.windowState !== 'maximized') {
      await windowSession.send('Browser.setWindowBounds', { windowId: browserWindowId, bounds: { windowState: 'maximized' } });
    }
    await page.bringToFront();
    await focusController?.focus();
    page.on('download', download => { blocked('파일 다운로드'); void download.cancel().catch(() => {}); });
    page.on('dialog', dialog => { blocked('사이트 대화상자'); void dialog.dismiss().catch(() => {}); });
    page.on('filechooser', () => blocked('파일 선택 창'));
    page.setDefaultTimeout(5000);
    const restorePointer = async () => {
      pointerPosition = await readWithNavigationRecovery({ signal, assertActive,
        read: () => page.evaluate(position => {
          const pointer = window.__webpilotVisualPointer;
          if (!pointer) throw new Error('화면 포인터를 준비하지 못했습니다.');
          pointer.move(position.x, position.y);
          return pointer.position();
        }, pointerPosition),
        recover: async () => { await settleNavigation(); await sleep(30, undefined, { signal }); },
      });
    };
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) { readinessDirty = true; activitySince = Date.now(); }
    });
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const settleNavigation = async () => {
      const deadline = Date.now() + 15000;
      do {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        if (!pendingNavigation) return;
        await page.waitForTimeout(30);
        assertActive();
      } while (Date.now() < deadline);
      throw new SitePolicyError('사이트 이동이 제한 시간 안에 완료되지 않았습니다.');
    };
    const settlePage = async () => {
      await settleNavigation();
      if (!readinessDirty) { await restorePointer(); return; }
      await waitForPageReady({ signal, expectChange: expectPageChange, read: async () => {
        assertActive();
        const state = await readWithNavigationRecovery({ signal, assertActive,
          read: () => page.evaluate(() => window.__webpilotPageActivity?.read() ?? { ready: document.readyState !== 'loading', quietForMs: 0, busy: false }),
          recover: async () => { await settleNavigation(); await sleep(30, undefined, { signal }); },
        });
        return { ...state, changed: state.changedAt >= activitySince, pending: [...activeRequests.values()].some(started => started >= activitySince) || Boolean(pendingNavigation) };
      } });
      await settleNavigation();
      readinessDirty = false;
      assertActive();
      await restorePointer();
    };
    const markAction = (expectChange = true) => { readinessDirty = true; expectPageChange = expectChange; activitySince = Date.now(); };
    await settlePage();
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
      await focusController?.focus();
      assertActive();
    };
    const viewportSize = () => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const movePointer = async (x, y) => {
      const from = await page.evaluate(() => ({ ...window.__webpilotVisualPointer.position(), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }));
      const steps = from.reduced ? 1 : 12;
      for (let index = 1; index <= steps; index++) {
        assertActive();
        const progress = 1 - (1 - index / steps) ** 3;
        pointerPosition = { x: from.x + (x - from.x) * progress, y: from.y + (y - from.y) * progress };
        // Each rendered intermediate position comes from a real mouse event.
        await page.mouse.move(pointerPosition.x, pointerPosition.y);
        if (index < steps) await sleep(16, undefined, { signal });
      }
      await restorePointer();
      assertActive();
    };
    const clickPointer = async () => { await page.evaluate(() => window.__webpilotVisualPointer?.click()); };

    const clearSnapshot = async () => {
      const handles = [...elementSnapshot.values()];
      elementSnapshot.clear();
      submissionElements.clear();
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
    const detectContentForm = async () => {
      if (!taskPermissions.allowContentSubmission || submissionAttempted) return null;
      const found = [];
      for (const form of await page.$$('form')) {
        const metadata = await form.evaluate(readContentForm).catch(() => null);
        let allowed = metadata && taskPermissions.contentKinds.includes(metadata.contentKind)
          && CONTENT_SUBMIT_LABEL.test(metadata.label) && !isForbiddenContentContext(metadata.description)
          && Object.values(metadata.fields).every(value => typeof value !== 'string' || redact(value) === value);
        if (allowed) {
          try {
            const destination = validateTargetUrl(metadata.url);
            allowed = destination.origin === allowedOrigin && (metadata.mode !== 'html' || CONTENT_ENDPOINT.test(destination.pathname));
          } catch { allowed = false; }
        }
        if (allowed) found.push({ form, metadata });
        else await form.dispose();
      }
      if (found.length !== 1) { await Promise.allSettled(found.map(item => item.form.dispose())); return null; }
      return found[0];
    };
    const contentEvidence = title => page.evaluate(expected => {
      const parts = [];
      const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
      let node, total = 0;
      while ((node = walker.nextNode()) && total < 16000) {
        const parent = node.parentElement;
        if (!parent || parent.isContentEditable || parent.closest('form,input,textarea,select,script,style,[aria-hidden="true"],[hidden],[data-webpilot-visual-pointer]') || !parent.getClientRects().length || getComputedStyle(parent).visibility === 'hidden') continue;
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (text) { parts.push(text); total += text.length; }
      }
      const text = parts.join(' ').replace(/\s+/g, ' ');
      const normalizedTitle = expected.replace(/\s+/g, ' ').trim();
      return { url: location.href, titleCount: normalizedTitle ? text.split(normalizedTitle).length - 1 : 0,
        completed: /(?:등록|게시|발행)(?:이|가)?\s*(?:되었습니다|완료|성공)|(?:created|published|posted)\s*(?:successfully)?/i.test(text) };
    }, title);
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
      await field.type(value, { delay: typingDelay(value.length), timeout: 5000 + value.length * 6 });
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
        markAction();
        await page.mouse.click(point.x, point.y, { button: 'left' });
        let clientTransition = false;
        while (!loginPermit.used && Date.now() < loginPermit.expires) {
          if (metadata.mode === 'spa') {
            const submitted = await page.evaluate(() => window.__webpilotLoginForm?.submitted()).catch(() => false);
            if (submitted) {
              const formStillVisible = await form.evaluate(element => element.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden').catch(() => true);
              clientTransition = !formStillVisible || page.url() !== metadata.url;
              if (clientTransition) break;
            }
          }
          await page.waitForTimeout(30); assertActive();
        }
        await loginPermit.completion;
        await settlePage();
        const used = loginPermit?.used;
        const failure = loginPermit?.failure;
        lastLoginResponse = { used: Boolean(used), httpStatus: loginPermit?.httpStatus, rejected: Boolean(loginPermit?.rejected) };
        loginPermit = undefined;
        assertActive();
        if (failure) throw new SitePolicyError(failure);
        if (!used && !clientTransition) throw new SitePolicyError('로그인 폼 제출 이후 허용된 인증 요청이나 화면 전환을 확인하지 못했습니다.');
        if (await challengePresent()) throw new SitePolicyError('추가 인증 또는 CAPTCHA가 필요하여 자동 탐색을 중지했습니다.');
        if (!used) return { message: '제공된 계정으로 로그인 폼을 제출한 뒤 화면 전환을 확인했습니다. 서버 인증 요청은 없었으므로 로그인 성공 여부는 확인하지 않았습니다.', url: redact(page.url()) };
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
    const authenticationView = async () => {
      assertActive();
      const view = await page.evaluate(() => {
        const visible = element => Boolean(element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
        const text = document.body?.innerText ?? '';
        return {
          loginVisible: [...document.querySelectorAll('input[type=password]')].some(visible),
          authenticatedMarker: [...document.querySelectorAll('a,button,[role=button]')].some(element =>
            /(?:log\s*out|sign[\s_-]*out|로그아웃)/i.test([element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' '))),
          rejected: /아이디나 비밀번호가 틀|로그인.{0,12}실패|비밀번호.{0,12}(틀|잘못|일치하지)|invalid (credentials|password|username)|incorrect (password|username)|login failed|sign.?in failed/i.test(text),
          nonempty: Boolean(text.trim()),
        };
      });
      return { ...view, challenged: await challengePresent() };
    };
    const authenticate = async () => {
      assertActive();
      const before = JSON.stringify(await context.storageState({ indexedDB: true }));
      const beforeView = await authenticationView();
      await login();
      const result = (state, message) => ({ url: redact(page.url()), message, login: { status: state } });
      if (lastLoginResponse?.rejected || lastLoginResponse?.httpStatus >= 400) {
        return result('rejected', '화면 표현용 Edge의 로그인 요청이 거절되었습니다. 계정과 로그인 화면을 확인해 주세요.');
      }
      // A CSRF cookie and a dismissed login form are insufficient. The page
      // must gain an authenticated control and retain it after navigation.
      const safeView = view => view.nonempty && !view.loginVisible && !view.rejected && !view.challenged;
      let view = await authenticationView();
      if (view.rejected) return result('rejected', '화면 표현용 Edge에서 로그인 실패 화면을 확인했습니다.');
      if (!lastLoginResponse?.used || !(lastLoginResponse.httpStatus >= 200 && lastLoginResponse.httpStatus < 400)
        || !safeView(view) || JSON.stringify(await context.storageState({ indexedDB: true })) === before) {
        return result('unconfirmed', '화면 표현용 Edge에서 로그인 제출은 했지만 인증 성공을 확인하지 못했습니다. 자동으로 다시 제출하지 않습니다.');
      }
      // Reopen the actual landing URL with the existing Edge session. This also
      // verifies that subsequent backend-follow navigation retains authentication;
      // a client-only form dismissal or an in-memory login cannot pass this check.
      const landing = validateBackendFollowUrl(page.url(), target.href);
      readinessDirty = true;
      expectPageChange = true;
      activitySince = Date.now();
      const response = await page.goto(landing.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settlePage();
      view = await authenticationView();
      if (!response?.ok() || !safeView(view) || page.url() !== landing.href) {
        return result('unconfirmed', '화면 표현용 Edge에서 페이지를 다시 열었을 때 로그인 상태 유지를 확인하지 못했습니다.');
      }
      let authenticated = view.authenticatedMarker && !beforeView.authenticatedMarker;
      if (!authenticated) {
        // No extra page or visible window: an empty context makes one anonymous
        // GET to the same landing, without following redirects or loading assets.
        // This supports protected pages that do not render a logout control.
        const anonymous = await browser.newContext({ serviceWorkers: 'block' });
        try {
          assertActive();
          const probe = await anonymous.request.get(landing.href, { maxRedirects: 0, timeout: 10000 });
          authenticated = [401, 403].includes(probe.status());
          if ([301, 302, 303, 307, 308].includes(probe.status()) && probe.headers().location) {
            const redirect = new URL(probe.headers().location, landing.href);
            authenticated = redirect.origin === allowedOrigin && !redirect.username && !redirect.password
              && redirect.pathname === target.pathname && redirect.pathname !== landing.pathname;
          }
        } catch { /* An unavailable anonymous check is not authentication evidence. */ }
        finally { await anonymous.close(); }
        assertActive();
      }
      if (!authenticated) return result('unconfirmed', '화면 표현용 Edge에서 로그인 전후의 인증 차이를 확인하지 못했습니다.');
      return result('confirmed', '화면 표현용 Edge의 로그인과 페이지 이동 후 로그인 상태 유지를 확인했습니다.');
    };
    const submitContent = async elementId => {
      if (submissionAttempted) throw new SitePolicyError('이번 작업에서는 콘텐츠 등록을 한 번만 허용합니다. 다시 제출하지 않습니다.');
      if (!taskPermissions.allowContentSubmission || !submissionElements.has(elementId)) throw new SitePolicyError('현재 작업과 페이지에서 허용된 콘텐츠 등록 버튼이 아닙니다.');
      const expected = elementSnapshot.get(elementId);
      const detected = await detectContentForm();
      if (!expected || !detected) throw new SitePolicyError('작성 폼이 변경되었거나 등록 조건이 충족되지 않았습니다. 페이지를 다시 읽어 주세요.');
      const { form, metadata } = detected;
      let submit;
      try {
        submit = (await form.evaluateHandle((element, index) => element.elements[index], metadata.submitIndex)).asElement();
        if (!submit || !await expected.evaluate((element, current) => element === current, submit)) throw new SitePolicyError('등록 버튼이 변경되었습니다. 페이지를 다시 읽어 주세요.');
        const point = await checkedPoint(submit);
        await movePointer(point.x, point.y);
        const current = await checkedPoint(submit);
        if (Math.abs(current.x - point.x) > 2 || Math.abs(current.y - point.y) > 2) throw new SitePolicyError('등록 버튼이 이동했습니다. 페이지를 다시 읽어 주세요.');
        const rechecked = await form.evaluate(readContentForm);
        if (JSON.stringify(rechecked) !== JSON.stringify(metadata)) throw new SitePolicyError('등록 직전에 작성 내용 또는 폼이 변경되었습니다. 페이지를 다시 읽어 주세요.');
        const before = await contentEvidence(metadata.title);
        contentPermit = { ...metadata, allowedOrigin, submitted: false, used: false, expires: Date.now() + 5000 };
        await form.evaluate((element, { submitter, mode }) => window.__webpilotContentForm.arm(element, submitter, mode), { submitter: submit, mode: metadata.mode });
        await clickPointer();
        submissionAttempted = true;
        markAction();
        await page.mouse.click(point.x, point.y, { button: 'left' });
        while (!contentPermit.used && Date.now() < contentPermit.expires) { await sleep(30, undefined, { signal }); assertActive(); }
        if (!contentPermit.used) throw new SiteInteractionError('등록 버튼을 클릭했지만 허용된 등록 요청을 확인하지 못했습니다. 중복 등록을 막기 위해 다시 제출하지 않습니다.');
        await contentPermit.completion;
        if (contentPermit.failure || !Number.isInteger(contentPermit.httpStatus)) throw new SiteInteractionError(contentPermit.failure);
        await settlePage(); assertActive();
        const after = await contentEvidence(metadata.title);
        const formClosed = await form.evaluate(element => !element.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden').catch(() => true);
        const idInPath = contentPermit.createdId && new URL(after.url).pathname.split('/').includes(contentPermit.createdId);
        const confirmed = after.titleCount > 0 && (idInPath && after.url !== before.url || formClosed && after.titleCount > before.titleCount && after.completed);
        const httpStatus = contentPermit.httpStatus;
        const status = httpStatus >= 400 ? 'rejected' : httpStatus >= 200 && httpStatus < 300 && confirmed ? 'confirmed' : 'unverified';
        const message = status === 'confirmed' ? '등록 요청의 응답과 새 글이 표시된 화면을 확인했습니다.'
          : status === 'rejected' ? `등록 요청에 HTTP ${httpStatus} 오류 응답이 반환되었습니다. 다시 제출하지 않습니다.`
            : '등록 요청의 서버 응답은 받았지만 화면에서 등록 완료를 확인하지 못했습니다. 다시 제출하지 않습니다.';
        submissionResult = { status, httpStatus, message };
        return { message, url: redact(page.url()), performed: true, submission: { ...submissionResult } };
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (submissionAttempted) throw error instanceof SiteInteractionError ? error : new SiteInteractionError('등록 동작의 완료 여부를 확인할 수 없어 중지했습니다. 중복 등록을 막기 위해 다시 제출하지 않습니다.');
        throw error;
      } finally {
        contentPermit = undefined;
        await page.evaluate(() => window.__webpilotContentForm?.clear()).catch(() => {});
        await Promise.allSettled([submit, form].filter(Boolean).map(handle => handle.dispose()));
      }
    };

    const session = {
      authenticate,
      async followBackendUrl(value) {
        assertActive();
        if (!followBackend) throw new SitePolicyError('백엔드 화면 동기화가 설정되지 않은 세션입니다.');
        const destination = validateBackendFollowUrl(value, target.href);
        if (redact(destination.href) !== destination.href) throw new SitePolicyError('계정 정보가 포함된 주소로 이동하지 않습니다.');
        await foreground();
        await clearSnapshot();
        if (page.url() !== destination.href) {
          // When the next observed backend page is a visible exact link here,
          // show the real pointer travelling to it before native navigation.
          // A direct navigation is not a click: do not pulse or invoke handlers.
          const candidate = await page.evaluateHandle(destination => {
            const matches = [...document.querySelectorAll('a[href]')].filter(element => {
              if (!(element instanceof HTMLAnchorElement) || element.href !== destination || element.closest('form,[inert]') || element.hasAttribute('download')
                || element.hasAttribute('form') || element.getAttribute('aria-disabled') === 'true'
                || element.target && element.target.toLowerCase() !== '_self') return false;
              const bounds = element.getBoundingClientRect();
              return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.left < innerWidth && bounds.top < innerHeight
                && getComputedStyle(element).visibility === 'visible';
            });
            return matches.length === 1 ? matches[0] : null;
          }, destination.href);
          try {
            const link = candidate.asElement();
            const metadata = await link?.evaluate(element => ({ href: element.href,
              label: [element.innerText, element.getAttribute('aria-label'), element.title].filter(Boolean).join(' ') })).catch(() => null);
            if (metadata?.href === destination.href && !isSensitiveControl(metadata.label) && redact(metadata.href) === metadata.href) {
              try {
                const point = await checkedPoint(link);
                await movePointer(point.x, point.y);
              } catch (error) {
                if (signal?.aborted) signal.throwIfAborted();
                if (!(error instanceof SitePolicyError)) throw error;
                // A missing/covered link does not prevent the observed backend
                // page from being opened through the existing URL policy.
              }
            }
          } finally { await candidate.dispose(); }
          lastBlocked = '';
          readinessDirty = true;
          expectPageChange = true;
          activitySince = Date.now();
          await page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await settlePage();
        }
        assertActive();
        return { url: redact(page.url()) };
      },
      async observe() {
        assertActive();
        await foreground();
        await settlePage();
        await clearSnapshot();
        const challenge = await challengePresent();
        if (credentials && challenge) throw new SitePolicyError('추가 인증 또는 CAPTCHA가 필요하여 자동 탐색을 중지했습니다.');
        const view = await page.evaluate(() => {
          const visible = element => {
            if (!element || element.isContentEditable || element.closest('input,textarea,select,script,style,noscript,[aria-hidden="true"],[data-webpilot-visual-pointer]')) return false;
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
        const candidates = await page.$$('a[href],button,input,textarea,[contenteditable]');
        const discarded = [];
        const readCandidate = handle => handle.evaluate(readPageElement).catch(() => null);
        let cursor = 0;
        while (cursor < candidates.length && elements.length < 60) {
          const batch = candidates.slice(cursor, cursor + 12);
          cursor += batch.length;
          const metadataBatch = await Promise.all(batch.map(readCandidate));
          for (let index = 0; index < batch.length; index++) {
            const handle = batch[index];
            const metadata = metadataBatch[index];
            if (elements.length >= 60) { discarded.push(handle); continue; }
            let permitted = metadata && !(metadata.role === 'textbox' ? SENSITIVE_INPUT.test(metadata.description) : isSensitiveControl(metadata.description));
            if (metadata?.role === 'button') permitted &&= isStandaloneButton(metadata.button);
            if (metadata?.href) {
              try { permitted &&= validateTargetUrl(metadata.href).origin === allowedOrigin && redact(metadata.href) === metadata.href; } catch { permitted = false; }
            }
            if (!permitted) { discarded.push(handle); continue; }
            const id = randomUUID();
            elementSnapshot.set(id, handle);
            elements.push({ id, role: metadata.role, label: redact(metadata.label), type: metadata.type, ...(metadata.href ? { href: redact(metadata.href) } : {}) });
          }
        }
        discarded.push(...candidates.slice(cursor));
        await Promise.allSettled(discarded.map(handle => handle.dispose()));
        const form = !challenge ? await detectLoginForm() : null;
        const loginFormVisible = Boolean(form);
        const loginAvailable = Boolean(form && credentials && !loginAttempted);
        await form?.form.dispose();
        if (credentials && !loginAttempted && !loginAvailable && await visiblePasswordPresent()) throw new SitePolicyError('로그인 입력란이 있지만 지원되는 동일 사이트 로그인 폼을 확인하지 못해 탐색을 중지했습니다. 외부 SSO·복잡한 인증 화면은 지원하지 않습니다.');
        const contentForm = await detectContentForm();
        if (contentForm) {
          const submit = (await contentForm.form.evaluateHandle((element, index) => element.elements[index], contentForm.metadata.submitIndex)).asElement();
          if (submit) {
            const id = randomUUID(); elementSnapshot.set(id, submit); submissionElements.add(id);
            elements.unshift({ id, role: 'submit', type: 'submit', label: redact(contentForm.metadata.label) });
            if (elements.length > 60) { const removed = elements.pop(); await elementSnapshot.get(removed.id)?.dispose(); elementSnapshot.delete(removed.id); }
          }
          await contentForm.form.dispose();
        }
        return { url: redact(page.url()), title: redact(view.title), text: redact(view.text), viewport: view.viewport, elements, loginFormVisible, loginAvailable,
          submissionAvailable: submissionElements.size > 0, ...(submissionResult ? { submission: { ...submissionResult } } : {}) };
      },
      async act(rawAction) {
        const action = validateDomAction(rawAction);
        assertActive();
        lastBlocked = '';
        try {
          if (action.action === 'login') { await foreground(); return await login(); }
          if (action.action === 'submit') { await foreground(); return await submitContent(action.element_id); }
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
          throw sanitizeInteractionError(error, { privateInputStarted });
        } finally { await clearSnapshot(); }
      },
      async capture() {
        assertActive();
        await foreground();
        await settlePage();
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
        let performed = true;
        let inputStarted = false;
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
            const label = [candidate.textContent, candidate.getAttribute('aria-label'), candidate.getAttribute('title'), candidate.getAttribute('name')].filter(Boolean).join(' ').slice(0, 1000);
            if (candidate instanceof HTMLAnchorElement) {
              if (candidate.download || candidate.hasAttribute('download') || (candidate.target && candidate.target.toLowerCase() !== '_self')) return { allowed: false, reason: '새 창과 다운로드 링크는 허용되지 않습니다.' };
              return { allowed: true, label, href: candidate.href };
            }
            return { allowed: true, label, button: { type: candidate.type, disabled: candidate.disabled, hasFormOwner: Boolean(candidate.form), inForm: Boolean(candidate.closest('form')),
              hasFormAttribute: candidate.hasAttribute('form'), hasSubmitOverrides: ['formaction', 'formmethod', 'formtarget', 'formenctype', 'formnovalidate'].some(name => candidate.hasAttribute(name)) } };
          }, { x: action.x, y: action.y });
          if (!element.allowed) { blocked(element.reason); throw new SitePolicyError(element.reason); }
          if (element.button && !isStandaloneButton(element.button)) { blocked('폼에 연결되었거나 제출 동작을 가진 버튼'); throw new SitePolicyError('폼에 연결된 제출·초기화 버튼은 일반 클릭으로 조작할 수 없습니다.'); }
          if (isSensitiveControl(element.label)) { blocked('민감하거나 상태를 변경할 수 있는 버튼'); throw new SitePolicyError('민감하거나 상태를 변경할 수 있는 버튼은 클릭하지 않습니다.'); }
          if (element.href) {
            const destination = validateTargetUrl(element.href);
            if (destination.origin !== allowedOrigin) { blocked('허용된 사이트 밖의 링크'); throw new SitePolicyError('허용된 사이트 밖의 링크는 클릭하지 않습니다.'); }
          }
          await clickPointer();
          markAction();
          await page.mouse.click(action.x, action.y, { button: 'left' });
        } else if (action.type === 'type') {
          await movePointer(action.x, action.y);
          if (expectedHandle) {
            const current = await checkedPoint(expectedHandle);
            if (Math.abs(current.x - action.x) > 2 || Math.abs(current.y - action.y) > 2) throw new SitePolicyError('입력란이 이동했습니다. 페이지를 다시 읽어 주세요.');
          }
          const handle = await page.evaluateHandle(({ x, y }) => {
            let element = document.elementFromPoint(x, y);
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element;
            if (!element?.isContentEditable) return null;
            while (element.parentElement?.isContentEditable) element = element.parentElement;
            return element;
          }, { x: action.x, y: action.y });
          try {
            const field = handle.asElement();
            if (!field) throw new SitePolicyError('입력할 수 있는 텍스트 필드가 아닙니다.');
            if (expectedHandle && !await expectedHandle.evaluate((expected, current) => expected === current, field)) throw new SitePolicyError('입력 요소가 변경되었습니다. 페이지를 다시 읽어 주세요.');
            const checkField = async () => {
              assertActive();
              const metadata = await field.evaluate(readPageElement);
              if (metadata?.role !== 'textbox' || SENSITIVE_INPUT.test(metadata.description) || redact(action.text) !== action.text) {
                blocked('민감하거나 지원하지 않는 입력란');
                throw new SitePolicyError('일반 제목·본문·검색 입력란만 사용할 수 있습니다. 계정·비밀번호·개인정보·결제 필드는 입력하지 않습니다.');
              }
              if (!metadata.multiline && action.text.includes('\n')) throw new SitePolicyError('한 줄 입력란에는 줄바꿈을 입력할 수 없습니다. 여러 줄 텍스트는 본문 입력란을 선택해 주세요.');
            };
            await checkField();
            await clickPointer();
            markAction();
            await page.mouse.click(action.x, action.y, { button: 'left' });
            assertActive();
            await checkField();
            inputStarted = true;
            await field.fill('');
            await checkField();
            const marker = randomUUID();
            await field.evaluate((element, marker) => element.setAttribute('data-webpilot-input-target', marker), marker);
            const checkFocusedField = async () => {
              await checkField();
              if (!await field.evaluate(element => element.isConnected && document.activeElement === element)) throw new SitePolicyError('입력 중 포커스가 다른 요소로 이동하여 입력을 중지했습니다. 페이지를 다시 읽어 주세요.');
            };
            try {
              const lines = action.text.split('\n');
              for (let index = 0; index < lines.length; index++) {
                signal?.throwIfAborted(); await checkFocusedField();
                const target = page.locator(`[data-webpilot-input-target="${marker}"]`);
                if (index) { await page.keyboard.insertText('\n'); await checkFocusedField(); }
                if (action.text.length > 200) {
                  for (const chunk of inputChunks(lines[index])) {
                    signal?.throwIfAborted(); await checkFocusedField();
                    // Native IME-style input keeps real input events while
                    // avoiding thousands of individual protocol round trips.
                    await page.keyboard.insertText(chunk);
                  }
                } else if (lines[index]) await target.pressSequentially(lines[index], { delay: typingDelay(action.text.length), timeout: 10000 });
              }
              await checkFocusedField();
            }
            finally { await field.evaluate(element => element.removeAttribute('data-webpilot-input-target')).catch(() => {}); }
          } catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            throw sanitizeInteractionError(error, { inputStarted });
          } finally { await handle.dispose(); }
        } else {
          await movePointer(action.x, action.y);
          const scrollState = await page.evaluateHandle(({ x, y }) => {
            const elements = new Set([document.scrollingElement].filter(Boolean));
            for (let element = document.elementFromPoint(x, y); element; element = element.parentElement) elements.add(element);
            return { x: scrollX, y: scrollY, elements: [...elements].map(element => ({ element, x: element.scrollLeft, y: element.scrollTop })) };
          }, { x: action.x, y: action.y });
          try {
            markAction();
            await page.mouse.wheel(action.scroll_x, action.scroll_y);
            await settlePage();
            performed = await scrollState.evaluate(before => scrollX !== before.x || scrollY !== before.y
              || before.elements.some(({ element, x, y }) => element.isConnected && (element.scrollLeft !== x || element.scrollTop !== y)));
          } finally { await scrollState.dispose(); }
        }
        try { await settlePage(); assertActive(); }
        catch (error) {
          if (signal?.aborted) signal.throwIfAborted();
          throw sanitizeInteractionError(error, { inputStarted });
        }
        return { message: lastBlocked ? `차단: ${lastBlocked}` : action.type === 'click' ? '허용된 사이트 안에서 링크 또는 일반 버튼을 클릭했습니다.' : action.type === 'type' ? '일반 입력란에 텍스트를 입력했습니다. 제출하지 않았습니다.' : performed ? '허용된 사이트 화면을 스크롤했습니다.' : '스크롤 위치가 변하지 않았습니다. 다른 동작을 선택해 주세요.', url: redact(page.url()), performed: !lastBlocked && performed };
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

module.exports = { startSiteSession, installVisualPointer, validateTargetUrl, validateBackendFollowUrl, validateAction, validateDomAction, matchesLoginRequest, matchesLoginPreparationRequest, matchesContentSubmission, validateTaskPermissions, isForbiddenContentContext, requestPolicy, isBlockedPath, SitePolicyError, SiteInteractionError, sanitizeInteractionError, VIEWPORT, waitForPageReady, typingDelay, readWithNavigationRecovery, isStandaloneButton, isSensitiveControl, normalizeInputText, readPageElement, inputChunks };
