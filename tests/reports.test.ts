import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReportResult, hasCompletedReport, isLegacyPartialReport } from '../src/lib/reports';
import type { ChatMessage } from '../src/types';

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

test('preserves verified backend run identity and partial-result status without native paths', () => {
  const runId = '55320ad0-85a0-4bf1-ad89-a754e246e4c2';
  assert.deepEqual(parseReportResult({ ...ready, runId, inspectionCompleted: false, sourceFile: 'private' }), { ...ready, runId, inspectionCompleted: false });
  assert.deepEqual(parseReportResult({ status: 'error', message: '첨부 오류', runId, inspectionCompleted: true }), { status: 'error', message: '첨부 오류', runId, inspectionCompleted: true });
  for (const runId of ['../old-report', '', false]) assert.equal(parseReportResult({ ...ready, runId }), undefined);
  assert.equal(parseReportResult({ ...ready, runId, inspectionCompleted: 'true' }), undefined);
});

test('report completion presentation preserves partial scope and never masks other errors or cancellation', () => {
  const report = parseReportResult({ ...ready, runId: '55320ad0-85a0-4bf1-ad89-a754e246e4c2', inspectionCompleted: false })!;
  const message: ChatMessage = { id: 'result', role: 'assistant', createdAt: ready.updatedAt, status: 'error',
    content: '일부 검사를 완료하지 못해 현재까지의 결과 보고서를 첨부했어요.\n\n실제 검사에 미완료 항목이 있습니다. 첨부된 보고서의 검사 범위를 확인해 주세요.', report,
    inspection: { phase: 'incomplete', url: 'https://example.test/' } };
  const before = JSON.stringify(message);
  assert.equal(isLegacyPartialReport(message), true);
  assert.equal(hasCompletedReport(message), true);
  assert.equal(hasCompletedReport({ ...message, status: 'complete', content: '보고서 생성을 완료했어요.' }), true);
  for (const changed of [
    { ...message, content: message.content + '\n\n응답을 받지 못했습니다. 연결 오류입니다.' },
    { ...message, status: 'cancelled' as const }, { ...message, status: 'streaming' as const },
    { ...message, report: { status: 'error' as const, message: '첨부 실패' } },
    { ...message, report: parseReportResult(ready) },
  ]) assert.equal(hasCompletedReport(changed), false);
  assert.equal(JSON.stringify(message), before);
});
