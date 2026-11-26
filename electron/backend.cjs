'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { normalizeHttpUrl } = require('./edge.cjs');
const { createBackendSettings, BACKEND_DEFAULT_MODELS, BACKEND_KEY_NAMES, validateBackendProvider, validateBackendModel } = require('./backend-settings.cjs');
const { validateBackendRunOptions, backendExecutionParameters, backendCliArguments, validateBackendLoginUrl } = require('./backend-run-options.cjs');
const { validateCredentials, createSecretRedactor } = require('./login-secrets.cjs');

// Compatibility for report/2 histories created before per-backend configuration.
const FIXED_MODELS = BACKEND_DEFAULT_MODELS.anthropic;
const BUDGET_MODELS = Object.freeze({
  openai: ['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'],
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
});
const MAX_REPORT_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHASES = new Set(['starting', 'mapping', 'exploring', 'executing', 'judging', 'reporting']);
const ACTIONS = new Set(['navigate', 'snapshot', 'click', 'fill', 'select', 'press', 'inspect', 'plan']);
const ENV_ALLOWLIST = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'home', 'lang', 'lc_all', 'tz']);
const executeFile = promisify(execFile);

function abortError() { return new DOMException('백엔드 검사를 중지했습니다.', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

/** Never inherit Computer Use provider settings, Node injection flags, or unrelated account secrets. */
function backendEnvironment(environment, backendRoot, configuration) {
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    if (ENV_ALLOWLIST.has(name.toLowerCase()) && typeof value === 'string') result[name] = value;
  }
  const keyName = BACKEND_KEY_NAMES[configuration?.provider ?? 'anthropic'];
  const key = configuration ? configuration.apiKey : environment[keyName];
  if (typeof key === 'string' && key.trim()) result[keyName] = key.trim();
  result.PLAYWRIGHT_BROWSERS_PATH = environment.PLAYWRIGHT_BROWSERS_PATH || path.join(backendRoot, '.browsers');
  return result;
}

function configurationSnapshot(value, requireSupported = false) {
  const provider = validateBackendProvider(value?.provider);
  const models = { plan: validateBackendModel(value?.models?.plan), triage: validateBackendModel(value?.models?.triage) };
  if (requireSupported && Object.values(models).some(model => !BUDGET_MODELS[provider].includes(model))) {
    throw new Error('선택한 백엔드 제공자의 비용 계산을 지원하는 모델을 선택해 주세요. 실제 검사 백엔드 설정의 모델 목록에서 계획·분류 모델을 지정하면 됩니다.');
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') throw new Error('백엔드 전용 API 키 형식이 올바르지 않습니다.');
  return Object.freeze({ provider, models: Object.freeze(models), apiKey: value.apiKey?.trim() ?? '' });
}

/** Telemetry is a constrained observation channel, never an instruction or a page-content channel. */
function safeProgress(message, origin, lastSequence) {
  if (!message || message.type !== 'backend-progress' || !PHASES.has(message.phase)
    || !Number.isSafeInteger(message.sequence) || message.sequence <= lastSequence) return undefined;
  const event = { type: 'backend-progress', phase: message.phase, sequence: message.sequence };
  if (ACTIONS.has(message.action)) event.action = message.action;
  if (typeof message.url === 'string' && message.url.length <= 8192) {
    try {
      const url = new URL(message.url);
      if (url.origin === origin && !url.username && !url.password && !/[\u0000-\u001f\u007f]/.test(message.url)) {
        // Query strings and fragments can contain session tokens, passwords, or user input.
        url.search = '';
        url.hash = /^#!?\/(?!\/)[^?&#]*$/.test(url.hash) ? url.hash : '';
        event.url = url.href;
      }
    } catch { /* An invalid URL must not change the visual browser's destination. */ }
  }
  return event;
}

async function readBoundedFile(filename, maximum) {
  const entry = await fsp.lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > maximum) throw new Error('invalid artifact');
  const handle = await fsp.open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== entry.size) throw new Error('changed artifact');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('short artifact');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('changed artifact');
    return buffer;
  } finally { await handle.close(); }
}

