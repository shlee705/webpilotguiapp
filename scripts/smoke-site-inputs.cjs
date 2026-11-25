'use strict';
// Isolated local controls only. No model, user site, stored keys or real account.
const assert = require('node:assert/strict');
const http = require('node:http');
const { startSiteSession, SitePolicyError, SiteInteractionError } = require('../electron/site-browser.cjs');

async function main() {
  const values = new Map();
  let posts = 0;
  const shell = body => `<!doctype html><html><meta charset="utf-8"><title>Draft input fixture</title><style>body{font:16px Arial;padding:24px;color:#222;background:#fafafa}label{display:block;margin-bottom:10px}input,textarea,[contenteditable]{display:block;width:420px;padding:8px;border:1px solid #999}textarea,[contenteditable]{height:65px}button{padding:8px;margin:5px}form{margin:10px 0}</style><body>${body}</body></html>`;
  const fixture = http.createServer((request, response) => {
    const address = new URL(request.url, 'http://fixture.invalid');
    if (request.method === 'POST') posts++;
    if (address.pathname === '/evidence') { values.set(address.searchParams.get('name'), address.searchParams.get('text')); response.end('ok'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (address.pathname === '/client-login') {
      response.end(shell(`<form id="sign-in" onsubmit="event.preventDefault();this.remove();document.querySelector('#result').textContent='Client screen changed';"><label>Username<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>로그인</button></form><p id="result"></p>`)); return;
    }
    response.end(shell(`<form id="draft" action="/publish" method="post"><label>제목<input id="title" name="title" aria-label="제목" value="TITLE_VALUE_MUST_NOT_LEAK"></label><label>본문<textarea id="body" name="body">BODY_VALUE_MUST_NOT_LEAK</textarea></label><div contenteditable="true" aria-label="본문 편집기" id="editor"><span>EDITOR_VALUE_MUST_NOT_LEAK</span></div><button>게시</button></form>
      <div contenteditable="plaintext-only" aria-label="짧은 메모" id="plain">PLAIN_VALUE_MUST_NOT_LEAK</div>
      <div contenteditable="true" aria-label="password editor">PRIVATE_EDITOR_MUST_NOT_LEAK</div>
      <div contenteditable="false" aria-label="읽기 전용 편집기">Read only</div>
      <input id="changing" aria-label="변경되는 입력란" onfocus="this.type='password'">
      <input style="position:fixed;right:24px;top:30px;width:220px" aria-label="입력 중 포커스 이동" value="initial draft" oninput="document.querySelector('#title').focus()">
      <button onclick="document.querySelector('#result').textContent='Editor entry opened'">게시글 작성</button>
      <button onclick="document.querySelector('#result').textContent='UNSAFE_SUBMISSION'">게시</button>
      <button onclick="document.querySelector('#result').textContent='SAMPLE_USED'">관리자 123456 / fixture</button><p id="result"></p>
      <div style="position:fixed;left:700px;top:30px;width:240px;height:150px;overflow:auto;overscroll-behavior:contain"><div style="height:550px">Nested scroll region</div></div>
      <script>for(const element of document.querySelectorAll('#title,#body,#editor,#plain')) element.addEventListener('input',()=>fetch('/evidence?name='+element.id+'&text='+encodeURIComponent(element.isContentEditable?element.innerText:element.value)));</script>`));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  let session;
  const find = (view, label) => { const entry = view.elements.find(item => item.label === label); assert.ok(entry, `Expected control: ${label}`); return entry.id; };
  try {
    session = await startSiteSession({ url: origin });
    let view = await session.observe();
    assert.doesNotMatch(JSON.stringify(view), /(?:TITLE|BODY|EDITOR|PLAIN)_VALUE_MUST_NOT_LEAK|PRIVATE_EDITOR_MUST_NOT_LEAK/);
    assert.equal(view.elements.filter(item => item.type === 'contenteditable').length, 2);
    assert.equal(view.elements.some(item => /password|관리자|^게시$/.test(item.label)), false);
    const nested = { type: 'scroll', x: 800, y: 100, scroll_x: 0, scroll_y: 1200 };
    assert.equal((await session.perform(nested)).performed, true);
    assert.equal((await session.perform(nested)).performed, false);
    assert.equal((await session.perform({ ...nested, scroll_y: -1200 })).performed, true);
    await assert.rejects(session.act({ action: 'type', element_id: find(view, '제목'), text: 'line one\nline two' }), /한 줄 입력란/);
    assert.equal(values.has('title'), false);
    view = await session.observe();
    await session.act({ action: 'type', element_id: find(view, '제목'), text: '테스트 제목' });
    assert.equal(values.get('title'), '테스트 제목');
    view = await session.observe();
    await session.act({ action: 'type', element_id: find(view, '본문'), text: '첫 줄\r\n둘째 줄' });
    assert.equal(values.get('body'), '첫 줄\n둘째 줄');
    view = await session.observe();
    await session.act({ action: 'type', element_id: find(view, '본문 편집기'), text: 'Editor one\nEditor two' });
    assert.equal(values.get('editor'), 'Editor one\nEditor two');
    view = await session.observe();
    await session.act({ action: 'type', element_id: find(view, '짧은 메모'), text: 'Plain one\nPlain two' });
    assert.equal(values.get('plain'), 'Plain one\nPlain two');
    view = await session.observe();
    await assert.rejects(session.act({ action: 'type', element_id: find(view, '변경되는 입력란'), text: 'must never enter password field' }), SitePolicyError);
    view = await session.observe();
    await assert.rejects(session.act({ action: 'type', element_id: find(view, '입력 중 포커스 이동'), text: 'must stop after clearing' }), SiteInteractionError);
    view = await session.observe();
    await session.act({ action: 'click', element_id: find(view, '게시글 작성') });
    view = await session.observe(); assert.match(view.text, /Editor entry opened/);
    assert.doesNotMatch(view.text, /UNSAFE_SUBMISSION|SAMPLE_USED/);
    await session.close();
    const credentials = { username: 'isolated-fixture-user', password: 'isolated-fixture-password' };
    session = await startSiteSession({ url: `${origin}/client-login`, credentials });
    assert.equal((await session.observe()).loginAvailable, true);
    const outcome = await session.act({ action: 'login' });
    assert.match(outcome.message, /로그인 폼을 제출.*화면 전환/);
    assert.match(outcome.message, /로그인 성공 여부는 확인하지 않았습니다/);
    view = await session.observe(); assert.match(view.text, /Client screen changed/);
    assert.doesNotMatch(JSON.stringify({ outcome, view }), /isolated-fixture-(?:user|password)/);
    assert.equal(posts, 0);
    console.log(JSON.stringify({ passed: true, nativeTitle: true, textareaMultiline: true, editableHost: true, plaintextHost: true,
      singleLineNewlineRejected: true, changedPasswordFieldRejected: true, sampleAccountsExcluded: true, clientSubmitObservedWithoutSuccessClaim: true, posts, paidApiCalls: 0 }));
  } finally { await session?.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
