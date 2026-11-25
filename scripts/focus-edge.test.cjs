const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { focusManagedEdge, createManagedEdgeFocus } = require('../electron/focus-edge.cjs');

test('rejects arbitrary values before a process is launched', async () => {
  let called = false;
  for (const pid of [0, -1, 1.5, '123', '123;anything', NaN, 0x80000000]) {
    await assert.rejects(focusManagedEdge(pid, { platform: 'win32', execute: () => { called = true; } }));
  }
  assert.equal(called, false);
});

test('launches only the fixed hidden no-shell script with a numeric PID argument', async () => {
  let captured;
  const result = await focusManagedEdge(12345, { platform: 'win32', execute: (file, args, options, callback) => { captured = { file, args, options }; callback(null, '{"ok":true}'); } });
  assert.equal(result.ok, true);
  assert.equal(captured.file, 'powershell.exe');
  assert.equal(captured.args.at(-2), '-EncodedCommand');
  const script = Buffer.from(captured.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.endsWith('} -BrowserProcessId 12345'));
  assert.ok(script.includes("$edgeProcess.ProcessName -ne 'msedge'"));
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.args.includes('-File'), false);
});

test('a failed or unconfirmed foreground operation never reports success', async () => {
  await assert.rejects(focusManagedEdge(123, { platform: 'win32', execute: (_f, _a, _o, cb) => cb(null, '{"ok":false}') }), /전경/);
  await assert.rejects(focusManagedEdge(123, { platform: 'win32', execute: (_f, _a, _o, cb) => cb(new Error('failed'), '') }), /가져오지/);
});

function helper({ ready = true, respond = true, timeoutMs = 2000 } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let launches = 0, kills = 0, invocation;
  const commands = [];
  child.kill = () => { kills++; return true; };
  child.stdin.on('data', command => {
    commands.push(command.toString());
    if (respond) child.stdout.write('{"ok":true}\n');
  });
  const controller = createManagedEdgeFocus(123, { platform: 'win32', timeoutMs,
    spawnProcess: (file, args, options) => { launches++; invocation = { file, args, options }; return child; } });
  if (ready) child.stdout.write('{"ready":true}\n');
  return { child, controller, commands, launches: () => launches, kills: () => kills, invocation };
}

test('one hidden session helper serves repeated and concurrent focus checks with fixed commands', async () => {
  const fixture = helper();
  try {
    const results = await Promise.all([fixture.controller.focus(), fixture.controller.focus(), fixture.controller.focus()]);
    assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
    assert.equal(fixture.launches(), 1);
    assert.deepEqual(fixture.commands, ['focus\n', 'focus\n', 'focus\n']);
    assert.equal(fixture.invocation.options.windowsHide, true);
    assert.equal(fixture.invocation.options.shell, false);
    const script = Buffer.from(fixture.invocation.args.at(-1), 'base64').toString('utf16le');
    assert.ok(script.endsWith('} -BrowserProcessId 123 -Persistent'));
    assert.ok(script.includes("$focusCommand -ne 'focus'"));
    assert.ok(script.includes('$edgeProcess.StartTime.Ticks -ne $browserStarted'));
  } finally { fixture.controller.close(); }
  assert.equal(fixture.kills(), 1);
  await assert.rejects(fixture.controller.focus(), /종료/);
});

test('closing a focus session immediately releases pending and queued requests', async () => {
  const fixture = helper({ respond: false });
  const first = fixture.controller.focus();
  const second = fixture.controller.focus();
  await new Promise(resolve => setImmediate(resolve));
  fixture.controller.close(); fixture.controller.close();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(fixture.kills(), 1);
});

test('helper startup and focus response timeouts reject and terminate the owned process', async () => {
  for (const options of [{ ready: false }, { respond: false }]) {
    const fixture = helper({ ...options, timeoutMs: 20 });
    await assert.rejects(fixture.controller.focus(), /초과/);
    assert.equal(fixture.kills(), 1);
  }
});

test('malformed helper output and process exit cannot report successful focus', async () => {
  for (const action of [child => child.stdout.write('not json\n'), child => child.emit('exit', 1)]) {
    const fixture = helper({ respond: false });
    const request = fixture.controller.focus();
    await new Promise(resolve => setImmediate(resolve));
    action(fixture.child);
    await assert.rejects(request);
    assert.equal(fixture.kills(), 1);
  }
});

test('session helper validates the managed PID before spawning', () => {
  for (const pid of [0, -1, '123', 1.5, NaN, 0x80000000]) {
    assert.throws(() => createManagedEdgeFocus(pid, { spawnProcess() { assert.fail('must not spawn'); } }));
  }
});
