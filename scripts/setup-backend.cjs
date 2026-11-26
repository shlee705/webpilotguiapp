'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const backendRoot = path.join(workspace, 'webtestpilot-backend');
const browserDirectory = path.join(backendRoot, '.browsers');
const runtimeDirectory = path.join(workspace, 'artifacts', 'backend-runtime');
const runtimePath = path.join(runtimeDirectory, 'node.exe');

function dependenciesReady(directory) {
  try {
    const expected = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8')).packages;
    const installed = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', '.package-lock.json'), 'utf8')).packages;
    if (!expected || !installed) return false;
    return Object.entries(expected).every(([relative, entry]) => {
      if (!relative) return true;
      if (!relative.startsWith('node_modules/')) return false;
      const actual = installed[relative];
      if (!actual && entry.optional) return true;
      if (!actual || actual.version !== entry.version || actual.integrity !== entry.integrity) return false;
      const packageFile = path.join(directory, relative, 'package.json');
      return JSON.parse(fs.readFileSync(packageFile, 'utf8')).version === entry.version;
    });
  } catch { return false; }
}

function npmCliPath() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const found = candidates.find(value => value && path.basename(value) === 'npm-cli.js' && fs.existsSync(value));
  if (!found) throw new Error('npm CLI를 찾지 못했습니다. Node.js 24와 npm을 설치한 뒤 npm run backend:setup으로 실행해 주세요.');
  return found;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: workspace, stdio: 'inherit', shell: false, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error('백엔드 실행 환경 준비 명령이 실패했습니다. 위의 설치 오류를 확인해 주세요.');
}

function browserReady(environment) {
  const probe = "(async () => { const { chromium } = require(process.argv[1]); const browser = await chromium.launch({ headless: true }); await browser.close(); })().catch(() => { process.exitCode = 1; });";
  const result = spawnSync(process.execPath, ['-e', probe, path.join(backendRoot, 'node_modules', 'playwright')], {
    cwd: backendRoot, env: environment, stdio: 'pipe', timeout: 30000, shell: false, windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function digest(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }

function prepareBackend({ checkOnly = false } = {}) {
  if (process.platform !== 'win32') throw new Error('이 데스크톱 배포 준비는 Windows에서 실행해 주세요.');
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.versions.electron) throw new Error('백엔드 준비에는 일반 Node.js 24가 필요합니다.');
  for (const directory of [backendRoot, path.join(backendRoot, 'qa')]) {
    if (dependenciesReady(directory)) continue;
    if (checkOnly) throw new Error('백엔드 의존성이 준비되지 않았습니다. npm run backend:setup을 실행해 주세요.');
    console.log(`백엔드 의존성 설치: ${path.relative(workspace, directory)}`);
    run(process.execPath, [npmCliPath(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory });
    if (!dependenciesReady(directory)) throw new Error('백엔드 잠금 파일과 설치된 패키지가 일치하지 않습니다.');
  }

  const environment = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDirectory };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (!browserReady(environment)) {
    if (checkOnly) throw new Error('백엔드 Chromium이 준비되지 않았습니다. npm run backend:setup을 실행해 주세요.');
    console.log('백엔드 전용 Chromium을 준비합니다.');
    run(process.execPath, [path.join(backendRoot, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], { cwd: backendRoot, env: environment });
    if (!browserReady(environment)) throw new Error('설치한 백엔드 Chromium을 실행하지 못했습니다.');
  }

  const sourceHash = digest(process.execPath);
  const runtimeReady = fs.existsSync(runtimePath) && digest(runtimePath) === sourceHash;
  if (!runtimeReady) {
    if (checkOnly) throw new Error('배포용 Node.js가 준비되지 않았습니다. npm run backend:setup을 실행해 주세요.');
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    const temporary = path.join(runtimeDirectory, `node-${randomUUID()}.tmp`);
    try {
      fs.copyFileSync(process.execPath, temporary);
      fs.renameSync(temporary, runtimePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  console.log(`백엔드 실행 환경 확인 완료: Node.js ${process.versions.node}, 전용 Chromium, 잠금 파일 기준 의존성`);
  console.log('실제 사이트 검사나 유료 모델 API는 호출하지 않았습니다.');
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('지원 옵션: --check');
    prepareBackend({ checkOnly: process.argv.includes('--check') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { dependenciesReady, prepareBackend };
