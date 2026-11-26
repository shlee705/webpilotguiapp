import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { chromium } from 'playwright';
import { explore } from '../src/explore.ts';
import { Budget, type Send } from '../src/agent.ts';
import { runPlan } from '../src/run.ts';
import { judge } from '../src/triage.ts';
import { writeHeadlines } from '../src/headline.ts';
import { writeReport, type Report } from '../src/report.ts';

test('unreachable target produces a genuine incomplete PDF with no model requests or invented checks', async () => {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  const browser = await chromium.launch();
  const dir = mkdtempSync(join(tmpdir(), 'qa-navigation-failure-'));
  let calls = 0;
  const send: Send = async () => { calls++; throw new Error('No model request is permitted in this fixture.'); };
  const budget = new Budget(1);
  const policy = { origins: [new URL(url).origin], allowWrites: false };
  try {
    const result = await explore({ browser, policy, startUrl: url, requirements: [{ id: 'R1', text: 'Search works.' }],
      send, model: 'gpt-6-luna', structureModel: 'gpt-6-luna', budget, maxTurns: 2, maxPages: 1 });
    assert.equal(result.complete, false);
    assert.equal(result.stop, 'error');
    assert.equal(calls, 0);
    assert.deepEqual(result.sitemap?.visited, []);
    assert.match(result.sitemap?.failedReasons?.[url] ?? '', /ERR_CONNECTION_REFUSED/);
    assert.equal(result.plan?.scenarios.length, 0);
    assert.equal(result.plan?.unplanned[0].requirement, 'R1');
    assert.equal(result.conversations[0].planned, false);
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(result.plan));
    writeFileSync(join(dir, 'explore.json'), JSON.stringify(result));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ startUrl: url, spentUsd: 0, budgetUsd: 1,
      provider: 'openai', models: { plan: 'gpt-6-luna', triage: 'gpt-6-luna' } }));
    const run = await runPlan({ plan: result.plan!, policy, runDir: join(dir, 'run') });
    const judgment = await judge({ plan: result.plan!, run, send, model: 'gpt-6-luna', budget, reproduceDir: join(dir, 'repro') });
    assert.equal(judgment.verdicts.length, 0);
    await writeHeadlines({ dir, send, model: 'gpt-6-luna', budget });
    const written = await writeReport(dir, browser);
    assert.ok(written.pdf);
    assert.equal(readFileSync(join(dir, 'report.pdf')).subarray(0, 5).toString(), '%PDF-');
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
    assert.equal(report.run.endReason, 'incomplete');
    assert.equal(report.run.verdicts.stage, 'done');
    assert.deepEqual(report.run.scenarios, { planned: 0, started: 0 });
    assert.match(report.coverage.failedReasons![url], /연결 거부/);
    assert.equal(report.bugs.length, 0);
    assert.equal(report.passed.checks, 0);
    assert.equal(calls, 0);
    assert.equal(budget.spent, 0);
  } finally {
    await browser.close();
    const target = resolve(dir);
    if (target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('qa-navigation-failure-')) rmSync(target, { recursive: true, force: true });
  }
});
