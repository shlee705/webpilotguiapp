import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, FileText, LoaderCircle, Maximize2, Minus, Plus, RotateCw, X } from 'lucide-react';
// Electron's embedded Chromium needs PDF.js's compatibility build/polyfills.
import { getDocument, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker';
import '../pdf-viewer.css';

interface Props { reportId: string; onClose: () => void; onRefresh: () => void }

export default function PdfViewer({ reportId, onClose, onRefresh }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState<number | null>(null);
  const [effectiveZoom, setEffectiveZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    let worker: Worker | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setError(''); setDocument(null); setPage(1); setZoom(null);
    paper.current?.replaceChildren();
    void (async () => {
      try {
        if (!window.pilotDesktop?.readReport) throw new Error('데스크톱 앱에서 보고서를 열어 주세요.');
        const result = await window.pilotDesktop.readReport(reportId);
        if (!active) return;
        if (!result.ok) throw new Error(result.error);
        worker = new PdfWorker();
        const workerFailure = new Promise<never>((_resolve, reject) => {
          const fail = () => {
            if (active) { setError('PDF 표시 기능을 불러오지 못했습니다. 다시 시도해 주세요.'); setLoading(false); setRendering(false); }
            reject(new Error('PDF worker failed'));
          };
          worker!.addEventListener('error', fail, { once: true });
          worker!.addEventListener('messageerror', fail, { once: true });
          loadTimer = setTimeout(fail, 30_000);
        });
        const assets = new URL('./pdfjs/', window.document.baseURI).href;
        task = getDocument({
          data: result.data,
          worker: PDFWorker.create({ port: worker }),
          cMapUrl: `${assets}cmaps/`, cMapPacked: true,
          standardFontDataUrl: `${assets}standard_fonts/`,
          wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`,
          useWorkerFetch: false, disableWorkerRendering: true, enableXfa: false,
        });
        const pdf = await Promise.race([task.promise, workerFailure]);
        if (active) setDocument(pdf);
      } catch (cause) {
        if (!active) return;
        worker?.terminate();
        const name = cause instanceof Error ? cause.name : '';
        setError(name === 'PasswordException' ? '암호가 설정된 PDF는 열 수 없습니다. 암호를 해제한 보고서를 다시 첨부해 주세요.'
          : name === 'InvalidPDFException' ? 'PDF 파일이 손상되어 열 수 없습니다. 보고서 파일을 확인해 주세요.'
          : cause instanceof Error && !task ? cause.message : '보고서를 표시하지 못했습니다. 다시 시도해 주세요.');
      } finally { clearTimeout(loadTimer); if (active) setLoading(false); }
    })();
    return () => {
      active = false;
      clearTimeout(loadTimer);
      if (task) {
        // A failed worker cannot acknowledge destroy; release its port anyway.
        const fallback = setTimeout(() => worker?.terminate(), 1000);
        void task.destroy().catch(() => {}).finally(() => { clearTimeout(fallback); worker?.terminate(); });
      }
      else worker?.terminate();
    };
  }, [reportId, attempt]);

  useEffect(() => { setPageInput(String(page)); }, [page]);

  useEffect(() => {
    if (!document || !size.width || !size.height) return;
    let active = true;
    let task: RenderTask | undefined;
    setRendering(true);
    void (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (!active) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = zoom ?? Math.max(.1, Math.min((size.width - 48) / base.width, (size.height - 48) / base.height, 2));
        const view = pdfPage.getViewport({ scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (view.width * view.height)));
        // Render offscreen so rapid page/zoom changes never reuse a running canvas.
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(view.width * pixelRatio); canvas.height = Math.ceil(view.height * pixelRatio);
        canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `PDF ${page}페이지`);
        task = pdfPage.render({ canvas, viewport: view, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        await task.promise;
        if (!active) return;
        paper.current?.replaceChildren(canvas);
        viewport.current?.scrollTo(0, 0);
        setEffectiveZoom(scale);
      } catch (cause) {
        if (active && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          console.error('PDF page rendering failed:', cause instanceof Error ? `${cause.name}: ${cause.message}` : 'Unknown rendering error');
          setError('이 페이지를 표시하지 못했습니다. 다시 시도해 주세요.');
        }
      } finally { if (active) setRendering(false); }
    })();
    return () => { active = false; task?.cancel(); };
  }, [document, page, zoom, size]);

  const unavailable = loading || !document || !!error;
  function changeZoom(delta: number) { setZoom(value => Math.min(3, Math.max(.25, Math.round(((value ?? effectiveZoom) + delta) * 100) / 100))); }
  function jump() {
    const next = Number(pageInput);
    if (document && Number.isSafeInteger(next) && next >= 1 && next <= document.numPages) setPage(next);
    else setPageInput(String(page));
  }

  return createPortal(<dialog ref={dialog} className="pdf-viewer" aria-label="PDF 보고서 뷰어"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="pdf-viewer-header"><span className="pdf-viewer-file"><FileText size={19} /><span><strong>report.pdf</strong><small>버그 탐색 보고서</small></span></span>
      <button type="button" className="pdf-tool" aria-label="PDF 뷰어 닫기" title="닫기 (Esc)" autoFocus onClick={onClose}><X size={19} /></button>
    </header>
    <div className="pdf-toolbar" aria-label="PDF 보기 도구">
      <div className="pdf-toolbar-group">
        <button type="button" className="pdf-tool" aria-label="이전 페이지" title="이전 페이지" disabled={unavailable || page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /></button>
        <form className="pdf-page-picker" onSubmit={event => { event.preventDefault(); jump(); }}>
          <input aria-label="페이지 번호" inputMode="numeric" value={pageInput} disabled={unavailable} onChange={event => setPageInput(event.target.value)} onBlur={jump} />
          <span aria-hidden="true">/ {document?.numPages ?? '—'}</span>
        </form>
        <span className="sr-only" role="status">{document ? `${page} / ${document.numPages}` : 'PDF 불러오는 중'}</span>
        <button type="button" className="pdf-tool" aria-label="다음 페이지" title="다음 페이지" disabled={unavailable || page === document?.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={17} /></button>
      </div>
      <span className="pdf-toolbar-divider" />
      <div className="pdf-toolbar-group">
        <button type="button" className="pdf-tool" aria-label="축소" title="축소" disabled={unavailable || effectiveZoom <= .25} onClick={() => changeZoom(-.25)}><Minus size={16} /></button>
        <span className="pdf-zoom-label">{unavailable ? '—' : `${Math.round(effectiveZoom * 100)}%`}</span>
        <button type="button" className="pdf-tool" aria-label="확대" title="확대" disabled={unavailable || effectiveZoom >= 3} onClick={() => changeZoom(.25)}><Plus size={16} /></button>
        <button type="button" className="pdf-tool pdf-fit" aria-label="페이지 맞춤" title="페이지 맞춤" disabled={unavailable} onClick={() => setZoom(null)}><Maximize2 size={15} /><span>페이지 맞춤</span></button>
      </div>
    </div>
    <div className="pdf-viewport" ref={viewport} aria-busy={loading || rendering}>
      <div className="pdf-paper" ref={paper} hidden={!!error || loading} />
      {(loading || rendering) && !error && <div className="pdf-loading" role="status"><LoaderCircle size={16} className="spin" />{loading ? '보고서를 불러오는 중…' : '페이지를 표시하는 중…'}</div>}
      {error && <div className="pdf-viewer-error" role="alert"><FileText size={30} /><strong>보고서를 열 수 없습니다</strong><p>{error}</p><div className="pdf-error-actions"><button type="button" onClick={() => setAttempt(value => value + 1)}><RotateCw size={14} />다시 시도</button><button type="button" onClick={onRefresh}>보고서 다시 불러오기</button></div></div>}
    </div>
  </dialog>, window.document.body);
}
