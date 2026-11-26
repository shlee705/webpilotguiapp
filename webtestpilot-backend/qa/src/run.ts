// ③ 실행. 새 실행 폴더에 입력을 고정(복사·해시)하고, plan에서 만든 spec을 playwright test로 돌린 뒤 ledger를 plan과 대조한다.
// 실행 폴더는 덮어쓰지 않는다. AI는 이 단계에 없다.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Policy } from './browser.ts';
import type { StorageState } from './login.ts';
import { validate, type Plan } from './plan.ts';
import { specs } from './generate.ts';
import { reconcile, type Entry, type Reconciled } from './reconcile.ts';
import { hasPrivateValues, privateJson, privateText, privateWorkerEnvironment } from './privacy.ts';
import { createExecutionProgressReader, type ExecutionProgress } from './execution-progress.ts';

const SRC = dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_CLI = join(dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')), 'cli.js');
const PLAYWRIGHT_TEST = import.meta.resolve('@playwright/test');

export type RunResult = Reconciled & { runDir: string; exitCode: number | null };

/** runDir는 사용자 데이터 폴더에도 둘 수 있다. ESM 설정과 Playwright 의존성 경로를 실행 사본에 고정한다. */
/** only를 주면 그 시나리오만 실행한다 (재현용). 대조는 전체 plan으로 하므로 나머지는 not_run이다. */
/** workers: 동시에 실행할 시나리오 수(기본 1). 시나리오 하나의 단계는 늘 한 워커에서 차례로 돈다. */
/** storageState: 로그인 상태는 worker 전용 환경 JSON으로만 전달한다. 계정값을 담은 저장소도 파일로 만들지 않는다. */
/** hideEnv: 실행 프로세스에 넘기지 않을 환경 변수 이름(앱 설정의 계정 비밀값 변수 등). */
export async function runPlan(o: { plan: Plan; policy: Policy; runDir: string; timeoutMs?: number; only?: string[]; workers?: number; storageState?: StorageState; hideEnv?: string[]; onProgress?: (event: ExecutionProgress) => unknown }): Promise<RunResult> {
  // 실행 프로세스는 실행 폴더에서 돌므로 상대 경로면 폴더 경로가 두 번 붙는다. 처음에 절대 경로로 고정한다.
  o = { ...o, runDir: resolve(o.runDir) };
  if (existsSync(o.runDir)) throw new Error(`실행 폴더가 이미 있음 (덮어쓰지 않음): ${o.runDir}`);
  const errors = validate(o.plan, o.plan.requirements, new Map(Object.entries(o.plan.targets)), o.policy.origins, undefined, new Set(o.plan.startVerified ?? []));
  if (errors.length) throw new Error(`plan이 계약을 통과하지 못함:\n- ${errors.join('\n- ')}`);
  mkdirSync(join(o.runDir, 'specs'), { recursive: true });
  mkdirSync(join(o.runDir, 'src'));

  // 실행과 대조는 모두 이 시점에 직렬화한 사본만 쓴다. 호출자가 나중에 plan을 바꿔도 판정 기준은 바뀌지 않는다.
  const timeoutMs = o.timeoutMs ?? 5000;
  // 쓰기 허용 실행은 시나리오끼리 서버 상태(같은 계정의 글·장바구니)를 공유하므로 동시에 돌리지 않는다.
  const workers = o.policy.allowWrites ? 1 : Math.max(1, o.workers ?? 1);
  const files: Record<string, string> = {
    'plan.json': privateJson(o.plan, 2),
    'policy.json': JSON.stringify(o.policy, null, 2),
    'package.json': JSON.stringify({ private: true, type: 'module' }),
    'playwright.config.mjs': config(workers),
  };
  // 실행 헬퍼도 복사해서 그 사본을 실행한다. manifest의 해시가 실제로 실행된 코드의 해시가 된다.
  for (const f of RUNTIME_SOURCES) {
    const source = readFileSync(join(SRC, f), 'utf8');
    // 외부 출력 폴더에는 node_modules가 없다. 원본 설치에서 해석한 file URL을 써서 실행하며,
    // manifest에도 이 실제 실행 사본을 해시한다. symlink나 별도 패키지 설치는 만들지 않는다.
    files[`src/${f}`] = f === 'fixture.ts' ? source.replace("from '@playwright/test'", `from ${JSON.stringify(PLAYWRIGHT_TEST)}`) : source;
  }
  const frozen: Plan = JSON.parse(files['plan.json']);
  const selected = o.only ? { ...frozen, scenarios: frozen.scenarios.filter(s => o.only!.map(privateText).includes(s.id)) } : frozen;
  for (const [name, code] of Object.entries(specs(selected, '../src/fixture.ts'))) files[`specs/${name}`] = code;
  for (const [name, text] of Object.entries(files)) writeFileSync(join(o.runDir, name), text);

  const manifest = {
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])),
    timeoutMs, workers, loggedIn: !!o.storageState, node: process.version,
    playwright: JSON.parse(readFileSync(join(dirname(PLAYWRIGHT_CLI), 'package.json'), 'utf8')).version,
  };
  writeFileSync(join(o.runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 비동기로 실행한다. 같은 프로세스가 대상 서버를 띄운 경우 동기 실행은 그 서버를 막아 교착된다.
  const progress = typeof o.onProgress === 'function' ? createExecutionProgressReader(o.runDir, o.policy.origins, o.onProgress) : undefined;
  let exitCode: number | null;
  try { exitCode = await new Promise<number | null>(resolve => {
    const privateEnv = privateWorkerEnvironment();
    if (Object.values(privateEnv).some(v => v.length > 24000) || JSON.stringify(o.storageState ?? {}).length > 24000) throw new Error('로그인 정보가 메모리 전달 한도를 초과하여 검사를 수행하지 못했습니다.');
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '-c', 'playwright.config.mjs'], {
      cwd: o.runDir, windowsHide: true, env: { ...childEnv(o.hideEnv), ...privateEnv, ...(hasPrivateValues() ? { PLAYWRIGHT_NO_COPY_PROMPT: '1' } : {}), QA_RUN_DIR: o.runDir, QA_EXECUTION_PROGRESS: progress ? '1' : '0', QA_TIMEOUT_MS: String(timeoutMs), ...(o.storageState ? { QA_STORAGE_STATE: JSON.stringify(o.storageState) } : {}) },
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('error', e => { output += `\n${e}`; });
    child.on('close', code => { writeFileSync(join(o.runDir, 'playwright.log'), privateText(output)); resolve(code); });
  }); } finally { progress?.stop(); }

  // 깨진 줄은 건너뛰고 문제로 남긴다. 그 앞뒤의 유효한 기록은 보존한다.
  const ledgerPath = join(o.runDir, 'ledger.jsonl');
  const broken: string[] = [];
  const entries: Entry[] = (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n') : []).flatMap((l, i) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l)]; } catch { broken.push(`ledger ${i + 1}번째 줄을 읽을 수 없음`); return []; }
  });
  const reconciled = reconcile(frozen, entries);
  const result = { ...reconciled, problems: [...broken, ...reconciled.problems], runDir: o.runDir, exitCode };
  writeFileSync(join(o.runDir, 'results.json'), privateJson(result, 2));
  return result;
}

