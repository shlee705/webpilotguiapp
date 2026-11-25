import { useState, type FormEvent } from 'react';
import { API_MODELS } from '../lib/models';
import type { LoginCredentials, TourPlan } from '../types';

interface Props {
  plan: TourPlan;
  onChange: (plan: TourPlan) => void;
  onSubmit: (event: FormEvent) => void;
  error: string;
  credentials?: LoginCredentials;
  onCredentialsChange: (credentials?: LoginCredentials) => void;
}

export default function TourPlanEditor({ plan, onChange, onSubmit, error, credentials, onCredentialsChange }: Props) {
  const [customModel, setCustomModel] = useState(!API_MODELS.some(model => model.id === plan.model));
  return <form className="tour-editor" onSubmit={onSubmit}>
    <label htmlFor="tour-url">대상 URL</label>
    <input id="tour-url" value={plan.targetUrl} maxLength={8192} onChange={event => onChange({ ...plan, targetUrl: event.target.value })} autoFocus placeholder="https://example.com" />
    <label htmlFor="tour-prompt">버그 탐색 요청</label>
    <textarea id="tour-prompt" value={plan.prompt} maxLength={16000} onChange={event => onChange({ ...plan, prompt: event.target.value })} rows={4} />
    <div className="tour-editor-grid"><div>
      <label htmlFor="tour-model">탐색 모델</label>
      <select id="tour-model" value={customModel ? 'custom' : plan.model} onChange={event => {
        const custom = event.target.value === 'custom';
        setCustomModel(custom);
        if (!custom) onChange({ ...plan, model: event.target.value });
      }}>
        {API_MODELS.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        <option value="custom">모델 ID 직접 입력</option>
      </select>
    </div><div>
      <label htmlFor="tour-limit">동작 한도</label>
      <input id="tour-limit" type="number" inputMode="numeric" min="1" step="1" required value={Number.isNaN(plan.maxActions) ? '' : plan.maxActions} onChange={event => onChange({ ...plan, maxActions: event.target.value === '' ? NaN : Number(event.target.value) })} aria-describedby="tour-limit-hint" />
      <p id="tour-limit-hint" className="tour-input-hint">1 이상의 정수를 입력하세요.</p>
    </div></div>
    {customModel && <><label htmlFor="tour-custom-model">모델 ID</label><input id="tour-custom-model" value={plan.model} maxLength={120} onChange={event => onChange({ ...plan, model: event.target.value })} /></>}
    <div className="tour-login-fields">
      <label className="tour-login-toggle"><input type="checkbox" checked={!!plan.loginEnabled} onChange={event => { onChange({ ...plan, loginEnabled: event.target.checked }); if (!event.target.checked) onCredentialsChange(undefined); }} /><span>로그인 계정 사용</span></label>
      {plan.loginEnabled && <>
        <label htmlFor="tour-username">사이트 아이디</label><input id="tour-username" value={credentials?.username ?? ''} maxLength={256} autoComplete="off" onChange={event => onCredentialsChange({ username: event.target.value, password: credentials?.password ?? '' })} placeholder="아이디 또는 이메일" />
        <label htmlFor="tour-password">사이트 비밀번호</label><input id="tour-password" type="password" value={credentials?.password ?? ''} maxLength={1024} autoComplete="new-password" onChange={event => onCredentialsChange({ username: credentials?.username ?? '', password: event.target.value })} />
        <p className="tour-login-note">이번 작업에서만 사용합니다. 계정 정보는 대화 기록에 저장하거나 모델에 전달하지 않습니다.</p>
      </>}
    </div>
    <p className="tour-editor-note">동일 출처의 사이트 안에서만 이동합니다. 지정한 계정의 로그인 외에 결제·삭제·다른 폼 제출은 진행하지 않습니다.</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="primary-button" type="submit">설정 적용</button></div>
  </form>;
}
