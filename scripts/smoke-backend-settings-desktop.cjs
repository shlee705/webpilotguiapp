'use strict';
// Real Electron IPC, isolated application directory, fixture keys, no API calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { BACKEND_RUN_DEFAULTS } = require('../electron/backend-run-options.cjs');
const { BACKEND_RUN_DEFAULT_VARIABLES, parseBackendEnv } = require('../electron/backend-settings.cjs');
const project = path.resolve(__dirname, '..');
const runDefaults = { budgetUsd: 4.5, exploreMinutes: 18, maxPages: 21, maxTemplates: 6,
  turnsPerTemplate: 17, maxTurns: 46, pagesPerTemplate: 4, concurrency: 2, workers: 3,
  planEffort: 'high', sessions: 'cluster' };

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-role-settings-'));
  const appRoot = path.join(fixture, 'app');
  const backend = path.join(appRoot, 'webtestpilot-backend');
  const profile = path.join(fixture, 'profile');
  fs.mkdirSync(path.join(backend, 'qa', 'src'), { recursive: true });
  fs.writeFileSync(path.join(backend, 'qa', 'src', 'cli.ts'), '// Intentionally no executable backend in this settings fixture.\n');
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'webpilot-desktop', version: require('../package.json').version,
    main: path.join(project, 'electron', 'main.cjs') }));
  fs.writeFileSync(path.join(backend, '.env'), '# preserve this comment\nUNRELATED_SETTING=keep-me\n');
  const env = { ...process.env, ELECTRON_DEV: '0' };
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|OPENAI_API_KEY|ANTHROPIC_API_KEY|WEBPILOT_BACKEND_.*)$/i.test(key)) delete env[key];
  let desktop;
  try {
    desktop = await _electron.launch({ args: [appRoot, `--user-data-dir=${profile}`, '--disable-background-networking'], env });
    const page = await desktop.firstWindow();
    await page.waitForSelector('#root > *');
    const actual = await desktop.evaluate(({ app, session }) => {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
      return app.getAppPath();
    });
    assert.equal(path.resolve(actual).toLowerCase(), path.resolve(appRoot).toLowerCase());
    const visualResult = await page.evaluate(async () => {
      const api = window.pilotDesktop;
      const initial = await api.getBackendSettings();
      await api.saveAiSettings({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'visual-anthropic-fixture-only' });
      const visual = await api.getAiSettings();
      const afterVisual = await api.getBackendSettings();
      return { initial, visual, afterVisual };
    });
    const visualFilename = path.join(profile, 'ai-settings.json');
    const visualFileBefore = fs.readFileSync(visualFilename);
    const backendResult = await page.evaluate(async defaults => {
      const api = window.pilotDesktop;
      const gpt = await api.saveBackendSettings({ provider: 'openai', models: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' }, apiKey: 'backend-openai-fixture-only', runDefaults: defaults });
      const visualAfterGpt = await api.getAiSettings();
      const claude = await api.saveBackendSettings({ provider: 'anthropic', models: { plan: 'claude-sonnet-5-5', triage: 'claude-haiku-5-5' }, apiKey: 'backend-anthropic-fixture-only' });
      const visualAfterClaude = await api.getAiSettings();
      const restored = await api.saveBackendSettings({ provider: 'openai' });
      const reread = await api.getBackendSettings();
      return { gpt, visualAfterGpt, claude, visualAfterClaude, restored, reread };
    }, runDefaults);
    const result = { ...visualResult, ...backendResult };
    assert.equal(result.initial.keyConfigured, false);
    assert.deepEqual(result.initial.runDefaults, BACKEND_RUN_DEFAULTS);
    assert.deepEqual(result.afterVisual, result.initial, 'Visual Anthropic settings cannot configure the actual backend.');
    assert.deepEqual(result.visualAfterGpt, result.visual);
    assert.deepEqual(result.visualAfterClaude, result.visual);
    assert.equal(result.gpt.provider, 'openai');
    assert.deepEqual(result.gpt.models, { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' });
    assert.equal(result.gpt.source, 'file');
    assert.equal(result.restored.provider, 'openai');
    assert.deepEqual(result.restored.models, result.gpt.models);
    assert.equal(result.restored.profiles.anthropic.keyConfigured, true);
    for (const settings of [result.gpt, result.claude, result.restored, result.reread]) {
      assert.deepEqual(settings.runDefaults, runDefaults, 'All run defaults survive independent provider/key/model changes.');
    }
    assert.equal(JSON.stringify(result).includes('fixture-only'), false);
    const envText = fs.readFileSync(path.join(backend, '.env'), 'utf8');
    assert.match(envText, /OPENAI_API_KEY=backend-openai-fixture-only/);
    assert.match(envText, /ANTHROPIC_API_KEY=backend-anthropic-fixture-only/);
    assert.match(envText, /UNRELATED_SETTING=keep-me/);
    assert.match(envText, /# preserve this comment/);
    assert.equal(envText.includes('visual-anthropic'), false);
    const envValues = parseBackendEnv(envText);
    for (const [field, variable] of Object.entries(BACKEND_RUN_DEFAULT_VARIABLES)) assert.equal(envValues[variable], String(runDefaults[field]));
    assert.deepEqual(fs.readFileSync(visualFilename), visualFileBefore, 'Backend defaults cannot rewrite visual settings bytes.');
    assert.equal(fs.readFileSync(visualFilename, 'utf8').includes('backend-'), false);
    const deleted = await page.evaluate(() => window.pilotDesktop.saveBackendSettings({ provider: 'openai', forgetKey: true }));
    assert.equal(deleted.keyConfigured, false);
    assert.equal(deleted.profiles.anthropic.keyConfigured, true);
    assert.deepEqual(deleted.runDefaults, runDefaults);
    assert.equal(fs.readFileSync(path.join(backend, '.env'), 'utf8').includes('backend-openai-fixture-only'), false);
    assert.deepEqual(await page.evaluate(() => window.pilotDesktop.getAiSettings()), result.visual);
    assert.deepEqual(fs.readFileSync(visualFilename), visualFileBefore);
    const envAfterDelete = fs.readFileSync(path.join(backend, '.env'));
    await desktop.close();
    desktop = await _electron.launch({ args: [appRoot, `--user-data-dir=${profile}`, '--disable-background-networking'], env });
    const reopenedPage = await desktop.firstWindow();
    await reopenedPage.waitForSelector('#root > *');
    const reopened = await reopenedPage.evaluate(() => window.pilotDesktop.getBackendSettings());
    assert.deepEqual(reopened, deleted, 'Defaults and keys restore through real IPC after restarting Electron.');
    assert.deepEqual(fs.readFileSync(path.join(backend, '.env')), envAfterDelete, 'Reading defaults does not rewrite backend .env.');
    assert.deepEqual(fs.readFileSync(visualFilename), visualFileBefore, 'Restarting does not move backend defaults into visual settings.');
    console.log(JSON.stringify({ passed: true, isolatedMainPreloadIpc: true, backendEnvWritten: true, twoRolesSeparated: true,
      backendModelsEditable: true, backendProviderKeysPreserved: true, visualKeysNotCopied: true, unrelatedEnvPreserved: true,
      allRunDefaultsSaved: true, runDefaultsPreservedAcrossProviderAndKeyChanges: true, runDefaultsRestoredAfterRestart: true,
      visualSettingsBytesUnchanged: true,
      actualWorkspaceEnvTouched: false, paidApiCalls: 0 }, null, 2));
  } finally {
    await desktop?.close().catch(() => {});
    const resolved = path.resolve(fixture);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('webpilot-role-settings-')) {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
