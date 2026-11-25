export interface ApiModel {
  id: string;
  name: string;
  description: string;
  docsUrl: string;
  lastChecked: string;
}

// Curated from each model's official OpenAI API documentation.
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
];
