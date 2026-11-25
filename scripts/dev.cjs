const { spawn } = require('node:child_process');
const path = require('node:path');

let server;
let desktop;
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (desktop && desktop.exitCode === null && !desktop.killed) desktop.kill();
  if (server) await server.close();
  process.exitCode = code;
}

async function start() {
  const { createServer } = await import('vite');
  server = await createServer({
    root: path.resolve(__dirname, '..'),
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  });
  await server.listen();
  server.printUrls();

  const environment = { ...process.env, ELECTRON_DEV: '1' };
  // Terminal hosts based on Electron may set this; the child must launch as an app.
  delete environment.ELECTRON_RUN_AS_NODE;
  desktop = spawn(require('electron'), [path.resolve(__dirname, '..')], {
    cwd: path.resolve(__dirname, '..'),
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  desktop.on('error', async (error) => {
    console.error('WebPilot 실행 실패:', error.message);
    await shutdown(1);
  });
  desktop.on('exit', (code) => { void shutdown(code ?? 0); });
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
start().catch(async (error) => {
  console.error('WebPilot 개발 서버 실행 실패:', error.message);
  await shutdown(1);
});
