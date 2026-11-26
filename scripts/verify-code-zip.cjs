'use strict';
// Read-only, streaming verification of GitHub Code > Download ZIP releases.
// Source/ASAR credential-content auditing is performed separately.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const asar = require('@electron/asar');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function prohibitedPath(filename, payload = false) {
  const parts = filename.split('/');
  const base = parts.at(-1);
  if (/^\.env(?:\.|$)/i.test(base) && (payload || base !== '.env.example')) return true;
  if (/^(?:\.npmrc|\.pypirc|ai-settings\.json|auth_state\.json|storage_state\.json|storageState\.json|\.desktop-result\.json|Cookies|Login Data|Web Data|Local State|Preferences|Secure Preferences)$/i.test(base)) return true;
  if (/\.(?:log|har)$/i.test(base)) return true;
  // Do not reject ordinary vendor files such as profile.js, logging.ts or
  // credentials.js; these exact directories/files hold actual local state.
  if (parts.some(part => /^(?:backend-runs|\.browser-profile|\.aws|\.ssh|\.codex|\.git|test-results|playwright-report)$/i.test(part))) return true;
  return /(?:^|\/)qa\/runs(?:\/|$)/i.test(filename);
}
function isLfsPointer(prefix, size) {
  return size <= 4096 && /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(prefix.toString('ascii'));
}
function digestStream(stream) {
  // yauzl 2.x exposes fd-slicer's legacy stream for STORED entries. It marks
  // itself destroyed before emitting end, which can leave modern Node async
  // iterators pending forever. Its documented data/end API remains reliable.
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    let size = 0;
    let prefix = Buffer.alloc(0);
    let ended = false;
    stream.once('error', reject);
    stream.once('close', () => { if (!ended) reject(Object.assign(new Error('stream-closed-before-end'), { code: 'stream-closed-before-end' })); });
    stream.once('end', () => { ended = true; resolve({ size, sha256: digest.digest('hex'), prefix }); });
    stream.on('data', chunk => {
      digest.update(chunk); size += chunk.length;
      if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
    });
  });
}
async function candidateManifest(directory) {
  const files = new Map();
  async function visit(folder, relative = '') {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      const name = relative + entry.name;
      const absolute = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) fail('candidate-link-forbidden');
      if (entry.isDirectory()) { await visit(absolute, `${name}/`); continue; }
      if (!entry.isFile()) fail('candidate-special-file-forbidden');
      if (prohibitedPath(name, true)) fail('candidate-private-path-forbidden');
      const before = await fs.promises.stat(absolute);
      const result = await digestStream(fs.createReadStream(absolute));
      const after = await fs.promises.stat(absolute);
      if (before.size !== result.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('candidate-changed-during-verification');
      if (isLfsPointer(result.prefix, result.size)) fail('candidate-lfs-pointer');
      files.set(name, { size: result.size, sha256: result.sha256, mz: result.prefix.subarray(0, 2).toString('ascii') === 'MZ' });
    }
  }
  await visit(directory);
  return files;
}
function openZip(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename,
    { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
    (error, zip) => error ? reject(error) : resolve(zip)));
}
function openEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function verifyCodeZip(candidate, archive) {
  candidate = fs.realpathSync(path.resolve(candidate));
  archive = fs.realpathSync(path.resolve(archive));
  const manifestBytes = asar.extractFile(path.join(candidate, 'resources', 'app.asar'), 'package.json');
  if (manifestBytes.length > 65536) fail('candidate-manifest-too-large');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.name !== 'webpilot-desktop' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) fail('candidate-version-invalid');
  const version = manifest.version;
  const prefix = `release/${version}/win-unpacked/`;
  const candidateFiles = await candidateManifest(candidate);
  const required = ['WebPilot.exe', 'resources/app.asar', 'resources/backend-runtime/node.exe',
    'resources/webtestpilot-backend/qa/src/cli.ts'];
  for (const name of required) if (!candidateFiles.has(name)) fail('candidate-required-runtime-missing');
  const browsers = [...candidateFiles.keys()].filter(name => /^resources\/webtestpilot-backend\/\.browsers\/.+\/(?:chrome-headless-shell|headless_shell|chrome)\.exe$/i.test(name));
  if (!browsers.length) fail('candidate-bundled-browser-missing');
  for (const name of ['WebPilot.exe', 'resources/backend-runtime/node.exe', ...browsers]) {
    if (!candidateFiles.get(name).mz) fail('candidate-executable-not-pe');
  }

  const zip = await openZip(archive);
  const seen = new Set();
  const matched = new Set();
  const oldReleaseRules = [];
  let root;
  let zipManifest;
  let attributes;
  let entries = 0;
  let payloadBytes = 0;
  let zipBytesRead = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', entry => {
        void (async () => {
          const name = entry.fileName;
          if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')) fail('zip-path-invalid');
          const pieces = name.split('/');
          if (!root) root = pieces[0];
          if (!root || pieces[0] !== root || (!name.endsWith('/') && pieces.length < 2)) fail('zip-repository-root-invalid');
          const relative = pieces.slice(1).join('/');
          const identity = name.toLowerCase();
          if (seen.has(identity)) fail('zip-duplicate-path');
          seen.add(identity);
          const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (unixType && unixType !== 0x8000 && unixType !== 0x4000) fail('zip-special-file-forbidden');
          const payload = relative.startsWith(prefix);
          if (prohibitedPath(relative.replace(/\/$/, ''), payload)) fail('zip-private-path-forbidden');
          if (relative.startsWith('release/')) {
            const releaseVersion = relative.split('/')[1];
            if (releaseVersion && releaseVersion !== version) fail('zip-old-release-not-export-ignored');
          }
          if (!payload && relative.split('/').includes('node_modules')) fail('zip-source-node-modules-forbidden');
          if (name.endsWith('/')) { zip.readEntry(); return; }
          entries++;
          const payloadName = payload ? relative.slice(prefix.length) : undefined;
          const expected = payload ? candidateFiles.get(payloadName) : undefined;
          if (payload && !expected) fail('zip-extra-payload-file');
          // Small mismatches may be Git LFS pointer stubs; inspect their header
          // before reporting a generic size mismatch.
          if (expected && entry.uncompressedSize !== expected.size && entry.uncompressedSize > 4096) fail('zip-payload-size-mismatch');
          const collect = relative === 'package.json' || relative === '.gitattributes';
          if (collect && entry.uncompressedSize > 65536) fail('zip-metadata-too-large');
          const stream = await openEntry(zip, entry);
          const metadata = [];
          if (collect) stream.on('data', chunk => metadata.push(chunk));
          const actual = await digestStream(stream);
          zipBytesRead += actual.size;
          if (isLfsPointer(actual.prefix, actual.size)) fail('zip-lfs-pointer');
          if (expected) {
            if (actual.size !== expected.size || actual.sha256 !== expected.sha256) fail('zip-payload-digest-mismatch');
            matched.add(payloadName); payloadBytes += actual.size;
          }
          if (relative === 'package.json') zipManifest = JSON.parse(Buffer.concat(metadata).toString('utf8'));
          if (relative === '.gitattributes') attributes = Buffer.concat(metadata).toString('utf8');
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  if (matched.size !== candidateFiles.size) fail('zip-payload-files-missing');
  if (zipManifest?.name !== manifest.name || zipManifest?.version !== version || zipManifest?.webpilotWorkspace !== 'webpilot-report-root-v1') fail('zip-source-version-mismatch');
  for (const line of (attributes || '').split(/\r?\n/)) {
    const match = /^\/?release\/([^\s/*]+)(?:\/\*\*)?\/?\s+.*\bexport-ignore\b/.exec(line.trim());
    if (match && match[1] !== version) oldReleaseRules.push(match[1]);
  }
  if (!oldReleaseRules.length) fail('zip-old-release-export-ignore-rules-missing');
  return { passed: true, version, archiveEntries: entries, payloadFiles: matched.size, payloadBytes, zipBytesRead,
    fullPayloadSha256Matched: true, lfsPointers: 0, prohibitedPaths: 0, sourceNodeModules: 0,
    oldReleasesAbsent: true, oldReleaseExportIgnoreRules: oldReleaseRules.length,
    windowsExecutable: true, bundledNode: true, bundledBrowsers: browsers.length,
    streamed: true, guiOrBrowserProcessesStarted: 0 };
}

if (require.main === module) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/verify-code-zip.cjs <candidate-win-unpacked> <github-code.zip>');
    process.exitCode = 1;
  } else {
    // A pending Promise alone does not keep Node alive. Only verified success
    // may produce exit 0, even if a dependency stops delivering stream events.
    process.exitCode = 1;
    verifyCodeZip(process.argv[2], process.argv[3]).then(result => { console.log(JSON.stringify(result)); process.exitCode = 0; })
      .catch(error => { console.error(JSON.stringify({ passed: false, failure: /^[a-z0-9-]+$/i.test(error.code || '') ? error.code : 'verification-failed' })); });
  }
}
module.exports = { verifyCodeZip, prohibitedPath, isLfsPointer };
