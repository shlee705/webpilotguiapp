'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createReportStore, resolveSourceReport, MAX_REPORT_BYTES, WORKSPACE_MARKER } = require('../electron/reports.cjs');

const PDF = Buffer.from('%PDF-1.4\nExisting user supplied report fixture\n%%EOF\n');
function fixture(t, content = PDF) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-report-test-'));
  t.after(() => {
    assert.ok(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('webpilot-report-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceFile = path.join(root, 'testReport', 'report.pdf');
  const directory = path.join(root, 'profile', 'reports');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  if (content) fs.writeFileSync(sourceFile, content);
  const opened = [];
  const options = { sourceFile, directory, openPath: async filename => { opened.push(filename); return ''; } };
  return { root, sourceFile, directory, opened, options, store: createReportStore(options) };
}

test('snapshots existing PDF unchanged with stable metadata across app restarts', async t => {
  const item = fixture(t);
  const before = fs.statSync(item.sourceFile);
  const first = await item.store.attachReport();
  assert.equal(first.status, 'ready');
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.name, 'report.pdf');
  assert.equal(first.size, PDF.length);
  assert.equal(first.updatedAt, before.mtime.toISOString());
  assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'size', 'status', 'updatedAt']);
  assert.deepEqual(fs.readFileSync(item.sourceFile), PDF);
  assert.equal(fs.statSync(item.sourceFile).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readFileSync(path.join(item.directory, `${first.id}.pdf`)), PDF);
  fs.writeFileSync(item.sourceFile, '%PDF-1.7\nNew source revision\n%%EOF');
  const second = await item.store.attachReport();
  assert.equal(second.status, 'ready');
  assert.notEqual(second.id, first.id);
  assert.deepEqual(fs.readFileSync(path.join(item.directory, `${first.id}.pdf`)), PDF);
  assert.deepEqual(await createReportStore(item.options).getReport(first.id), first);
  assert.equal(fs.readdirSync(item.directory).some(name => name.endsWith('.part')), false);
});

test('missing source reports missing without creating a cached file', async t => {
  const item = fixture(t, null);
  assert.equal((await item.store.attachReport()).status, 'missing');
  assert.equal(fs.existsSync(item.directory), false);
});

test('rejects non-PDF, empty and oversized originals', async t => {
  const item = fixture(t, Buffer.from('not a PDF'));
  assert.equal((await item.store.attachReport()).status, 'error');
  fs.writeFileSync(item.sourceFile, '');
  assert.equal((await item.store.attachReport()).status, 'error');
  fs.writeFileSync(item.sourceFile, PDF);
  fs.truncateSync(item.sourceFile, MAX_REPORT_BYTES + 1);
  assert.equal((await item.store.attachReport()).status, 'error');
  assert.equal(fs.existsSync(item.directory), false);
});

test('pre-cancelled attachment creates no snapshot', async t => {
  const item = fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(item.store.attachReport({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fs.existsSync(item.directory), false);
});

test('cancellation during copying removes partial snapshot', async t => {
  const item = fixture(t, Buffer.concat([PDF, Buffer.alloc(8 * 1024 * 1024)]));
  fs.mkdirSync(item.directory, { recursive: true });
  const controller = new AbortController();
  const watcher = fs.watch(item.directory, (_event, filename) => {
    if (String(filename).endsWith('.part')) controller.abort();
  });
  try { await assert.rejects(item.store.attachReport({ signal: controller.signal }), { name: 'AbortError' }); }
  finally { watcher.close(); }
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(fs.readdirSync(item.directory), []);
});

test('opens only validated cached UUID PDF without exposing original path', async t => {
  const item = fixture(t);
  const report = await item.store.attachReport();
  assert.deepEqual(await item.store.openReport(report.id), { ok: true });
  assert.deepEqual(item.opened, [path.join(item.directory, `${report.id}.pdf`)]);
  for (const invalid of ['../testReport/report.pdf', item.sourceFile, `${report.id}.pdf`, '', null, { id: report.id }]) {
    assert.equal((await item.store.openReport(invalid)).ok, false);
  }
  assert.equal(item.opened.length, 1);
  assert.equal((await item.store.getReport(randomUUID())).status, 'missing');
});

test('refuses missing or corrupted cached PDFs and sanitizes viewer errors', async t => {
  const item = fixture(t);
  const report = await item.store.attachReport();
  const filename = path.join(item.directory, `${report.id}.pdf`);
  fs.writeFileSync(filename, 'corrupted');
  assert.equal((await item.store.openReport(report.id)).ok, false);
  assert.deepEqual(item.opened, []);
  fs.writeFileSync(filename, PDF);
  const failedViewer = createReportStore({ ...item.options, openPath: async () => 'private-path viewer error' });
  const result = await failedViewer.openReport(report.id);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('private-path'), false);
  fs.unlinkSync(filename);
  assert.equal((await item.store.openReport(report.id)).ok, false);
});

test('reads only the saved snapshot as independent PDF bytes without launching an external app', async t => {
  const item = fixture(t);
  const report = await item.store.attachReport();
  fs.writeFileSync(item.sourceFile, '%PDF-1.7\nA different source report\n%%EOF');
  const result = await createReportStore(item.options).readReport(report.id);
  assert.equal(result.ok, true);
  assert.equal(result.data instanceof Uint8Array, true);
  assert.equal(Buffer.isBuffer(result.data), false);
  assert.deepEqual(Object.keys(result).sort(), ['data', 'ok']);
  assert.deepEqual(Buffer.from(result.data), PDF);
  result.data.fill(0);
  assert.deepEqual(Buffer.from((await item.store.readReport(report.id)).data), PDF);
  assert.deepEqual(item.opened, []);
});

test('readReport rejects paths, malformed IDs and absent snapshots without exposing filesystem paths', async t => {
  const item = fixture(t);
  const report = await item.store.attachReport();
  for (const id of ['../testReport/report.pdf', item.sourceFile, `${report.id}.pdf`, '', null, { id: report.id }, randomUUID()]) {
    const result = await item.store.readReport(id);
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'ok']);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.error.includes(item.root), false);
  }
  assert.deepEqual(item.opened, []);
});

