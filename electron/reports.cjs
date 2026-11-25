'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_REPORT_BYTES = 50 * 1024 * 1024;
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_MARKER = 'webpilot-report-root-v1';
const missing = () => ({ status: 'missing', message: 'testReport/report.pdf 파일이 아직 없습니다. 파일을 준비한 뒤 다시 첨부해 주세요.' });
const invalid = () => ({ status: 'error', message: '보고서는 50MB 이하의 올바른 PDF 파일이어야 합니다.' });

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('보고서 첨부가 취소되었습니다.', 'AbortError');
}

function resolveSourceReport({ appPath, exePath, isPackaged }) {
  if (!isPackaged) {
    if (!path.isAbsolute(appPath)) throw new Error('앱 경로를 확인할 수 없습니다.');
    return path.join(appPath, 'testReport', 'report.pdf');
  }
  if (!path.isAbsolute(exePath)) throw new Error('실행 파일 경로를 확인할 수 없습니다.');
  const executableDirectory = path.dirname(exePath);
  let candidate = executableDirectory;
  for (let depth = 0; depth < 8; depth++) {
    try {
      const filename = path.join(candidate, 'package.json');
      const stat = fs.lstatSync(filename);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) {
        const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (manifest.name === 'webpilot-desktop' && manifest.webpilotWorkspace === WORKSPACE_MARKER) {
          return path.join(candidate, 'testReport', 'report.pdf');
        }
      }
    } catch { /* Only an explicit readable workspace marker selects a parent. */ }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return path.join(executableDirectory, 'testReport', 'report.pdf');
}

function createReportStore({ sourceFile, directory, openPath }) {
  if (!path.isAbsolute(sourceFile) || !path.isAbsolute(directory)) throw new Error('보고서 경로는 절대 경로여야 합니다.');

  async function inspect(filename) {
    const link = await fsp.lstat(filename);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error('invalid PDF');
    const file = await fsp.open(filename, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 5 || stat.size > MAX_REPORT_BYTES) throw new Error('invalid PDF');
      const signature = Buffer.alloc(5);
      const { bytesRead } = await file.read(signature, 0, 5, 0);
      if (bytesRead !== 5 || signature.toString('ascii') !== '%PDF-') throw new Error('invalid PDF');
      return { file, stat };
    } catch (error) { await file.close().catch(() => {}); throw error; }
  }

  function metadata(id, stat) {
    return { status: 'ready', id, name: 'report.pdf', size: stat.size, updatedAt: stat.mtime.toISOString() };
  }

  async function getReport(id) {
    if (typeof id !== 'string' || !REPORT_ID.test(id)) return { status: 'error', message: '올바른 보고서 ID가 필요합니다.' };
    let handle;
    try {
      const inspected = await inspect(path.join(directory, `${id}.pdf`));
      handle = inspected.file;
      return metadata(id, inspected.stat);
    } catch (error) { return error.code === 'ENOENT' ? { status: 'missing', message: '이 대화에 첨부된 보고서 파일을 찾을 수 없습니다.' } : invalid(); }
    finally { await handle?.close().catch(() => {}); }
  }

  async function attachReport({ signal } = {}) {
    checkAbort(signal);
    let source;
    try { source = await inspect(sourceFile); }
    catch (error) { checkAbort(signal); return error.code === 'ENOENT' ? missing() : invalid(); }
    const id = randomUUID();
    const temporary = path.join(directory, `${id}.pdf.part`);
    const destination = path.join(directory, `${id}.pdf`);
    let committed = false;
    try {
      checkAbort(signal);
      await fsp.mkdir(directory, { recursive: true });
      const cache = await fsp.lstat(directory);
      if (!cache.isDirectory() || cache.isSymbolicLink()) throw new Error('invalid cache');
      checkAbort(signal);
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_REPORT_BYTES ? new Error('report too large') : null, chunk);
      } });
      await pipeline(source.file.createReadStream({ start: 0, autoClose: false }), limit,
        fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
      checkAbort(signal);
      const after = await source.file.stat();
      if (bytes !== source.stat.size || after.size !== source.stat.size || after.mtimeMs !== source.stat.mtimeMs) {
        throw new Error('source changed while attaching');
      }
      await fsp.utimes(temporary, source.stat.atime, source.stat.mtime);
      checkAbort(signal);
      await fsp.rename(temporary, destination);
      committed = true;
      checkAbort(signal);
      return metadata(id, source.stat);
    } catch (error) {
      await fsp.unlink(temporary).catch(() => {});
      if (committed) await fsp.unlink(destination).catch(() => {});
      checkAbort(signal);
      return { status: 'error', message: '보고서 사본을 저장하지 못했습니다. 파일을 확인한 뒤 다시 첨부해 주세요.' };
    } finally { await source.file.close().catch(() => {}); }
  }

  async function openReport(id) {
    const report = await getReport(id);
    if (report.status !== 'ready') return { ok: false, error: report.message };
    try {
      if (typeof openPath !== 'function' || await openPath(path.join(directory, `${id}.pdf`))) throw new Error('viewer unavailable');
      return { ok: true };
    } catch { return { ok: false, error: 'PDF를 열지 못했습니다. 기본 PDF 앱을 확인해 주세요.' }; }
  }

  async function readReport(id) {
    if (typeof id !== 'string' || !REPORT_ID.test(id)) return { ok: false, error: '올바른 보고서 ID가 필요합니다.' };
    let handle;
    try {
      const cache = await fsp.lstat(directory);
      if (!cache.isDirectory() || cache.isSymbolicLink()) throw new Error('invalid cache');
      const { file, stat } = await inspect(path.join(directory, `${id}.pdf`));
      handle = file;
      // Read from the inspected handle into a bounded buffer. A growing file
      // cannot turn a renderer request into an unbounded readFile allocation.
      const data = new Uint8Array(stat.size);
      let offset = 0;
      while (offset < data.byteLength) {
        const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || Buffer.from(data.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new Error('snapshot changed while reading');
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error.code === 'ENOENT' ? '이 대화에 첨부된 보고서 파일을 찾을 수 없습니다.' : invalid().message };
    } finally { await handle?.close().catch(() => {}); }
  }
  return { attachReport, getReport, openReport, readReport };
}

let defaultStore;
function getStore() {
  if (!defaultStore) {
    const { app, shell } = require('electron');
    defaultStore = createReportStore({
      sourceFile: resolveSourceReport({ appPath: app.getAppPath(), exePath: app.getPath('exe'), isPackaged: app.isPackaged }),
      directory: path.join(app.getPath('userData'), 'reports'), openPath: filename => shell.openPath(filename),
    });
  }
  return defaultStore;
}

module.exports = { createReportStore, resolveSourceReport, MAX_REPORT_BYTES, WORKSPACE_MARKER,
  attachReport: options => getStore().attachReport(options),
  getReport: id => getStore().getReport(id),
  openReport: id => getStore().openReport(id),
  readReport: id => getStore().readReport(id),
};
