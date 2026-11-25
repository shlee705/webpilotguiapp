'use strict';

// Local-only real Edge verification. No model/API requests or user sites.
const http = require('node:http');
const assert = require('node:assert/strict');
const { startSiteSession, SitePolicyError } = require('../electron/site-browser.cjs');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stop = server => new Promise(resolve => server.close(resolve));
const credentials = { username: 'fixture-user@example.test', password: 'fixture-secret-&+123' };
let externalRequests = 0;
let unauthorizedPosts = 0;
let loginPosts = 0;
let spaPosts = 0;
let leakedRequests = 0;
let typed = '';
let session;
const outside = http.createServer((_request, response) => { externalRequests++; response.end('outside'); });
const shell = body => `<!doctype html><html><head><meta charset="utf-8"><title>WebPilot DOM fixture</title><style>body{font:16px Arial;max-width:700px;padding:40px;color:#314b35;background:#f7faf3}a,button,input{display:block;margin:14px 0;padding:10px;min-width:240px;box-sizing:border-box}form{border:1px solid #d3dfca;padding:20px;border-radius:12px}label{display:block}</style></head><body>${body}</body></html>`;

async function main() {
  await listen(outside);
  const other = `http://127.0.0.1:${outside.address().port}`;
  const fixture = http.createServer((request, response) => {
    const address = new URL(request.url, 'http://fixture.invalid');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (address.pathname === '/evidence') { typed = address.searchParams.get('text') ?? ''; response.end(''); return; }
    if (address.pathname === '/leak') { leakedRequests++; response.end(''); return; }
    if (request.method === 'POST') {
      if (['/api/auth/login', '/api/auth/form', '/api/auth/redirect'].includes(address.pathname)) {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          const fields = request.headers['content-type'].includes('application/json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
          assert.equal(fields.username, credentials.username);
          assert.equal(fields.password, credentials.password);
          spaPosts++;
          if (address.pathname === '/api/auth/redirect') { response.writeHead(302, { Location: `${other}/forbidden-auth-redirect` }); response.end(); return; }
          response.setHeader('Content-Type', 'application/json');
          response.end('{"ok":true}');
        });
        return;
      }
      if (address.pathname !== '/session') { unauthorizedPosts++; response.end('blocked POST reached server'); return; }
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const fields = new URLSearchParams(body);
        assert.equal(fields.get('username'), credentials.username);
        assert.equal(fields.get('password'), credentials.password);
        loginPosts++;
        response.writeHead(303, { Location: '/signed-in', 'Set-Cookie': 'fixture-auth=1; HttpOnly; SameSite=Lax; Path=/' });
        response.end();
      });
      return;
    }
    if (address.pathname === '/signed-in') {
      assert.match(request.headers.cookie ?? '', /fixture-auth=1/);
      response.end(shell(`<h1>Login fixture reached</h1><p>${credentials.username} ${credentials.password}</p><a href="/inside">Continue tour</a><button type="button" onclick="fetch('/write',{method:'POST'}).catch(()=>{})">Network action</button><script>fetch('${other}/after-login').catch(()=>{})</script>`));
      return;
    }
    if (address.pathname === '/inside') { response.end(shell('<h1>Inside page</h1><a href="/">Home</a>')); return; }
    if (['/spa', '/spa-form', '/spa-redirect'].includes(address.pathname)) {
      const endpoint = address.pathname === '/spa-form' ? '/api/auth/form' : address.pathname === '/spa-redirect' ? '/api/auth/redirect' : '/api/auth/login';
      const asJson = address.pathname !== '/spa-form';
      response.end(shell(`<h1>SPA sign in</h1><form id="spa-login" onsubmit="event.preventDefault(); const fields=Object.fromEntries(new FormData(this)); const options={method:'POST',headers:{'Content-Type':'${asJson ? 'application/json' : 'application/x-www-form-urlencoded'}'},body:${asJson ? 'JSON.stringify(fields)' : 'new URLSearchParams(fields).toString()'}}; fetch('/write',options).catch(()=>{});fetch('${other}/api/auth/login',options).catch(()=>{});fetch('${endpoint}',options).then(response=>response.json()).then(()=>{document.body.replaceChildren();const heading=document.createElement('h1');heading.textContent='SPA login completed';const link=document.createElement('a');link.href='/inside';link.textContent='Continue tour';document.body.append(heading,link);fetch('${endpoint}',options).catch(()=>{});}).catch(()=>{});"><label>Username<input name="username" autocomplete="username" type="email"></label><label>Password<input name="password" autocomplete="current-password" type="password"></label><input name="csrf" value="fixture-csrf" type="hidden"><button type="submit">Sign in</button></form>`));
      return;
    }
    if (address.pathname === '/login' || address.pathname === '/mfa' || address.pathname === '/external-login') {
      response.end(shell(`<h1>Sign in</h1><form action="${address.pathname === '/external-login' ? other + '/session' : '/session'}" method="post"><label>Username<input name="username" autocomplete="username" type="email"></label><label>Password<input name="password" autocomplete="current-password" type="password" oninput="fetch('/leak?secret='+encodeURIComponent(this.value)).catch(()=>{})"></label><input name="csrf" value="fixture-csrf" type="hidden"><button type="submit">Sign in</button></form>${address.pathname === '/mfa' ? '<label>Verification code<input name="otp" autocomplete="one-time-code"></label>' : ''}`));
      return;
    }
    response.end(shell(`<h1>DOM observation fixture</h1><p>Read this visible page.</p><a href="/login">Open login page</a><a href="${other}/outside">Outside link</a><button type="button" onclick="fetch('/write',{method:'POST'}).catch(()=>{})">Network action</button><input type="search" aria-label="Search docs" value="PREFILLED_VALUE_MUST_NOT_LEAK" oninput="fetch('/evidence?text='+encodeURIComponent(this.value))"><textarea aria-label="Notes">TEXTAREA_VALUE_MUST_NOT_LEAK</textarea><input type="password" style="display:none" value="PASSWORD_VALUE_MUST_NOT_LEAK"><div hidden>HIDDEN_TEXT_MUST_NOT_LEAK</div>`));
  });
  await listen(fixture);
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const statuses = [];
  const find = (view, label) => { const element = view.elements.find(item => item.label.includes(label)); assert.ok(element, `Expected element: ${label}`); return element.id; };
  try {
    session = await startSiteSession({ url: origin, credentials, onStatus: message => statuses.push(message) });
    let view = await session.observe();
    assert.equal(view.loginAvailable, false);
    assert.ok(view.viewport.width > 600 && view.viewport.height > 500);
    assert.ok(view.elements.length <= 60);
    assert.ok(view.text.length <= 10000);
    assert.doesNotMatch(JSON.stringify(view), /PREFILLED_VALUE|TEXTAREA_VALUE|PASSWORD_VALUE|HIDDEN_TEXT/);
    assert.ok(!view.elements.some(element => element.href?.startsWith(other)));
    const stale = find(view, 'Open login page');
    const search = find(view, 'Search docs');
    await session.act({ action: 'type', element_id: search, text: 'Real DOM input' });
    assert.equal(typed, 'Real DOM input');
    await assert.rejects(session.act({ action: 'click', element_id: stale }), /ID가 만료/);
    view = await session.observe();
    const denied = await session.act({ action: 'click', element_id: find(view, 'Network action') });
    assert.match(denied.message, /차단/);
    view = await session.observe();
    await session.act({ action: 'click', element_id: find(view, 'Open login page') });
    view = await session.observe();
    assert.equal(view.loginAvailable, true);
    assert.ok(!view.elements.some(element => element.type === 'password' || /username|password/i.test(element.label)));
    const result = await session.act({ action: 'login' });
    assert.match(result.message, /로그인 폼을 제출/);
    assert.equal(loginPosts, 1);
    view = await session.observe();
    assert.equal(view.url, `${origin}/signed-in`);
    const serialized = JSON.stringify({ view, result, statuses });
    assert.ok(!serialized.includes(credentials.username) && !serialized.includes(credentials.password), 'Credentials never enter model context/status/result');
    assert.equal(view.loginAvailable, false);
    await assert.rejects(session.act({ action: 'login' }), /한 번/);
    view = await session.observe();
    await session.act({ action: 'click', element_id: find(view, 'Continue tour') });
    assert.equal((await session.observe()).url, `${origin}/inside`);
    await session.close();
    session = await startSiteSession({ url: `${origin}/login` });
    const noCredentialsView = await session.observe();
    assert.equal(noCredentialsView.loginFormVisible, true);
    assert.equal(noCredentialsView.loginAvailable, false);
    await assert.rejects(session.act({ action: 'login' }), /계정이 제공되지/);
    await session.close();
    session = await startSiteSession({ url: `${origin}/external-login`, credentials });
    await assert.rejects(session.observe(), /로그인 입력란|외부 SSO/);
    await assert.rejects(session.act({ action: 'login' }), SitePolicyError);
    await session.close();
    session = await startSiteSession({ url: `${origin}/mfa`, credentials });
    await assert.rejects(session.observe(), /CAPTCHA|추가 인증/);
    await assert.rejects(session.act({ action: 'login' }), /CAPTCHA|추가 인증/);
    await session.close();
    for (const route of ['/spa', '/spa-form']) {
      session = await startSiteSession({ url: `${origin}${route}`, credentials });
      assert.equal((await session.observe()).loginAvailable, true);
      await session.act({ action: 'login' });
      view = await session.observe();
      assert.match(view.text, /SPA login completed/);
      await session.act({ action: 'click', element_id: find(view, 'Continue tour') });
      assert.equal((await session.observe()).url, `${origin}/inside`);
      await session.close();
    }
    session = await startSiteSession({ url: `${origin}/spa-redirect`, credentials });
    assert.equal((await session.observe()).loginAvailable, true);
    await assert.rejects(session.act({ action: 'login' }), /리디렉션/);
    assert.equal(spaPosts, 3, 'one auth request per session; retries remain blocked');
    assert.equal(externalRequests, 0);
    assert.equal(unauthorizedPosts, 0);
    // Full passwords cannot leave through a URL. Partial input events are also
    // blocked by the private-input network guard.
    assert.equal(leakedRequests, 0);
    console.log(JSON.stringify({ passed: true, domNavigation: true, nativeTyping: true, nativeLogin: true, loginPosts, spaPosts, externalRequests, unauthorizedPosts, leakedRequests, credentialsRedacted: true, staleIdsRejected: true, noCredentialsRejected: true, mfaRejected: true, spaJsonAndForm: true, authRedirectRejected: true }));
  } finally { await session?.close(); await stop(fixture); await stop(outside); }
}
main().catch(async error => { console.error(error); await session?.close(); outside.close(); process.exitCode = 1; });
