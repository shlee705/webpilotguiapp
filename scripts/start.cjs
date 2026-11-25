const { spawn } = require('node:child_process');
const path = require('node:path');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_DEV;
const child = spawn(require('electron'), [path.resolve(__dirname, '..')], {
  env: environment, stdio: 'inherit', windowsHide: true,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 0; });
