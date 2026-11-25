'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

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

module.exports = { focusManagedEdge };
