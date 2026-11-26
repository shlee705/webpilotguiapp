'use strict';
// Real Edge, isolated local controls, no API calls or supplied credentials.
const assert = require('node:assert/strict');
const http = require('node:http');
const { startSiteSession, SitePolicyError } = require('../electron/site-browser.cjs');

async function main() {
  let posts = 0;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Standalone button fixture</title><style>
    body{font:16px Arial;background:#fafafa;color:#222}#controls>button,#custom{position:absolute;left:24px;width:240px;height:38px}
    #result{position:absolute;left:300px;top:30px}#modal{position:fixed;inset:0;background:#ffffffee;z-index:10}
    #modal>button{position:absolute;left:400px;top:70px;width:200px;height:38px}#login-form{position:absolute;left:400px;top:120px}
    #login-form label{display:block;margin:15px 0}#login-form input{display:block;padding:8px}#actual-submit{position:fixed;left:400px;top:350px;width:200px;height:38px}
    </style></head><body><div id="controls">
    <button style="top:24px" onclick="document.querySelector('#result').textContent='학과소개 내용 확인'">학과소개</button>
    <button style="top:74px" onclick="document.querySelector('#result').textContent='알림마당 내용 확인'">알림마당</button>
    <button style="top:124px" onclick="document.querySelector('#modal').hidden=false">로그인 화면 열기</button>
    <button style="top:174px" type="reset">Standalone reset</button>
    <button style="top:224px" form="remote">Remote form action</button>
    <button style="top:274px" form="missing">Missing form owner</button>
    <button style="top:324px" formaction="/write">Submission override</button>
    <button style="top:374px" onmouseenter="this.setAttribute('form','remote')">Ownership changing</button>
    <button style="top:424px" type="submit" onclick="document.querySelector('#result').textContent='Standalone explicit submit clicked'">독립 버튼</button>
    </div><div id="custom" style="top:474px" role="button" tabindex="0">Custom role action</div>
    <p id="result">Ready</p><form id="remote" action="/write" method="post" hidden><input name="data" value="fixed"></form>
    <div id="modal" hidden><button onclick="document.querySelector('#modal').hidden=true">창닫기</button>
    <form id="login-form" onsubmit="event.preventDefault();fetch('/api/auth/login',{method:'POST',body:new URLSearchParams(new FormData(this))})">
    <label>Username<input name="studentId" autocomplete="username" value="ACCOUNT_VALUE_MUST_NOT_LEAK"></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" value="PASSWORD_VALUE_MUST_NOT_LEAK"></label>
    <button id="actual-submit">로그인</button></form></div></body></html>`;
  const fixture = http.createServer((request, response) => {
    if (request.method === 'POST') posts += 1;
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  let session;
  const find = (view, label) => {
    const item = view.elements.find(element => element.label === label);
    assert.ok(item, `Expected observed control: ${label}`); return item.id;
  };
  try {
    session = await startSiteSession({ url });
    let view = await session.observe();
    assert.equal(view.loginFormVisible, false);
    assert.equal(view.loginAvailable, false);
    assert.equal(view.elements.some(element => /reset|form action|form owner|override|Custom role/.test(element.label)), false);
    await session.act({ action: 'click', element_id: find(view, '학과소개') });
    view = await session.observe(); assert.match(view.text, /학과소개 내용 확인/);
    await session.act({ action: 'click', element_id: find(view, '로그인 화면 열기') });
    view = await session.observe();
    assert.equal(view.url, url);
    assert.equal(view.loginFormVisible, true);
    assert.equal(view.loginAvailable, false);
    assert.doesNotMatch(JSON.stringify(view), /ACCOUNT_VALUE_MUST_NOT_LEAK|PASSWORD_VALUE_MUST_NOT_LEAK/);
    assert.equal(view.elements.some(element => /Username|Password/.test(element.label)), false);
    await assert.rejects(session.act({ action: 'login' }), /계정이 제공되지/);
    await assert.rejects(session.perform({ type: 'click', x: 500, y: 369 }), SitePolicyError);
    view = await session.observe();
    await session.act({ action: 'click', element_id: find(view, '창닫기') });
    view = await session.observe(); assert.equal(view.loginFormVisible, false);
    await session.act({ action: 'click', element_id: find(view, '알림마당') });
    view = await session.observe(); assert.match(view.text, /알림마당 내용 확인/);
    // Real intermediate pointer movement can hover this control while crossing
    // the column. Verify its ownership-change guard before travelling past it.
    await assert.rejects(session.act({ action: 'click', element_id: find(view, 'Ownership changing') }), SitePolicyError);
    view = await session.observe();
    await session.act({ action: 'click', element_id: find(view, '독립 버튼') });
    view = await session.observe(); assert.match(view.text, /Standalone explicit submit clicked/);
    for (const y of [193, 243, 293, 343, 493]) await assert.rejects(session.perform({ type: 'click', x: 144, y }), SitePolicyError);
    assert.equal(posts, 0);
    console.log(JSON.stringify({ passed: true, defaultButtons: true, loginModalWithoutCredentials: true, modalClose: true,
      generalMenuNavigation: true, secretValuesExcluded: true, formOwnerMutationBlocked: true, unsafeControlsBlocked: true, loginPosts: posts, paidApiCalls: 0 }));
  } finally {
    await session?.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
