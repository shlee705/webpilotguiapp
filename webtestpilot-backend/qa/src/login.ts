// M5 계정 로그인(설계 5장 0단계, IN-3). 로그인 절차는 엔진 코드가 아니라 앱 설정(데이터)이다.
// 프로그램이 로그인해 브라우저 상태(쿠키·로컬 저장소)를 만들고, 탐색·실행·재현은 그 상태로 시작한다.
// 비밀값은 환경 변수에서만 읽고 모델 입력·기록·보고서에 넣지 않는다.
import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { settle, toLocator, type Policy, type Target } from './browser.ts';
import { checkResetSpec, type ResetSpec } from './reset.ts';

/** 앱 설정 파일(--app). 이 앱에서만 필요한 준비 정보를 둔다. 공통 엔진에는 앱별 분기를 넣지 않는다. */
export type AppConfig = {
  login?: LoginSpec;
  /** 요청하지 않을 주소(부분 문자열). 로그아웃처럼 서버 세션을 끊어 뒤 검사 전체를 로그인 없는 상태로 만드는 주소 */
  deny?: string[];
  /** 등록된 초기화: 실행 전·재현 전에 프로그램이 호출하고 확인한다 */
  reset?: ResetSpec;
};
export type LoginSpec = {
  /** 로그인 화면 주소(허용 origin 안) */
  url: string;
  /** 아이디·비밀번호 칸과 제출 버튼. 계획의 대상과 같은 데이터 모양(역할·이름 등) */
  username?: Target; password?: Target; submit?: Target;
  /** GUI 계정: 현재 화면의 단일 로그인 폼을 관측해 한 번 제출한다. */
  auto?: true;
  /** 성공 확인: 로그인 뒤 이 글자가 보이거나, 주소에 이 문자열이 들어 있거나, 이 대상(역할·이름)이 있어야 한다(여럿 주면 모두).
   * target은 로그인 뒤 첫 화면이 홈이라 주소로 가를 수 없고 사용자 이름이 aria-label에만 있을 때 쓴다(Maison 8081: "계정 메뉴 (이름)" 버튼) */
  success?: { text?: string; urlIncludes?: string; target?: Target };
  /** 비밀값을 읽을 환경 변수 이름. 값 자체는 설정 파일에 쓰지 않는다 */
  env: { username: string; password: string };
};
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type LoginResult = { ok: true; state: StorageState } | { ok: false; reason: string };

