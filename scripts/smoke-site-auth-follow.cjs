'use strict';

// Synthetic local server and native Edge only. No user credentials or model API.
const assert = require('node:assert/strict');
const http = require('node:http');
const { startSiteSession } = require('../electron/site-browser.cjs');
const credentials = { username: 'fixture-user@example.test', password: 'fixture-password-123!' };
const counts = { csrf: 0, posts: 0, leaks: 0, unauthorized: 0, protected: 0, external: 0 };
const outside = http.createServer((_request, response) => { counts.external++; response.end('outside'); });
const shell = content => `<!doctype html><meta charset="utf-8"><style>body{padding:40px;font:18px Arial}input,button{display:block;margin:12px;padding:10px}form{width:400px}</style>${content}`;
const loginPage = flow => shell(`<h1>Sign in</h1><form id="login" onsubmit="event.preventDefault(); submitLogin(this)">
  <input name="identifier" type="email" autocomplete="username" oninput="fetch('/leak?value='+encodeURIComponent(this.value)).catch(()=>{});fetch('/api/auth/csrf').catch(()=>{})">
  <input name="password" type="password" autocomplete="current-password" oninput="fetch('/leak?value='+encodeURIComponent(this.value)).catch(()=>{})">
  <button type="submit">Sign in</button></form><script>
  async function submitLogin(form){try{
    const fields=Object.fromEntries(new FormData(form));
    await fetch('/api/auth/csrf').then(r=>r.json());
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fields)}).then(r=>r.json());
    if('${flow}'==='confirmed'||'${flow}'==='markerless') location.assign('${flow === 'markerless' ? '/protected-no-marker' : '/protected'}');
    else {document.body.innerHTML='<h1>Page after submission</h1>${flow === 'ephemeral' ? '<button>Log out</button>' : ''}';history.pushState({},'', '${flow === 'public' ? '/public' : '/ephemeral'}');}
  }catch{document.body.insertAdjacentHTML('beforeend','<p>Login failed</p>')}}
  </script>`);
let session;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/leak') { counts.leaks++; response.end(''); return; }
  if (url.pathname === '/api/auth/csrf' && request.method === 'GET') {
    counts.csrf++;
    if ((request.headers.cookie ?? '').includes('flow=csrf-redirect')) {
      response.writeHead(302, { Location: `http://127.0.0.1:${outside.address().port}/forbidden` }); response.end(); return;
    }
    response.setHeader('Set-Cookie', 'csrf=fixture; Path=/; SameSite=Lax');
    response.setHeader('Content-Type', 'application/json'); response.end('{"csrfToken":"fixture"}'); return;
  }
  if (request.method === 'POST') {
    if (url.pathname !== '/api/auth/login') { counts.unauthorized++; response.end(''); return; }
    let body = '';
    request.on('data', part => { body += part; });
    request.on('end', () => {
      const fields = JSON.parse(body);
      assert.deepEqual(fields, { identifier: credentials.username, password: credentials.password });
      assert.match(request.headers.cookie ?? '', /csrf=fixture/);
      counts.posts++;
      const flow = /flow=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
      response.setHeader('Content-Type', 'application/json');
      if (['confirmed', 'markerless'].includes(flow)) response.setHeader('Set-Cookie', 'authenticated=1; Path=/; HttpOnly; SameSite=Lax');
      response.end(flow === 'rejected' ? '{"success":false,"error":"Invalid credentials"}' : '{"ok":true}');
    }); return;
  }
  if (url.pathname === '/signin') {
    const flow = url.searchParams.get('flow') || 'confirmed';
    response.setHeader('Set-Cookie', `flow=${flow}; Path=/; SameSite=Lax`);
    response.end(loginPage(flow)); return;
  }
  if (url.pathname === '/ephemeral') {
    response.writeHead(303, { Location: '/signin?flow=ephemeral' }); response.end(); return;
  }
  if (url.pathname === '/public') { response.end(shell('<h1>Public landing page</h1>')); return; }
  if (['/protected', '/protected-no-marker', '/next'].includes(url.pathname)) {
    if (!(request.headers.cookie ?? '').includes('authenticated=1')) {
      if (url.pathname === '/protected-no-marker') { response.writeHead(401); response.end('Authentication required'); return; }
      response.writeHead(303, { Location: '/signin' }); response.end(); return;
    }
    counts.protected++;
    response.end(shell(`<h1>Signed in</h1><p>${url.pathname}</p><a href="/next">Next page</a>${url.pathname === '/protected-no-marker' ? '' : '<button type="button">Log out</button>'}`)); return;
  }
  response.writeHead(404); response.end('Not found');
});
async function main() {
  await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const statuses = [];
  try {
    for (const flow of ['confirmed', 'rejected', 'ephemeral', 'public', 'markerless', 'csrf-redirect']) {
      session = await startSiteSession({ url: `${origin}/signin?flow=${flow}`, credentials, followBackend: true,
        signal: AbortSignal.timeout(45000), onStatus: value => statuses.push(value) });
      const before = counts.posts;
      if (flow === 'csrf-redirect') {
        await assert.rejects(session.authenticate(), /로그인/);
        assert.equal(counts.posts, before);
        await session.close(); session = undefined;
        console.log(JSON.stringify({ flow, redirectBlocked: true }));
        continue;
      }
      const result = await session.authenticate();
      assert.equal(result.login.status, ['ephemeral', 'public'].includes(flow) ? 'unconfirmed' : flow === 'markerless' ? 'confirmed' : flow);
      assert.equal(counts.posts, before + 1);
      await assert.rejects(session.authenticate(), /한 번/);
      if (['confirmed', 'markerless'].includes(flow)) {
        await session.followBackendUrl(`${origin}/next`);
        assert.equal((await session.observe()).url, `${origin}/next`);
      }
      assert.ok(!JSON.stringify({ result, statuses }).includes(credentials.username));
      assert.ok(!JSON.stringify({ result, statuses }).includes(credentials.password));
      await session.close(); session = undefined;
      console.log(JSON.stringify({ flow, status: result.login.status }));
    }
    assert.equal(counts.csrf, 6, 'Only submitted forms may obtain CSRF; input events cannot');
    assert.equal(counts.posts, 5, 'No automatic login resubmission');
    assert.equal(counts.leaks, 0);
    assert.equal(counts.unauthorized, 0);
    assert.equal(counts.external, 0);
    assert.ok(counts.protected >= 6, 'Authenticated landing reload and backend-follow page both retain the session');
    console.log(JSON.stringify({ passed: true, csrfPreparation: true, confirmedAndPersisted: true, rejectionDetected: true,
      ephemeralLoginUnconfirmed: true, publicLandingUnconfirmed: true, markerlessProtectedVerified: true,
      csrfRedirectBlocked: true, secretsRedacted: true, counts, paidApiCalls: 0, userLogins: 0 }));
  } finally { await session?.close(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => outside.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
