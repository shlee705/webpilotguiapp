'use strict';

// Read-only UI check of the user-specified local site. No API calls, supplied
// credentials, login submissions or changes to the site's source/data.
const assert = require('node:assert/strict');
const { runSiteAgent } = require('../electron/site-agent.cjs');

async function main() {
  const targetUrl = 'http://127.0.0.1:5173/';
  const signal = AbortSignal.timeout(90000);
  const steps = [];
  const result = await runSiteAgent({
    apiKey: 'mock-local-check', model: 'gpt-6-luna', targetUrl, maxActions: 3, signal,
    messages: [{ role: 'user', content: `${targetUrl}에서 로그인 화면을 먼저 확인한 후 학과소개 메뉴를 확인해 줘.` }],
    onEvent() {}, onUsage() {},
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const content = body.input.at(-1).content;
      const view = JSON.parse(content.split('\nCurrent page: ')[1].split('\nRecent outcomes: ')[0]);
      const index = steps.length;
      assert.ok(index < 3, 'There must be no model request after three actions');
      assert.match(content, new RegExp(`Actions remaining: ${3 - index}(?:\\n|$)`));
      assert.equal(view.credentialsAvailable, false);
      assert.equal(view.loginAvailable, false);
      const pattern = index === 0 ? /^로그인$/ : index === 1 ? /창\s*닫기/ : /^학과소개$/;
      if (index === 1) {
        assert.equal(view.loginFormVisible, true, 'Native observation must detect the login modal without credentials');
        assert.equal(view.elements.some(item => /^(관리자|학생)\s+\S+\s*\/\s*\S+$/.test(item.label)), false, 'Sample account helpers must not be actionable');
      }
      const target = view.elements.find(item => pattern.test(item.label));
      assert.ok(target, `Expected visible control ${pattern}`);
      steps.push({ action: 'click', target: target.label, loginFormVisible: view.loginFormVisible });
      const action = { action: 'click', element_id: target.id, text: '', scroll_y: 0, reason: '사용자가 지정한 화면을 순서대로 확인합니다.' };
      return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(action) }] }], usage: { input_tokens: 0, output_tokens: 0 } }) };
    },
  });
  assert.equal(result.actionCount, 3);
  assert.equal(result.observations.filter(item => !item.blocked).length, 3);
  assert.match(result.summary, /제공된 계정이 없어/);
  assert.equal(result.report, undefined);
  console.log(JSON.stringify({ ok: true, targetUrl, steps, actionCount: result.actionCount, apiCalls: 0, credentialsSupplied: false, loginSubmitted: false }, null, 2));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
