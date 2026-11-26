import { useState, type FormEvent } from 'react';
import { modelsForProvider, PROVIDERS } from '../lib/models';
import type { ApiProvider, LoginCredentials, TourPlan } from '../types';
import BackendRunFields from './BackendRunFields';

interface Props {
  plan: TourPlan;
  onChange: (plan: TourPlan) => void;
  onSubmit: (event: FormEvent) => void;
  error: string;
  credentials?: LoginCredentials;
  onCredentialsChange: (credentials?: LoginCredentials) => void;
}

export default function TourPlanEditor({ plan, onChange, onSubmit, error, credentials, onCredentialsChange }: Props) {
  const provider = plan.provider ?? 'openai';
  const catalog = modelsForProvider(provider);
  const [customModel, setCustomModel] = useState(!catalog.some(model => model.id === plan.model));
  return <form className="tour-editor" onSubmit={onSubmit}>
    <label htmlFor="tour-url">대상 URL</label>
    <input id="tour-url" value={plan.targetUrl} maxLength={8192} onChange={event => onChange({ ...plan, targetUrl: event.target.value })} autoFocus placeholder="https://example.com" />
    <label htmlFor="tour-prompt">실제 백엔드 검사 요구사항</label>
    <textarea id="tour-prompt" value={plan.prompt} maxLength={16000} onChange={event => onChange({ ...plan, prompt: event.target.value })} rows={4} />
    <BackendRunFields value={plan.backendOptions} onChange={backendOptions => onChange({ ...plan, backendOptions })} />
    <div className="tour-login-fields">
      <h3 className="tour-role-heading">사이트 로그인</h3>
      <label className="tour-login-toggle"><input type="checkbox" checked={!!plan.loginEnabled} onChange={event => { onChange({ ...plan, loginEnabled: event.target.checked, ...(!event.target.checked ? { backendLoginUrl: undefined } : {}) }); if (!event.target.checked) onCredentialsChange(undefined); }} /><span>로그인 계정 사용</span></label>
      {plan.loginEnabled && <>
        <label htmlFor="tour-login-url">로그인 URL</label><input id="tour-login-url" value={plan.backendLoginUrl ?? ''} maxLength={8192} autoComplete="off" onChange={event => onChange({ ...plan, backendLoginUrl: event.target.value })} placeholder="비우면 대상 URL 사용 · 예: /login" />
        <p className="tour-input-hint">실제 검사와 화면 표현용 Edge가 각각 로그인할 같은 출처 주소입니다. 화면 표현은 로그인 후 백엔드의 현재 페이지를 따라갑니다.</p>
        <label htmlFor="tour-username">사이트 아이디</label><input id="tour-username" value={credentials?.username ?? ''} maxLength={256} autoComplete="off" onChange={event => onCredentialsChange({ username: event.target.value, password: credentials?.password ?? '' })} placeholder="아이디 또는 이메일" />
        <label htmlFor="tour-password">사이트 비밀번호</label><input id="tour-password" type="password" value={credentials?.password ?? ''} maxLength={1024} autoComplete="new-password" onChange={event => onCredentialsChange({ username: credentials?.username ?? '', password: event.target.value })} />
        <p className="tour-login-note">이번 실행의 실제 검사와 화면 표현 로그인에만 사용합니다. 계정은 실행 중 메모리에만 보관하며 대화 기록·모델 요청·로그·API 설정 파일에 저장하지 않습니다.</p>
      </>}
    </div>
    <h3 className="tour-role-heading">화면 표현 설정</h3>
    <label htmlFor="tour-provider">화면 표현 AI</label>
    <select id="tour-provider" value={provider} onChange={event => {
      const next = event.target.value as ApiProvider;
      setCustomModel(false); onChange({ ...plan, provider: next, model: PROVIDERS[next].defaultModel });
    }}><option value="openai">GPT (OpenAI)</option><option value="anthropic">Claude (Anthropic)</option></select>
    <div>
      <label htmlFor="tour-model">화면 표현 모델</label>
      <select id="tour-model" value={customModel ? 'custom' : plan.model} onChange={event => {
        const custom = event.target.value === 'custom';
        setCustomModel(custom);
        if (!custom) onChange({ ...plan, model: event.target.value });
      }}>
        {catalog.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        <option value="custom">모델 ID 직접 입력</option>
      </select>
    </div>
    <p className="tour-input-hint">횟수를 정하지 않고 백엔드의 현재 탐색 위치와 단계를 따라갑니다. 실제 검사가 종료되면 화면 표시도 함께 종료됩니다.</p>
    {customModel && <><label htmlFor="tour-custom-model">모델 ID</label><input id="tour-custom-model" value={plan.model} maxLength={120} onChange={event => onChange({ ...plan, model: event.target.value })} /></>}
    <p className="tour-editor-note">화면 표현 설정은 별도 Edge의 동작에만 적용됩니다. 실제 검사는 위의 백엔드 검사 설정으로 실행하며, 화면 표현은 글 등록·결제·삭제를 하지 않습니다.</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="primary-button" type="submit">설정 적용</button></div>
  </form>;
}
