const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createCaptureStore(directory) {
  function saveCapture(imageDataUrl, metadata) {
    if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/png;base64,') || imageDataUrl.length > MAX_BYTES * 1.4) {
      throw new Error('저장할 화면 캡처 형식이 올바르지 않습니다.');
    }
    const image = Buffer.from(imageDataUrl.slice('data:image/png;base64,'.length), 'base64');
    if (image.length > MAX_BYTES || !image.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG 화면 캡처만 저장할 수 있습니다.');
    if (!metadata || !Number.isInteger(metadata.index) || metadata.index < 1 || metadata.index > 1000) throw new Error('캡처 순서가 올바르지 않습니다.');
    let url;
    try { url = new URL(metadata.url); } catch { throw new Error('캡처한 페이지 주소가 올바르지 않습니다.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.href.length > 8192) throw new Error('캡처한 페이지 주소가 올바르지 않습니다.');
    const id = randomUUID();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.png`), image, { flag: 'wx', mode: 0o600 });
    return { id, url: url.href, index: metadata.index, createdAt: new Date().toISOString() };
  }

  function readCapture(id) {
    if (typeof id !== 'string' || !CAPTURE_ID.test(id)) throw new Error('올바른 캡처 ID가 필요합니다.');
    const filename = path.join(directory, `${id}.png`);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('화면 캡처 파일을 읽을 수 없습니다.');
    const image = fs.readFileSync(filename);
    if (!image.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('화면 캡처 파일이 손상되었습니다.');
    return `data:image/png;base64,${image.toString('base64')}`;
  }
  return { saveCapture, readCapture };
}

let defaultStore;
function getStore() {
  if (!defaultStore) defaultStore = createCaptureStore(path.join(require('electron').app.getPath('userData'), 'captures'));
  return defaultStore;
}

module.exports = {
  createCaptureStore,
  saveCapture: (image, metadata) => getStore().saveCapture(image, metadata),
  readCapture: id => getStore().readCapture(id),
};
