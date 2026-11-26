import { useEffect, useState } from 'react';
import type { ApiProvider, BackendRunOptions } from '../types';
import { modelsForProvider } from '../lib/models';
import { BACKEND_RUN_DEFAULTS } from '../lib/backend-options';
import BackendLimitFields from './BackendLimitFields';

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
    <BackendLimitFields value={options} onChange={onChange} />
  </fieldset>;
}