test('readReport refuses empty, corrupted, oversized and non-file cached entries', async t => {
  const item = fixture(t);
  const report = await item.store.attachReport();
  const filename = path.join(item.directory, `${report.id}.pdf`);
  for (const contents of ['', 'not a PDF']) {
    fs.writeFileSync(filename, contents);
    assert.equal((await item.store.readReport(report.id)).ok, false);
  }
  fs.writeFileSync(filename, PDF);
  fs.truncateSync(filename, MAX_REPORT_BYTES + 1);
  assert.equal((await item.store.readReport(report.id)).ok, false);
  fs.unlinkSync(filename);
  fs.mkdirSync(filename);
  assert.equal((await item.store.readReport(report.id)).ok, false);
});

test('readReport refuses a redirected report cache directory', async t => {
  const item = fixture(t);
  const report = await item.store.attachReport();
  const redirected = path.join(item.root, 'redirected-reports');
  fs.renameSync(item.directory, redirected);
  try { fs.symlinkSync(redirected, item.directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('This host does not allow test directory links.'); return; }
    throw error;
  }
  assert.equal((await item.store.readReport(report.id)).ok, false);
});

test('cache write failure returns error without changing original', async t => {
  const item = fixture(t);
  fs.mkdirSync(path.dirname(item.directory), { recursive: true });
  fs.writeFileSync(item.directory, 'not a directory');
  assert.equal((await item.store.attachReport()).status, 'error');
  assert.deepEqual(fs.readFileSync(item.sourceFile), PDF);
});

test('development source is fixed to appPath without cwd lookup', t => {
  const item = fixture(t);
  assert.equal(resolveSourceReport({ appPath: item.root, isPackaged: false }), item.sourceFile);
  assert.throws(() => resolveSourceReport({ appPath: '.', isPackaged: false }));
});

test('packaged source finds only explicit workspace marker, otherwise exe-adjacent', t => {
  const item = fixture(t);
  const executable = path.join(item.root, 'release', '0.3.1', 'win-unpacked', 'WebPilot.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const resolve = () => resolveSourceReport({ exePath: executable, isPackaged: true });
  const fallback = path.join(path.dirname(executable), 'testReport', 'report.pdf');
  assert.equal(resolve(), fallback);
  fs.writeFileSync(path.join(item.root, 'package.json'), JSON.stringify({ name: 'webpilot-desktop' }));
  assert.equal(resolve(), fallback);
  fs.writeFileSync(path.join(item.root, 'package.json'), JSON.stringify({ name: 'other-app', webpilotWorkspace: WORKSPACE_MARKER }));
  assert.equal(resolve(), fallback);
  fs.writeFileSync(path.join(item.root, 'package.json'), JSON.stringify({ name: 'webpilot-desktop', webpilotWorkspace: WORKSPACE_MARKER }));
  assert.equal(resolve(), item.sourceFile);
});
