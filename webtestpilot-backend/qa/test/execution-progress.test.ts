import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createExecutionProgressReader, MAX_PROGRESS_FILE_BYTES, recordExecutionProgress, type ExecutionProgress } from '../src/execution-progress.ts';
import { configurePrivateValues } from '../src/privacy.ts';
import { childEnv, runPlan } from '../src/run.ts';
import type { Plan } from '../src/plan.ts';

function temporary() { return mkdtempSync(join(tmpdir(), 'qa-execution-progress-')); }
function cleanup(dir: string) {
  const target = resolve(dir);
  if (target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('qa-execution-progress-')) rmSync(target, { recursive: true, force: true });
}
const restoreEnv = (name: string, value: string | undefined) => value === undefined ? delete process.env[name] : process.env[name] = value;

test('worker display metadata is sanitized before the first file write and is explicitly opt-in', () => {
  const dir = temporary(), origin = 'https://site.test';
  const oldDir = process.env.QA_RUN_DIR, oldEnabled = process.env.QA_EXECUTION_PROGRESS;
  process.env.QA_RUN_DIR = dir;
  configurePrivateValues(['private-user-775', 'private-pass&99'], [origin + '/']);
  try {
    process.env.QA_EXECUTION_PROGRESS = '0';
    recordExecutionProgress({ url: () => origin + '/disabled' }, 'click', [origin]);
    assert.deepEqual(readdirSync(dir), []);
    process.env.QA_EXECUTION_PROGRESS = '1';
    for (const url of ['https://outside.test/', 'https://user:password@site.test/', origin + '/private-user-775',
      origin + '/%70rivate-user-775', origin + '/private-pass%2699', 'about:blank']) {
      recordExecutionProgress({ url: () => url }, 'inspect', [origin]);
    }
    assert.deepEqual(readdirSync(dir), [], 'private and unobserved URLs must never reach disk');
    recordExecutionProgress({ url: () => origin + '/safe?password=private-pass%2699#/tab?account=private-user-775' }, 'click', [origin]);
    const raw = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
    assert.doesNotMatch(raw, /private-|password|account/);
    const event = JSON.parse(raw);
    assert.equal(event.url, origin + '/safe#/tab');
    assert.equal(event.action, 'click');
    assert.deepEqual(Object.keys(event).sort(), ['action', 'at', 'url']);
    assert.equal(childEnv().QA_EXECUTION_PROGRESS, undefined);
    const file = join(dir, `.desktop-progress.${process.pid}.jsonl`);
    writeFileSync(file, 'x'.repeat(MAX_PROGRESS_FILE_BYTES));
    recordExecutionProgress({ url: () => origin + '/after-rotation' }, 'inspect', [origin]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).url, origin + '/after-rotation', 'file bounds never stop future actual observations');
    process.env.QA_RUN_DIR = join(dir, 'missing');
    assert.doesNotThrow(() => recordExecutionProgress({ url: () => origin + '/' }, 'click', [origin]));
  } finally { configurePrivateValues([]); restoreEnv('QA_RUN_DIR', oldDir); restoreEnv('QA_EXECUTION_PROGRESS', oldEnabled); cleanup(dir); }
});

test('worker tails buffer partial lines, isolate workers, skip malformed/private data, and flush once on stop', async () => {
  const dir = temporary(), origin = 'https://site.test', events: ExecutionProgress[] = [];
  configurePrivateValues(['private-user-775', 'private-pass&99']);
  const reader = createExecutionProgressReader(dir, [origin], event => { events.push(event); if (events.length === 1) throw new Error('display unavailable'); });
  const a = join(dir, '.desktop-progress.100.jsonl'), b = join(dir, '.desktop-progress.200.jsonl');
  const line = (url: string, action = 'inspect') => JSON.stringify({ at: Date.now(), url, action }) + '\n';
  try {
    const first = line(origin + '/one?key=hidden', 'navigate');
    writeFileSync(a, first.slice(0, 20)); reader.drain(); assert.equal(events.length, 0);
    appendFileSync(a, first.slice(20)); reader.drain();
    assert.deepEqual(events, [{ url: origin + '/one', action: 'navigate' }]);
    reader.drain(); assert.equal(events.length, 1);
    appendFileSync(a, 'malformed\n' + 'x'.repeat(17000)); reader.drain();
    appendFileSync(a, '\n' + line(origin + '/two', 'click'));
    writeFileSync(b, line('https://outside.test/') + line(origin + '/private-user-775') + line(origin + '/bad', 'arbitrary') + line(origin + '/three', 'fill'));
    reader.stop(); reader.stop(); reader.drain();
    assert.deepEqual(events.map(event => event.url), [origin + '/one', origin + '/two', origin + '/three']);
    assert.deepEqual(readdirSync(dir), [], 'only temporary worker display records are removed');
    await new Promise(done => setTimeout(done, 130));
    assert.equal(events.length, 3, 'stopped readers emit no late events');
  } finally { reader.stop(); configurePrivateValues([]); cleanup(dir); }
});