/** 앱 설정을 읽고 모양을 검사한다. 비밀값이 설정 파일에 들어 있으면 거부한다. */
export function readAppConfig(path: string): AppConfig {
  // Windows PowerShell 5.1의 utf8 저장은 BOM을 붙이므로 제거한다.
  const c = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as AppConfig & { login?: Record<string, unknown> };
  if (c.deny !== undefined && !(Array.isArray(c.deny) && c.deny.every(d => typeof d === 'string' && d.trim()))) throw new Error('앱 설정: deny는 비어 있지 않은 문자열 목록이어야 함');
  if (c.reset !== undefined) { const err = checkResetSpec(c.reset); if (err) throw new Error(err); }
  const l = c.login;
  if (l) {
    if ('password' in l && typeof l.password === 'string') throw new Error('앱 설정: 비밀번호 값을 파일에 쓰지 말고 env.password에 환경 변수 이름을 적으세요');
    const target = (t: unknown) => !!t && typeof t === 'object' && ('role' in t || 'text' in t);
    if (typeof l.url !== 'string') throw new Error('앱 설정: login.url이 필요함');
    if ('auto' in l && l.auto !== true) throw new Error('앱 설정: login.auto는 true여야 함');
    if (!l.auto && (!target(l.username) || !target(l.password) || !target(l.submit))) throw new Error('앱 설정: login에는 username·password·submit 대상이 필요함');
    const s = l.success as LoginSpec['success'] | undefined;
    if (!l.auto && (!s || (!s.text && !s.urlIncludes && !target(s.target)))) throw new Error('앱 설정: login.success에 text·urlIncludes·target 중 하나가 필요함');
    const env = l.env as LoginSpec['env'] | undefined;
    if (!env || ![env.username, env.password].every(n => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) throw new Error('앱 설정: login.env에 username·password 환경 변수 이름이 필요함');
  }
  return c;
}

/**
 * 로그인해 브라우저 상태를 돌려준다. 로그인 제출은 쓰기 요청이라, 이 절차만 허용 origin 안의 쓰기를 허용한 별도 컨텍스트에서 한다.
 * 실패 사유에는 비밀값을 넣지 않는다. 실패하면 호출자는 로그인 없이 계속하고 "로그인 이후 기능 미검사"로 남긴다.
 */
export async function login(browser: Browser, policy: Policy, spec: LoginSpec, env: NodeJS.ProcessEnv = process.env, timeoutMs = 10000): Promise<LoginResult> {
  const username = env[spec.env.username], password = env[spec.env.password];
  if (!username || !password) return { ok: false, reason: `환경 변수 ${!username ? spec.env.username : spec.env.password}가 비어 있음` };
  let loginUrl: URL;
  try { loginUrl = new URL(spec.url); } catch { return { ok: false, reason: '로그인 주소 형식이 올바르지 않음' }; }
  if (!/^https?:$/.test(loginUrl.protocol) || loginUrl.username || loginUrl.password || !policy.origins.includes(loginUrl.origin)) return { ok: false, reason: '로그인 주소가 허용 origin 밖이거나 계정 정보가 주소에 포함됨' };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let externalAuth = false;
  let navigationFailed = false;
  let submissionArmed = false, submittedRequests = 0;
  const guard = async (c: BrowserContext) => c.route('**/*', r => {
    const u = new URL(r.request().url());
    const same = u.origin === loginUrl.origin;
    if (!same && r.request().isNavigationRequest()) externalAuth = true;
    // GET 폼은 계정값을 주소·서버 로그에 남긴다. 자동 감지 폼이라도 전송하지 않는다.
    const urlHasSecret = !!u.username || !!u.password || u.href.includes(password) || u.href.includes(encodeURIComponent(password))
      || [...u.searchParams.values()].includes(username) || u.hash.slice(1) === username;
    if (spec.auto && !['GET', 'HEAD', 'OPTIONS'].includes(r.request().method())) {
      const body = r.request().postData() ?? '';
      const has = (value: string) => [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2), JSON.stringify(value).slice(1, -1)].some(v => body.includes(v));
      if (!same || urlHasSecret || !submissionArmed || submittedRequests || r.request().method() !== 'POST' || !has(username) || !has(password)) return r.abort('blockedbyclient');
      submittedRequests++;
    }
    return (same && !urlHasSecret) || /^(data|blob|about):$/.test(u.protocol) ? r.continue() : r.abort('blockedbyclient');
  });
  try {
    // 허용 origin 밖으로는 로그인 중에도 나가지 않는다(외부 인증은 지원하지 않음).
    await guard(context);
    const page = await context.newPage();
    page.on('response', r => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) navigationFailed = r.status() >= 400; });
    await page.goto(spec.url, { timeout: timeoutMs });
    await settle(page, timeoutMs);
    if (navigationFailed) return { ok: false, reason: '로그인 화면이 HTTP 오류를 반환함' };
    const beforeState = JSON.stringify(await context.storageState({ indexedDB: true }));
    if (spec.auto) {
      const unsupported = await loginChallenge(page);
      if (unsupported) return { ok: false, reason: unsupported };
      const form = await detectLoginForm(page);
      if (!form) return { ok: false, reason: '자동 로그인: 단일 아이디·비밀번호·제출 폼을 명확하게 찾지 못함(로그인 URL을 확인하세요)' };
      const action = new URL(await form.form.getAttribute('action') || page.url(), page.url());
      if (action.origin !== loginUrl.origin) return { ok: false, reason: '외부 origin 인증은 지원하지 않음' };
      await form.username.fill(username, { timeout: timeoutMs });
      await form.password.fill(password, { timeout: timeoutMs });
      submissionArmed = true;
      await form.submit.click({ timeout: timeoutMs });
    } else {
    for (const [name, t] of [['아이디 칸', spec.username!], ['비밀번호 칸', spec.password!], ['제출 버튼', spec.submit!]] as const) {
      const n = await toLocator(page, t).count();
      if (n !== 1) return { ok: false, reason: `${name}를 하나로 찾지 못함(${n}개)` };
    }
    await toLocator(page, spec.username!).fill(username, { timeout: timeoutMs });
    await toLocator(page, spec.password!).fill(password, { timeout: timeoutMs });
    await toLocator(page, spec.submit!).click({ timeout: timeoutMs });
    }
    await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
    await settle(page, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const ok = async () => !navigationFailed && (spec.auto ? await autoSucceeded(page) && JSON.stringify(await context.storageState({ indexedDB: true })) !== beforeState : await succeeded(page, spec.success!));
    while (!(await ok())) {
      if (externalAuth) return { ok: false, reason: '외부 origin 인증은 지원하지 않음' };
      if (navigationFailed) return { ok: false, reason: '로그인 뒤 페이지가 HTTP 오류를 반환함' };
      const unsupported = spec.auto && await loginChallenge(page);
      if (unsupported) return { ok: false, reason: unsupported };
      if (Date.now() > deadline) return { ok: false, reason: '성공 확인 조건을 만족하지 않음(로그인 이후 기능 미검사)' };
      await page.waitForTimeout(200);
    }
    const landing = page.url();
    if (new URL(landing).origin !== loginUrl.origin || externalAuth) return { ok: false, reason: '외부 origin 인증은 지원하지 않음' };
    const state = await context.storageState({ indexedDB: true });
    if (JSON.stringify(state).length > 24000) return { ok: false, reason: '로그인 저장소가 메모리 전달 한도를 초과함(로그인 이후 기능 미검사)' };
    // 쿠키·저장소에 담기지 않는 로그인(메모리 토큰 등)은 새 컨텍스트에서 풀린다. 그러면 로그인 상태로 검사했다고 쓸 수 없다.
    const check = await browser.newContext({ serviceWorkers: 'block', storageState: state });
    try {
      await guard(check);
      const p = await check.newPage();
      const response = await p.goto(landing, { timeout: timeoutMs });
      await settle(p, timeoutMs);
      const kept = !!response?.ok() && new URL(p.url()).origin === loginUrl.origin && !externalAuth && (spec.auto ? await autoSucceeded(p) : await succeeded(p, spec.success!));
      if (!kept) return { ok: false, reason: '저장한 로그인 상태로 다시 열면 로그인 상태가 아님(쿠키·저장소에 남지 않는 로그인)' };
    } finally { await check.close(); }
    if (spec.auto) {
      // 로그인 전에도 같은 화면이 보이면 쿠키 변화만으로 인증 성공이라 말할 수 없다.
      const anonymous = await browser.newContext({ serviceWorkers: 'block' });
      try {
        await guard(anonymous);
        const p = await anonymous.newPage();
        const response = await p.goto(landing, { timeout: timeoutMs });
        await settle(p, timeoutMs);
        const asksLogin = await p.locator('input[type=password]:visible').count() > 0;
        const marker = (q: Page) => q.getByRole('link', { name: /로그아웃|log.?out|sign.?out/i }).or(q.getByRole('button', { name: /로그아웃|log.?out|sign.?out/i })).count();
        const distinct = asksLogin || [401, 403].includes(response?.status() ?? 0) || await marker(page) > 0 && await marker(p) === 0;
        if (!distinct || externalAuth) return { ok: false, reason: '자동 로그인 성공을 확인할 인증 전후 차이가 없음(로그인 이후 기능 미검사)' };
      } finally { await anonymous.close(); }
    }
    return { ok: true, state };
  } catch (e) {
    // 브라우저 예외에는 주소·입력값이 섞이므로 원문을 기록하지 않는다(아이디도 비밀값).
    return { ok: false, reason: externalAuth ? '외부 origin 인증은 지원하지 않음' : `로그인 중 오류: ${/timeout/i.test(String((e as Error).message)) ? '화면 응답 시간 초과' : '로그인 페이지 또는 입력·제출 처리 실패'}` };
  } finally {
    await context.close();
  }
}