async function validateResult(runDir, targetUrl, configuration = { provider: 'anthropic', models: FIXED_MODELS }, allowLegacyProvider = true, expectedParameters) {
  try {
    const expected = configurationSnapshot(configuration);
    const folder = await fsp.lstat(runDir);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('invalid result directory');
    const reportPath = path.join(runDir, 'report.json');
    const pdfPath = path.join(runDir, 'report.pdf');
    const reportBytes = await readBoundedFile(reportPath, MAX_JSON_BYTES);
    const report = JSON.parse(reportBytes.toString('utf8'));
    if (report.version !== 'report/2' || report.run?.startUrl !== targetUrl
      || !['completed', 'incomplete'].includes(report.run?.endReason)
      || report.run?.verdicts?.stage !== 'done'
      || report.run?.models?.plan !== expected.models.plan || report.run?.models?.triage !== expected.models.triage
      || (report.run?.provider ?? (allowLegacyProvider ? 'anthropic' : undefined)) !== expected.provider
      || !Array.isArray(report.run?.incompleteReasons)) throw new Error('invalid report contract');
    if (expectedParameters && (!report.run.parameters || typeof report.run.parameters !== 'object'
      || Object.keys(report.run.parameters).length !== Object.keys(expectedParameters).length
      || Object.entries(expectedParameters).some(([key, value]) => report.run.parameters[key] !== value))) throw new Error('backend parameters mismatch');
    const pdf = await readBoundedFile(pdfPath, MAX_REPORT_BYTES);
    if (pdf.length < 5 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('invalid PDF');
    return { pdfPath, reportPath, provider: expected.provider, models: { ...expected.models }, ...(expectedParameters ? { parameters: { ...expectedParameters } } : {}), completed: report.run.endReason === 'completed',
      reportSha256: createHash('sha256').update(reportBytes).digest('hex'), pdfSha256: createHash('sha256').update(pdf).digest('hex'),
      // Raw backend diagnostics can include page material; expose a count, not their contents.
      incompleteReasons: report.run.endReason === 'incomplete'
        ? [`백엔드 보고서에 미완료 사유 ${report.run.incompleteReasons.length}건이 기록되어 있습니다.`] : [] };
  } catch {
    throw new Error('이번 백엔드 실행의 판정 결과 또는 PDF 보고서를 확인하지 못했습니다. 이전 보고서는 첨부하지 않습니다.');
  }
}

const BROWSER_PROBE = `
const { createRequire } = require('node:module');
const path = require('node:path');
const root = process.argv[1];
const req = createRequire(path.join(root, 'package.json'));
(async () => { const browser = await req('playwright').chromium.launch({ headless: true }); await browser.close(); })().catch(() => { process.exitCode = 1; });
`;

/** Only explicit backend run options may override its dedicated profile; visual model keys stay excluded. */
function createBackendRunner({ backendRoot, runsDirectory, nodePath = 'node', environment = process.env,
  getConfiguration, spawnImpl = spawn, execFileImpl = executeFile, platform = process.platform, killTimeoutMs = 10000 } = {}) {
  if (!path.isAbsolute(backendRoot || '') || !path.isAbsolute(runsDirectory || '')) throw new Error('백엔드와 실행 결과 폴더에는 절대 경로가 필요합니다.');
  const entrypoint = path.join(backendRoot, 'qa', 'src', 'cli.ts');
  if (getConfiguration !== undefined && typeof getConfiguration !== 'function') throw new Error('백엔드 전용 설정 저장소를 확인할 수 없습니다.');
  const settings = getConfiguration ? undefined : createBackendSettings({ backendRoot, environment });
  const readConfiguration = options => {
    const saved = getConfiguration ? getConfiguration(options.provider) : settings.resolveConfig(options.provider);
    if (options.provider && saved.provider !== options.provider) throw new Error('선택한 백엔드 제공자의 전용 키 설정을 불러오지 못했습니다.');
    return configurationSnapshot({ ...saved, ...(options.models ? { models: options.models } : {}) }, true);
  };
  const runtimeEnv = () => backendEnvironment(environment, backendRoot, { provider: 'anthropic', apiKey: '' });
  let installation;

  async function checkInstallation(configuration) {
    if (!configuration.apiKey) {
      throw new Error(`실제 검사 백엔드의 전용 ${BACKEND_KEY_NAMES[configuration.provider]}가 없습니다. 실제 검사 백엔드 설정에서 전용 키를 저장하거나 webtestpilot-backend/.env 또는 별도 환경변수에 설정해 주세요. Computer Use 화면 표현용 GPT·Claude의 키와 모델은 백엔드에 사용하지 않습니다.`);
    }
    if (!installation) installation = (async () => {
      const required = [entrypoint, path.join(backendRoot, 'node_modules', 'playwright', 'package.json'),
        path.join(backendRoot, 'node_modules', '@playwright', 'test', 'package.json'),
        path.join(backendRoot, 'qa', 'node_modules', '@anthropic-ai', 'sdk', 'package.json'),
        path.join(backendRoot, 'qa', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')];
      if (required.some(file => !fs.existsSync(file))) {
        throw new Error('백엔드 실행 패키지가 준비되지 않았습니다. 프로젝트 루트에서 npm run setup:backend를 실행해 주세요.');
      }
      let version;
      try { version = await execFileImpl(nodePath, ['--version'], { env: runtimeEnv(), windowsHide: true, shell: false, timeout: 10000, maxBuffer: 4096 }); }
      catch { throw new Error('백엔드용 Node.js 24 이상을 실행할 수 없습니다. npm run setup:backend로 실행 환경을 준비해 주세요.'); }
      if (Number(/^v(\d+)\./.exec(String(version.stdout).trim())?.[1]) < 24 || !/^v\d+\./.test(String(version.stdout).trim())) {
        throw new Error('백엔드에는 Node.js 24 이상이 필요합니다. npm run setup:backend로 실행 환경을 준비해 주세요.');
      }
      try {
        await execFileImpl(nodePath, ['-e', BROWSER_PROBE, backendRoot], { cwd: backendRoot, env: runtimeEnv(), windowsHide: true, shell: false, timeout: 20000, maxBuffer: 4096 });
      } catch { throw new Error('백엔드 Chromium을 실행할 수 없습니다. npm run setup:backend로 브라우저를 준비해 주세요.'); }
    })().catch(error => { installation = undefined; throw error; });
    await installation;
  }

  async function preflight(backendOptions) { await checkInstallation(readConfiguration(validateBackendRunOptions(backendOptions))); }

  async function run({ targetUrl, task = '', backendOptions, credentials: requestedCredentials, backendLoginUrl: requestedLoginUrl, signal, onProgress = () => {} }) {
    checkAbort(signal);
    const url = normalizeHttpUrl(targetUrl);
    if (new URL(url).username || new URL(url).password) throw new Error('주소에 로그인 계정을 포함할 수 없습니다.');
    if (typeof task !== 'string' || task.length > 32000) throw new Error('백엔드 검사 요청은 32,000자 이하의 텍스트여야 합니다.');
    const credentials = validateCredentials(requestedCredentials);
    const loginUrl = validateBackendLoginUrl(requestedLoginUrl, url, credentials);
    const redact = createSecretRedactor(credentials);
    task = redact(task);
    // Capture the dedicated key once. Changing settings during runtime probes
    // cannot change the credentials of an already started inspection.
    const options = validateBackendRunOptions(backendOptions);
    const parameters = backendExecutionParameters(options);
    const configuration = readConfiguration(options);
    const runEnvironment = backendEnvironment(environment, backendRoot, configuration);
    if (credentials) {
      runEnvironment.WEBPILOT_LOGIN_USERNAME = credentials.username;
      runEnvironment.WEBPILOT_LOGIN_PASSWORD = credentials.password;
    }
    await checkInstallation(configuration);
    checkAbort(signal);
    const runId = randomUUID();
    await fsp.mkdir(runsDirectory, { recursive: true });
    const rootStat = await fsp.lstat(runsDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('백엔드 결과 저장 폴더를 확인할 수 없습니다.');
    const runDir = path.join(runsDirectory, runId);
    const requirementFile = path.join(runsDirectory, `${runId}.requirements.json`);
    const loginFile = credentials ? path.join(runsDirectory, `${runId}.app.json`) : undefined;
    let requirementCreated = false;
    let loginCreated = false;
    const cleanupInputs = async () => {
      if (requirementCreated) await fsp.unlink(requirementFile).catch(() => {});
      if (loginCreated) await fsp.unlink(loginFile).catch(() => {});
    };
    try {
      await fsp.writeFile(requirementFile, JSON.stringify(task.trim() ? [{ id: 'R1', text: task.trim() }] : []), { flag: 'wx', mode: 0o600 });
      requirementCreated = true;
      if (loginFile) {
        await fsp.writeFile(loginFile, JSON.stringify({ deny: ['/logout', '/signout', '/sign-out', '/log-out'], login: { url: loginUrl, auto: true,
          env: { username: 'WEBPILOT_LOGIN_USERNAME', password: 'WEBPILOT_LOGIN_PASSWORD' } } }), { flag: 'wx', mode: 0o600 });
        loginCreated = true;
      }
    }
    catch (error) {
      if (error.code !== 'EEXIST') {
        if (!requirementCreated) await fsp.unlink(requirementFile).catch(() => {});
        else if (loginFile) await fsp.unlink(loginFile).catch(() => {});
      }
      await cleanupInputs();
      throw new Error('백엔드 검사 요청을 저장하지 못했습니다. 저장 공간을 확인해 주세요.');
    }
    const args = [entrypoint, '--url', url, '--desktop-events', '--provider', configuration.provider,
      '--plan-model', configuration.models.plan, '--triage-model', configuration.models.triage,
      '--output-dir', runDir, '--requirements', requirementFile, ...(loginFile ? ['--app', loginFile] : []), ...backendCliArguments(options)];
    let child;
    let resultMessage;
    let sequence = 0;
    let cancelPromise;
    let closeResult;
    let spawnFailure = false;
    let treeKillFailed = false;
    let childClosed = false;
    let closeWatchdog;
    const closed = new Promise(resolve => { closeResult = resolve; });
    try {
      checkAbort(signal);
      child = spawnImpl(nodePath, args, { cwd: path.join(backendRoot, 'qa'), env: runEnvironment, shell: false, windowsHide: true,
        detached: platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    } catch (error) {
      await cleanupInputs();
      checkAbort(signal);
      throw new Error('백엔드 프로세스를 시작하지 못했습니다. 실행 환경을 확인해 주세요.');
    }
    child.once('error', () => {
      spawnFailure = true;
      if (!child.pid) { childClosed = true; closeResult({ code: null }); }
      else cancelPromise ??= stopTree();
    });
    child.once('close', (code, processSignal) => {
      childClosed = true;
      clearTimeout(closeWatchdog);
      closeResult({ code, signal: processSignal });
    });
    child.on('message', message => {
      if (signal?.aborted) return;
      const progress = safeProgress(message, new URL(url).origin, sequence);
      if (progress) {
        if (progress.url && redact(progress.url) !== progress.url) delete progress.url;
        sequence = progress.sequence;
        try { onProgress(progress); } catch { /* A closed visual consumer must not alter the real inspection. */ }
      } else if (message?.type === 'backend-result' && message.runDir === runDir && typeof message.pdf === 'boolean') {
        resultMessage = { pdf: message.pdf };
      }
    });

    async function stopTree() {
      if (childClosed || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
      if (platform === 'win32') {
        const systemRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
        const taskkill = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
        try { await execFileImpl(taskkill, ['/PID', String(child.pid), '/T', '/F'], { env: runtimeEnv(), windowsHide: true, shell: false, timeout: killTimeoutMs, maxBuffer: 4096 }); }
        catch { treeKillFailed = true; try { child.kill('SIGKILL'); } catch { /* May have already exited. */ } }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* May have already exited. */ } }
      }
      // If process termination cannot be observed, report the uncertainty instead of blocking app shutdown forever.
      if (!childClosed) closeWatchdog = setTimeout(() => closeResult({ code: null, terminationTimedOut: true }), killTimeoutMs);
    }
    const cancel = () => { cancelPromise ??= stopTree(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const status = await closed;
      if (cancelPromise) await cancelPromise;
      if (treeKillFailed || status.terminationTimedOut) {
        const error = new Error('백엔드 하위 프로세스의 종료를 모두 확인하지 못했습니다. 실행 중인 백엔드 브라우저를 확인해 주세요.');
        error.name = 'BackendTerminationError';
        throw error;
      }
      checkAbort(signal);
      if (spawnFailure) throw new Error('백엔드 프로세스를 시작하지 못했습니다. 실행 환경을 확인해 주세요.');
      if (status.code !== 0) throw new Error('실제 백엔드 검사가 오류로 종료되었습니다. 이번 실행의 보고서는 완료 처리하지 않습니다.');
      if (!resultMessage?.pdf) throw new Error('백엔드 검사는 종료되었지만 이번 실행의 PDF 생성이 확인되지 않았습니다.');
      const report = await validateResult(runDir, url, configuration, false, parameters);
      checkAbort(signal);
      const marker = path.join(runDir, '.desktop-result.json');
      const temporary = path.join(runDir, '.desktop-result.json.part');
      let committed = false;
      try {
        await fsp.writeFile(temporary, JSON.stringify({ version: 3, runId, targetUrl: url, completed: report.completed,
          provider: configuration.provider, models: configuration.models, parameters,
          reportSha256: report.reportSha256, pdfSha256: report.pdfSha256 }), { flag: 'wx', mode: 0o600 });
        checkAbort(signal);
        await fsp.rename(temporary, marker);
        committed = true;
        checkAbort(signal);
      } catch (error) {
        await fsp.unlink(temporary).catch(() => {});
        if (committed) await fsp.unlink(marker).catch(() => {});
        throw error;
      }
      return { runId, runDir, ...report };
    } finally {
      clearTimeout(closeWatchdog);
      signal?.removeEventListener('abort', cancel);
      // Requirements are frozen by the backend; login setup contains environment names only.
      await cleanupInputs();
    }
  }

  async function readResult(runId) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('올바른 백엔드 실행 ID가 필요합니다.');
    const runDir = path.join(runsDirectory, runId);
    try {
      const root = await fsp.lstat(runsDirectory);
      const folder = await fsp.lstat(runDir);
      if (!root.isDirectory() || root.isSymbolicLink() || !folder.isDirectory() || folder.isSymbolicLink()) throw new Error('invalid run folder');
      const marker = JSON.parse((await readBoundedFile(path.join(runDir, '.desktop-result.json'), 4096)).toString('utf8'));
      if (![1, 2, 3].includes(marker.version) || marker.runId !== runId || typeof marker.completed !== 'boolean'
        || normalizeHttpUrl(marker.targetUrl) !== marker.targetUrl) throw new Error('invalid completion marker');
      const expected = marker.version === 1 ? { provider: 'anthropic', models: FIXED_MODELS } : configurationSnapshot(marker);
      const parameters = marker.version === 3 ? backendExecutionParameters(marker.parameters) : undefined;
      if (marker.version === 3 && (!marker.parameters || Object.keys(marker.parameters).length !== Object.keys(parameters).length
        || Object.entries(parameters).some(([key, value]) => marker.parameters[key] !== value))) throw new Error('invalid parameter marker');
      const report = await validateResult(runDir, marker.targetUrl, expected, marker.version === 1, parameters);
      if (report.completed !== marker.completed || report.reportSha256 !== marker.reportSha256 || report.pdfSha256 !== marker.pdfSha256) throw new Error('changed completed result');
      return { runId, runDir, ...report };
    } catch { throw new Error('해당 실행에서 확인된 백엔드 보고서를 찾을 수 없습니다. 새 검사를 시작해 주세요.'); }
  }

  return { preflight, run, readResult };
}

module.exports = { createBackendRunner, backendEnvironment, configurationSnapshot, safeProgress, validateResult, FIXED_MODELS };
