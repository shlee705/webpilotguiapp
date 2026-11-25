'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOverlayManager } = require('../electron/overlay.cjs');

function fixture() {
  const screen = new EventEmitter();
  const notices = [], registrations = [], unregistered = [];
  let callback, allowRegistration = true, mainDestroyed = false;
  const native = { screen, globalShortcut: {
    register(key, handler) { registrations.push(key); if (!allowRegistration) return false; callback = handler; return true; },
    unregister(key) { unregistered.push(key); callback = undefined; },
  } };
  Object.defineProperty(native, 'BrowserWindow', { get() { assert.fail('Silent stop controls must never access BrowserWindow.'); } });
  const main = { isDestroyed: () => mainDestroyed, webContents: { isDestroyed: () => mainDestroyed, send: (...args) => notices.push(args) } };
  const manager = createOverlayManager(() => main, native);
  return { manager, screen, notices, registrations, unregistered, pressEscape: () => callback?.(),
    setRegistrationAllowed: value => { allowRegistration = value; }, destroyMain: () => { mainDestroyed = true; } };
}

test('concurrent and duplicate sessions share Escape without creating any window', async () => {
  const item = fixture();
  assert.deepEqual(await item.manager.begin('a'), { ok: true });
  assert.deepEqual(await item.manager.begin('a'), { ok: true });
  assert.deepEqual(await item.manager.begin('b'), { ok: true });
  item.manager.updateActivity({ phase: 'acting' });
  assert.deepEqual(item.registrations, ['Escape']);
  item.manager.end('a'); item.manager.end('unknown');
  assert.deepEqual(item.unregistered, []);
  item.manager.end('b');
  assert.deepEqual(item.unregistered, ['Escape']);
  assert.deepEqual(item.notices, []);
  item.manager.dispose();
});

test('Escape clears all sessions and notifies once, then permits a fresh session', async () => {
  const item = fixture();
  await item.manager.begin('a'); await item.manager.begin('b');
  item.pressEscape(); item.pressEscape();
  assert.deepEqual(item.notices, [['overlay:stopped', { reason: 'escape' }]]);
  assert.deepEqual(item.unregistered, ['Escape']);
  item.manager.end('a'); item.manager.end('b');
  assert.deepEqual(await item.manager.begin('new'), { ok: true });
  assert.equal(item.registrations.length, 2);
  item.manager.dispose();
  assert.equal(item.unregistered.length, 2);
});

test('failed Escape registration leaves no session and can be retried', async () => {
  const item = fixture(); item.setRegistrationAllowed(false);
  const failure = await item.manager.begin('a');
  assert.equal(failure.ok, false);
  assert.match(failure.error, /Esc/);
  item.setRegistrationAllowed(true);
  assert.deepEqual(await item.manager.begin('b'), { ok: true });
  item.manager.end('b');
  assert.deepEqual(item.unregistered, ['Escape']);
  assert.deepEqual(item.notices, []);
  item.manager.dispose();
});

test('display changes cancel active sessions but do not notify while idle', async () => {
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    const item = fixture();
    item.screen.emit(event); assert.deepEqual(item.notices, []);
    await item.manager.begin('a'); item.screen.emit(event); item.screen.emit(event);
    assert.deepEqual(item.notices, [['overlay:stopped', { reason: 'display-changed' }]]);
    assert.deepEqual(item.unregistered, ['Escape']);
    item.manager.dispose();
  }
});

test('dispose is idempotent, releases Escape and removes every display listener', async () => {
  const item = fixture(); await item.manager.begin('a');
  item.manager.dispose(); item.manager.dispose();
  assert.deepEqual(item.screen.eventNames(), []);
  assert.deepEqual(item.unregistered, ['Escape']);
  assert.deepEqual(item.notices, []);
  assert.equal((await item.manager.begin('b')).ok, false);
});

test('renderer cleanup can stop silently and destroyed renderers are never notified', async () => {
  const item = fixture(); await item.manager.begin('a');
  item.manager.stopAll('renderer-navigation', false);
  assert.deepEqual(item.notices, []);
  await item.manager.begin('b'); item.destroyMain(); item.pressEscape();
  assert.deepEqual(item.notices, []);
  assert.equal(item.unregistered.length, 2);
  item.manager.dispose();
});

test('invalid session identifiers do not register Escape', async () => {
  const item = fixture();
  for (const value of ['', null, undefined, 1, {}, 'a'.repeat(257)]) assert.equal((await item.manager.begin(value)).ok, false);
  assert.deepEqual(item.registrations, []);
  item.manager.dispose();
});
