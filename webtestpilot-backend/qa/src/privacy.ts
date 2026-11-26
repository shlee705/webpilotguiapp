// 실행 중 계정값은 메모리에만 둔다. 토큰은 모델·증거용이며 실제 조작 직전에만 복원한다.
import type Anthropic from '@anthropic-ai/sdk';
import type { Page, Locator } from 'playwright';

let values: string[] = [];
let publicUrls: string[] = [];
let replacements: { value: string; token: string }[] = [];
const originals = new Map<string, string>();
export const PRIVATE_NOTICE = '개인정보 보호 토큰과 가린 화면 영역은 관측 불가입니다. 가린 영역을 버그 또는 성공의 근거로 사용하지 마세요. 개인정보 토큰을 입력값으로 사용하지 마세요.';
export function configurePrivateValues(privateValues: string[], urls: string[] = []): void {
  values = [...privateValues]; publicUrls = [...urls];
  originals.clear();
  replacements = values.flatMap((v, i) => !v ? [] : [...new Set([v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2), JSON.stringify(v).slice(1, -1)])]
    .map((value, n) => ({ value, token: `__PRIVATE_${i}_${n}__` }))).sort((a, b) => b.value.length - a.value.length);
}
// Playwright discovery 프로세스가 실제 워커를 다시 만들므로 해당 child 트리의 전용 환경에만 유지한다.
// 원본 GUI/CLI 환경·파일·manifest에는 이 값을 넣지 않는다.
if (process.env.QA_PRIVATE_VALUES) {
  const input = JSON.parse(process.env.QA_PRIVATE_VALUES) as { values: string[]; publicUrls: string[]; originals?: [string, string][] };
  configurePrivateValues(input.values, input.publicUrls);
  for (const [safe, original] of input.originals ?? []) originals.set(safe, original);
}
export const privateWorkerEnvironment = (): Record<string, string> => values.length ? { QA_PRIVATE_VALUES: JSON.stringify({ values, publicUrls, originals: [...originals] }) } : {};
export const hasPrivateValues = () => values.some(Boolean);
export function privateText(text: string): string {
  // 입력 화면에서 검증된 공개 시작 URL은 계정 이름과 경로명이 우연히 같아도 계약을 보존한다.
  if (publicUrls.includes(text)) return text;
  const original = text;
  if (replacements.length) {
    const matches = new Map(replacements.map(r => [r.value, r.token]));
    const pattern = new RegExp('__PRIVATE_\\d+_\\d+__|' + replacements.map(r => r.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    text = text.replace(pattern, m => /^__PRIVATE_\d+_\d+__$/.test(m) ? m : matches.get(m)!);
  }
  // 복원은 실제 관측한 문자열 전체가 정확히 같을 때만. 비밀번호·계정 query는 절대 복원하지 않는다.
  const passwordForms = replacements.filter(r => r.token.startsWith('__PRIVATE_1_'));
  let canRestore = !passwordForms.some(r => original.includes(r.value));
  if (/^https?:\/\//.test(original)) {
    try {
      const u = new URL(original);
      const hashValues = [...new URLSearchParams(u.hash.includes('?') ? u.hash.slice(u.hash.indexOf('?') + 1) : u.hash.slice(1)).values()];
      canRestore &&= !u.username && !u.password && ![...u.searchParams.values(), ...hashValues].some(v => values.includes(v)) && !values.includes(decodeURIComponent(u.hash.slice(1)));
    }
    catch { canRestore = false; }
  }
  if (text !== original && canRestore && original.length <= 1024) originals.set(text, original);
  return text;
}
export function privateData<T>(value: T, path = ''): T {
  if (['models', 'parameters', 'run.models', 'run.parameters'].includes(path)) return value;
  // 계획의 공개 구조 ID는 관측한 계정 텍스트와 구분한다. object key와 참조 값이 같은 ID를 유지해야 한다.
  if (typeof value === 'string' && /^(?:R|T|F|S)\d+(?:\.[AC]\d+)?$/.test(value)
    && /(?:scenarios|requirements|features|targets|unplanned|^ledger\.)/.test(path)
    && /\.(?:id|scenario|target|after|expected_from|covers\[\]|requirements\[\])$/.test(path)) return value;
  if (typeof value === 'string' && (/\bmodel$/.test(path) && /^(gpt-|claude-)/.test(value) || /\bprovider$/.test(path) && ['openai', 'anthropic'].includes(value))) return value;
  if (typeof value === 'string') return privateText(value) as T;
  if (Array.isArray(value)) return value.map(v => privateData(v, `${path}[]`)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, privateData(v, path ? `${path}.${k}` : k)])) as T;
  return value;
}
export const privateJson = (value: unknown, space?: number, path = '') => JSON.stringify(privateData(value, path), null, space);
export function runtimeData<T>(data: T, key = ''): T {
  // 모델이 정한 테스트 입력으로 계정값을 복사하지 않는다. selector·URL·기대값만 복원한다.
  if (['value', 'input', 'fill'].includes(key)) return data;
  if (typeof data === 'string') {
    return (['url', 'name', 'text', 'expected', 'urlIncludes'].includes(key) ? originals.get(data) ?? data : data) as T;
  }
  if (Array.isArray(data)) return data.map(v => runtimeData(v)) as T;
  if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, runtimeData(v, k)])) as T;
  return data;
}

/** message.content의 객체 참조를 보존한다(OpenAI의 reasoning 이력 WeakMap 키). */
export function privateRequest(req: Anthropic.MessageCreateParamsNonStreaming): void {
  if (!hasPrivateValues()) return;
  const content = (blocks: any) => {
    if (typeof blocks === 'string') return privateText(blocks);
    for (const block of blocks ?? []) {
      if (block.type === 'text') block.text = privateText(block.text);
      else if (block.type === 'tool_result') block.content = content(block.content);
      else if (block.type === 'tool_use') block.input = privateData(block.input, 'toolInput');
    }
    return blocks;
  };
  if (typeof req.system === 'string') req.system = `${privateText(req.system)}\n${PRIVATE_NOTICE}`;
  else {
    content(req.system);
    const system = req.system ?? [];
    if (!system.some(b => b.text === PRIVATE_NOTICE)) system.push({ type: 'text', text: PRIVATE_NOTICE });
    req.system = system;
  }
  for (const message of req.messages) message.content = content(message.content);
}

/** 텍스트가 이미지로 노출되는 경로도 막는다. 사이트 DOM 값·이벤트에는 손대지 않는다. */
export async function privateMasks(page: Page): Promise<Locator[]> {
  if (!hasPrivateValues()) return [page.locator('input[type=password]')];
  await page.locator('*').evaluateAll((elements, secrets) => {
    for (const e of elements) e.removeAttribute('data-qa-private');
    const contains = (text: string | null) => !!text && secrets.some(s => text.includes(s));
    for (const e of elements) {
      const text = contains(e.textContent) && ![...e.children].some(c => contains(c.textContent));
      const pseudo = ['::before', '::after'].some(p => contains(getComputedStyle(e, p).content));
      if (text || pseudo || getComputedStyle(e).backgroundImage !== 'none') e.setAttribute('data-qa-private', '1');
    }
  }, replacements.map(r => r.value));
  return [page.locator('[data-qa-private], input, textarea, select, img, svg, canvas, video, iframe, object, embed')];
}
