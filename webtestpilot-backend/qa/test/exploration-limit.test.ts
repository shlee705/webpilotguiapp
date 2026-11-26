import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { chromium, type Browser } from 'playwright';
import type Anthropic from '@anthropic-ai/sdk';
import { explore, type ExploreResult } from '../src/explore.ts';
import { Budget, type Send } from '../src/agent.ts';
import { runPlan } from '../src/run.ts';
import { judge } from '../src/triage.ts';
import { writeHeadlines } from '../src/headline.ts';
import { writeReport, type Report } from '../src/report.ts';
import type { Requirement } from '../src/plan.ts';

let browser: Browser;
let server: Server;
let origin: string;
before(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    if (req.url === '/away') { res.writeHead(302, { location: 'http://localhost:9/' }); return res.end(); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const link = req.url === '/index' ? '<a href="/details">Details</a>' : '';
    res.end(`<!doctype html><html lang="en"><head><title>Local test fixture</title></head><body><main><h1>Local test fixture</h1><p>This page is served only by the test.</p>${link}</main></body></html>`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await browser?.close(); await new Promise<void>(done => server?.close(() => done())); });

function mockSend(stop: Anthropic.Message['stop_reason'] = 'tool_use', invalidPlan = false): Send & { calls: number } {
  const send: Send & { calls: number } = Object.assign(async (req: Anthropic.MessageCreateParamsNonStreaming) => {
    send.calls++;
    const content = stop === 'tool_use'
      ? [{ type: 'tool_use', id: `fixture-${send.calls}`, name: invalidPlan ? 'submit_plan' : 'snapshot',
        input: invalidPlan ? { scenarios: [{ id: 'S1', title: 'Invalid plan', covers: [], start: { url: origin }, steps: [], checks: [] }], unplanned: [] } : {} }]
      : [{ type: 'text', text: 'No submitted plan.' }];
    return { id: `fixture-${send.calls}`, type: 'message', role: 'assistant', model: req.model, content,
      stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as Anthropic.Message;
  }, { calls: 0 });
  return send;
}

async function produceReport(result: ExploreResult, budget: Budget): Promise<Report> {
  assert.ok(result.plan, 'No accepted plan must still produce a diagnostic plan.');
  const dir = mkdtempSync(join(tmpdir(), 'qa-exploration-limit-'));
  const never: Send = async () => { throw new Error('Diagnostic run/report must not call a model.'); };
  try {
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(result.plan));
    writeFileSync(join(dir, 'explore.json'), JSON.stringify(result));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ startUrl: origin + '/', spentUsd: budget.spent,
      budgetUsd: budget.limitUsd, provider: 'openai', models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna' } }));
    const run = await runPlan({ plan: result.plan, policy: { origins: [origin], allowWrites: false }, runDir: join(dir, 'run') });
    const judgment = await judge({ plan: result.plan, run, send: never, model: 'gpt-6-luna', budget, reproduceDir: join(dir, 'repro') });
    assert.deepEqual(judgment.verdicts, []);
    await writeHeadlines({ dir, send: never, model: 'gpt-6-luna', budget });
    const written = await writeReport(dir, browser);
    assert.ok(written.pdf);
    assert.equal(readFileSync(join(dir, 'report.pdf')).subarray(0, 5).toString(), '%PDF-');
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
    assert.equal(report.run.endReason, 'incomplete');
    assert.deepEqual(report.run.scenarios, { planned: 0, started: 0 });
    assert.equal(report.bugs.length, 0);
    assert.equal(report.passed.checks, 0);
    assert.ok(report.run.incompleteReasons.length > 0, 'Requirements can be empty, but incomplete scope must remain visible.');
    assert.ok(report.coverage.templates.every(t => t.conversations.every(c => !c.planned)));
    return report;
  } finally {
    const target = resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('qa-exploration-limit-'));
    rmSync(target, { recursive: true, force: true });
  }
}

