import type { ReportResult } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keep only validated display metadata; never accept a filesystem path or PDF bytes. */
export function parseReportResult(value: unknown): ReportResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const report = value as Record<string, unknown>;
  if (report.status === 'ready') {
    if (typeof report.id !== 'string' || !UUID.test(report.id) || report.name !== 'report.pdf'
      || typeof report.size !== 'number' || !Number.isSafeInteger(report.size) || report.size <= 0
      || typeof report.updatedAt !== 'string') return;
    const timestamp = new Date(report.updatedAt);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== report.updatedAt) return;
    return { status: 'ready', id: report.id, name: 'report.pdf', size: report.size, updatedAt: report.updatedAt };
  }
  if ((report.status === 'missing' || report.status === 'error') && typeof report.message === 'string'
    && report.message.trim() && report.message.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(report.message)) {
    return { status: report.status, message: report.message };
  }
  return undefined;
}
