'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFile, spawn } = require('node:child_process');

function validatePid(browserPid) {
  if (!Number.isSafeInteger(browserPid) || browserPid < 1 || browserPid > 0x7fffffff) throw new Error('전용 Edge 프로세스를 확인할 수 없습니다.');
}

function createManagedEdgeFocus(browserPid, { spawnProcess = spawn, platform = process.platform, timeoutMs = 8000 } = {}) {
  validatePid(browserPid);
  if (platform !== 'win32') return { focus: async () => ({ ok: true }), close() {} };
  const script = fs.readFileSync(path.join(__dirname, 'focus-edge.ps1'), 'utf8');
  const encoded = Buffer.from(`& {\n${script}\n} -BrowserProcessId ${browserPid} -Persistent`, 'utf16le').toString('base64');
  let child, closed = false, ready = false, buffer = '', pending;
  let resolveReady, rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Startup can fail while the browser is still navigating, before focus().
  void started.catch(() => {});
  let startupTimer = setTimeout(() => fail(new Error('전용 Edge 전경 제어를 준비하는 시간이 초과되었습니다.')), timeoutMs);
  function fail(error) {
    if (closed) return;
    closed = true;
    clearTimeout(startupTimer);
    rejectReady(error);
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
    child?.stdin.destroy();
    child?.kill();
  }
  try {
    child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', () => fail(new Error('전용 Edge 전경 제어를 준비하지 못했습니다.')));
    child.on('exit', () => fail(new Error('전용 Edge 전경 제어가 종료되었습니다.')));
    child.stdin.on('error', () => fail(new Error('전용 Edge 전경 제어에 연결하지 못했습니다.')));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (closed) return;
      buffer += chunk;
      if (buffer.length > 16384) { fail(new Error('전용 Edge 전경 제어 응답이 올바르지 않습니다.')); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let result;
        try { result = JSON.parse(line); } catch { fail(new Error('전용 Edge 전경 제어 응답이 올바르지 않습니다.')); return; }
        if (!ready && result?.ready === true) { ready = true; clearTimeout(startupTimer); resolveReady(); continue; }
        if (!ready || !pending || typeof result?.ok !== 'boolean') { fail(new Error('전용 Edge 전경 제어 응답이 올바르지 않습니다.')); return; }
        const current = pending; pending = undefined; clearTimeout(current.timer);
        if (result.ok) current.resolve({ ok: true });
        else current.reject(new Error('전용 Edge 창이 전경에 표시되지 않았습니다. Edge 창을 선택한 뒤 다시 시도해 주세요.'));
      }
    });
  } catch { fail(new Error('전용 Edge 전경 제어를 준비하지 못했습니다.')); }
  let queue = Promise.resolve();
  return {
    focus() {
      const run = async () => {
        await started;
        if (closed) throw new Error('전용 Edge 전경 제어가 종료되었습니다.');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => fail(new Error('전용 Edge 창을 앞으로 가져오는 시간이 초과되었습니다.')), timeoutMs);
          pending = { resolve, reject, timer };
          child.stdin.write('focus\n');
        });
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    close() { fail(new Error('전용 Edge 전경 제어가 종료되었습니다.')); },
  };
}

function focusManagedEdge(browserPid, { execute = execFile, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(browserPid) || browserPid < 1 || browserPid > 0x7fffffff) return Promise.reject(new Error('전용 Edge 프로세스를 확인할 수 없습니다.'));
  if (platform !== 'win32') return Promise.resolve({ ok: true });
  // Electron can read fixed resources inside ASAR; PowerShell receives the code
  // directly and never attempts to execute a virtual ASAR filesystem path.
  const script = fs.readFileSync(path.join(__dirname, 'focus-edge.ps1'), 'utf8');
  const encoded = Buffer.from(`& {\n${script}\n} -BrowserProcessId ${browserPid}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, shell: false, timeout: 8000, encoding: 'utf8', maxBuffer: 16384 },
      (error, stdout) => {
        if (error) { reject(new Error('전용 Edge 창을 앞으로 가져오지 못했습니다. Edge 창을 선택한 뒤 다시 시도해 주세요.')); return; }
        try {
          const result = JSON.parse(stdout.trim());
          if (!result.ok) throw new Error();
          resolve({ ok: true });
        } catch { reject(new Error('전용 Edge 창이 전경에 표시되지 않았습니다. Edge 창을 선택한 뒤 다시 시도해 주세요.')); }
      });
  });
}

module.exports = { focusManagedEdge, createManagedEdgeFocus };
