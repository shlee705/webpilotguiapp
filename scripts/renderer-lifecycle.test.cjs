const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installRendererLifecycle } = require('../electron/renderer-lifecycle.cjs');

function fixture() {
  const contents = new EventEmitter();
  const active = [new AbortController(), new AbortController()];
  const effects = [];
  const dispose = installRendererLifecycle(contents, {
    cancelAll: async () => { for (const controller of active) controller.abort('renderer-navigation'); },
    stopEffects: (...args) => effects.push(args),
  });
  return { contents, active, effects, dispose };
}

test('main frame reload aborts active requests and stops overlays without notifying the outgoing renderer', () => {
  const { contents, active, effects } = fixture();
  contents.emit('did-start-navigation', { url: 'file:///app/index.html', isMainFrame: true, isSameDocument: false });
  assert.equal(active.every(controller => controller.signal.aborted), true);
  assert.equal(active[0].signal.reason, 'renderer-navigation');
  assert.deepEqual(effects, [['renderer-navigation', false]]);
});

test('subframes and same-document navigation keep active requests running', () => {
  const { contents, active, effects } = fixture();
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  contents.emit('did-start-navigation', {}, { isMainFrame: true, isInPlace: true });
  assert.equal(active.some(controller => controller.signal.aborted), false);
  assert.deepEqual(effects, []);
});

test('modern event details take precedence over deprecated positional fields', () => {
  const { contents, active, effects } = fixture();
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }, 'file:///app/index.html', false, true);
  assert.equal(active.some(controller => controller.signal.aborted), false);
  assert.deepEqual(effects, []);
  contents.emit('did-start-navigation', {}, { isMainFrame: true, isSameDocument: false });
  assert.equal(active.every(controller => controller.signal.aborted), true);
});

test('supports legacy Electron navigation arguments and removal of the listener', () => {
  const first = fixture();
  first.contents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true, 10, 20);
  assert.equal(first.active.every(controller => controller.signal.aborted), true);
  const second = fixture();
  second.contents.emit('did-start-navigation', {}, 'file:///app/index.html#part', true, true, 10, 20);
  assert.equal(second.active.some(controller => controller.signal.aborted), false);
  second.dispose();
  second.contents.emit('did-start-navigation', {}, 'file:///app/index.html', false, true, 10, 20);
  assert.equal(second.active.some(controller => controller.signal.aborted), false);
  assert.equal(second.contents.listenerCount('did-start-navigation'), 0);
});

test('empty initial navigation and a failed cancellation do not prevent overlay cleanup', async () => {
  const contents = new EventEmitter();
  const effects = [];
  installRendererLifecycle(contents, { cancelAll: () => Promise.reject(new Error('already closing')), stopEffects: (...args) => effects.push(args) });
  contents.emit('did-start-navigation', {}, { url: '', isMainFrame: true, isSameDocument: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(effects, [['renderer-navigation', false]]);
});
