import { DEFAULT_MODEL, type AiProfile, type AiSettings, type ApiProvider } from '../types';

export interface ApiModel {
  id: string;
  name: string;
  description: string;
  docsUrl: string;
  lastChecked: string;
  provider?: ApiProvider;
}

// Curated from each provider's official API model documentation.
// Catalog presence does not guarantee access for a particular API organization.
export const API_MODELS: readonly ApiModel[] = [
  {
    id: 'gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    description: '코딩과 일상 작업에 적합한 범용 모델',
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-6.2-sol',
    lastChecked: '2026-11-25',
  },
  {
    id: 'gpt-6.2-astra',
    name: 'GPT-6.2 Astra',
    description: '복잡하고 난도가 높은 프로젝트를 위한 모델',
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-6.2-astra',
    lastChecked: '2026-11-25',
  },
  {
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    description: '화면·이미지 이해와 컴퓨터 사용에 특화',
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-6.1-terra',
    lastChecked: '2026-11-25',
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    description: '반복적이고 처리량이 많은 작업에 효율적',
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
    lastChecked: '2026-11-25',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    description: '코딩·컴퓨터 사용을 위한 빠른 경량 모델',
    docsUrl: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
    lastChecked: '2026-11-25',
  },
  {
    id: 'claude-haiku-5-5', provider: 'anthropic', name: 'Claude Haiku 5.5',
    description: '빠른 화면 읽기와 반복 작업을 위한 Claude 모델',
    docsUrl: 'https://platform.claude.com/docs/en/models/overview', lastChecked: '2026-11-26',
  },
  {
    id: 'claude-sonnet-5-5', provider: 'anthropic', name: 'Claude Sonnet 5.5',
    description: '추론과 속도의 균형을 갖춘 Claude 모델',
    docsUrl: 'https://platform.claude.com/docs/en/models/overview', lastChecked: '2026-11-26',
  },
  {
    id: 'claude-opus-5-5', provider: 'anthropic', name: 'Claude Opus 5.5',
    description: '복잡한 화면과 동작을 판단하는 Claude 모델',
    docsUrl: 'https://platform.claude.com/docs/en/models/overview', lastChecked: '2026-11-26',
  },
];

export const PROVIDERS = {
  openai: { label: 'GPT (OpenAI)', name: 'OpenAI', defaultModel: DEFAULT_MODEL, keyUrl: 'https://platform.openai.com/api-keys', usageUrl: 'https://platform.openai.com/usage', docsUrl: 'https://developers.openai.com/api/docs/models' },
  anthropic: { label: 'Claude (Anthropic)', name: 'Anthropic', defaultModel: 'claude-haiku-5-5', keyUrl: 'https://platform.claude.com/settings/keys', usageUrl: 'https://platform.claude.com/settings/usage', docsUrl: 'https://platform.claude.com/docs/en/models/overview' },
} as const;

export function modelsForProvider(provider: ApiProvider) {
  return API_MODELS.filter(model => (model.provider ?? 'openai') === provider);
}

/** Settings written before provider selection always belong to OpenAI. */
export function profileForProvider(settings: AiSettings | null, provider: ApiProvider): AiProfile | undefined {
  return settings?.profiles?.[provider] ?? ((settings?.provider ?? 'openai') === provider ? settings ?? undefined : undefined);
}
