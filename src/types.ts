export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const DEFAULT_MODEL = 'gpt-6-luna';
export type ApiProvider = 'openai' | 'anthropic';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageSummary extends TokenUsage {
  month: string;
  requests: number;
  untrackedRequests: number;
}

export interface AiProfile {
  model: string;
  keyConfigured: boolean;
  keyHint: string;
  storage: 'encrypted' | 'session';
  usage: UsageSummary;
}

export interface AiSettings extends AiProfile {
  provider?: ApiProvider;
  profiles?: Record<ApiProvider, AiProfile>;
}

export interface BackendProfile {
  models: { plan: string; triage: string };
  keyConfigured: boolean;
  savedKeyConfigured: boolean;
  keyHint: string;
  storage: 'env-file';
  source: 'environment' | 'file' | 'none';
}

export interface BackendSettings extends BackendProfile {
  provider: ApiProvider;
  profiles: Record<ApiProvider, BackendProfile>;
}

export interface BackendRunOptions {
  provider?: ApiProvider;
  models?: { plan: string; triage: string };
  budgetUsd?: number;
  exploreMinutes?: number;
  maxPages?: number;
  maxTemplates?: number;
  turnsPerTemplate?: number;
  maxTurns?: number;
  pagesPerTemplate?: number;
  concurrency?: number;
  workers?: number;
  planEffort?: 'low' | 'medium' | 'high';
  sessions?: 'template' | 'cluster';
}

export interface AgentStep {
  id: string;
  label: string;
  state: 'running' | 'complete';
}

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  description: string;
  url?: string;
}

export interface BrowserAction {
  url: string;
  status: 'opening' | 'opened' | 'error';
  error?: string;
}

export interface Capture {
  id: string;
  url: string;
  index: number;
  createdAt: string;
}

export interface TourPlan {
  targetUrl: string;
  prompt: string;
  model: string;
  provider?: ApiProvider;
  backendOptions?: BackendRunOptions;
  backendLoginUrl?: string;
  loginEnabled?: boolean;
  state: 'pending' | 'running' | 'complete' | 'cancelled' | 'error';
}

export interface AgentActivity {
  phase: 'reading' | 'thinking' | 'acting' | 'finalizing' | 'complete';
  actionCount: number;
  visitedCount: number;
  url: string;
  detail?: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface InspectionStatus {
  phase: 'starting' | 'mapping' | 'exploring' | 'executing' | 'judging' | 'reporting' | 'complete' | 'incomplete' | 'error' | 'cancelled';
  url?: string;
}

export type ReportResult = (
  | { status: 'ready'; id: string; name: 'report.pdf'; size: number; updatedAt: string }
  | { status: 'missing' | 'error'; message: string }
) & { runId?: string; inspectionCompleted?: boolean };

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status?: MessageStatus;
  steps?: AgentStep[];
  findings?: Finding[];
  browserAction?: BrowserAction;
  model?: string;
  provider?: ApiProvider;
  usage?: TokenUsage;
  source?: ApiProvider | 'legacy' | 'local';
  captures?: Capture[];
  plan?: TourPlan;
  activity?: AgentActivity;
  report?: ReportResult;
  inspection?: InspectionStatus;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export type AgentEvent =
  | ({ type: 'status' } & AgentStep)
  | { type: 'delta'; text: string }
  | { type: 'finding'; finding: Finding }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'browser'; url: string; status: 'opened' | 'error'; error?: string }
  | { type: 'screenshot'; capture: Capture }
  | ({ type: 'activity' } & AgentActivity)
  | { type: 'report'; report: ReportResult }
  | ({ type: 'inspection' } & InspectionStatus)
  | { type: 'done' };
