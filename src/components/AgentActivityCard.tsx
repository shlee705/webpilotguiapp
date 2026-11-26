import { useEffect, useState } from 'react';
import { Check, Clock3, Globe2, Pause, TriangleAlert } from 'lucide-react';
import type { AgentActivity, InspectionStatus, MessageStatus } from '../types';
import '../tour.css';
import '../activity.css';

interface Props { activity: AgentActivity; inspection?: InspectionStatus; status?: MessageStatus; startedAt: string; reportCompleted?: boolean; reportUnavailable?: boolean }
const elapsedSince = (startedAt: string) => Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)) || 0;
const formatElapsed = (seconds: number) => String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
function compactUrl(value: string) {
  try { const url = new URL(value); return url.host + (url.pathname === '/' ? '' : url.pathname); }
  catch { return value; }
}

export default function AgentActivityCard({ activity, inspection, status, startedAt, reportCompleted = false, reportUnavailable = false }: Props) {
  const { phase, actionCount, visitedCount } = activity;
  const failedReport = reportUnavailable && status !== 'streaming' && status !== 'cancelled';
  const stopped = status === 'cancelled' || status === 'error' || failedReport;
  const active = !stopped && status !== 'complete' && phase !== 'complete';
  const [elapsed, setElapsed] = useState(() => active ? elapsedSince(startedAt) : 0);
  useEffect(() => {
    if (!active) return;
    setElapsed(elapsedSince(startedAt));
    const timer = window.setInterval(() => setElapsed(elapsedSince(startedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  const completed = !active && !stopped;
  const title = reportCompleted ? '보고서 생성을 완료했습니다' : failedReport ? '보고서를 불러오지 못했습니다' : stopped ? (status === 'cancelled' ? '버그 탐색을 중지했습니다' : '버그 탐색을 완료하지 못했습니다') : completed ? '웹사이트 버그 탐색을 마쳤습니다' : phase === 'finalizing' ? '버그 탐색 보고서를 준비하고 있습니다...' : '웹사이트 버그 탐색중...';
  const descriptions = { reading: '현재 페이지와 조작할 수 있는 요소를 읽고 있습니다', thinking: '모델이 다음 이동과 동작을 선택하고 있습니다', acting: '선택한 요소를 실제로 클릭하고 입력하고 있습니다', finalizing: '작업을 정리하고 보고서 파일을 확인하고 있습니다', complete: '버그 탐색이 완료되었습니다' };
  const StaticIcon = status === 'cancelled' ? Pause : status === 'error' || failedReport ? TriangleAlert : Check;
  const phaseLabel = { reading: '페이지 읽기', thinking: '동작 선택', acting: '실제 조작', finalizing: '보고서 정리', complete: '완료' }[phase];
  const backendLabel = reportCompleted ? '보고서 생성 완료' : inspection && { starting: '실제 검사 준비', mapping: '사이트 구조 확인', exploring: '검사 대상 탐색·계획', executing: '검사 계획 실행', judging: '결과 판정·재현', reporting: '보고서 생성', complete: '실제 검사 완료', incomplete: '일부 검사 미완료', error: '실제 검사 종료 · 오류 확인 필요', cancelled: '실제 검사 중지' }[inspection.phase];
  return <section className={'agent-activity pilot-activity ' + (active ? 'agent-activity-active' : 'agent-activity-ended') + ' agent-activity-' + (failedReport ? 'error' : stopped ? status : phase)} aria-label="에이전트 버그 탐색 상태">
    {backendLabel && <div className="inspection-status" role="status"><span>실제 검사</span><strong>{backendLabel}</strong>{inspection?.url && <small title={inspection.url}>{compactUrl(inspection.url)}</small>}</div>}
    {active ? <>
      <div className="agent-activity-main">
        <span className="agent-activity-symbol" aria-hidden="true"><i /><i /><i /></span>
        <div className="agent-activity-copy"><h3 role="status" aria-live="polite">{title}</h3><p>{activity.detail || descriptions[phase]}</p></div>
        <span className="agent-activity-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
      </div>
      <div className="agent-activity-location" title={activity.url}><Globe2 size={12} aria-hidden="true" /><span>{compactUrl(activity.url)}</span></div>
      <div className="agent-activity-bottom">
        <span className="agent-activity-stage-current">{phaseLabel}</span>
        <span className="agent-activity-count">{inspection && '화면 표현 · '}방문 <strong>{visitedCount}</strong>곳 <span aria-hidden="true">·</span> 동작 <strong>{actionCount}</strong>회</span>
        <span className="agent-activity-elapsed" aria-label={'경과 시간 ' + elapsed + '초'}><Clock3 size={11} aria-hidden="true" />{formatElapsed(elapsed)}</span>
      </div>
    </> : <div className="agent-activity-summary"><span className="agent-activity-end-icon"><StaticIcon size={15} /></span><div><h3 role="status">{title}</h3><p>{inspection && '화면 표현 · '}방문한 페이지 {visitedCount}곳 <span>·</span> 수행한 동작 {actionCount}회</p></div>{completed && <span className="agent-activity-done-label">완료</span>}</div>}
  </section>;
}
