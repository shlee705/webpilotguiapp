import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assertDesktopOptions, createProgressReporter, DESKTOP_MODELS, progressUrl, toolProgressAction, type BackendProgress, type BackendResult } from '../src/progress.ts';

test('데스크톱 이벤트는 같은 origin의 경로만 보내며 검색어·비밀 쿼리·userinfo는 보내지 않는다', () => {
  const origin = 'https://site.test';
  assert.equal(progressUrl(origin + '/board?token=secret&q=private#password', origin), origin + '/board');
  assert.equal(progressUrl(origin + '/app?session=secret#/posts/7?password=private', origin), origin + '/app#/posts/7');
  assert.equal(progressUrl(origin + '/app#!/posts?token=x', origin), origin + '/app#!/posts');
  assert.equal(progressUrl('https://user:password@site.test/private', origin), undefined);
  assert.equal(progressUrl('https://site.test:9443/private', origin), undefined);
  assert.equal(progressUrl('https://evil.test/path', origin), undefined);
  assert.equal(progressUrl('javascript:alert(1)', origin), undefined);
  assert.equal(progressUrl('not a URL', origin), undefined);
});

test('진행 sequence는 실행별로 증가하고 보고서 실패를 별도 사실로 전송한다', () => {
  const events: (BackendProgress | BackendResult)[] = [];
  const reporter = createProgressReporter('https://site.test/', event => events.push(event));
  reporter.progress('mapping', 'https://site.test/a?key=secret', 'navigate');
  reporter.progress('exploring', 'https://site.test/b', 'click');
  reporter.progress('judging', 'https://external.test/private');
  reporter.result(resolve('qa-run'), false);
  assert.deepEqual(events.slice(0, 3), [
    { type: 'backend-progress', phase: 'mapping', sequence: 1, url: 'https://site.test/a', action: 'navigate' },
    { type: 'backend-progress', phase: 'exploring', sequence: 2, url: 'https://site.test/b', action: 'click' },
    { type: 'backend-progress', phase: 'judging', sequence: 3 },
  ]);
  assert.deepEqual(events[3], { type: 'backend-result', runDir: resolve('qa-run'), pdf: false, pdfError: 'report-generation-failed' });
  assert.doesNotMatch(JSON.stringify(events), /secret|external|private/);
  assert.doesNotThrow(() => createProgressReporter('https://site.test/', () => { throw new Error('closed channel'); }).progress('exploring'));
});

test('데스크톱 실행은 백엔드 제공자별 모델만 허용하고 origin 확장·IPC 없는 실행을 거부한다', () => {
  const options = { enabled: true, hasIpc: true, outputDir: resolve('qa-run'), startUrl: 'https://site.test/', planModel: DESKTOP_MODELS.plan, triageModel: DESKTOP_MODELS.triage };
  assert.doesNotThrow(() => assertDesktopOptions(options));
  assert.throws(() => assertDesktopOptions({ ...options, planModel: 'gpt-6-luna' }), /제공자와 모델/);
  assert.throws(() => assertDesktopOptions({ ...options, triageModel: 'arbitrary-model' }), /제공자와 모델/);
  assert.doesNotThrow(() => assertDesktopOptions({ ...options, provider: 'openai', planModel: 'gpt-6.2-sol', triageModel: 'gpt-6-luna' }));
  assert.throws(() => assertDesktopOptions({ ...options, hasIpc: false }), /IPC/);
  assert.throws(() => assertDesktopOptions({ ...options, outputDir: 'relative-path' }), /절대 출력 경로/);
  assert.throws(() => assertDesktopOptions({ ...options, origins: 'https://site.test,https://other.test' }), /같은 origin/);
  assert.throws(() => assertDesktopOptions({ ...options, startUrl: 'file:///private' }), /HTTP/);
  assert.doesNotThrow(() => assertDesktopOptions({ ...options, enabled: false, hasIpc: false, outputDir: undefined, planModel: 'legacy-model' }));
});

test('표시 동작은 고정된 종류만 전달하며 원시 도구 이름이나 인자를 노출하지 않는다', () => {
  assert.equal(toolProgressAction('fill'), 'fill');
  assert.equal(toolProgressAction('restart'), 'navigate');
  assert.equal(toolProgressAction('screenshot'), 'inspect');
  assert.equal(toolProgressAction('private arbitrary text'), 'inspect');
});
