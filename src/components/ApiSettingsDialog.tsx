import { useRef, useState } from 'react';
import type { AiSettings, ApiProvider } from '../types';
import SettingsPanel from './SettingsPanel';
import BackendSettingsPanel from './BackendSettingsPanel';

interface Props {
  settings: AiSettings | null;
  onSaved: (settings: AiSettings) => void;
  running: boolean;
  initialProvider?: ApiProvider;
}

export default function ApiSettingsDialog({ settings, onSaved, running, initialProvider }: Props) {
  const [role, setRole] = useState<'visual' | 'backend'>('visual');
  const [provider, setProvider] = useState<ApiProvider>(initialProvider ?? settings?.provider ?? 'openai');
  const [pending, setPending] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const choices = [{ id: 'visual' as const, label: '화면 표현 AI' }, { id: 'backend' as const, label: '실제 검사 백엔드' }];
  return <div className="settings-roles">
    <div className="settings-role-tabs" role="tablist" aria-label="AI 설정 역할">
      {choices.map((item, index) => <button key={item.id} ref={node => { tabs.current[index] = node; }} id={`settings-${item.id}-tab`} role="tab" aria-selected={role === item.id} aria-controls={`settings-${item.id}-panel`} tabIndex={role === item.id ? 0 : -1} disabled={pending} onClick={() => setRole(item.id)} onKeyDown={event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 1 - index : undefined;
        if (next === undefined || pending) return;
        event.preventDefault(); setRole(choices[next].id); tabs.current[next]?.focus();
      }}>{item.label}</button>)}
    </div>
    <p className="settings-role-note">두 역할은 모델과 API 키를 따로 사용합니다.</p>
    <div id={`settings-${role}-panel`} role="tabpanel" aria-labelledby={`settings-${role}-tab`}>
      {role === 'visual'
        ? <SettingsPanel settings={settings} initialProvider={provider} onProviderChange={setProvider} onBusyChange={setPending} onSaved={onSaved} running={running} />
        : <BackendSettingsPanel running={running} onBusyChange={setPending} />}
    </div>
  </div>;
}
