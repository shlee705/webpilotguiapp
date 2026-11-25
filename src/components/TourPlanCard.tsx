import { Check, LoaderCircle, Pause, TriangleAlert } from 'lucide-react';
import type { TourPlan } from '../types';
import { API_MODELS } from '../lib/models';
import '../tour.css';
import '../plan-card.css';

interface TourPlanCardProps {
  plan: TourPlan;
  onStart: () => void;
  onEdit: () => void;
  disabled?: boolean;
  credentialsReady?: boolean;
  animate?: boolean;
}

const stateLabels: Record<TourPlan['state'], string> = {
  pending: '시작 대기', running: '버그 탐색중', complete: '탐색 완료', cancelled: '탐색 중지', error: '실행 오류',
};

export default function TourPlanCard({ plan, onStart, onEdit, disabled = false, credentialsReady = false, animate = false }: TourPlanCardProps) {
  const modelName = API_MODELS.find(model => model.id === plan.model)?.name ?? plan.model;
  const pending = plan.state === 'pending';
  const retryable = plan.state === 'error' || plan.state === 'cancelled';
  const StateIcon = plan.state === 'running' ? LoaderCircle : plan.state === 'complete' ? Check : plan.state === 'cancelled' ? Pause : TriangleAlert;
  return <section className={`tour-plan reference-plan tour-plan-${plan.state}${animate && pending ? ' reference-plan--animate' : ''}`} aria-label="버그 탐색 계획">
    <div className="reference-plan-frame">
    <div className="reference-plan-header"><h3>테스트 설정</h3><span className="tour-plan-state">{pending ? '기본값' : <><StateIcon size={10} />{stateLabels[plan.state]}</>}</span></div>
    <table className="tour-plan-table" aria-label="테스트 설정">
      <colgroup><col className="tour-plan-label-column" /><col /></colgroup>
      <tbody>
        <tr><th scope="row">대상 URL</th><td><span className="tour-plan-url">{plan.targetUrl}</span></td></tr>
        <tr><th scope="row">탐색 범위</th><td>동일 출처 사이트 내부</td></tr>
        <tr><th scope="row">로그인</th><td>{plan.loginEnabled ? ((pending || retryable) && !credentialsReady ? '계정 다시 입력 필요' : '지정한 계정으로 로그인') : '계정 미지정 · 로그인 화면 확인 가능'}</td></tr>
        <tr><th scope="row">화면</th><td>데스크톱 · 최대화 Edge</td></tr>
        <tr><th scope="row">입력 범위</th><td>검색·제목·본문·글 등록{plan.loginEnabled && ' · 로그인'} <span className="tour-plan-value-note">· 요청한 제한 반영</span></td></tr>
        <tr><th scope="row">탐색 횟수</th><td>{plan.maxActions}회 <span className="tour-plan-value-note">· 지시한 대상 우선, 횟수 도달 시 완료</span></td></tr>
        <tr><th scope="row">모델</th><td><span className="tour-plan-model">{modelName}</span></td></tr>
        <tr><th scope="row">예상 시간</th><td className="tour-plan-time">페이지·응답 속도에 따라 달라짐</td></tr>
      </tbody>
    </table>
    </div>
    {pending || retryable ? <div className="tour-plan-confirm"><p>{retryable ? '작업이 중단되었습니다. 설정을 유지한 채 처음부터 다시 시작할 수 있어요.' : '이 설정으로 테스트를 시작하겠습니다. 진행할까요?'}</p><div className="tour-plan-actions"><button type="button" className="tour-plan-start" onClick={onStart} disabled={disabled}>{retryable ? '다시 시도' : '시작하기'}</button><button type="button" className="tour-plan-edit" onClick={onEdit} disabled={disabled}>설정 바꾸기</button></div></div> : <div className="tour-plan-result"><StateIcon size={12} /><span>{plan.state === 'running' ? '웹사이트 버그 탐색중...' : '웹사이트 버그 탐색을 마쳤습니다.'}</span></div>}
  </section>;
}
