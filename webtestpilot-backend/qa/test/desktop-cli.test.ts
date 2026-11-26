import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

async function ipcChild(args: string[]) {
  const events: unknown[] = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|ANTHROPIC|OPENAI|WEBPILOT_BACKEND/i.test(name)));
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], signal: AbortSignal.timeout(15000) });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.stdout!.resume();
  child.on('message', message => events.push(message));
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stderr, events };
}

test('데스크톱 IPC는 별도 프로세스에서 실제 단계·정제 URL·PDF 결과만 전달한다', async () => {
  const moduleUrl = new URL('../src/progress.ts', import.meta.url).href;
  const out = join(tmpdir(), 'qa-ipc-result');
  const code = `import { configureDesktopProgress, desktopProgress, desktopResult } from ${JSON.stringify(moduleUrl)};
configureDesktopProgress(true, 'https://site.test/');
desktopProgress('mapping', 'https://site.test/a?password=private', 'navigate');
desktopProgress('exploring', 'https://site.test/b', 'click');
desktopResult(${JSON.stringify(out)}, true);`;
  const result = await ipcChild(['--input-type=module', '-e', code]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.events, [
    { type: 'backend-progress', phase: 'mapping', sequence: 1, url: 'https://site.test/a', action: 'navigate' },
    { type: 'backend-progress', phase: 'exploring', sequence: 2, url: 'https://site.test/b', action: 'click' },
    { type: 'backend-result', runDir: out, pdf: true },
  ]);
});

test('실제 CLI는 제공자와 다른 모델을 API 키·브라우저·결과 폴더 준비 전에 거부한다', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'qa-cli-config-test-'));
  try {
    // Keep the real CLI implementation, but anchor its backend .env path in an
    // empty temporary application. Never load the developer/user's real key file.
    const original = new URL('../src/cli.ts', import.meta.url);
    const source = readFileSync(original, 'utf8').replace(/from '([^']+)'/g,
      (_match, specifier: string) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, original).href : import.meta.resolve(specifier))}`);
    const cli = join(isolated, 'qa', 'src', 'cli.ts');
    mkdirSync(join(isolated, 'qa', 'src'), { recursive: true });
    writeFileSync(cli, source);
    const out = join(isolated, 'qa-rejected-model-' + randomUUID());
    const result = await ipcChild([cli, '--url', 'http://127.0.0.1:1/', '--provider', 'anthropic',
      '--desktop-events', '--output-dir', out, '--plan-model', 'gpt-6-luna']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /제공자와 모델/);
    assert.deepEqual(result.events, []);
    assert.equal(existsSync(out), false);
  } finally {
    const target = resolve(isolated);
    if (target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('qa-cli-config-test-')) rmSync(target, { recursive: true, force: true });
  }
});
