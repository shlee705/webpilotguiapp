import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import type { Report } from '../src/report.ts';

test('actual desktop CLI reaches a genuine incomplete PDF after one exploration turn without a submitted plan', { timeout: 90000 }, async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'qa-cli-turn-limit-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="en"><head><title>Local turn limit fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>Turn limit fixture</h1><p>This local page has not been tested by a submitted scenario.</p></main></body></html>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const targetUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // Run the actual orchestration, but keep .env lookup in an empty temporary
    // application and replace only model transport with a deterministic reply.
    // No production test switch, actual key, remote API or user site is involved.
    const original = new URL('../src/cli.ts', import.meta.url);
    let source = readFileSync(original, 'utf8').replace(/from '([^']+)'/g,
      (_match, specifier: string) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, original).href : import.meta.resolve(specifier))}`);
    const providerStatement = 'const providerSend = createProviderSend(backend);';
    assert.equal(source.split(providerStatement).length, 2, 'The isolated test must replace exactly the provider factory.');
    source = source.replace(providerStatement, `
globalThis.fetch = async () => { throw new Error('Network API calls are forbidden in this fixture.'); };
let fixtureCalls = 0;
const providerSend: Send = async request => {
  if (++fixtureCalls !== 1) throw new Error('No model call is allowed after the configured one-turn limit.');
  return { id: 'fixture-message', type: 'message', role: 'assistant', model: request.model,
    content: [{ type: 'tool_use', id: 'fixture-snapshot', name: 'snapshot', input: {} }],
    stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  } as unknown as Anthropic.Message;
};`);
    const cli = join(isolated, 'qa', 'src', 'cli.ts');
    mkdirSync(join(isolated, 'qa', 'src'), { recursive: true });
    writeFileSync(cli, source);
    const out = join(isolated, 'result');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|ANTHROPIC|OPENAI|WEBPILOT_BACKEND|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i.test(name)));
    env.OPENAI_API_KEY = 'fixture-only-no-network-key';
    const events: { type?: string; phase?: string; runDir?: string; pdf?: boolean }[] = [];
    child = spawn(process.execPath, [cli, '--url', targetUrl, '--provider', 'openai', '--desktop-events', '--output-dir', out,
      '--plan-model', 'gpt-6-luna', '--triage-model', 'gpt-6-luna', '--budget', '10', '--explore-minutes', '5',
      '--max-pages', '1', '--max-templates', '1', '--max-turns', '1', '--turns-per-template', '1', '--pages-per-template', '1'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], signal: AbortSignal.timeout(60000) });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.stdout!.resume();
    child.on('message', message => {
      if (typeof message === 'object' && message !== null) events.push(message as (typeof events)[number]);
    });
    const code = await new Promise<number | null>((done, fail) => { child!.once('error', fail); child!.once('close', done); });
    assert.equal(code, 0, stderr);
    assert.ok(events.some(event => event.type === 'backend-progress' && event.phase === 'reporting'));
    assert.deepEqual(events.at(-1), { type: 'backend-result', runDir: out, pdf: true });
    const exploration = JSON.parse(readFileSync(join(out, 'explore.json'), 'utf8'));
    assert.equal(exploration.stop, 'max_turns', JSON.stringify({ detail: exploration.detail, conversations: exploration.conversations }));
    assert.equal(exploration.complete, false);
    assert.equal(exploration.turns.length, 1);
    assert.equal(exploration.conversations[0].planned, false);
    assert.equal(exploration.conversations[0].turns, 1);
    const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
    assert.deepEqual(plan.scenarios, []);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
    assert.equal(report.run.endReason, 'incomplete');
    assert.ok(report.run.incompleteReasons.length > 0);
    assert.deepEqual(report.run.scenarios, { planned: 0, started: 0 });
    assert.equal(report.passed.checks, 0);
    assert.equal(report.bugs.length, 0);
    assert.equal(report.run.parameters?.maxTurns, 1);
    assert.equal(report.run.parameters?.turnsPerTemplate, 1);
    assert.equal(report.run.parameters?.maxPages, 1);
    assert.equal(report.run.parameters?.maxTemplates, 1);
    assert.equal(report.run.parameters?.pagesPerTemplate, 1);
    assert.equal(report.run.parameters?.budgetUsd, 10);
    assert.equal(report.run.parameters?.exploreMinutes, 5);
    assert.equal(report.run.provider, 'openai');
    assert.deepEqual(report.run.models, { plan: 'gpt-6-luna', triage: 'gpt-6-luna' });
    assert.equal(readFileSync(join(out, 'report.pdf')).subarray(0, 5).toString(), '%PDF-');
    const calls = JSON.parse(readFileSync(join(out, 'calls.json'), 'utf8'));
    assert.equal(calls.length, 1, 'Reporting must not bypass the configured exploration limit with extra model calls.');
    assert.equal(calls[0].error, undefined);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise<void>(done => server.close(() => done()));
    const directory = resolve(isolated);
    if (directory.startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('qa-cli-turn-limit-')) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
});