/** 로그인 성공 조건(주어진 것 모두). */
async function succeeded(page: Page, s: NonNullable<LoginSpec['success']>): Promise<boolean> {
  return (!s.urlIncludes || page.url().includes(s.urlIncludes))
    && (!s.text || (await page.getByText(s.text).count()) > 0)
    && (!s.target || (await toLocator(page, s.target).count()) > 0);
}

const USER_FIELDS = 'input:not([type]), input[type=text], input[type=email], input[autocomplete=username]';
async function detectLoginForm(page: Page) {
  const password = page.locator('input[type=password]:visible');
  if (await password.count() !== 1 || !await password.isEditable()) return null;
  const form = password.locator('xpath=ancestor::form[1]');
  if (await form.count() !== 1) return null;
  const username = form.locator(USER_FIELDS).filter({ visible: true });
  const submit = form.locator('button:not([type]), button[type=submit], input[type=submit]').filter({ visible: true });
  if (await username.count() !== 1 || !await username.isEditable() || await submit.count() !== 1 || !await submit.isEnabled()) return null;
  const label = (await submit.innerText().catch(() => '') || await submit.getAttribute('value') || '').trim();
  if (/가입|등록|비밀번호.*(변경|재설정)|sign.?up|register|reset|change/i.test(label)) return null;
  return { form, username, password, submit };
}

async function loginChallenge(page: Page): Promise<string | undefined> {
  if (await page.locator('iframe[src*=captcha], iframe[title*=captcha i], [class*=captcha]:visible, [id*=captcha]:visible').count()) return 'CAPTCHA 인증은 자동 로그인에서 지원하지 않음';
  if (await page.locator('input[autocomplete=one-time-code]:visible, input[name*=otp i]:visible, input[name*=totp i]:visible').count()
    || await page.getByText(/2단계 인증|인증 코드를 입력|two.factor|verification code|authenticator code/i).count()) return '2단계 인증은 자동 로그인에서 지원하지 않음';
  return undefined;
}

async function autoSucceeded(page: Page): Promise<boolean> {
  if (await loginChallenge(page)) return false;
  // 양식이 사라진 것뿐 아니라 오류 화면·빈 화면도 걸러 낸다. 재접속 검증은 호출자에서 별도로 한다.
  if (await page.locator('form').filter({ has: page.locator('input[type=password]:visible') }).count()) return false;
  if (await page.getByText(/아이디나 비밀번호가 틀|로그인.{0,12}실패|비밀번호.{0,12}(틀|잘못|일치하지)|invalid (credentials|password|username)|incorrect (password|username)|login failed|sign.?in failed/i).count()) return false;
  return (await page.locator('body').innerText()).trim().length > 0 && !/^about:|^chrome-error:/.test(page.url());
}
