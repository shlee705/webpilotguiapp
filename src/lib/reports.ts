import type { ChatMessage, ReportResult } from '../types';

export const REPORT_GENERATED_MESSAGE = '보고서 생성을 완료했어요. 검사 범위와 상세 결과는 첨부된 보고서에서 확인해 주세요.';

/** Older runs used a transport error for a successfully attached partial report. */
export function isLegacyPartialReport(message: ChatMessage): boolean {
  return message.status === 'error' && message.report?.status === 'ready' && !!message.report.runId
    && message.report.inspectionCompleted === false
    && /^(?:응답을 받지 못했습니다\.\s*)?실제 검사에 미완료 항목이 있습니다\.(?:\s*첨부된 보고서의 검사 범위를 확인해 주세요\.)?$/.test(message.content.trim().split(/\n\s*\n/).at(-1) ?? '');
}

export function hasCompletedReport(message: ChatMessage): boolean {
  return message.report?.status === 'ready' && !!message.report.runId
    && (message.status === 'complete' || isLegacyPartialReport(message));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keep only validated display metadata; never accept a filesystem path or PDF bytes. */
export function parseReportResult(value: unknown): ReportResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const report = value as Record<string, unknown>;
  if (report.runId !== undefined && (typeof report.runId !== 'string' || !UUID.test(report.runId))) return;
  if (report.inspectionCompleted !== undefined && typeof report.inspectionCompleted !== 'boolean') return;
  const inspection = report.runId ? { runId: report.runId as string, ...(typeof report.inspectionCompleted === 'boolean' ? { inspectionCompleted: report.inspectionCompleted } : {}) } : {};
  if (report.status === 'ready') {
    if (typeof report.id !== 'string' || !UUID.test(report.id) || report.name !== 'report.pdf'
      || typeof report.size !== 'number' || !Number.isSafeInteger(report.size) || report.size <= 0
      || typeof report.updatedAt !== 'string') return;
    const timestamp = new Date(report.updatedAt);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== report.updatedAt) return;
    return { status: 'ready', id: report.id, name: 'report.pdf', size: report.size, updatedAt: report.updatedAt, ...inspection };
  }
  if ((report.status === 'missing' || report.status === 'error') && typeof report.message === 'string'
    && report.message.trim() && report.message.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(report.message)) {
    return { status: report.status, message: report.message, ...inspection };
  }
  return undefined;
}
