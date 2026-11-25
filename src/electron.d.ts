import type { AgentEvent, AiSettings, LoginCredentials, MessageRole, ReportResult } from './types';

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
      getAiSettings(): Promise<AiSettings>;
      saveAiSettings(options: { model: string; apiKey?: string; forgetKey?: boolean }): Promise<AiSettings>;
      testAiConnection(options: { model: string; apiKey?: string }): Promise<{ ok: boolean; error?: string; models?: string[] }>;
      startAiChat(options: { requestId: string; messages: { role: MessageRole; content: string }[]; model: string; targetUrl?: string; maxActions?: number; credentials?: LoginCredentials }): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
      cancelAiChat(requestId: string): Promise<unknown>;
      onAiEvent(listener: (details: { requestId: string; event: AgentEvent }) => void): () => void;
      getCapture(id: string): Promise<{ ok: boolean; imageUrl?: string; error?: string }>;
      refreshReport(): Promise<ReportResult>;
      openReport(id: string): Promise<{ ok: boolean; error?: string }>;
      readReport(id: string): Promise<{ ok: true; data: Uint8Array } | { ok: false; error: string }>;
    };
  }
}
