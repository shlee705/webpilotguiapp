'use strict';

// Exercises the real Electron main/preload IPC with an isolated profile. It never
// starts a live inspector or calls a model. Reports below are explicit fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { _electron } = require('playwright');

const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixturePdf() {
  const stream = 'BT /F1 12 Tf 20 120 Td (IPC fixture - no live inspection) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function makeRunFixture(profile, models) {
  const runId = randomUUID();
  const targetUrl = 'http://127.0.0.1:9/fixture-never-visited';
  const runDir = path.join(profile, 'backend-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const report = Buffer.from(JSON.stringify({ version: 'report/2', run: { startUrl: targetUrl, models,
    endReason: 'completed', verdicts: { stage: 'done', later: [] }, incompleteReasons: [] } }));
  const pdf = fixturePdf();
  fs.writeFileSync(path.join(runDir, 'report.json'), report);
  fs.writeFileSync(path.join(runDir, 'report.pdf'), pdf);
  fs.writeFileSync(path.join(runDir, '.desktop-result.json'), JSON.stringify({ version: 1, runId, targetUrl,
    completed: true, reportSha256: hash(report), pdfSha256: hash(pdf) }));
  return { runId, runDir, pdf };
}

async function main() {
  const flags = process.argv.slice(2);
  assert.ok(flags.every(flag => flag === '--packaged'), 'Supported option: --packaged');
  const packaged = flags.includes('--packaged');
  const executable = packaged ? process.env.WEBPILOT_EXECUTABLE || path.join(project, 'release', version, 'win-unpacked', 'WebPilot.exe') : undefined;
  if (executable) assert.ok(fs.existsSync(executable), `Build release/${version} before running --packaged.`);
  else assert.ok(fs.existsSync(path.join(project, 'dist', 'index.html')), 'Run npm run build before this smoke.');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-backend-smoke-'));
  const sourceReport = path.join(project, 'testReport', 'report.pdf');
  const originalReport = fs.existsSync(sourceReport) ? { hash: hash(fs.readFileSync(sourceReport)), mtime: fs.statSync(sourceReport).mtimeMs } : undefined;
  const environment = { ...process.env, ELECTRON_DEV: '0' };
  for (const name of Object.keys(environment)) {
    if (['ELECTRON_RUN_AS_NODE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS'].includes(name.toUpperCase())) delete environment[name];
  }
  let desktop;
  try {
    desktop = await _electron.launch({ ...(executable ? { executablePath: executable } : {}),
      args: [...(executable ? [] : [project]), `--user-data-dir=${profile}`, '--disable-background-networking'], env: environment,
    });
    const page = await desktop.firstWindow();
    await page.waitForSelector('#root > *');
    const configuration = await desktop.evaluate(({ app, session }) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
      const fs = require('node:fs');
      const path = require('node:path');
      const { resolveBackendPaths } = require(path.join(app.getAppPath(), 'electron', 'backend-paths.cjs'));
      const { FIXED_MODELS } = require(path.join(app.getAppPath(), 'electron', 'backend.cjs'));
      const { backendRoot, nodePath: runtime } = resolveBackendPaths({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged });
      // Existing backend credentials belong to the user. If a backend .env
      // exists, skip every start request; never turn a smoke into a live run.
      const hasBackendEnvFile = fs.existsSync(path.join(backendRoot, '.env'));
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
      return { profile: app.getPath('userData'), packaged: app.isPackaged, resourcesPath: process.resourcesPath, backendRoot, runtime, hasBackendEnvFile,
        backendEntryExists: fs.existsSync(path.join(backendRoot, 'qa', 'src', 'cli.ts')),
        runtimeExists: fs.existsSync(runtime), fixedModels: FIXED_MODELS, version: app.getVersion() };
    });
    assert.equal(path.resolve(configuration.profile).toLowerCase(), path.resolve(profile).toLowerCase());
    assert.equal(configuration.packaged, packaged);
    assert.equal(configuration.version, version);
    assert.equal(configuration.backendEntryExists, true);
    assert.equal(configuration.runtimeExists, true);
    assert.deepEqual(configuration.fixedModels, { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' });
    if (packaged) {
      assert.equal(configuration.backendRoot, path.join(configuration.resourcesPath, 'webtestpilot-backend'));
      assert.equal(configuration.runtime, path.join(configuration.resourcesPath, 'backend-runtime', 'node.exe'));
    }
    let bundledRuntimeVerified = false;
    if (packaged) {
      // Exercise the same bundled backend selected by the packaged app.
      const bundled = await desktop.evaluate(({ app }) => {
        const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`);
        const fs = require('node:fs');
        const path = require('node:path');
        const { execFileSync } = require('node:child_process');
        const root = path.join(process.resourcesPath, 'webtestpilot-backend');
        const runtime = path.join(process.resourcesPath, 'backend-runtime', 'node.exe');
        const excluded = ['.env', 'qa/runs', 'eval', 'qa/test', 'docs', '.claude'];
        if (excluded.some(relative => fs.existsSync(path.join(root, relative)))) throw new Error('Packaged resources contain excluded local files.');
        for (const relative of ['qa/src/cli.ts', 'qa/src/progress.ts', 'qa/src/providers.ts', 'qa/prompts/explore.md', 'qa/prompts/triage.md',
          'node_modules/playwright/package.json', 'node_modules/playwright-core/package.json', 'node_modules/@playwright/test/package.json',
          'qa/node_modules/@anthropic-ai/sdk/package.json', 'qa/node_modules/@modelcontextprotocol/sdk/package.json']) {
          if (!fs.existsSync(path.join(root, relative))) throw new Error('Packaged backend source is incomplete.');
        }
        const probe = `const path=require('node:path'); const {createRequire}=require('node:module'); const root=process.argv[1];
          const rootRequire=createRequire(path.join(root,'package.json')), qaRequire=createRequire(path.join(root,'qa','package.json'));
          const expected=rootRequire('./package.json').devDependencies['@playwright/test'];
          for(const name of ['playwright','playwright-core','@playwright/test']) {
            const resolved=rootRequire.resolve(name+'/package.json');
            if(!resolved.startsWith(root+path.sep)||rootRequire(name+'/package.json').version!==expected)throw Error('Bundled Playwright dependency mismatch');
          }
          qaRequire('@anthropic-ai/sdk'); qaRequire('@modelcontextprotocol/sdk/server/mcp.js');
          (async()=>{
          const {pathToFileURL}=require('node:url');
          const {createProviderSend}=await import(pathToFileURL(path.join(root,'qa/src/providers.ts')).href);
          const {runAgent,Budget}=await import(pathToFileURL(path.join(root,'qa/src/agent.ts')).href);
          let selected=0,executed=0;
          const send=createProviderSend({provider:'openai',apiKey:'fixture-no-network-key',fetchImpl:async(url,options)=>{
            if(url!=='https://api.openai.com/v1/responses'||JSON.parse(options.body).model!=='gpt-6-luna')throw Error('Packaged GPT routing mismatch');
            selected++;return Response.json({id:'fixture',model:'gpt-6-luna',status:'completed',usage:{input_tokens:10,output_tokens:5},
              output:[{type:'function_call',status:'completed',call_id:'fixture-call',name:'finish_fixture',arguments:'{}'}]});}});
          const result=await runAgent({send,model:'gpt-6-luna',system:'fixture',user:'fixture',budget:new Budget(1),maxTurns:1,maxTokens:100,
            tools:[{def:{name:'finish_fixture',input_schema:{type:'object'}},run:async()=>{executed++;return{text:'fixture',done:{}};}}]});
          if(result.stop!=='done'||selected!==1||executed!==1)throw Error('Packaged GPT adapter did not execute its fixture tool exactly once');
          const browser=await rootRequire('playwright').chromium.launch({headless:true,timeout:15000}); await browser.close();
          console.log(JSON.stringify({node:process.versions.node,sdkLoaded:true,emptyBrowserLaunched:true,gptBackendAdapterVerified:true}));})().catch(error=>{console.error(String(error.message).slice(0,3000));process.exitCode=1});`;
        const environment = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.browsers') };
        delete environment.ELECTRON_RUN_AS_NODE;
        delete environment.NODE_OPTIONS;
        delete environment.ANTHROPIC_API_KEY;
        delete environment.OPENAI_API_KEY;
        return JSON.parse(execFileSync(runtime, ['-e', probe, root], { cwd: root, env: environment,
          windowsHide: true, shell: false, timeout: 25000, maxBuffer: 64 * 1024, encoding: 'utf8' }).trim());
      });
      assert.match(bundled.node, /^24\./);
      assert.equal(bundled.sdkLoaded, true);
      assert.equal(bundled.emptyBrowserLaunched, true);
      assert.equal(bundled.gptBackendAdapterVerified, true);
      bundledRuntimeVerified = true;
    }

    const backendBeforeVisual = await page.evaluate(() => window.pilotDesktop.getBackendSettings());
    if (!configuration.hasBackendEnvFile) {
      assert.equal(backendBeforeVisual.keyConfigured, false);
      assert.equal(backendBeforeVisual.profiles.openai.keyConfigured, false);
    }
    assert.equal(typeof backendBeforeVisual.profiles.openai.models.plan, 'string');
    const missingKeyChecks = await page.evaluate(async ({ mayStart }) => {
      const desktop = window.pilotDesktop;
      const events = [];
      const unsubscribe = desktop.onAiEvent(payload => events.push(payload));
      const results = [];
      try {
        const profiles = [{ provider: 'openai', model: 'gpt-6-luna' }, { provider: 'anthropic', model: 'claude-haiku-5-5' }];
        for (const [index, { provider, model }] of profiles.entries()) {
          const saved = await desktop.saveAiSettings({ provider, model, apiKey: `sk-smoke-${provider}-visual-only-never-network-${index}234` });
          const result = mayStart ? await desktop.startAiChat({ requestId: `missing-backend-key-${index}`, provider, model, targetUrl: 'http://127.0.0.1:9/never-visited',
            messages: [{ role: 'user', content: '무료 IPC 연결 확인. 실제 사이트나 API를 호출하지 않는다.' }] }) : { skipped: true };
          const after = await desktop.getAiSettings();
          results.push({ saved, after, result });
        }
      } finally { unsubscribe(); }
      return { results, events };
    }, { mayStart: !configuration.hasBackendEnvFile });
    for (const { saved, after, result } of missingKeyChecks.results) {
      if (configuration.hasBackendEnvFile) assert.equal(result.skipped, true);
      else { assert.equal(result.ok, false); assert.match(result.error, /ANTHROPIC_API_KEY|Anthropic/); }
      assert.equal(saved.keyConfigured, true);
      assert.deepEqual(after, saved, 'Backend preflight must not change the visual model, key or usage.');
      assert.equal(after.usage.requests, 0);
    }
    const profileSwitch = await page.evaluate(async () => {
      const desktop = window.pilotDesktop;
      const initial = await desktop.getAiSettings();
      const gpt = await desktop.saveAiSettings({ provider: 'openai' });
      const claude = await desktop.saveAiSettings({ provider: 'anthropic' });
      return { initial, gpt, claude };
    });
    assert.equal(profileSwitch.gpt.provider, 'openai');
    assert.equal(profileSwitch.gpt.model, 'gpt-6-luna');
    assert.equal(profileSwitch.claude.provider, 'anthropic');
    assert.equal(profileSwitch.claude.model, 'claude-haiku-5-5');
    assert.deepEqual(profileSwitch.gpt.profiles, profileSwitch.initial.profiles);
    assert.deepEqual(profileSwitch.claude.profiles, profileSwitch.initial.profiles);
    for (const provider of ['openai', 'anthropic']) assert.equal(profileSwitch.claude.profiles[provider].keyConfigured, true);
    assert.deepEqual(await page.evaluate(() => window.pilotDesktop.getBackendSettings()), backendBeforeVisual);
    assert.equal(JSON.stringify(profileSwitch).includes('visual-only-never-network'), false, 'Raw API keys must never cross the settings read IPC.');
    assert.equal(missingKeyChecks.events.some(({ event }) => event.type === 'report' || event.type === 'delta' || event.type === 'done' || event.type === 'browser'), false);
    assert.equal(fs.existsSync(path.join(profile, 'backend-runs')), false, 'Missing key must fail before staging or spawning a backend run.');

    for (const id of [randomUUID(), '../report.pdf', 'not-a-run']) {
      const result = await page.evaluate(runId => window.pilotDesktop.refreshReport(runId), id);
      assert.equal(result.status, 'error');
      assert.equal(result.id, undefined, 'Invalid run IDs must never fall back to the old root PDF.');
    }
    const fixture = makeRunFixture(profile, configuration.fixedModels);
    const attached = await page.evaluate(runId => window.pilotDesktop.refreshReport(runId), fixture.runId);
    assert.equal(attached.status, 'ready');
    assert.equal(attached.runId, fixture.runId);
    assert.equal(attached.inspectionCompleted, true);
    assert.equal(attached.size, fixture.pdf.length);
    const read = await page.evaluate(async id => {
      const result = await window.pilotDesktop.readReport(id);
      if (!result.ok) return result;
      const sum = await crypto.subtle.digest('SHA-256', result.data);
      return { ok: true, size: result.data.byteLength, hash: Array.from(new Uint8Array(sum), byte => byte.toString(16).padStart(2, '0')).join('') };
    }, attached.id);
    assert.deepEqual(read, { ok: true, size: fixture.pdf.length, hash: hash(fixture.pdf) });
    fs.appendFileSync(path.join(fixture.runDir, 'report.pdf'), '\nchanged fixture');
    const changed = await page.evaluate(runId => window.pilotDesktop.refreshReport(runId), fixture.runId);
    assert.equal(changed.status, 'error');
    assert.equal(changed.id, undefined);
    assert.equal(hash(fs.readFileSync(path.join(profile, 'reports', `${attached.id}.pdf`))), hash(fixture.pdf), 'Previously attached bytes must remain unchanged.');
    if (originalReport) {
      assert.equal(hash(fs.readFileSync(sourceReport)), originalReport.hash);
      assert.equal(fs.statSync(sourceReport).mtimeMs, originalReport.mtime);
    }
    console.log(JSON.stringify({ passed: true, packaged, version: configuration.version, isolatedProfile: true,
      mainPreloadIpc: true, missingBackendKeyRejected: configuration.hasBackendEnvFile ? 0 : 2, liveStartSkippedForExistingEnv: configuration.hasBackendEnvFile, visualSettingsUnchanged: true,
      providerSettingsPreserved: true, guiAnthropicKeyNotUsedByBackend: true,
      legacyDefaultBackendModels: configuration.fixedModels, backendGptSettingsAvailable: true, runtimeExists: true, backendEntryExists: true,
      bundledRuntimeVerified,
      invalidRunFallbackBlocked: true, fixtureReportAttached: true, fixturePdfBytesRead: true,
      changedFixtureRejected: true, originalReportUnchanged: true, liveInspections: 0, paidApiCalls: 0 }, null, 2));
  } finally {
    await desktop?.close().catch(() => {});
    const temporaryRoot = path.resolve(os.tmpdir());
    const resolvedProfile = path.resolve(profile);
    if (resolvedProfile.startsWith(temporaryRoot + path.sep) && path.basename(resolvedProfile).startsWith('webpilot-backend-smoke-')) {
      try { fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* A remaining OS lock can keep this isolated temporary profile. */ }
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { fixturePdf, makeRunFixture };