const RUNTIME_SOURCES = ['fixture.ts', 'browser.ts', 'plan.ts', 'rules.ts', 'privacy.ts', 'execution-progress.ts', 'progress-url.ts'];
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 실행 코드에 키·토큰을 넘기지 않는다. */
export function childEnv(hide: string[] = []): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !hide.includes(k) && !/KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|ANTHROPIC|OPENAI|PRIVATE_VALUES|QA_EXECUTION_PROGRESS|QA_PROGRESS/i.test(k)));
}

// 시나리오(spec 파일)마다 워커 하나, 재시도 없이. trace·screenshot은 항상 남긴다 (실패 분류의 증거).
const config = (workers: number) => `export default {
  testDir: 'specs',
  outputDir: 'artifacts',
  workers: ${workers},
  retries: 0,
  timeout: 120000,
  // 인증 실행의 runner JSON은 원문 locator·DOM을 포함하므로 디스크에 쓰지 않는다. 실제 판정은 정제 ledger를 사용한다.
  reporter: process.env.QA_STORAGE_STATE || process.env.QA_PRIVATE_VALUES ? [['line']] : [['json', { outputFile: 'report.json' }]],
  // 로그인 상태는 실행마다 전용 환경 JSON으로 받는다. 파일·manifest에는 저장하지 않는다.
  // 로그인 실행에서는 trace·자동 스크린샷을 끈다. 인증된 화면의 DOM·요청(쿠키 헤더)이 가리지 않은 채 남기 때문이다. 증거는 fixture가 가려서 찍는다.
  use: { trace: process.env.QA_STORAGE_STATE || process.env.QA_PRIVATE_VALUES ? 'off' : 'on', screenshot: process.env.QA_STORAGE_STATE || process.env.QA_PRIVATE_VALUES ? 'off' : 'on', serviceWorkers: 'block', headless: true, storageState: process.env.QA_STORAGE_STATE ? JSON.parse(process.env.QA_STORAGE_STATE) : undefined },
};
`;
