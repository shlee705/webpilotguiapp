import { useEffect, useState } from 'react';
import type { ApiProvider, BackendRunOptions } from '../types';
import { modelsForProvider } from '../lib/models';
import { BACKEND_NUMBER_FIELDS, BACKEND_RUN_DEFAULTS, type BackendNumberField } from '../lib/backend-options';

const defaultModels = {
  openai: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' },
  anthropic: { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' },
};
interface Props { value?: BackendRunOptions; onChange: (value: BackendRunOptions) => void }

export default function BackendRunFields({ value = {}, onChange }: Props) {
  const options = { ...BACKEND_RUN_DEFAULTS, ...value };
  const [profiles, setProfiles] = useState(defaultModels);
  useEffect(() => {
    let mounted = true;
    void window.pilotDesktop?.getBackendSettings?.().then(settings => {
      if (mounted) setProfiles({ openai: { ...settings.profiles.openai.models }, anthropic: { ...settings.profiles.anthropic.models } });
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);
  const update = (patch: Partial<BackendRunOptions>) => onChange({ ...options, ...patch });
  const numeric = (name: BackendNumberField) => {
    const field = BACKEND_NUMBER_FIELDS[name];
    return <div key={name}><label htmlFor={`run-${name}`}>{field.label}</label><input id={`run-${name}`} type="number" min={field.integer ? 1 : 0.01} max={field.max} step={field.integer ? 1 : 'any'} required inputMode={field.integer ? 'numeric' : 'decimal'} value={Number.isNaN(options[name]) ? '' : options[name]} onChange={event => update({ [name]: event.target.value === '' ? NaN : Number(event.target.value) })} /></div>;
  };
  return <fieldset className="tour-backend-fields"><legend>실제 백엔드 검사 설정</legend><p className="tour-editor-note">아래 값이 이번 실제 검사에 전달됩니다. API 키는 QA팀의 백엔드 전용 설정에서 가져옵니다.</p>
    <label htmlFor="run-provider">백엔드 AI</label><select id="run-provider" value={options.provider ?? ''} onChange={event => {
      if (!event.target.value) { const { provider: _provider, models: _models, ...rest } = options; onChange(rest); return; }
      const provider = event.target.value as ApiProvider;
      update({ provider, models: { ...profiles[provider] } });
    }}><option value="">백엔드 전용 설정의 제공자·모델 사용</option><option value="anthropic">Claude (Anthropic)</option><option value="openai">GPT (OpenAI)</option></select>
    {options.provider && <div className="tour-editor-grid">{(['plan', 'triage'] as const).map(stage => {
      const label = stage === 'plan' ? '백엔드 계획·탐색 모델' : '백엔드 판정·보고서 모델';
      const catalog = modelsForProvider(options.provider!);
      const current = options.models?.[stage] ?? profiles[options.provider!][stage];
      const preset = catalog.some(model => model.id === current);
      const change = (model: string) => update({ models: { ...(options.models ?? profiles[options.provider!]), [stage]: model } });
      return <div key={stage}><label htmlFor={`run-${stage}-model`}>{label}</label><select id={`run-${stage}-model`} value={preset ? current : '__custom'} onChange={event => change(event.target.value === '__custom' ? '' : event.target.value)}>{catalog.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}<option value="__custom">모델 ID 직접 입력</option></select>{!preset && <input className="custom-model" aria-label={`${label} ID`} value={current} maxLength={128} onChange={event => change(event.target.value.trim())} />}</div>;
    })}</div>}
    <div className="tour-editor-grid backend-primary-fields">{(['budgetUsd', 'exploreMinutes', 'maxPages'] as const).map(numeric)}</div>
    <p className="tour-input-hint">예산은 실제 백엔드의 API 호출 상한입니다. 탐색 시간은 새 탐색을 시작할 수 있는 한도이며, 이후 판정·보고서 작업은 이어질 수 있습니다.</p>
    <details className="tour-backend-advanced"><summary>백엔드 고급 검사 설정</summary><div className="tour-editor-grid">{(['maxTemplates', 'turnsPerTemplate', 'maxTurns', 'pagesPerTemplate', 'concurrency', 'workers'] as const).map(numeric)}<div><label htmlFor="run-effort">백엔드 추론 수준</label><select id="run-effort" value={options.planEffort} onChange={event => update({ planEffort: event.target.value as BackendRunOptions['planEffort'] })}><option value="low">낮음</option><option value="medium">보통</option><option value="high">높음</option></select></div><div><label htmlFor="run-sessions">백엔드 탐색 묶음</label><select id="run-sessions" value={options.sessions} onChange={event => update({ sessions: event.target.value as BackendRunOptions['sessions'] })}><option value="template">페이지 종류별</option><option value="cluster">사이트 구조 묶음별</option></select></div></div></details>
  </fieldset>;
}
