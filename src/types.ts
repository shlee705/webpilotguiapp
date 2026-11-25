export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const DEFAULT_MODEL = 'gpt-6-luna';

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

export interface AiSettings {
  model: string;
  keyConfigured: boolean;
  keyHint: string;
  storage: 'encrypted' | 'session';
  usage: UsageSummary;
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
  maxActions: number;
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

export type ReportResult =
  | { status: 'ready'; id: string; name: 'report.pdf'; size: number; updatedAt: string }
  | { status: 'missing' | 'error'; message: string };

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
  usage?: TokenUsage;
  source?: 'openai' | 'legacy' | 'local';
  captures?: Capture[];
  plan?: TourPlan;
  activity?: AgentActivity;
  report?: ReportResult;
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
  | { type: 'done' };
