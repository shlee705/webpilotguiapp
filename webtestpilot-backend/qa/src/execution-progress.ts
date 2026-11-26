// Display-only worker observations. Never use Playwright's internal process IPC.
import { appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Page } from 'playwright';
import type { BackendAction } from './progress.ts';
import { progressUrl } from './progress-url.ts';
import { privateText } from './privacy.ts';

export type ExecutionProgress = { url: string; action: BackendAction };
const ACTIONS = new Set(['navigate', 'snapshot', 'click', 'fill', 'select', 'press', 'inspect']);
const FILE = /^\.desktop-progress\.\d+\.jsonl$/;
const MAX_LINE = 16384;
export const MAX_PROGRESS_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 65536;

function safeUrl(value: unknown, origins: string[]): string | undefined {
  if (typeof value !== 'string') return;
  for (const origin of origins) {
    const url = progressUrl(value, origin);
    if (url && privateText(url) === url) {
      let decoded = url;
      try { decoded = decodeURIComponent(url); } catch { /* Compare the original if escapes are malformed. */ }
      if (privateText(decoded) === decoded) return url;
    }
  }
}

/** The caller supplies the actual page URL, not a planned destination or action value. */
export function recordExecutionProgress(page: Pick<Page, 'url'>, action: ExecutionProgress['action'], origins: string[]): void {
  if (process.env.QA_EXECUTION_PROGRESS !== '1' || !process.env.QA_RUN_DIR || !ACTIONS.has(action)) return;
  try {
    const url = safeUrl(page.url(), origins);
    if (!url) return;
    const line = JSON.stringify({ at: Date.now(), url, action }) + '\n';
    if (line.length > MAX_LINE) return;
    // Separate files prevent concurrent workers from interleaving partial records.
    const file = join(process.env.QA_RUN_DIR, `.desktop-progress.${process.pid}.jsonl`);
    let size = 0;
    try { size = statSync(file).size; } catch { /* A new worker has no progress file yet. */ }
    if (size + Buffer.byteLength(line) > MAX_PROGRESS_FILE_BYTES) writeFileSync(file, line, { mode: 0o600 });
    else appendFileSync(file, line, { mode: 0o600 });
  } catch { /* Display collection never changes execution or evidence. */ }
}

type Cursor = { offset: number; pending: string; dropping: boolean; decoder: StringDecoder };

/** Read only appended bytes; tolerate partial records and discard malformed/private metadata. */
export function createExecutionProgressReader(directory: string, origins: string[], sink: (event: ExecutionProgress) => unknown) {
  const cursors = new Map<string, Cursor>();
  let stopped = false;
  let latestAt = 0;
  const files = () => { try { return readdirSync(directory).filter(name => FILE.test(name)); } catch { return []; } };
  const drain = () => {
    if (stopped) return;
    const events: (ExecutionProgress & { at: number })[] = [];
    for (const name of files()) {
      let fd: number | undefined;
      try {
        fd = openSync(join(directory, name), 'r');
        const size = fstatSync(fd).size;
        if (size > MAX_PROGRESS_FILE_BYTES) continue;
        let cursor = cursors.get(name);
        if (!cursor || cursor.offset > size) {
          cursor = { offset: 0, pending: '', dropping: false, decoder: new StringDecoder('utf8') };
          cursors.set(name, cursor);
        }
        // Slow consumers display recent real observations rather than blocking QA
        // to replay an old backlog. Each worker file has bounded memory and I/O.
        if (size - cursor.offset > MAX_READ_BYTES) {
          cursor.offset = size - MAX_READ_BYTES; cursor.pending = ''; cursor.dropping = true; cursor.decoder = new StringDecoder('utf8');
        }
        const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, Math.max(1, size - cursor.offset)));
        while (cursor.offset < size) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - cursor.offset), cursor.offset);
          if (!count) break;
          cursor.offset += count;
          let text = cursor.decoder.write(buffer.subarray(0, count));
          if (cursor.dropping) {
            const end = text.indexOf('\n');
            if (end < 0) continue;
            text = text.slice(end + 1); cursor.dropping = false;
          }
          cursor.pending += text;
          let end;
          while ((end = cursor.pending.indexOf('\n')) >= 0) {
            const line = cursor.pending.slice(0, end); cursor.pending = cursor.pending.slice(end + 1);
            if (line.length > MAX_LINE) continue;
            try {
              const value = JSON.parse(line);
              const url = safeUrl(value?.url, origins);
              if (url && Number.isSafeInteger(value.at) && value.at >= latestAt && value.at <= Date.now() + 1000 && ACTIONS.has(value.action)) {
                events.push({ at: value.at, url, action: value.action });
              }
            } catch { /* Incomplete and malformed display data is not inspection evidence. */ }
          }
          if (cursor.pending.length > MAX_LINE) { cursor.pending = ''; cursor.dropping = true; }
        }
      } catch { /* A worker may exit or its optional display file may be unavailable. */ }
      finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } }
    }
    for (const { at, ...event } of events.sort((a, b) => a.at - b.at)) {
      latestAt = Math.max(latestAt, at);
      try { Promise.resolve(sink(event)).catch(() => {}); } catch { /* GUI failure cannot alter QA. */ }
    }
  };
  const timer = setInterval(drain, 100);
  timer.unref();
  return {
    drain,
    stop() {
      if (stopped) return;
      clearInterval(timer);
      try { drain(); } finally {
        stopped = true;
        for (const name of files()) try { unlinkSync(join(directory, name)); } catch { /* best effort */ }
        cursors.clear();
      }
    },
  };
}
