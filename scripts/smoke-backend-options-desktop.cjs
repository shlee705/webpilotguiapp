'use strict';
// Real renderer -> preload -> main -> child-process arguments -> verified report.
// The child inspector and browser/model dependencies are explicit local fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { fixturePdf } = require('./smoke-backend-desktop.cjs');
const project = path.resolve(__dirname, '..');
const optionFlags = { budgetUsd: 'budget', exploreMinutes: 'explore-minutes', maxPages: 'max-pages', maxTemplates: 'max-templates',
  turnsPerTemplate: 'turns-per-template', maxTurns: 'max-turns', pagesPerTemplate: 'pages-per-template', concurrency: 'concurrency',
  workers: 'workers', planEffort: 'plan-effort', sessions: 'sessions' };

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-run-options-'));
  const appRoot = path.join(fixture, 'app'), backend = path.join(appRoot, 'webtestpilot-backend'), profile = path.join(fixture, 'profile');
  const write = (relative, content) => { const file = path.join(backend, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  write('package.json', '{"name":"backend-fixture","type":"commonjs"}');
  write('node_modules/playwright/package.json', '{"name":"playwright","main":"index.js"}');
  write('node_modules/playwright/index.js', 'exports.chromium={launch:async()=>({close:async()=>{}})};');
  for (const file of ['node_modules/@playwright/test/package.json', 'qa/node_modules/@anthropic-ai/sdk/package.json', 'qa/node_modules/@modelcontextprotocol/sdk/package.json']) write(file, '{}');
  write('qa/src/cli.ts', `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);const value=name=>args[args.indexOf('--'+name)+1];
const flags=${JSON.stringify(optionFlags)};const parameters=Object.fromEntries(Object.entries(flags).map(([key,flag])=>[key,['planEffort','sessions'].includes(key)?value(flag):Number(value(flag))]));
const out=value('output-dir');fs.mkdirSync(out,{recursive:true});
const requirements=JSON.parse(fs.readFileSync(value('requirements'),'utf8'));
const login=JSON.parse(fs.readFileSync(value('app'),'utf8')).login;
fs.writeFileSync(path.join(out,'captured.json'),JSON.stringify({parameters,requirements,provider:value('provider'),models:{plan:value('plan-model'),triage:value('triage-model')},
selectedBackendKey:process.env.OPENAI_API_KEY==='backend-openai-fixture-only',otherProviderKeyAbsent:!process.env.ANTHROPIC_API_KEY,
loginUrl:login.url,autoLogin:login.auto===true,credentialsInEnvironment:process.env[login.env.username]==='fixture-account@example.test'&&process.env[login.env.password]==='fixture-account-password',
credentialsAbsentFromArguments:!JSON.stringify(args).includes('fixture-account'),credentialsAbsentFromAppFile:!JSON.stringify(login).includes('fixture-account')}));
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({version:'report/2',run:{startUrl:value('url'),provider:value('provider'),models:{plan:value('plan-model'),triage:value('triage-model')},parameters,endReason:'completed',verdicts:{stage:'done',later:[]},incompleteReasons:[]}}));
fs.writeFileSync(path.join(out,'report.pdf'),Buffer.from('${fixturePdf().toString('base64')}','base64'));
process.send({type:'backend-progress',phase:'exploring',sequence:1,url:value('url'),action:'snapshot'},()=>
  process.send({type:'backend-progress',phase:'executing',sequence:2},()=>
    process.send({type:'backend-progress',phase:'executing',sequence:3,url:value('url'),action:'click'},()=>
      process.send({type:'backend-result',runDir:out,pdf:true},()=>process.disconnect()))));
`);
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'webpilot-desktop', version: require('../package.json').version, main: path.join(project, 'electron', 'main.cjs') }));
  const env = { ...process.env, ELECTRON_DEV: '0' };
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|OPENAI_API_KEY|ANTHROPIC_API_KEY|WEBPILOT_BACKEND_.*)$/i.test(key)) delete env[key];
  let desktop;
  try {
    desktop = await _electron.launch({ args: [appRoot, `--user-data-dir=${profile}`, '--disable-background-networking'], env });
    const page = await desktop.firstWindow(); await page.waitForSelector('#root > *');
    const actual = await desktop.evaluate(({ app, session }, source) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
      const require = process.getBuiltinModule('module').createRequire(`${source}/package.json`);
      require(`${source}/electron/site-agent.cjs`).runSiteAgent = async options => {
        const { signal, backendProgress } = options;
        const probe = globalThis.__visualFollowProbe = { receivedCount: Object.hasOwn(options, 'maxActions'), hasProgressFeed: !!backendProgress,
          nativeLoginConfigured: options.loginUrl === 'http://127.0.0.1:9/login'
            && options.credentials?.username === 'fixture-account@example.test' && options.credentials?.password === 'fixture-account-password' };
        try {
          while (!signal.aborted && !backendProgress.isFinished()) {
            const state = backendProgress.current();
            if (state) probe.phase = state.phase;
            await backendProgress.waitForChange(state?.sequence ?? 0, signal);
          }
        } finally {
          probe.phase = backendProgress.current()?.phase;
          probe.finished = backendProgress.isFinished(); probe.aborted = signal.aborted;
        }
      };
      return app.getAppPath();
    }, project);
    assert.equal(path.resolve(actual).toLowerCase(), path.resolve(appRoot).toLowerCase());
    const options = { provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6.1-terra' }, budgetUsd: 2.5, exploreMinutes: 3,
      maxPages: 7, maxTemplates: 2, turnsPerTemplate: 4, maxTurns: 6, pagesPerTemplate: 2, concurrency: 2, workers: 2, planEffort: 'low', sessions: 'cluster' };
    const task = '검색 폼의 빈 입력과 결과 페이지 이동을 확인한다.';
    const result = await page.evaluate(async ({ options, task }) => {
      const api = window.pilotDesktop;
      await api.saveAiSettings({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'visual-fixture-key-only' });
      await api.saveBackendSettings({ provider: 'openai', apiKey: 'backend-openai-fixture-only' });
      await api.saveBackendSettings({ provider: 'anthropic', apiKey: 'other-backend-fixture-key' });
      const events = []; const stop = api.onAiEvent(payload => events.push(payload.event));
      try {
        const response = await api.startAiChat({ requestId: 'options-fixture', provider: 'anthropic', model: 'claude-haiku-5-5',
          // Old clients may still send a quota. The native inspection must ignore it.
          targetUrl: 'http://127.0.0.1:9/fixture-never-visited', maxActions: 1, backendOptions: options, backendTask: task,
          backendLoginUrl: 'http://127.0.0.1:9/login', credentials: { username: 'fixture-account@example.test', password: 'fixture-account-password' },
          messages: [{ role: 'user', content: '화면 표현용 메시지는 검사 요구사항을 대체하지 않는다.' }] });
        return { response, events };
      } finally { stop(); }
    }, { options, task });
    assert.deepEqual(result.response, { ok: true });
    assert.deepEqual(await desktop.evaluate(() => globalThis.__visualFollowProbe), {
      receivedCount: false, hasProgressFeed: true, nativeLoginConfigured: true, phase: 'executing', finished: true, aborted: true,
    });
    const attached = result.events.find(event => event.type === 'report').report;
    assert.equal(attached.status, 'ready');
    const runDir = path.join(profile, 'backend-runs', attached.runId);
    const captured = JSON.parse(fs.readFileSync(path.join(runDir, 'captured.json'), 'utf8'));
    assert.deepEqual(captured.parameters, Object.fromEntries(Object.keys(optionFlags).map(key => [key, options[key]])));
    assert.deepEqual(captured.requirements, [{ id: 'R1', text: task }]);
    assert.equal(captured.provider, options.provider); assert.deepEqual(captured.models, options.models);
    assert.equal(captured.selectedBackendKey, true); assert.equal(captured.otherProviderKeyAbsent, true);
    assert.equal(captured.loginUrl, 'http://127.0.0.1:9/login');
    for (const field of ['autoLogin', 'credentialsInEnvironment', 'credentialsAbsentFromArguments', 'credentialsAbsentFromAppFile']) assert.equal(captured[field], true);
    assert.equal(fs.readdirSync(path.join(profile, 'backend-runs')).some(name => name.endsWith('.app.json')), false);
    assert.equal(fs.readFileSync(path.join(backend, '.env'), 'utf8').includes('fixture-account'), false);
    const restored = await page.evaluate(id => window.pilotDesktop.refreshReport(id), attached.runId);
    assert.equal(restored.status, 'ready');
    const reportPath = path.join(runDir, 'report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); report.run.parameters.maxPages++;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    assert.equal((await page.evaluate(id => window.pilotDesktop.refreshReport(id), attached.runId)).status, 'error');
    console.log(JSON.stringify({ passed: true, isolatedMainPreloadIpc: true, actualChildArgumentsVerified: true, exactRequirementsVerified: true,
      independentBackendProfileVerified: true, backendDrivenVisualLifecycleVerified: true, loginEnvironmentAndCleanupVerified: true, reportParametersVerified: true, changedReportRejected: true, paidApiCalls: 0, actualWorkspaceEnvTouched: false }, null, 2));
  } finally {
    await desktop?.close().catch(() => {});
    const resolved = path.resolve(fixture);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('webpilot-run-options-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
