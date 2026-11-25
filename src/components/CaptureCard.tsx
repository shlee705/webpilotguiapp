import { useEffect, useState } from 'react';
import { Camera, LoaderCircle, Maximize2 } from 'lucide-react';
import type { Capture } from '../types';

export default function CaptureCard({ capture }: { capture: Capture }) {
  const [image, setImage] = useState('');
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    void window.pilotDesktop?.getCapture(capture.id).then(result => {
      if (!active) return;
      if (result.ok && result.imageUrl) setImage(result.imageUrl); else setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [capture.id]);
  return <figure className={`capture-card ${expanded ? 'expanded' : ''}`}>
    <button className="capture-image" onClick={() => setExpanded(value => !value)} aria-label={`스크린샷 ${capture.index} ${expanded ? '축소' : '확대'}`} disabled={!image}>
      {image ? <><img alt={`브라우저 캡처 ${capture.index}`} src={image} loading="lazy" /><span className="capture-zoom"><Maximize2 size={14} /></span></> : <span className="capture-placeholder">{failed ? <><Camera size={22} />저장된 이미지를 불러올 수 없습니다</> : <LoaderCircle size={20} className="spin" />}</span>}
    </button>
    <figcaption><span><Camera size={12} />스크린샷 {String(capture.index).padStart(2, '0')}</span><time>{new Date(capture.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time></figcaption><p title={capture.url}>{capture.url}</p>
  </figure>;
}
