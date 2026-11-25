const test = require('node:test');
const assert = require('node:assert/strict');
const { focusManagedEdge } = require('../electron/focus-edge.cjs');

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