for (const [maxTurns, requirements] of [[1, []], [3, [{ id: 'R1', text: 'Verify the page.' }]]] as [number, Requirement[]][]) {
  test(`max_turns=${maxTurns}, requirements=${requirements.length}: actual incomplete PDF without extra model calls`, async () => {
    const send = mockSend();
    const budget = new Budget(2);
    const result = await explore({ browser, policy: { origins: [origin], allowWrites: false }, startUrl: origin + '/',
      requirements, send, model: 'gpt-6-luna', budget, maxTurns, turnsPerTemplate: maxTurns, maxPages: 1 });
    assert.equal(result.stop, 'max_turns');
    assert.equal(result.complete, false);
    assert.equal(send.calls, maxTurns);
    assert.equal(result.turns.length, maxTurns);
    assert.deepEqual(result.plan?.scenarios, []);
    assert.deepEqual(result.plan?.unplanned.map(u => u.requirement), requirements.map(r => r.id));
    assert.deepEqual(result.sitemap?.visited, [origin + '/']);
    assert.match(result.detail ?? '', new RegExp(`대화별 최대 ${maxTurns}턴, 페이지 종류별 ${maxTurns}턴`));
    assert.match(result.detail ?? '', /1~3턴/);
    const spent = budget.spent;
    const report = await produceReport(result, budget);
    assert.ok(report.run.incompleteReasons.some(r => r.includes('max_turns') && r.includes('1~3턴')));
    assert.equal(send.calls, maxTurns);
    assert.equal(budget.spent, spent);
  });
}

test('template retries obey existing turn caps and retain every unplanned page in the report', async () => {
  const send = mockSend();
  const budget = new Budget(2);
  const result = await explore({ browser, policy: { origins: [origin], allowWrites: false }, startUrl: origin + '/index',
    requirements: [], send, model: 'gpt-6-luna', budget, maxTurns: 3, turnsPerTemplate: 1, maxPages: 2, maxTemplates: 2 });
  assert.equal(result.sitemap?.templates.length, 2);
  assert.equal(result.conversations.length, 4, 'Each template retains the existing one retry.');
  assert.equal(send.calls, 4);
  assert.ok(result.conversations.every(c => c.stop === 'max_turns' && c.turns === 1 && !c.planned));
  assert.equal(result.complete, false);
  const report = await produceReport(result, budget);
  assert.equal(report.coverage.templates.length, 2);
  assert.equal(report.run.incompleteReasons.length, 2);
  assert.equal(send.calls, 4);
});

for (const stop of ['refusal', 'max_tokens', 'end_turn'] as const) {
  test(`${stop}: no accepted plan yields a diagnostic report with the original stop`, async () => {
    const send = mockSend(stop);
    const budget = new Budget(2);
    const result = await explore({ browser, policy: { origins: [origin] }, startUrl: origin + '/', requirements: [],
      send, model: 'gpt-6-luna', budget, maxTurns: 3, maxPages: 1 });
    assert.equal(result.stop, stop === 'end_turn' ? 'no_submit' : stop);
    assert.equal(result.complete, false);
    assert.equal(send.calls, 1);
    await produceReport(result, budget);
    assert.equal(send.calls, 1);
  });
}

test('budget exhaustion produces a report without starting model calls', async () => {
  const send = mockSend();
  const budget = new Budget(0);
  const result = await explore({ browser, policy: { origins: [origin] }, startUrl: origin + '/',
    requirements: [{ id: 'R1', text: 'Verify the page.' }], send, model: 'gpt-6-luna', budget, maxTurns: 3, maxPages: 1 });
  assert.equal(result.stop, 'budget');
  assert.equal(send.calls, 0);
  assert.equal(result.complete, false);
  assert.match(result.plan!.unplanned[0].reason, /예산 한도/);
  await produceReport(result, budget);
  assert.equal(send.calls, 0);
  assert.equal(budget.spent, 0);
});

