import type { BackendRunOptions } from '../types';
import { BACKEND_NUMBER_FIELDS, BACKEND_RUN_DEFAULTS, type BackendNumberField } from '../lib/backend-options';

interface Props {
  value: BackendRunOptions;
  onChange: (value: BackendRunOptions) => void;
  idPrefix?: string;
  disabled?: boolean;
}

/** Shared controls keep saved defaults and individual test limits consistent. */
export default function BackendLimitFields({ value, onChange, idPrefix = 'run', disabled = false }: Props) {
  const options = { ...BACKEND_RUN_DEFAULTS, ...value };
  const update = (patch: Partial<BackendRunOptions>) => onChange({ ...options, ...patch });
  const numeric = (name: BackendNumberField) => {
    const field = BACKEND_NUMBER_FIELDS[name];
    const id = `${idPrefix}-${name}`;
    return <div key={name}><label htmlFor={id}>{field.label}</label><input id={id} type="number" min={field.integer ? 1 : 0.01} max={field.max} step={field.integer ? 1 : 'any'} required disabled={disabled} inputMode={field.integer ? 'numeric' : 'decimal'} value={Number.isNaN(options[name]) ? '' : options[name]} onChange={event => update({ [name]: event.target.value === '' ? NaN : Number(event.target.value) })} /></div>;
  };
  return <>
    <div className="tour-editor-grid backend-primary-fields">{(['budgetUsd', 'exploreMinutes', 'maxPages'] as const).map(numeric)}</div>
    <p className="tour-input-hint">예산은 실제 백엔드의 API 호출 상한입니다. 탐색 시간은 새 탐색을 시작할 수 있는 한도이며, 이후 판정·보고서 작업은 이어질 수 있습니다.</p>
    <details className="tour-backend-advanced"><summary>백엔드 고급 검사 설정</summary><div className="tour-editor-grid">
      {(['maxTemplates', 'turnsPerTemplate', 'maxTurns', 'pagesPerTemplate', 'concurrency', 'workers'] as const).map(numeric)}
      <div><label htmlFor={`${idPrefix}-effort`}>백엔드 추론 수준</label><select id={`${idPrefix}-effort`} value={options.planEffort} disabled={disabled} onChange={event => update({ planEffort: event.target.value as BackendRunOptions['planEffort'] })}><option value="low">낮음</option><option value="medium">보통</option><option value="high">높음</option></select></div>
      <div><label htmlFor={`${idPrefix}-sessions`}>백엔드 탐색 묶음</label><select id={`${idPrefix}-sessions`} value={options.sessions} disabled={disabled} onChange={event => update({ sessions: event.target.value as BackendRunOptions['sessions'] })}><option value="template">페이지 종류별</option><option value="cluster">사이트 구조 묶음별</option></select></div>
    </div></details>
  </>;
}
