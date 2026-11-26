import type { AgentEvent, AiSettings, ApiProvider, BackendRunDefaults, BackendRunOptions, BackendSettings, LoginCredentials, MessageRole, ReportResult } from './types';

declare global {
  interface Window {
    pilotDesktop?: {
      platform: string;
      minimize(): void;
      toggleMaximize(): Promise<boolean>;
      isMaximized(): Promise<boolean>;
      close(): void;
      openInEdge(url: string): Promise<{ ok: boolean; error?: string }>;
      beginOverlay(sessionId: string): Promise<{ ok: boolean; error?: string }>;
      endOverlay(sessionId: string): Promise<{ ok: boolean; error?: string }>;
      onOverlayStopped(listener: (details: { reason: string }) => void): () => void;
      onMaximizedChange(listener: (maximized: boolean) => void): () => void;
      getAiSettings(provider?: ApiProvider): Promise<AiSettings>;
      saveAiSettings(options: { provider?: ApiProvider; model: string; apiKey?: string; forgetKey?: boolean }): Promise<AiSettings>;
      testAiConnection(options: { provider?: ApiProvider; model: string; apiKey?: string }): Promise<{ ok: boolean; error?: string; models?: string[] }>;
      getBackendSettings(): Promise<BackendSettings>;
      saveBackendSettings(options: { provider?: ApiProvider; models?: { plan: string; triage: string }; runDefaults?: BackendRunDefaults; apiKey?: string; forgetKey?: boolean }): Promise<BackendSettings>;
      testBackendConnection(options: { provider?: ApiProvider; models?: { plan: string; triage: string }; apiKey?: string }): Promise<{ ok: boolean; error?: string }>;
      startAiChat(options: { requestId: string; messages: { role: MessageRole; content: string }[]; provider?: ApiProvider; model: string; targetUrl?: string; backendOptions?: BackendRunOptions; backendTask?: string; backendLoginUrl?: string; credentials?: LoginCredentials }): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
      cancelAiChat(requestId: string): Promise<unknown>;
      onAiEvent(listener: (details: { requestId: string; event: AgentEvent }) => void): () => void;
      getCapture(id: string): Promise<{ ok: boolean; imageUrl?: string; error?: string }>;
      refreshReport(runId?: string): Promise<ReportResult>;
      openReport(id: string): Promise<{ ok: boolean; error?: string }>;
      readReport(id: string): Promise<{ ok: true; data: Uint8Array } | { ok: false; error: string }>;
    };
  }
}
