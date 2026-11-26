'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { crc32 } = require('node:zlib');
const asar = require('@electron/asar');

// GitHub mixes DEFLATED and STORED entries. Small .NET test archives previously
// covered only DEFLATED, missing yauzl's different legacy stream for STORED.
function storedZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename), data = Buffer.from(value), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('Code ZIP CLI completes STORED and empty entries and rejects an LFS stub', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-codezip-regression-'));
  t.after(() => {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('webpilot-codezip-regression-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const candidate = path.join(temporary, 'candidate'), app = path.join(temporary, 'app');
  fs.mkdirSync(path.join(candidate, 'resources'), { recursive: true });
  fs.mkdirSync(app);
  const manifest = JSON.stringify({ name: 'webpilot-desktop', version: '1.0.3', webpilotWorkspace: 'webpilot-report-root-v1' });
  fs.writeFileSync(path.join(app, 'package.json'), manifest);
  await asar.createPackage(app, path.join(candidate, 'resources', 'app.asar'));
  const payload = [
    ['WebPilot.exe', 'MZfixture'], ['resources/backend-runtime/node.exe', 'MZnode'],
    ['resources/webtestpilot-backend/qa/src/cli.ts', '// synthetic fixture'],
    ['resources/webtestpilot-backend/.browsers/chromium_headless_shell-1/chrome-headless-shell-win64/chrome-headless-shell.exe', 'MZbrowser'],
    ['resources/empty.txt', ''],
  ];
  for (const [name, bytes] of payload) {
    fs.mkdirSync(path.dirname(path.join(candidate, name)), { recursive: true });
    fs.writeFileSync(path.join(candidate, name), bytes);
  }
  payload.push(['resources/app.asar', fs.readFileSync(path.join(candidate, 'resources/app.asar'))]);
  const prefix = 'webpilotguiapp-1xx/release/1.0.3/win-unpacked/';
  const entries = [
    ['webpilotguiapp-1xx/package.json', manifest],
    ['webpilotguiapp-1xx/.gitattributes', 'release/1.0.2 export-ignore\n'],
    ...payload.map(([name, bytes]) => [prefix + name, bytes]),
  ];
  const filename = path.join(temporary, 'code.zip');
  const run = () => spawnSync(process.execPath, [path.join(__dirname, 'verify-code-zip.cjs'), candidate, filename],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 });
  fs.writeFileSync(filename, storedZip(entries));
  const success = run();
  assert.ifError(success.error);
  assert.equal(success.status, 0, success.stderr);
  assert.ok(success.stdout.trim(), 'Exit 0 without a completed verification JSON is never success.');
  const result = JSON.parse(success.stdout);
  assert.equal(result.passed, true);
  assert.equal(result.payloadFiles, payload.length);
  assert.equal(result.fullPayloadSha256Matched, true);
  assert.equal(result.guiOrBrowserProcessesStarted, 0);

  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'0'.repeat(64)}\nsize 10000\n`;
  fs.writeFileSync(filename, storedZip(entries.map(([name, bytes]) => [name, name === `${prefix}WebPilot.exe` ? pointer : bytes])));
  const rejected = run();
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 1);
  assert.deepEqual(JSON.parse(rejected.stderr), { passed: false, failure: 'zip-lfs-pointer' });
});
