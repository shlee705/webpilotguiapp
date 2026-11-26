import { useEffect, useState } from 'react';
import { Check, ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { AiSettings, ApiProvider } from '../types';
import { modelsForProvider, profileForProvider, PROVIDERS } from '../lib/models';

interface Props {
  settings: AiSettings | null;
  onSaved: (settings: AiSettings) => void;
  running: boolean;
  initialProvider?: ApiProvider;
  onProviderChange?: (provider: ApiProvider) => void;
  onBusyChange?: (busy: boolean) => void;
}

export default function SettingsPanel({ settings, onSaved, running, initialProvider, onProviderChange, onBusyChange }: Props) {
  const [provider, setProvider] = useState<ApiProvider>(initialProvider ?? settings?.provider ?? 'openai');
  const [models, setModels] = useState<Record<ApiProvider, string>>({
    openai: profileForProvider(settings, 'openai')?.model ?? PROVIDERS.openai.defaultModel,
    anthropic: profileForProvider(settings, 'anthropic')?.model ?? PROVIDERS.anthropic.defaultModel,
  });
  const model = models[provider];
  const setModel = (value: string) => setModels(current => ({ ...current, [provider]: value }));
  const [key, setKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | 'remove' | null>(null);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[] | null>(null);
  const native = !!window.pilotDesktop?.saveAiSettings;
  const catalog = modelsForProvider(provider);
  const providerInfo = PROVIDERS[provider];
  const profile = profileForProvider(settings, provider);
  const selected = catalog.find(item => item.id === model);
  const usage = profile?.usage;
  useEffect(() => {
    onBusyChange?.(pending !== null);
    return () => onBusyChange?.(false);
  }, [pending, onBusyChange]);

  function resetNotice() { setNotice(''); setFailed(false); }
  function changeProvider(value: ApiProvider) {
    setProvider(value); onProviderChange?.(value); setKey(''); setVisible(false); setAvailableModels(null); resetNotice();
  }
  async function save() {
    if (!window.pilotDesktop || pending) return;
    setPending('save'); resetNotice();
    try {
      const saved = await window.pilotDesktop.saveAiSettings({ provider, model: model.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) });
      onSaved(saved); setKey(''); setVisible(false);
      setNotice(saved.keyConfigured ? 'API 키와 모델 설정을 저장했습니다.' : '모델을 저장했습니다. API 키를 입력하면 연결할 수 있습니다.');
    } catch { setFailed(true); setNotice('설정을 저장하지 못했습니다. API 키와 모델 ID를 확인해 주세요.'); }
    finally { setPending(null); }
  }
  async function test() {
    if (!window.pilotDesktop || pending) return;
    setPending('test'); resetNotice();
    try {
      const result = await window.pilotDesktop.testAiConnection({ provider, model: model.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) });
      setAvailableModels(result.models ?? null); setFailed(!result.ok);
      setNotice(result.ok ? 'API 키와 모델 접근을 확인했습니다. 변경한 설정은 연결 저장을 눌러 적용하세요.' : result.error ?? 'API 연결을 확인할 수 없습니다.');
    } catch { setFailed(true); setNotice('API 연결을 확인할 수 없습니다. 네트워크 상태를 확인해 주세요.'); }
    finally { setPending(null); }
  }
  async function remove() {
    if (!window.pilotDesktop || pending) return;
    setPending('remove'); resetNotice();
    try { onSaved(await window.pilotDesktop.saveAiSettings({ provider, model: model.trim(), forgetKey: true })); setKey(''); setVisible(false); setNotice(`저장된 ${providerInfo.name} API 키를 삭제했습니다.`); }
    catch { setFailed(true); setNotice('API 키를 삭제하지 못했습니다.'); }
    finally { setPending(null); }
  }

  return <div className="api-settings">
    <div className="api-intro"><span className="api-emblem"><KeyRound size={19} /></span><div><strong>화면 표현 AI · Computer Use</strong><p>탐색 과정을 보여주는 Edge의 모델과 키입니다. 실제 검사 백엔드에는 적용되지 않습니다.</p></div></div>
    {!native && <p className="settings-notice error" role="alert">API 연결과 키 저장은 WebPilot 데스크톱 앱에서 사용할 수 있습니다.</p>}
    <div className="settings-section">
      <label className="field-label" htmlFor="api-provider">AI 선택</label>
      <select id="api-provider" value={provider} onChange={event => changeProvider(event.target.value as ApiProvider)} disabled={!!pending || running}>
        <option value="openai">GPT (OpenAI)</option><option value="anthropic">Claude (Anthropic)</option>
      </select>
    </div>
    <div className="settings-section">
      <label className="field-label" htmlFor="api-model">모델 선택</label>
      <select id="api-model" aria-label="모델 선택" value={selected ? model : '__custom'} onChange={event => { setModel(event.target.value === '__custom' ? '' : event.target.value); resetNotice(); }} disabled={!!pending || running}>
        {[...catalog].sort((a, b) => Number(b.id === providerInfo.defaultModel) - Number(a.id === providerInfo.defaultModel)).map(item => <option key={item.id} value={item.id}>{item.name}{item.id === providerInfo.defaultModel ? ' · 기본' : ''}{availableModels && !availableModels.includes(item.id) ? ' · 접근 확인 필요' : ''}</option>)}
        <option value="__custom">모델 ID 직접 입력</option>
      </select>
      {!selected && <input className="custom-model" aria-label="모델 ID" placeholder="모델 ID 입력" value={model} onChange={event => { setModel(event.target.value); resetNotice(); }} disabled={!!pending || running} />}
      <p className="model-description">{selected?.description ?? `사용할 수 있는 ${providerInfo.name} ${provider === 'openai' ? 'Responses' : 'Messages'} API 모델 ID를 입력하세요.`}</p>
      <a className="model-source" href={selected?.docsUrl ?? providerInfo.docsUrl} target="_blank" rel="noreferrer">{providerInfo.name} 공식 모델 정보 <ExternalLink size={10} /><span>{(selected?.lastChecked ?? '2026-11-26').replaceAll('-', '.')} 확인</span></a>
    </div>
    <div className="settings-section">
      <div className="setting-label-row"><label htmlFor="api-key">{providerInfo.name} API 키</label><a href={providerInfo.keyUrl} target="_blank" rel="noreferrer">키 발급 <ExternalLink size={11} /></a></div>
      <div className="api-key-field"><input id="api-key" type={visible ? 'text' : 'password'} value={key} onChange={event => { setKey(event.target.value); resetNotice(); setAvailableModels(null); }} placeholder={profile?.keyConfigured ? `저장됨 ${profile.keyHint} · 변경할 키 입력` : provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'} autoComplete="off" spellCheck={false} disabled={!native || !!pending || running} maxLength={512} /><button className="icon-button" onClick={() => setVisible(value => !value)} aria-label={visible ? 'API 키 숨기기' : 'API 키 보기'}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
      <div className="key-storage-note"><ShieldCheck size={12} /><span>{profile?.storage === 'session' ? '암호화 저장을 사용할 수 없어 앱을 닫으면 키가 지워집니다.' : 'Windows 암호화 저장 · 저장한 키는 화면에 다시 노출하지 않습니다.'}</span>{profile?.keyConfigured && <button onClick={() => void remove()} disabled={!!pending || running}>키 삭제</button>}</div>
    </div>
    <div className="api-settings-actions"><button className="secondary-button" onClick={() => void test()} disabled={!native || !!pending || running || !model.trim() || (!key.trim() && !profile?.keyConfigured)}>{pending === 'test' && <LoaderCircle size={13} className="spin" />}연결 확인</button><button className="primary-button" onClick={() => void save()} disabled={!native || !!pending || running || !model.trim()}>{pending === 'save' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}연결 저장</button></div>
    {notice && <p className={`settings-notice ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>{notice}</p>}
    <div className="settings-section usage-section"><div className="setting-label-row"><span>이번 달 {providerInfo.name} API 사용량</span><span className="usage-month">{usage?.month ?? '—'}</span></div><div className="usage-grid"><div><span>입력</span><strong>{(usage?.inputTokens ?? 0).toLocaleString()}<small>토큰</small></strong></div><div><span>출력</span><strong>{(usage?.outputTokens ?? 0).toLocaleString()}<small>토큰</small></strong></div><div><span>요청</span><strong>{(usage?.requests ?? 0).toLocaleString()}<small>회</small></strong></div></div><p className="muted-note">이 앱에서 확인한 API 토큰만 집계합니다. {providerInfo.name} 계정 전체 사용량이나 잔여 한도를 의미하지 않습니다.{!!usage?.untrackedRequests && ` 중단·오류 등으로 토큰이 확인되지 않은 요청 ${usage.untrackedRequests}회는 합계에서 제외됩니다.`}</p></div>
    <div className="settings-section"><p className="muted-note">검정 포인터가 전용 Edge 안에서 이동하며 클릭·입력을 수행합니다. Esc 또는 채팅의 응답 중지 버튼으로 멈출 수 있습니다.</p></div>
    <div className="settings-footer"><span>API 사용 요금은 {providerInfo.name} 계정 기준</span><a href={providerInfo.usageUrl} target="_blank" rel="noreferrer">사용량 대시보드 <ExternalLink size={11} /></a></div>
  </div>;
}
