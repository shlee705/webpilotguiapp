const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('올바른 HTTP 또는 HTTPS 주소를 입력해 주세요.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('올바른 HTTP 또는 HTTPS 주소를 입력해 주세요.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) {
    throw new Error('HTTP 또는 HTTPS 주소만 Edge에서 열 수 있습니다.');
  }
  return url.href;
}

function findEdgeExecutable(environment = process.env, exists = existsSync) {
  const roots = [environment['ProgramFiles(x86)'], environment.ProgramFiles, environment.LOCALAPPDATA];
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

async function openInEdge(value, dependencies = {}) {
  let url;
  try {
    url = normalizeHttpUrl(value);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    return { ok: false, error: '이 기능은 Windows 데스크톱 앱에서 사용할 수 있습니다.' };
  }
  const executable = findEdgeExecutable(dependencies.env ?? process.env, dependencies.exists ?? existsSync);
  if (!executable) {
    return { ok: false, error: 'Microsoft Edge를 찾을 수 없습니다. Edge 설치 후 다시 시도해 주세요.' };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = (dependencies.spawn ?? spawn)(executable, ['--new-tab', url], {
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
    } catch {
      resolve({ ok: false, error: 'Microsoft Edge를 실행할 수 없습니다. 설치 상태를 확인해 주세요.' });
      return;
    }
    child.once('error', () => {
      resolve({ ok: false, error: 'Microsoft Edge를 실행할 수 없습니다. 설치 상태를 확인해 주세요.' });
    });
    child.once('spawn', () => {
      child.unref();
      // This confirms process launch only, not page load or a completed site test.
      resolve({ ok: true });
    });
  });
}

module.exports = { normalizeHttpUrl, findEdgeExecutable, openInEdge };
