import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Eye, EyeOff, LoaderCircle, Server, ShieldCheck } from 'lucide-react';
import type { ApiProvider, BackendSettings } from '../types';
import { modelsForProvider, PROVIDERS } from '../lib/models';

interface Props { running: boolean; onBusyChange: (busy: boolean) => void }
type ModelPair = { plan: string; triage: string };
const DEFAULT_MODELS: Record<ApiProvider, ModelPair> = {
  openai: { plan: 'gpt-6.2-sol', triage: 'gpt-6-luna' },
  anthropic: { plan: 'claude-opus-5-5', triage: 'claude-sonnet-5-5' },
};

function ModelField({ stage, provider, value, onChange, disabled }: { stage: 'plan' | 'triage'; provider: ApiProvider; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const catalog = modelsForProvider(provider);
  const selected = catalog.find(model => model.id === value);
  const label = stage === 'plan' ? '계획·탐색 모델' : '판정·보고서 모델';
  return <div className="settings-section backend-model-field">
    <label className="field-label" htmlFor={`backend-${stage}-model`}>{label}</label>
    <select id={`backend-${stage}-model`} value={selected ? value : '__custom'} disabled={disabled} onChange={event => onChange(event.target.value === '__custom' ? '' : event.target.value)}>
      {[...catalog].sort((a, b) => Number(b.id === DEFAULT_MODELS[provider][stage]) - Number(a.id === DEFAULT_MODELS[provider][stage])).map(model => <option key={model.id} value={model.id}>{model.name}{model.id === DEFAULT_MODELS[provider][stage] ? ' · 기본' : ''}</option>)}
      <option value="__custom">모델 ID 직접 입력</option>
    </select>
    {!selected && <><input className="custom-model" aria-label={`${label} ID`} value={value} onChange={event => onChange(event.target.value)} placeholder="백엔드에서 사용할 모델 ID" maxLength={128} disabled={disabled} /><p className="muted-note">목록 밖 모델은 백엔드 실행 지원 여부를 추가로 확인합니다.</p></>}
    <p className="model-description">{stage === 'plan' ? '실제 사이트에서 다음 검사와 탐색 동작을 결정합니다.' : '검사 증거를 바탕으로 버그를 판정하고 보고서를 구성합니다.'}</p>
  </div>;
}

export default function BackendSettingsPanel({ running, onBusyChange }: Props) {
  const [settings, setSettings] = useState<BackendSettings | null>(null);
  const [provider, setProvider] = useState<ApiProvider>('anthropic');
  const [models, setModels] = useState<Record<ApiProvider, ModelPair>>(DEFAULT_MODELS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [key, setKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | 'remove' | null>(null);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const native = !!window.pilotDesktop?.getBackendSettings;
  const providerInfo = PROVIDERS[provider];
  const profile = settings?.profiles[provider];
  const selectedModels = models[provider];
  const hasModels = !!selectedModels.plan.trim() && !!selectedModels.triage.trim();

  const refresh = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      if (!window.pilotDesktop?.getBackendSettings) throw new Error();
      const result = await window.pilotDesktop.getBackendSettings();
      if (mounted.current) {
        setSettings(result); setProvider(result.provider);
        setModels({ openai: { ...result.profiles.openai.models }, anthropic: { ...result.profiles.anthropic.models } });
      }
    } catch {
      if (mounted.current) { setSettings(null); setLoadError('백엔드 설정 상태를 확인하지 못했습니다. 다시 확인해 주세요.'); }
    } finally { if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);
  useEffect(() => { onBusyChange(pending !== null); return () => onBusyChange(false); }, [pending, onBusyChange]);

  function clearNotice() { setNotice(''); setFailed(false); }
  function changeProvider(next: ApiProvider) { setProvider(next); setKey(''); setVisible(false); clearNotice(); }
  function changeModel(stage: 'plan' | 'triage', value: string) {
    setModels(current => ({ ...current, [provider]: { ...current[provider], [stage]: value } })); clearNotice();
  }
  const trimmedModels = () => ({ plan: selectedModels.plan.trim(), triage: selectedModels.triage.trim() });
  async function save(forgetKey = false) {
    if (!window.pilotDesktop || pending || !settings || running) return;
    setPending(forgetKey ? 'remove' : 'save'); clearNotice();
    try {
      const saved = await window.pilotDesktop.saveBackendSettings(forgetKey ? { provider, forgetKey: true }
        : { provider, models: trimmedModels(), ...(key.trim() ? { apiKey: key.trim() } : {}) });
      setSettings(saved); setKey(''); setVisible(false);
      setModels(current => ({ ...current, [provider]: { ...saved.profiles[provider].models } }));
      setNotice(forgetKey
        ? saved.profiles[provider].keyConfigured ? '.env의 백엔드 키를 삭제했습니다. 별도로 설정된 환경변수의 키는 유지됩니다.' : '.env의 백엔드 키를 삭제했습니다.'
        : saved.profiles[provider].source === 'environment' ? '백엔드 모델과 키를 .env에 저장했습니다. 현재 실행에서는 환경변수의 키가 우선 사용됩니다.' : '실제 검사 백엔드 설정을 .env에 저장했습니다. 화면 표현 AI 설정은 바뀌지 않습니다.');
    } catch { setFailed(true); setNotice(forgetKey ? '백엔드 API 키를 삭제하지 못했습니다.' : '백엔드 설정을 저장하지 못했습니다. 모델 ID와 키, 저장 공간을 확인해 주세요.'); }
    finally { setPending(null); }
  }
  async function test() {
    if (!window.pilotDesktop || pending || !settings || running) return;
    setPending('test'); clearNotice();
    try {
      const result = await window.pilotDesktop.testBackendConnection({ provider, models: trimmedModels(), ...(key.trim() ? { apiKey: key.trim() } : {}) });
      setFailed(!result.ok);
      setNotice(result.ok ? '백엔드 API 키와 선택한 모델의 접근을 확인했습니다. 변경한 설정은 백엔드 설정 저장을 눌러 적용하세요.' : result.error ?? '백엔드 연결을 확인하지 못했습니다.');
    } catch { setFailed(true); setNotice('백엔드 연결을 확인하지 못했습니다. 네트워크 상태를 확인해 주세요.'); }
    finally { setPending(null); }
  }

  const variable = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const source = profile?.source === 'environment' ? `백엔드 환경변수 · ${variable}`
    : profile?.source === 'file' ? `백엔드 폴더의 .env · ${variable}` : `${providerInfo.name} 백엔드 전용 키 없음`;
  return <div className="api-settings backend-settings">
    <div className="api-intro"><span className="api-emblem"><Server size={19} /></span><div><strong>실제 검사 백엔드 · WebTestPilot</strong><p>사이트 탐색·버그 판정·보고서 생성을 담당하는 두뇌입니다. 이 모델과 키는 화면 표현 AI와 별도로 사용합니다.</p></div></div>
    {!native && <p className="settings-notice error" role="alert">백엔드 설정은 WebPilot 데스크톱 앱에서 사용할 수 있습니다.</p>}
    {loading ? <p className="backend-loading" role="status"><LoaderCircle size={14} className="spin" />백엔드 설정 상태를 확인하고 있습니다.</p>
      : loadError ? <div className="settings-section"><p className="settings-notice error" role="alert">{loadError}</p><button className="secondary-button backend-refresh" onClick={() => void refresh()} disabled={!native}>상태 다시 확인</button></div>
        : settings && profile && <>
          <div className="settings-section"><label className="field-label" htmlFor="backend-provider">백엔드 AI 선택</label><select id="backend-provider" value={provider} onChange={event => changeProvider(event.target.value as ApiProvider)} disabled={!!pending || running}><option value="anthropic">Claude (Anthropic)</option><option value="openai">GPT (OpenAI)</option></select></div>
          <ModelField stage="plan" provider={provider} value={selectedModels.plan} onChange={value => changeModel('plan', value)} disabled={!!pending || running} />
          <ModelField stage="triage" provider={provider} value={selectedModels.triage} onChange={value => changeModel('triage', value)} disabled={!!pending || running} />
          <div className="settings-section backend-key-status"><span className="field-label">선택한 서비스의 백엔드 키</span><strong>{profile.keyConfigured ? '키 설정됨' : '키 설정 필요'}</strong><p>{source}</p></div>
          <div className="settings-section"><div className="setting-label-row"><label htmlFor="backend-api-key">백엔드 전용 {providerInfo.name} API 키</label><a href={providerInfo.keyUrl} target="_blank" rel="noreferrer">키 발급 <ExternalLink size={11} /></a></div>
            <div className="api-key-field"><input id="backend-api-key" type={visible ? 'text' : 'password'} value={key} onChange={event => { setKey(event.target.value); clearNotice(); }} placeholder={profile.savedKeyConfigured ? `저장됨 ${profile.keyHint} · 변경할 백엔드 키 입력` : `백엔드에서만 사용할 ${provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}`} autoComplete="off" spellCheck={false} disabled={!!pending || running} maxLength={1024} /><button className="icon-button" onClick={() => setVisible(value => !value)} aria-label={visible ? '백엔드 API 키 숨기기' : '백엔드 API 키 보기'}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
            <div className="key-storage-note"><ShieldCheck size={12} /><span>백엔드 폴더의 .env에 전용으로 저장 · 화면 표현 키와 별도 보관</span>{profile.savedKeyConfigured && <button onClick={() => void save(true)} disabled={!!pending || running}>백엔드 키 삭제</button>}</div>
          </div>
          <div className="api-settings-actions"><button className="secondary-button" onClick={() => void test()} disabled={!!pending || running || !hasModels || (!key.trim() && !profile.keyConfigured)}>{pending === 'test' && <LoaderCircle size={13} className="spin" />}백엔드 연결 확인</button><button className="primary-button" onClick={() => void save()} disabled={!!pending || running || !hasModels}>{pending === 'save' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}백엔드 설정 저장</button></div>
          {notice && <p className={`settings-notice ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>{notice}</p>}
          <p className="muted-note">연결 확인은 키와 선택한 모델의 접근만 확인합니다. 사이트 검사나 보고서 생성을 시작하지 않습니다.</p>
          <div className="settings-section backend-source-note"><strong>백엔드 키의 적용 순서</strong><p className="muted-note">{variable} 환경변수가 있으면 먼저 사용하고, 없으면 백엔드 폴더의 .env를 사용합니다. 이 화면의 저장·삭제는 .env의 백엔드 설정에만 적용됩니다. 화면 표현용 키로 대체하지 않습니다.</p></div>
        </>}
  </div>;
}
