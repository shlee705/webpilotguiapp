import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReportResult } from '../src/lib/reports';

const ready = { status: 'ready', id: 'c1f75f37-1698-45de-82cf-df6c8b4c0fd5', name: 'report.pdf', size: 1024, updatedAt: '2026-11-25T12:00:00.000Z' };

test('accepts canonical report metadata and drops any native file path or data', () => {
  assert.deepEqual(parseReportResult({ ...ready, path: 'C:/private/report.pdf', data: 'base64-data' }), ready);
  assert.deepEqual(parseReportResult({ status: 'missing', message: '아직 보고서가 없습니다.', path: 'private' }), { status: 'missing', message: '아직 보고서가 없습니다.' });
  assert.deepEqual(parseReportResult({ status: 'error', message: '보고서 읽기에 실패했습니다.' }), { status: 'error', message: '보고서 읽기에 실패했습니다.' });
});

test('rejects malformed UUIDs, names, file sizes, timestamps and unbounded error messages', () => {
  const invalid = [null, [], {}, { status: 'unexpected', message: 'error' },
    { ...ready, id: '../report.pdf' }, { ...ready, id: '00000000-0000-0000-0000-000000000000' },
    { ...ready, name: 'C:/report.pdf' }, { ...ready, name: 'report.PDF' },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(size => ({ ...ready, size })),
    ...['not-a-date', '2026-11-25', '2026-02-30T12:00:00.000Z'].map(updatedAt => ({ ...ready, updatedAt })),
    { status: 'error', message: '' }, { status: 'missing', message: ' ' }, { status: 'error', message: 'a'.repeat(4097) },
    { status: 'error', message: 'bad\u0000message' },
  ];
  for (const value of invalid) assert.equal(parseReportResult(value), undefined);
});
