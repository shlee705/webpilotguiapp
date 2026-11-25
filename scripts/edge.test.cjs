const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { normalizeHttpUrl, findEdgeExecutable, openInEdge } = require('../electron/edge.cjs');

test('accepts and normalizes HTTP(S) URLs including Unicode and query characters', () => {
  assert.equal(normalizeHttpUrl(' https://example.com/한글?q=a&next=b '), 'https://example.com/%ED%95%9C%EA%B8%80?q=a&next=b');
  assert.equal(normalizeHttpUrl('http://localhost:8080'), 'http://localhost:8080/');
});

test('rejects unsafe schemes, control characters, invalid types, and oversized URLs', () => {
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'ms-edge:https://example.com', '--new-window', 'https://exa\nmple.com', {}, null, 'https://example.com/' + 'x'.repeat(8192)]) {
    assert.throws(() => normalizeHttpUrl(url));
  }
});

test('finds per-user Edge when machine-wide installations are missing', () => {
  const environment = { ProgramFiles: 'machine', 'ProgramFiles(x86)': 'machine-x86', LOCALAPPDATA: 'user' };
  const expected = path.join('user', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(findEdgeExecutable(environment, (candidate) => candidate === expected), expected);
  assert.equal(findEdgeExecutable({}, () => true), undefined);
});

test('passes URL as one literal argument without invoking a command shell', async () => {
  let invocation;
  let unreferenced = false;
  const result = await openInEdge('https://example.com/?query=one&x="; calc.exe', {
    platform: 'win32',
    env: { ProgramFiles: 'program-files' },
    exists: () => true,
    spawn: (...args) => {
      invocation = args;
      const child = new EventEmitter();
      child.unref = () => { unreferenced = true; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(invocation[1].length, 2);
  assert.equal(invocation[1][0], '--new-tab');
  assert.equal(invocation[1][1], 'https://example.com/?query=one&x=%22;%20calc.exe');
  assert.equal(invocation[2].shell, false);
  assert.equal(unreferenced, true);
});

test('returns an explicit failure when Edge is unavailable', async () => {
  const result = await openInEdge('https://example.com', {
    platform: 'win32', env: {}, exists: () => false,
    spawn: () => assert.fail('Must not launch a fallback browser'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Edge/);
});

test('returns spawn errors rather than reporting success', async () => {
  const result = await openInEdge('https://example.com', {
    platform: 'win32', env: { ProgramFiles: 'program-files' }, exists: () => true,
    spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('EACCES')));
      return child;
    },
  });
  assert.equal(result.ok, false);
});

test('rejects invalid URLs before attempting to locate or launch Edge', async () => {
  const result = await openInEdge('file:///C:/example', {
    platform: 'win32', exists: () => assert.fail('No filesystem lookup expected'),
    spawn: () => assert.fail('No process launch expected'),
  });
  assert.equal(result.ok, false);
});
