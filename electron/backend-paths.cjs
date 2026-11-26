'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Packaged apps always use their shipped backend, even inside a source ZIP. */
function resolveBackendPaths({ appPath, resourcesPath, isPackaged }, exists = fs.existsSync) {
  if (!path.isAbsolute(resourcesPath || '')) throw new Error('백엔드 리소스 경로를 확인할 수 없습니다.');
  const bundledBackend = path.join(resourcesPath, 'webtestpilot-backend');
  if (isPackaged) {
    // Missing bundle files must fail preflight, never select an ancestor's .env
    // or a system Node installation with a different runtime/dependency set.
    return { backendRoot: bundledBackend, nodePath: path.join(resourcesPath, 'backend-runtime', 'node.exe') };
  }
  if (!path.isAbsolute(appPath || '')) throw new Error('개발 앱 경로를 확인할 수 없습니다.');
  const localBackend = path.join(appPath, 'webtestpilot-backend');
  const runtime = path.join(appPath, 'artifacts', 'backend-runtime', 'node.exe');
  return {
    backendRoot: exists(path.join(localBackend, 'qa', 'src', 'cli.ts')) ? localBackend : bundledBackend,
    nodePath: exists(runtime) ? runtime : 'node',
  };
}

module.exports = { resolveBackendPaths };
