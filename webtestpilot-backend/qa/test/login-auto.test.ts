import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { login, readAppConfig, type LoginSpec } from '../src/login.ts';
import { configurePrivateValues, privateMasks, privateRequest, privateJson, PRIVATE_NOTICE } from '../src/privacy.ts';
import { runPlan } from '../src/run.ts';
import type { Plan } from '../src/plan.ts';

const USER = 'fixture-user', PASSWORD = 'fixture-pw+@123';
let browser: Browser, server: Server, origin = '';
const posts = new Map<string, number>();
let blockedWrites = 0;
const form = (action = '') => `<form method="post" action="${action}"><label>아이디<input name="user" autocomplete="username"></label><label>비밀번호<input type="password" name="pass"></label><button>로그인</button></form>`;
before(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/unrelated-write') { blockedWrites++; return res.end('changed'); }
    if (req.method === 'POST') {
      posts.set(url.pathname, (posts.get(url.pathname) ?? 0) + 1);
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        const data = new URLSearchParams(body);
        const user = url.pathname === '/admin/login' ? 'admin' : url.pathname === '/private-login' ? 'test' : USER;
        if (data.get('user') !== user || data.get('pass') !== PASSWORD) return res.end(`<p>아이디나 비밀번호가 틀립니다</p>${form()}`);
        if (url.pathname === '/otp') return res.end('<p>인증 코드를 입력</p><input autocomplete="one-time-code">');
        if (url.pathname === '/http-error') { res.statusCode = 500; return res.end('<h1>Internal server error</h1>'); }
        const target = url.pathname === '/ambiguous' ? '/public' : url.pathname === '/private-login' ? '/private-account' : '/account';
        res.writeHead(302, { 'set-cookie': `session=${user}; Path=/; HttpOnly`, location: target }); res.end();
      }); return;
    }
    if (url.pathname === '/public') return res.end('<h1>누구나 보는 페이지</h1>');
    if (url.pathname === '/account' || url.pathname === '/private-account') {
      if (!req.headers.cookie?.includes('session=')) { res.writeHead(302, { location: '/login' }); return res.end(); }
      return res.end(`<h1>회원 대시보드</h1><a href="/logout">로그아웃</a><p>환영합니다, test</p><p>${PASSWORD}</p><input value="test"><canvas></canvas>`);
    }
    if (url.pathname === '/captcha') return res.end(`${form()}<div class="captcha">인증</div>`);
    if (url.pathname === '/external') return res.end(form('http://127.0.0.1:1/external'));
    // 자동 로그인 제출 이외의 같은 origin 쓰기도 막아야 한다.
    res.end(`${form()}<script>fetch('/unrelated-write', {method:'POST',body:'background'})</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { configurePrivateValues([]); await browser?.close(); server?.close(); });
const spec = (path = '/login'): LoginSpec => ({ auto: true, url: origin + path, env: { username: 'AUTO_USER', password: 'AUTO_PASSWORD' } });
const env = (username = USER, password = PASSWORD) => ({ AUTO_USER: username, AUTO_PASSWORD: password });

test('자동 로그인 설정은 값 대신 환경 변수 이름만 받고, admin 경로에서 한 번 제출한 세션으로 검사한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-auto-login-'));
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ login: spec('/admin/login') }));
  assert.equal(readAppConfig(join(dir, 'app.json')).login?.auto, true);
  const result = await login(browser, { origins: [origin] }, spec('/admin/login'), env('admin'), 1000);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(posts.get('/admin/login'), 1);
  assert.equal(blockedWrites, 0);
  const page = await browser.newPage({ storageState: result.ok ? result.state : undefined });
  await page.goto(origin + '/account');
  assert.equal(await page.getByRole('heading').innerText(), '회원 대시보드');
  await page.close();
});

test('자동 로그인은 잘못된 계정·OTP·CAPTCHA·외부 인증·HTTP 오류·인증 차이 없는 페이지를 성공이라 하지 않는다', async () => {
  for (const [path, input, pattern] of [
    ['/wrong', env(USER, 'wrong-private-password'), /성공 확인/],
    ['/otp', env(), /2단계/], ['/captcha', env(), /CAPTCHA/], ['/external', env(), /외부 origin/],
    ['/http-error', env(), /HTTP 오류/], ['/ambiguous', env(), /인증 전후 차이/],
  ] as const) {
    const result = await login(browser, { origins: [origin] }, spec(path), input, 500);
    assert.ok(!result.ok, path);
    if (!result.ok) assert.match(result.reason, pattern);
    assert.ok(!JSON.stringify(result).includes(USER) && !JSON.stringify(result).includes(PASSWORD));
    assert.ok((posts.get(path) ?? 0) <= 1, `${path}: 제출 재시도 없음`);
  }
});

test('인증 검사: 계정은 모델·ledger·실패 아티팩트에 없고 가려진 값의 비교는 판단 불가로 둔다', async () => {
  configurePrivateValues(['test', PASSWORD], [origin + '/private-account']);
  try {
    const result = await login(browser, { origins: [origin] }, spec('/private-login'), env('test'), 1000);
    assert.ok(result.ok, JSON.stringify(result));
    const page = await browser.newPage({ storageState: result.ok ? result.state : undefined });
    await page.goto(origin + '/private-account');
    const masks = await privateMasks(page);
    assert.ok(await masks[0].count() >= 4, '계정 본문·입력·canvas를 마스크한다');
    assert.equal(await page.getByText(PASSWORD, { exact: true }).getAttribute('data-qa-private'), '1');
    const picture = await page.screenshot({ mask: masks });
    assert.ok(picture.length > 100);
    const request: any = { model: 'gpt-6-luna', max_tokens: 100, system: '검사', messages: [{ role: 'user', content: await page.locator('body').ariaSnapshot() }] };
    privateRequest(request);
    assert.ok(!JSON.stringify(request).includes(PASSWORD));
    assert.ok(request.system.includes(PRIVATE_NOTICE));
    await page.close();
    const plan: Plan = { version: 1, textRead: 'name+content', requirements: [{ id: 'R1', text: '회원 대시보드가 보인다' }], questions: [], observations: [], unplanned: [], features: [],
      targets: { T1: { target: { role: 'heading', name: '^회원 대시보드$' }, group: false, url: origin + '/private-account' }, T2: { target: { text: '환영합니다, test' }, group: false, url: origin + '/private-account' } },
      scenarios: [{ id: 'S1', title: '회원 대시보드', covers: ['R1'], start: { url: origin + '/private-account' }, steps: [], checks: [
        { id: 'S1.C1', after: 'start', target: 'T1', read: 'visible', op: 'equals', expected: 'true', source: { kind: 'requirement', id: 'R1', quote: '회원 대시보드가 보인다' } },
        { id: 'S1.C2', after: 'start', target: 'T2', read: 'text', op: 'equals', expected: '환영합니다, test', source: { kind: 'requirement', id: 'R1', quote: '회원 대시보드가 보인다' } },
      ] }] };
    const dir = join(mkdtempSync(join(tmpdir(), 'qa-private-worker-')), 'run');
    const run = await runPlan({ plan, policy: { origins: [origin] }, runDir: dir, storageState: result.ok ? result.state : undefined, timeoutMs: 1200 });
    assert.equal(run.scenarios[0].checks[0].status, 'passed', privateJson(run));
    assert.equal(run.scenarios[0].checks[1].status, 'unresolved', privateJson(run));
    assert.equal(run.scenarios[0].valid, true, privateJson(run));
    assert.ok(!readFileSync(join(dir, 'plan.json'), 'utf8').includes('환영합니다, test'));
    const scan = (root: string) => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (/\.(png|zip)$/.test(entry.name)) continue;
        const content = readFileSync(path, 'utf8');
        assert.ok(!content.includes(PASSWORD) && !content.includes(encodeURIComponent(PASSWORD)), `${entry.name}: password leak`);
        assert.ok(!content.includes('환영합니다, test'), `${entry.name}: account text leak`);
      }
    };
    scan(dir);
    assert.ok(!readdirSync(dir).includes('state.json'));
  } finally { configurePrivateValues([]); }
});
