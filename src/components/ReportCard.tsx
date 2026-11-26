import { lazy, Suspense, useState } from 'react';
import { FileText, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReportResult } from '../types';
import { parseReportResult } from '../lib/reports';
import '../tour.css';
import '../activity.css';

const PdfViewer = lazy(() => import('./PdfViewer'));

interface Props { report: ReportResult; onChange: (report: ReportResult) => void; disabled?: boolean }

export default function ReportCard({ report, onChange, disabled = false }: Props) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState(false);
  const ready = report.status === 'ready';
  async function refresh() {
    if (working || disabled) return;
    setWorking(true); setError('');
    try {
      if (!window.pilotDesktop?.refreshReport) throw new Error();
      const next = parseReportResult(await window.pilotDesktop.refreshReport(report.runId));
      if (!next) throw new Error();
      onChange(next);
    } catch { setError('보고서를 불러오지 못했습니다. 파일을 확인한 뒤 다시 시도해 주세요.'); }
    finally { setWorking(false); }
  }
  return <section className={'report-card pilot-report ' + (ready ? 'report-ready' : 'report-pending')} aria-label="버그 탐색 보고서" aria-busy={working}>
    <div className="report-card-main"><span className="report-file-icon" aria-hidden="true"><FileText size={24} strokeWidth={1.35} /><b>PDF</b></span><div className="report-file-info"><strong>report.pdf</strong><span>{report.runId ? (report.inspectionCompleted === false ? '실제 검사 결과 · 검사 범위는 보고서에서 확인' : '이번 실행의 실제 검사 보고서') : 'testReport/report.pdf'}</span><small>{ready ? `${(report.size / 1024 / 1024).toFixed(1)} MB · 버그 탐색 보고서` : report.message}</small></div>
      <button type="button" className="report-open" disabled={working || disabled} onClick={() => { if (ready) setViewing(true); else void refresh(); }}>{working ? <LoaderCircle size={14} className="spin" /> : ready ? <FileText size={14} /> : <RefreshCw size={14} />}{working ? '불러오는 중' : ready ? '보고서 열기' : '다시 불러오기'}</button>
    </div>
    {error && <div className="report-error" role="alert"><TriangleAlert size={13} /><span>{error}</span><button type="button" disabled={working || disabled} onClick={() => void refresh()}>다시 불러오기</button></div>}
    {viewing && ready && <Suspense fallback={<span role="status">PDF 뷰어를 여는 중…</span>}><PdfViewer reportId={report.id} onClose={() => setViewing(false)} onRefresh={() => { setViewing(false); void refresh(); }} /></Suspense>}
  </section>;
}
