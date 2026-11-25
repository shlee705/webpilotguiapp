'use strict';

// Real isolated Edge against a local SPA fixture. No user account/site or paid API.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { runSiteAgent } = require('../electron/site-agent.cjs');
const { startSiteSession, SitePolicyError } = require('../electron/site-browser.cjs');
const { deriveTaskPermissions } = require('../electron/task-permissions.cjs');

async function main() {
  const draft = { title: '로컬 공지 등록 확인', body: '첫째 줄: 공지 작성 흐름을 확인합니다.\n둘째 줄: 한 번만 등록합니다.' };
  const stats = { posts: [], listReads: 0, unexpectedWrites: [] };
  let failSubmission = false;
  let hideConfirmation = false;
  let storedPost;
  const shell = body => `<!doctype html><html><head><meta charset="utf-8"><title>공지사항 등록 fixture</title><style>
    body{font:16px Arial;padding:24px;background:#fafafa;color:#222}h1{font-size:24px}form{display:grid;gap:10px;max-width:580px}
    label{display:block}input:not([type=checkbox]),textarea,select{display:block;width:540px;box-sizing:border-box;padding:8px;font:inherit}textarea{height:90px}
    button{padding:10px 18px;font:inherit}form[hidden]{display:none}#submit-post{position:fixed;left:24px;top:440px;width:200px;height:42px}
    #details{max-width:650px}#details p{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
  const fixture = http.createServer(async (request, response) => {
    const address = new URL(request.url, 'http://fixture.invalid');
    response.setHeader('Connection', 'close');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (request.method !== 'POST' || address.pathname !== '/api/posts') {
        stats.unexpectedWrites.push({ method: request.method, path: address.pathname });
        response.writeHead(405); response.end(); return;
      }
      const value = JSON.parse(body);
      stats.posts.push(value);
      response.setHeader('Content-Type', 'application/json');
      if (failSubmission) { response.writeHead(503); response.end(JSON.stringify({ error: 'Fixture registration unavailable' })); return; }
      storedPost = { id: 'fixture-notice-1', ...value };
      response.writeHead(201); response.end(JSON.stringify({ post: storedPost })); return;
    }
    if (address.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (address.pathname === '/api/posts') {
      stats.listReads++;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ posts: storedPost ? [storedPost] : [] })); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (address.pathname === '/sensitive') {
      response.end(shell(`<h1>보호 대상 작업</h1><form action="/api/payments" method="post" aria-label="결제 등록"><label>제목<input name="title" value="결제 요청"></label><label>본문<textarea name="body">결제 신청</textarea></label><button>결제 등록</button></form>
        <form action="/api/posts/delete" method="post" aria-label="공지 삭제"><input name="title" value="삭제 대상"><textarea name="body">삭제 요청</textarea><button>삭제</button></form>
        <button id="network-check" onclick="fetch('/api/posts/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'blocked',body:'blocked'})}).catch(()=>{})">연결 상태 확인</button>`)); return;
    }
    const prefill = address.searchParams.has('prefill');
    response.end(shell(`<h1>공지사항 작성</h1><form class="stack-form" id="post-editor">
      <label>분류<select name="category"><option>학과</option></select></label>
      <label>제목<input name="title" aria-label="제목" required value="${prefill ? '초안 전용 제목' : ''}"></label>
      <label>본문<textarea name="body" aria-label="본문" required>${prefill ? '초안 전용 본문' : ''}</textarea></label>
      <label><input type="checkbox" name="secret">비밀글</label><label><input type="checkbox" name="pinned">상단 고정</label>
      <button id="submit-post">공지 등록</button></form><p id="toast" role="status"></p><div id="details"></div>
      <script>document.querySelector('#post-editor').addEventListener('submit',async event=>{
        event.preventDefault(); const form=event.currentTarget;
        const payload={board:'notices',title:form.elements.title.value,body:form.elements.body.value,category:form.elements.category.value,secret:form.elements.secret.checked,pinned:form.elements.pinned.checked};
        try {
          const response=await fetch('/api/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
          if(!response.ok)throw new Error('등록 실패');
          const {post}=await response.json();
          if(${hideConfirmation}){document.querySelector('#toast').textContent='서버 응답을 받았습니다.';return;}
          await fetch('/api/posts').then(response=>response.json());
          form.hidden=true; document.querySelector('#toast').textContent='공지사항이 등록되었습니다.';
          history.pushState({},'', '/notices/'+post.id);
          const heading=document.createElement('h2');heading.textContent=post.title;
          const body=document.createElement('p');body.textContent=post.body;
          document.querySelector('#details').replaceChildren(heading,body);
        } catch { document.querySelector('#toast').textContent='공지사항을 등록하지 못했습니다.'; }
      });</script>`));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const find = (view, label, role = 'textbox') => {
    const element = view.elements.find(item => item.role === role && item.label.includes(label));
    assert.ok(element, `Expected ${role} control: ${label}`); return element.id;
  };
  let session;
  const results = {};
  try {
    // Default autonomy permits ordinary content creation without requiring the
    // user to repeat a special registration keyword. Negative limits still win.
    const task = '공지글 제목과 본문을 채워서 작성 기능이 정상 동작하는지 확인해 주세요.';
    assert.equal(deriveTaskPermissions(task).allowContentSubmission, true);
    const snapshots = [], actions = [], outcomes = [], events = [];
    let decisions = 0, attempts = 0, reports = 0, duplicateRejected = false, closed = false;
    const controller = new AbortController();
    const result = await runSiteAgent({
      apiKey: 'fixture-only-never-sent', model: 'gpt-6-luna', targetUrl: `${origin}/notices`,
      messages: [{ role: 'user', content: `${task}\n제목: ${draft.title}\n본문: ${draft.body}` }],
      signal: controller.signal, maxActions: 3, retryDelayMs: 0, finalizePauseMs: 0,
      onEvent: event => events.push(event), onUsage: () => {},
      reportProvider: async () => { assert.equal(closed, true); reports++; return { status: 'missing', message: '등록 검증 fixture는 보고서 파일을 생성하지 않습니다.' }; },
      sessionFactory: async options => {
        assert.equal(options.taskPermissions.allowContentSubmission, true);
        session = await startSiteSession(options);
        return {
          observe: async () => { const view = await session.observe(); snapshots.push(view); return view; },
          act: async action => {
            actions.push(action.action);
            const outcome = await session.act(action); outcomes.push(outcome);
            if (action.action === 'submit') {
              assert.equal(outcome.submission?.status, 'confirmed', JSON.stringify(outcome));
              await assert.rejects(session.act(action), SitePolicyError);
              duplicateRejected = true;
            }
            return outcome;
          },
          close: async () => { await session.close(); closed = true; },
        };
      },
      fetchImpl: async (endpoint, options) => {
        assert.equal(endpoint, 'https://api.openai.com/v1/responses');
        attempts++;
        if (attempts === 1) return Response.json({ error: { code: 'server_error' } }, { status: 503 });
        const body = JSON.parse(options.body);
        const content = body.input[1].content;
        const context = JSON.parse(content.split('\nCurrent page: ')[1].split('\nRecent outcomes:')[0]);
        const next = { action: 'type', element_id: '', text: '', scroll_y: 0, reason: '' };
        if (decisions === 0) { next.element_id = find(context, '제목'); next.text = draft.title; next.reason = '요청한 공지 제목 입력'; }
        else if (decisions === 1) { next.element_id = find(context, '본문'); next.text = draft.body; next.reason = '요청한 공지 본문 입력'; }
        else if (decisions === 2) { assert.equal(context.submissionAvailable, true); next.action = 'submit'; next.element_id = find(context, '등록', 'submit'); next.reason = '작성한 공지 등록과 결과 확인'; }
        else assert.fail('No model request may follow the configured three successful actions.');
        decisions++;
        return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(next) }] }] });
      },
    });
    assert.deepEqual(actions, ['type', 'type', 'submit']);
    assert.equal(result.actionCount, 3);
    assert.equal(decisions, 3); assert.equal(attempts, 4);
    assert.equal(snapshots.length, 4, 'The final submit requires one read of its visible result, without another model call.');
    assert.equal(stats.posts.length, 1);
    assert.deepEqual(stats.posts[0], { board: 'notices', title: draft.title, body: draft.body, category: '학과', secret: false, pinned: false });
    assert.ok(stats.listReads >= 1);
    assert.equal(snapshots.at(-1).url, `${origin}/notices/fixture-notice-1`);
    assert.ok(snapshots.at(-1).text.includes(draft.title));
    assert.match(snapshots.at(-1).text, /공지사항이 등록되었습니다/);
    assert.equal(duplicateRejected, true); assert.equal(reports, 1); assert.equal(closed, true);
    assert.equal(events.filter(event => event.id === 'site-response-retry').length, 1);
    results.registration = { successfulActions: result.actionCount, registrationPosts: stats.posts.length, decisions, modelAttempts: attempts, titleVisible: true, duplicateRejected };
    session = undefined;

    for (const task of ['공지글 초안만 작성해 주세요.', '공지글을 작성하되 등록하지 마세요.']) {
      const permissions = deriveTaskPermissions(task);
      assert.equal(permissions.allowContentSubmission, false);
      session = await startSiteSession({ url: `${origin}/notices?prefill=1`, taskPermissions: permissions });
      const view = await session.observe();
      assert.equal(view.submissionAvailable, false);
      assert.equal(view.elements.some(element => element.role === 'submit'), false);
      await assert.rejects(session.act({ action: 'submit', element_id: randomUUID() }), SitePolicyError);
      await assert.rejects(session.perform({ type: 'click', x: 124, y: 461 }), SitePolicyError);
      await session.close(); session = undefined;
      assert.equal(stats.posts.length, 1);
    }
    results.explicitRestrictions = { draftOnlyBlocked: true, registrationForbiddenBlocked: true, genericClickCannotBypass: true };

    session = await startSiteSession({ url: `${origin}/sensitive`, taskPermissions: deriveTaskPermissions('사이트 기능을 자율적으로 점검해 주세요.') });
    const sensitive = await session.observe();
    assert.equal(sensitive.submissionAvailable, false);
    assert.equal(sensitive.elements.some(element => element.role === 'submit'), false);
    await assert.rejects(session.act({ action: 'submit', element_id: randomUUID() }), SitePolicyError);
    const networkCheck = find(await session.observe(), '연결 상태 확인', 'button');
    await session.act({ action: 'click', element_id: networkCheck });
    assert.equal(stats.unexpectedWrites.length, 0);
    await session.close(); session = undefined;
    results.sensitiveActions = { paymentBlocked: true, deletionBlocked: true, unrelatedPostBlocked: true };

    failSubmission = true;
    session = await startSiteSession({ url: `${origin}/notices?prefill=1`, taskPermissions: deriveTaskPermissions('공지 작성 기능을 확인해 주세요.') });
    const failureView = await session.observe();
    const failedAction = { action: 'submit', element_id: find(failureView, '등록', 'submit') };
    const failedOutcome = await session.act(failedAction);
    assert.equal(failedOutcome.submission?.status, 'rejected', JSON.stringify(failedOutcome));
    assert.equal(failedOutcome.submission?.httpStatus, 503);
    assert.equal(failedOutcome.performed, true, 'An observed rejected request records its one submission attempt, without claiming registration.');
    await assert.rejects(session.act(failedAction), SitePolicyError);
    assert.equal(stats.posts.length, 2, 'An uncertain or failed registration must never be replayed.');
    assert.equal(stats.unexpectedWrites.length, 0);
    await session.close(); session = undefined;
    results.failedSubmission = { requestCount: 1, noSuccessClaim: true, resubmissionBlocked: true };

    failSubmission = false; hideConfirmation = true;
    session = await startSiteSession({ url: `${origin}/notices?prefill=1`, taskPermissions: deriveTaskPermissions('공지 작성 기능을 확인해 주세요.') });
    const unverifiedView = await session.observe();
    const unverifiedAction = { action: 'submit', element_id: find(unverifiedView, '등록', 'submit') };
    const unverifiedOutcome = await session.act(unverifiedAction);
    assert.equal(unverifiedOutcome.submission?.status, 'unverified', JSON.stringify(unverifiedOutcome));
    assert.equal(unverifiedOutcome.submission?.httpStatus, 201);
    await assert.rejects(session.act(unverifiedAction), SitePolicyError);
    assert.equal(stats.posts.length, 3, 'A 2xx response without visible registration evidence must not cause resubmission.');
    await session.close(); session = undefined;
    results.unverifiedSubmission = { requestCount: 1, httpSuccessAloneIsInsufficient: true, resubmissionBlocked: true };
    return { passed: true, ...results, paidApiCalls: 0, userAccountsUsed: 0, sourceSiteModified: false };
  } finally { await session?.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
}

module.exports = { main };
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