test('nonretryable model error remains incomplete and is not copied into requirement diagnostics', async () => {
  const diagnosticMarker = 'PRIVATE_PROVIDER_ERROR_MARKER';
  let calls = 0;
  const send: Send = async () => { calls++; throw new Error(diagnosticMarker); };
  const budget = new Budget(2);
  const result = await explore({ browser, policy: { origins: [origin] }, startUrl: origin + '/',
    requirements: [{ id: 'R1', text: 'Verify the page.' }], send, model: 'gpt-6-luna', budget, maxTurns: 3, maxPages: 1 });
  assert.equal(result.stop, 'error');
  assert.equal(result.complete, false);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result.plan).includes(diagnosticMarker));
  await produceReport(result, budget);
  assert.equal(calls, 1);
});

test('invalid submitted scenarios never enter the diagnostic execution plan', async () => {
  const send = mockSend('tool_use', true);
  const budget = new Budget(2);
  const result = await explore({ browser, policy: { origins: [origin] }, startUrl: origin + '/', requirements: [],
    send, model: 'gpt-6-luna', budget, maxTurns: 1, maxPages: 1 });
  assert.equal(result.stop, 'max_turns');
  assert.equal(result.complete, false);
  assert.deepEqual(result.plan?.scenarios, []);
  assert.deepEqual(result.plan?.targets, {});
  await produceReport(result, budget);
  assert.equal(send.calls, 1);
});

test('a later policy violation discards earlier accepted scenarios and remains incomplete without requirements', async () => {
  let calls = 0;
  const send: Send = async req => {
    calls++;
    const first = String(req.messages[0].content);
    const last = req.messages.at(-1)!;
    const text = Array.isArray(last.content) ? last.content.map(b => b.type === 'tool_result' ? String(b.content) : '').join('\n') : '';
    const reply = (name?: string, input: unknown = {}) => ({ id: `policy-${calls}`, type: 'message', role: 'assistant', model: req.model,
      stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null,
      content: name ? [{ type: 'tool_use', id: `policy-tool-${calls}`, name, input }] : [{ type: 'text', text: 'No plan.' }],
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as Anthropic.Message;
    if (first.includes('범위: 페이지 종류 ' + origin + '/details')) return req.messages.length === 1 ? reply('navigate', { url: origin + '/away' }) : reply();
    if (req.messages.length === 1) return reply('snapshot');
    if (req.messages.length === 3) {
      const ref = text.split('\n').find(line => line.includes('heading'))?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
      assert.ok(ref);
      return reply('pin', { ref, group: false });
    }
    const target = text.match(/(T\d+) =/)?.[1];
    assert.ok(target);
    return reply('submit_plan', { features: [{ id: 'F1', name: 'Heading', page: origin + '/index' }], unplanned: [],
      scenarios: [{ id: 'S1', title: 'Page heading is visible', covers: ['F1'], start: { url: origin + '/index' }, steps: [],
        checks: [{ id: 'S1.C1', after: 'start', target, read: 'visible', op: 'equals', expected: 'true',
          source: { kind: 'inferred', rule: 'no-error-page', quote: 'Page is open with its heading visible.' } }] }] });
  };
  const budget = new Budget(2);
  const result = await explore({ browser, policy: { origins: [origin], allowWrites: false }, startUrl: origin + '/index',
    requirements: [], send, model: 'gpt-6-luna', budget, maxTurns: 3, turnsPerTemplate: 3, maxPages: 2, maxTemplates: 2 });
  assert.equal(result.conversations[0].stop, 'done', 'An earlier conversation genuinely accepted a plan.');
  assert.equal(result.stop, 'error');
  assert.equal(result.complete, false);
  assert.deepEqual(result.plan?.scenarios, []);
  assert.ok(result.violations.some(v => v.includes('redirect http://localhost:9/')));
  assert.ok(result.conversations.every(c => !c.planned));
  assert.equal(calls, 5);
  const report = await produceReport(result, budget);
  assert.ok(report.run.incompleteReasons.every(reason => reason.includes('정책 위반')));
  assert.equal(calls, 5);
});
