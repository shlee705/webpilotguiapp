import type { InspectionStatus } from '../types';

const phases = new Set(['starting', 'mapping', 'exploring', 'executing', 'judging', 'reporting', 'complete', 'incomplete', 'error', 'cancelled']);

export function parseInspection(value: unknown): InspectionStatus | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  if (typeof input.phase !== 'string' || !phases.has(input.phase)) return;
  let url: string | undefined;
  if (input.url !== undefined) {
    if (typeof input.url !== 'string' || input.url.length > 8192) return;
    try {
      const parsed = new URL(input.url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
      url = parsed.href;
    } catch { return; }
  }
  return { phase: input.phase as InspectionStatus['phase'], ...(url ? { url } : {}) };
}