function fixturePlan(origin: string): Plan {
  return { version: 1, textRead: 'name+content', requirements: [{ id: 'R1', text: 'Input and navigation work.' }],
    observations: [], features: [], questions: [], unplanned: [],
    targets: {
      T1: { target: { role: 'textbox', name: '^Search$' }, group: false, url: origin + '/first?token=private-query' },
      T2: { target: { role: 'link', name: '^Next$' }, group: false, url: origin + '/first?token=private-query' },
      T3: { target: { role: 'heading', name: '^Second$' }, group: false, url: origin + '/second' },
    },
    scenarios: [{ id: 'S1', title: 'Input and navigation', covers: ['R1'], start: { url: origin + '/first?token=private-query' },
      steps: [{ id: 'S1.A1', op: 'fill', target: 'T1', value: 'private-input-never-in-progress' }, { id: 'S1.A2', op: 'click', target: 'T2' }],
      checks: [{ id: 'S1.C1', after: 'S1.A2', target: 'T3', read: 'visible', op: 'equals', expected: 'true', source: { kind: 'requirement', id: 'R1', quote: 'navigation work' } }],
    }],
  };
}

test('actual Playwright workers publish live executing page/actions without changing results or inheriting progress opt-in', async () => {
  const dir = temporary();
  let gating = true, clickObserved = false, live = false;
  let heldResponse: import('node:http').ServerResponse | undefined;
  let gateTimer: ReturnType<typeof setTimeout> | undefined;
  const release = () => { clearTimeout(gateTimer); heldResponse?.end('<h1>Second</h1>'); heldResponse = undefined; };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url!.startsWith('/second') && gating) {
      heldResponse = response;
      if (clickObserved) { live = true; release(); }
      else gateTimer = setTimeout(release, 3000);
      return;
    }
    response.end(request.url!.startsWith('/second') ? '<h1>Second</h1>' : '<label>Search<input></label><a href="/second">Next</a>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const events: ExecutionProgress[] = [];
  const oldEnabled = process.env.QA_EXECUTION_PROGRESS;
  try {
    const result = await runPlan({ plan: fixturePlan(origin), policy: { origins: [origin] }, runDir: join(dir, 'enabled'), timeoutMs: 1500,
      onProgress(event) {
        events.push(event);
        if (event.action === 'click') { clickObserved = true; if (heldResponse) { live = true; release(); } }
        if (events.length === 1) throw new Error('GUI disconnected');
      },
    });
    assert.equal(result.exitCode, 0, readFileSync(join(result.runDir, 'playwright.log'), 'utf8'));
    assert.deepEqual(result.problems, []);
    assert.equal(result.scenarios[0].checks[0].status, 'passed');
    assert.equal(live, true, 'the click observation must arrive while the worker is awaiting the next page response');
    assert.ok(events.some(event => event.url === origin + '/first' && event.action === 'fill'), JSON.stringify(events));
    assert.ok(events.some(event => event.url === origin + '/first' && event.action === 'click'), JSON.stringify(events));
    assert.ok(events.some(event => event.url === origin + '/second' && event.action === 'navigate'), JSON.stringify(events));
    assert.ok(events.some(event => event.url === origin + '/second' && event.action === 'inspect'), JSON.stringify(events));
    assert.doesNotMatch(JSON.stringify(events), /private-|token|input|T1|S1/);
    assert.equal(readdirSync(result.runDir).some(name => name.startsWith('.desktop-progress.')), false);
    const count = events.length;
    await new Promise(done => setTimeout(done, 150));
    assert.equal(events.length, count);

    process.env.QA_EXECUTION_PROGRESS = '1';
    gating = false;
    const noCallback = await runPlan({ plan: fixturePlan(origin), policy: { origins: [origin] }, runDir: join(dir, 'disabled'), timeoutMs: 1500 });
    assert.equal(noCallback.exitCode, 0);
    assert.equal(readdirSync(noCallback.runDir).some(name => name.startsWith('.desktop-progress.')), false);
  } finally {
    release();
    restoreEnv('QA_EXECUTION_PROGRESS', oldEnabled);
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    cleanup(dir);
  }
});
