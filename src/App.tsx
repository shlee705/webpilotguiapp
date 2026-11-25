import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Copy, ExternalLink, FileText, History, Link2, LoaderCircle, Maximize2, Minus, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import { DEFAULT_MODEL, type AiSettings, type AgentEvent, type ChatMessage, type Conversation, type Finding, type TourPlan, type LoginCredentials, type ReportResult } from './types';
import { createConversation, createMessage, loadConversations, saveConversations } from './lib/storage';
import { sendChat } from './lib/transport';
import { extractFirstWebUrl } from './lib/url';
import { API_MODELS } from './lib/models';
import SettingsPanel from './components/SettingsPanel';
import CaptureCard from './components/CaptureCard';
import TourPlanCard from './components/TourPlanCard';
import AgentActivityCard from './components/AgentActivityCard';
import TourPlanEditor from './components/TourPlanEditor';
import ReportCard from './components/ReportCard';
import { loginCredentialsError, parsePromptCredentials, redactKnownCredentials } from './lib/credentials';

const modelName = (id: string) => API_MODELS.find(model => model.id === id)?.name ?? id;
function siteOrigin(value: string) {
  try { return new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`).origin; }
  catch { return undefined; }
}

function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path opacity=".5" d="M2 13h5v9H2z" /><path opacity=".75" d="M9 8h5v14H9z" /><path d="M16 2h5v20h-5z" /></svg></span>;
}

function WelcomeHero() {
  return <><div className="welcome-wordmark"><Brand /><span>WebTestPilot</span></div><h1>오늘 어떤 도움을 드릴까요?</h1></>;
}

function conversationSite(item: Conversation) {
  const address = item.messages.find(message => message.plan)?.plan?.targetUrl
    ?? item.messages.map(message => extractFirstWebUrl(message.content)).find(Boolean);
  try { return address ? new URL(address).host : '일반 대화'; } catch { return '일반 대화'; }
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="modal" onCancel={onClose} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={19} /></button></div>{children}
  </dialog>;
}

const severityLabels: Record<Finding['severity'], string> = { critical: '심각', high: '높음', medium: '보통', low: '낮음', info: '정보' };
function Message({ message, onStart, onEdit, onReportChange, busy, credentialsReady, animate, onEntered }: { message: ChatMessage; onStart: () => void; onEdit: () => void; onReportChange: (report: ReportResult) => void; busy: boolean; credentialsReady: boolean; animate: boolean; onEntered: () => void }) {
  const [entering] = useState(animate);
  useLayoutEffect(() => { onEntered(); }, []);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); copyTimer.current = setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); }
  }
  if (message.role === 'user') return <div className={`message user-message ${entering ? 'message-enter' : ''}`}><div className="user-message-wrap"><div className="user-bubble">{message.content}</div>{message.browserAction && <div className={`browser-action ${message.browserAction.status}`} role="status">{message.browserAction.status === 'opening' ? <LoaderCircle size={12} className="spin" /> : message.browserAction.status === 'opened' ? <ExternalLink size={12} /> : <CircleHelp size={12} />}<span>{message.browserAction.status === 'opening' ? 'Microsoft Edge를 여는 중…' : message.browserAction.status === 'opened' ? '전용 Edge에서 사이트를 열었어요' : message.browserAction.error ?? 'Microsoft Edge를 열지 못했습니다.'}</span></div>}</div></div>;
  return <article className={`message assistant-message ${message.status === 'error' ? 'has-error' : ''} ${message.plan ? 'plan-message' : ''} ${entering ? 'message-enter' : ''}`}>
    <div className="assistant-byline"><Brand small /><span>WebPilot</span><span className="message-mode">{message.plan ? '탐색 준비' : message.model ? modelName(message.model) : '이전 기록'}</span></div>
    {!!message.steps?.length && !message.activity && <div className="agent-steps">{message.steps.map(step => <div key={step.id} className="agent-step">{step.state === 'complete' ? <Check size={15} /> : message.status === 'streaming' ? <LoaderCircle size={15} className="spin" /> : <Minus size={15} />}<span>{step.label}</span></div>)}</div>}
    {message.content && <div className="message-content">{message.content}</div>}
    {message.plan && <TourPlanCard plan={message.plan} onStart={onStart} onEdit={onEdit} disabled={busy} credentialsReady={credentialsReady} animate={entering} />}
    {!!message.captures?.length && <div className="capture-gallery">{message.captures.map(capture => <CaptureCard key={capture.id} capture={capture} />)}</div>}
    {message.activity && <AgentActivityCard activity={message.activity} status={message.status} startedAt={message.createdAt} />}
    {message.report && <ReportCard report={message.report} onChange={onReportChange} disabled={busy} />}
    {message.activity && !!message.steps?.length && <details className="tour-log"><summary>실제 동작 기록 {message.steps.length}개</summary><div className="agent-steps">{message.steps.map(step => <div className="agent-step" key={step.id}>{step.state === 'complete' ? <Check size={13} /> : message.status === 'streaming' ? <LoaderCircle size={13} className="spin" /> : <Minus size={13} />}<span>{step.label}</span></div>)}</div></details>}
    {message.status === 'streaming' && !message.activity && !message.content && !message.steps?.length && <div className="thinking"><span /><span /><span /><span className="sr-only">응답을 준비하고 있습니다</span></div>}
    {!!message.findings?.length && <div className="findings">{message.findings.map(finding => <div className="finding" key={finding.id}><span className={`severity severity-${finding.severity}`}>{severityLabels[finding.severity]}</span><strong>{finding.title}</strong><p>{finding.description}</p>{finding.url && /^https?:\/\//i.test(finding.url) && <a href={finding.url} target="_blank" rel="noreferrer">관련 페이지 <ExternalLink size={12} /></a>}</div>)}</div>}
    {message.status === 'cancelled' && !message.plan && <p className="message-note">응답 생성을 중지했습니다.</p>}
    {message.status !== 'streaming' && message.content && !message.plan && <div className="message-actions"><button className="icon-button" onClick={copy} title={copied ? '복사됨' : '응답 복사'} aria-label={copied ? '복사됨' : '응답 복사'}>{copied ? <CheckCheck size={15} /> : <Copy size={15} />}</button><span>{message.usage ? `${message.usage.totalTokens.toLocaleString()} 토큰` : message.status === 'error' ? '요청을 다시 보내 주세요' : message.source === 'legacy' ? '이전 버전에서 저장한 응답' : 'OpenAI API 응답'}</span></div>}
  </article>;
}

function groupLabel(value: string) {
  const date = Date.parse(value);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (date >= today.getTime()) return '오늘';
  today.setDate(today.getDate() - 1);
  return date >= today.getTime() ? '어제' : '이전 대화';
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState<'all' | 'reports'>('all');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 550);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [modal, setModal] = useState<'settings' | 'help' | 'url' | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<{ conversationId: string; messageId: string; plan: TourPlan; credentials?: LoginCredentials } | null>(null);
  const [planError, setPlanError] = useState('');
  const [inputError, setInputError] = useState('');
  const planCredentials = useRef(new Map<string, LoginCredentials>());
  const [urlValue, setUrlValue] = useState('');
  const [urlError, setUrlError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [maximized, setMaximized] = useState(false);
  const [effectError, setEffectError] = useState('');
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [aiError, setAiError] = useState('');
  const controllers = useRef(new Map<string, AbortController>());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const welcomeHeroRef = useRef<HTMLDivElement>(null);
  const composerOrigin = useRef<DOMRect | null>(null);
  const freshMessages = useRef(new Set<string>());
  const [departingHero, setDepartingHero] = useState<{ top: number; left: number; width: number } | null>(null);
  const followScroll = useRef(true);
  const conversation = conversations.find(item => item.id === currentId);
  const draftKey = currentId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const busy = !!currentId && activeIds.includes(currentId);
  const hasMessages = !!conversation?.messages.length;
  const filtered = [...conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).filter(item => (historyFilter !== 'reports' || item.messages.some(message => message.report)) && `${item.title} ${item.messages.map(m => m.content).join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const groups = ['오늘', '어제', '이전 대화'].map(label => ({ label, items: filtered.filter(item => groupLabel(item.updatedAt) === label) })).filter(group => group.items.length);
  const selectedModel = aiSettings?.model ?? DEFAULT_MODEL;

  async function refreshAiSettings() {
    if (!window.pilotDesktop?.getAiSettings) return;
    try { setAiSettings(await window.pilotDesktop.getAiSettings()); setAiError(''); }
    catch { setAiError('API 설정을 불러올 수 없습니다. 앱을 다시 실행해 주세요.'); }
  }

  useEffect(() => { setStorageError(!saveConversations(conversations)); }, [conversations]);
  useLayoutEffect(() => {
    const origin = composerOrigin.current;
    composerOrigin.current = null;
    const element = composerRef.current;
    if (!hasMessages || !origin || !element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const destination = element.getBoundingClientRect();
    if (!destination.width || !destination.height) return;
    const motion = element.animate([
      { transform: `translate(${origin.left - destination.left}px, ${origin.top - destination.top}px) scale(${origin.width / destination.width}, ${origin.height / destination.height})`, transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' },
    ], { duration: 460, easing: 'cubic-bezier(.22,.8,.24,1)' });
    return () => motion.cancel();
  }, [hasMessages, currentId]);
  useEffect(() => {
    if (!departingHero) return;
    const timer = window.setTimeout(() => setDepartingHero(null), 420);
    return () => window.clearTimeout(timer);
  }, [departingHero]);
  useEffect(() => { void refreshAiSettings(); }, []);
  useEffect(() => { const api = window.pilotDesktop; if (!api) return; void api.isMaximized().then(setMaximized); return api.onMaximizedChange(setMaximized); }, []);
  useEffect(() => window.pilotDesktop?.onOverlayStopped?.(() => { for (const controller of controllers.current.values()) controller.abort(); }), []);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSidebarOpen(true); setTimeout(() => searchRef.current?.focus(), 0); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);
  useEffect(() => { if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`; } }, [draft, hasMessages]);
  useEffect(() => { if (followScroll.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' }); }, [conversation?.messages, activeIds]);
  useEffect(() => { followScroll.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' }); }, [currentId]);
  useEffect(() => { const active = controllers.current; return () => { for (const controller of active.values()) controller.abort(); }; }, []);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !modal && !editingPlan && !deleteId && currentId) controllers.current.get(currentId)?.abort();
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [currentId, modal, editingPlan, deleteId]);

  function newChat() { setEditingPlan(null); setCurrentId(null); setSearch(''); setHistoryFilter('all'); setDepartingHero(null); followScroll.current = true; setTimeout(() => inputRef.current?.focus(), 0); }
  function setDraft(value: string) { setDrafts(previous => ({ ...previous, [draftKey]: value })); }
  function applyEvent(id: string, messageId: string, event: AgentEvent) {
    setConversations(previous => previous.map(item => item.id !== id ? item : { ...item, messages: item.messages.map(message => {
      if (message.id !== messageId) return message;
      if (event.type === 'delta') return { ...message, content: message.content + event.text };
      if (event.type === 'status') return { ...message, steps: [...(message.steps ?? []).filter(step => step.id !== event.id), { id: event.id, label: event.label, state: event.state }] };
      if (event.type === 'finding') return { ...message, findings: [...(message.findings ?? []).filter(finding => finding.id !== event.finding.id), event.finding] };
      if (event.type === 'usage') return { ...message, usage: event.usage };
      if (event.type === 'screenshot') return { ...message, captures: [...(message.captures ?? []), event.capture] };
      if (event.type === 'report') return { ...message, report: event.report };
      if (event.type === 'activity') return { ...message, activity: { phase: event.phase, visitedCount: event.visitedCount, actionCount: event.actionCount, url: event.url, detail: event.detail } };
      return message;
    }) }));
  }
  async function runRequest(chat: Conversation, requestMessages: ChatMessage[], assistantMessage: ChatMessage, userMessageId: string, options: { model: string; targetUrl?: string; maxActions?: number; planMessageId?: string; credentials?: LoginCredentials }) {
    const controller = new AbortController();
    controllers.current.set(chat.id, controller);
    setActiveIds(previous => [...previous, chat.id]);
    followScroll.current = true;
    let finalStatus: ChatMessage['status'] = 'complete';
    let errorContent = '';
    try {
      if (options.targetUrl && window.pilotDesktop?.beginOverlay) {
        try {
          const effect = await window.pilotDesktop.beginOverlay(chat.id);
          setEffectError(effect.ok ? '' : effect.error ?? 'Esc 중지 키를 등록하지 못했습니다. 채팅의 응답 중지 버튼을 사용해 주세요.');
        } catch { setEffectError('Esc 중지 키를 등록하지 못했습니다. 채팅의 응답 중지 버튼을 사용해 주세요.'); }
      }
      await sendChat({ conversationId: chat.id, messages: requestMessages, ...options, signal: controller.signal, onEvent: event => {
        if (event.type === 'activity' && event.phase === 'finalizing') {
          void window.pilotDesktop?.endOverlay?.(chat.id).catch(() => {});
        }
        if (event.type === 'browser') {
          setConversations(previous => previous.map(item => item.id !== chat.id ? item : { ...item, messages: item.messages.map(message => message.id !== userMessageId ? message : { ...message, browserAction: { url: event.url, status: event.status, error: event.error } }) }));
        } else applyEvent(chat.id, assistantMessage.id, event);
      } });
    }
    catch (error) {
      finalStatus = controller.signal.aborted ? 'cancelled' : 'error';
      if (finalStatus === 'error') errorContent = '응답을 받지 못했습니다. ' + (error instanceof Error ? error.message : '잠시 후 다시 시도해 주세요.');
    }
    finally {
      void window.pilotDesktop?.endOverlay?.(chat.id).catch(() => {});
      controllers.current.delete(chat.id);
      if (options.planMessageId) planCredentials.current.delete(options.planMessageId);
      void refreshAiSettings();
      setActiveIds(previous => previous.filter(id => id !== chat.id));
      setConversations(previous => previous.map(item => item.id !== chat.id ? item : { ...item, messages: item.messages.map(message => {
        if (message.id === assistantMessage.id) return { ...message, status: finalStatus, content: errorContent ? [message.content, errorContent].filter(Boolean).join('\n\n') : message.content };
        if (message.id === options.planMessageId && message.plan) return { ...message, plan: { ...message.plan, state: finalStatus === 'complete' ? 'complete' : finalStatus === 'cancelled' ? 'cancelled' : 'error' } };
        if (message.id === userMessageId && message.browserAction?.status === 'opening') return { ...message, browserAction: { ...message.browserAction, status: 'error', error: '사이트 탐색이 시작되기 전에 요청이 종료되었습니다.' } };
        return message;
      }) }));
    }
  }

  async function startTour(messageId: string) {
    if (!conversation || controllers.current.has(conversation.id)) return;
    const planIndex = conversation.messages.findIndex(message => message.id === messageId);
    const planMessage = conversation.messages[planIndex];
    const plan = planMessage?.plan;
    if (!plan || !['pending', 'error', 'cancelled'].includes(plan.state)) return;
    if (!aiSettings?.keyConfigured) { setModal('settings'); return; }
    const credentials = planCredentials.current.get(messageId);
    if (plan.loginEnabled && !credentials) { editTour(messageId); setPlanError('이번 작업에 사용할 로그인 계정을 다시 입력해 주세요.'); return; }
    const userMessage = conversation.messages.slice(0, planIndex).reverse().find(message => message.role === 'user');
    if (!userMessage) return;
    const assistantMessage: ChatMessage = { ...createMessage('assistant'), status: 'streaming', model: plan.model, source: 'openai', activity: { phase: 'reading', visitedCount: 0, actionCount: 0, url: plan.targetUrl } };
    const confirmation = createMessage('user', plan.state === 'pending' ? '네, 시작해 주세요.' : '같은 설정으로 다시 시작해 주세요.');
    freshMessages.current.add(confirmation.id);
    freshMessages.current.add(assistantMessage.id);
    const requestMessages = [...conversation.messages, createMessage('user', '대상 URL: ' + plan.targetUrl + '\n버그 탐색 요청: ' + plan.prompt)];
    setConversations(previous => previous.map(item => item.id !== conversation.id ? item : { ...item, updatedAt: new Date().toISOString(), messages: [...item.messages.map(message => {
      if (message.id === messageId && message.plan) return { ...message, plan: { ...message.plan, state: 'running' as const } };
      if (message.id === userMessage.id) return { ...message, browserAction: { url: plan.targetUrl, status: 'opening' as const } };
      return message;
    }), confirmation, assistantMessage] }));
    await runRequest(conversation, requestMessages, assistantMessage, userMessage.id, { model: plan.model, targetUrl: plan.targetUrl, maxActions: plan.maxActions, planMessageId: messageId, ...(plan.loginEnabled && credentials ? { credentials } : {}) });
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const parsed = parsePromptCredentials(draft);
    if (parsed.hasCredentialFields) setDraft(parsed.text);
    if (parsed.error) { setInputError(parsed.error); return; }
    setInputError('');
    const text = parsed.text.trim();
    if ((!text && !parsed.credentials) || (currentId && controllers.current.has(currentId))) return;
    const pendingPlan = conversation?.messages.slice().reverse().find(message => message.plan?.state === 'pending');
    if (parsed.credentials && !extractFirstWebUrl(text)) {
      if (!pendingPlan?.plan) { setInputError('계정과 함께 버그를 탐색할 사이트 URL을 입력해 주세요.'); return; }
      planCredentials.current.set(pendingPlan.id, parsed.credentials);
      setConversations(previous => previous.map(item => item.id !== currentId ? item : { ...item, messages: item.messages.map(message => message.id === pendingPlan.id && message.plan ? { ...message, plan: { ...message.plan, loginEnabled: true } } : message) }));
      setDrafts(previous => ({ ...previous, [draftKey]: '' }));
      return;
    }
    if (pendingPlan && /^(네|예|응|시작|시작해|시작해줘|진행|진행해|진행해줘|좋아)[.!\s]*$/.test(text)) {
      setDrafts(previous => ({ ...previous, [draftKey]: '' }));
      await startTour(pendingPlan.id);
      return;
    }
    const targetUrl = extractFirstWebUrl(text);
    if (!targetUrl && !aiSettings?.keyConfigured) { setModal('settings'); return; }
    const chat = conversation ?? createConversation();
    const userMessage = createMessage('user', text);
    const assistantMessage: ChatMessage = targetUrl
      ? { ...createMessage('assistant', '요청하신 사이트를 확인했습니다. 아래 설정으로 진행합니다.'), source: 'local', plan: { targetUrl, prompt: text, model: selectedModel, maxActions: 5, loginEnabled: !!parsed.credentials, state: 'pending' } }
      : { ...createMessage('assistant'), status: 'streaming', model: selectedModel, source: 'openai' };
    freshMessages.current.add(userMessage.id);
    freshMessages.current.add(assistantMessage.id);
    if (!hasMessages && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      composerOrigin.current = composerRef.current?.getBoundingClientRect() ?? null;
      const hero = welcomeHeroRef.current?.getBoundingClientRect();
      if (hero) setDepartingHero({ top: hero.top, left: hero.left, width: hero.width });
    }
    if (targetUrl && parsed.credentials) planCredentials.current.set(assistantMessage.id, parsed.credentials);
    for (const message of chat.messages) if (targetUrl && message.plan?.state === 'pending') planCredentials.current.delete(message.id);
    // A new URL replaces an older unstarted proposal in this conversation.
    const previousMessages = chat.messages.map(message => targetUrl && message.plan?.state === 'pending' ? { ...message, plan: { ...message.plan, state: 'cancelled' as const } } : message);
    const requestMessages = [...previousMessages, userMessage];
    setDrafts(previous => ({ ...previous, [draftKey]: '' }));
    followScroll.current = true;
    const updated = { ...chat, title: chat.messages.length ? chat.title : text.replace(/\s+/g, ' ').slice(0, 60), updatedAt: new Date().toISOString(), messages: [...requestMessages, assistantMessage] };
    setConversations(previous => conversation ? previous.map(item => item.id === chat.id ? updated : item) : [updated, ...previous]);
    setCurrentId(chat.id);
    if (!targetUrl) await runRequest(chat, requestMessages, assistantMessage, userMessage.id, { model: selectedModel });
  }

  function editTour(messageId: string) {
    const plan = conversation?.messages.find(message => message.id === messageId)?.plan;
    if (!conversation || !plan || !['pending', 'error', 'cancelled'].includes(plan.state) || controllers.current.has(conversation.id)) return;
    setPlanError('');
    setEditingPlan({ conversationId: conversation.id, messageId, plan: { ...plan }, credentials: planCredentials.current.get(messageId) });
  }

  function changeTourPlan(plan: TourPlan) {
    if (!editingPlan) return;
    const originChanged = siteOrigin(plan.targetUrl) !== siteOrigin(editingPlan.plan.targetUrl);
    if (originChanged) planCredentials.current.delete(editingPlan.messageId);
    setEditingPlan(previous => previous ? { ...previous, plan, ...(originChanged ? { credentials: undefined } : {}) } : null);
    setPlanError(originChanged && plan.loginEnabled ? '대상 사이트가 변경되었습니다. 이 사이트에 사용할 계정을 다시 입력해 주세요.' : '');
  }

  function saveTour(event: FormEvent) {
    event.preventDefault();
    if (!editingPlan || controllers.current.has(editingPlan.conversationId)) return;
    try {
      const value = editingPlan.plan.targetUrl.trim();
      const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
      const parsed = parsePromptCredentials(editingPlan.plan.prompt);
      if (parsed.error) { setPlanError(parsed.error); setEditingPlan({ ...editingPlan, plan: { ...editingPlan.plan, prompt: parsed.text } }); return; }
      const credentials = parsed.credentials ?? editingPlan.credentials;
      const plan = { ...editingPlan.plan, targetUrl: url.href, model: editingPlan.plan.model.trim(), prompt: redactKnownCredentials(parsed.text.trim(), credentials), loginEnabled: !!parsed.credentials || editingPlan.plan.loginEnabled };
      const credentialError = plan.loginEnabled ? loginCredentialsError(credentials) : undefined;
      if (credentialError) { setPlanError(credentialError); return; }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(plan.model)) { setPlanError('올바른 모델 ID를 입력해 주세요. 예: gpt-6-luna'); return; }
      if (!Number.isSafeInteger(plan.maxActions) || plan.maxActions < 1) { setPlanError('동작 한도는 1 이상의 정수로 입력해 주세요.'); return; }
      if (!plan.prompt) throw new Error();
      setConversations(previous => previous.map(item => item.id !== editingPlan.conversationId ? item : { ...item, updatedAt: new Date().toISOString(), messages: item.messages.map(message => message.id === editingPlan.messageId && message.plan && ['pending', 'error', 'cancelled'].includes(message.plan.state) ? { ...message, plan: { ...plan, state: 'pending' as const } } : message) }));
      if (plan.loginEnabled && credentials) planCredentials.current.set(editingPlan.messageId, credentials); else planCredentials.current.delete(editingPlan.messageId);
      setEditingPlan(null);
    } catch { setPlanError('올바른 HTTP(S) 주소와 버그 탐색 요청을 입력해 주세요.'); }
  }
  function updateReport(conversationId: string, messageId: string, report: ReportResult) {
    setConversations(previous => previous.map(item => item.id !== conversationId ? item : { ...item, messages: item.messages.map(message => {
      if (message.id !== messageId) return message;
      const completion = '버그 탐색을 완료했고 보고서를 완성했어요.';
      const unavailable = '웹사이트 버그 탐색을 마쳤지만 보고서를 불러오지 못했어요. 보고서를 다시 확인해 주세요.';
      const body = message.content.replace(/^(?:버그 탐색을 완료했고 보고서를 완성했어요\.|웹사이트 버그 탐색을 마쳤지만[^\n]*)(?:\n\n)?/, '');
      const content = message.status === 'complete'
        ? [report.status === 'ready' ? completion : unavailable, body].filter(Boolean).join('\n\n')
        : message.content;
      return { ...message, report, content };
    }) }));
  }
  function deleteConversation() {
    if (!deleteId) return;
    controllers.current.get(deleteId)?.abort();
    for (const message of conversations.find(item => item.id === deleteId)?.messages ?? []) planCredentials.current.delete(message.id);
    setConversations(previous => previous.filter(item => item.id !== deleteId));
    setDrafts(previous => { const next = { ...previous }; delete next[deleteId]; return next; });
    if (currentId === deleteId) newChat();
    setDeleteId(null);
  }
  function addUrl(event: FormEvent) {
    event.preventDefault();
    try { const url = new URL(/^https?:\/\//i.test(urlValue.trim()) ? urlValue.trim() : `https://${urlValue.trim()}`); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error(); setDraft(`${draft}${draft ? '\n' : ''}${url.href}`); setModal(null); setUrlValue(''); setUrlError(''); inputRef.current?.focus(); }
    catch { setUrlError('올바른 웹사이트 주소를 입력해 주세요. 예: https://example.com'); }
  }

  const composer = <div ref={composerRef} className={`composer-area ${hasMessages ? 'docked' : ''}`}>
    <form className={`composer ${busy ? 'is-busy' : ''}`} onSubmit={submit}>
      <textarea ref={inputRef} aria-label="메시지" placeholder="테스트할 사이트 주소와 원하는 점검을 적어 주세요" value={draft} onChange={event => { setDraft(event.target.value); setInputError(''); }} rows={2} maxLength={16000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); } }} />
      <div className="composer-toolbar">
        <div className="composer-tools"><button type="button" className="icon-button add-button" aria-label="웹사이트 URL 추가" title="웹사이트 URL 추가" onClick={() => { setUrlError(''); setModal('url'); }}><Plus size={14} /></button><span className="agent-selector" title="지정한 사이트 내부에서만 동작합니다">사이트 내부</span></div>
        <div className="send-tools"><span className="enter-hint">{busy ? '응답 생성 중' : 'Enter로 보내기'}</span>{busy ? <button className="send-button stop-button" type="button" aria-label="응답 중지" onClick={() => currentId && controllers.current.get(currentId)?.abort()}><Square size={12} fill="currentColor" /></button> : <button className="send-button" type="submit" aria-label="메시지 보내기" disabled={!draft.trim()}><ArrowUp size={16} /></button>}</div>
      </div>
    </form>
    {inputError && <p className="composer-error" role="alert">{inputError}</p>}
    {hasMessages && <p className="composer-footnote"><ShieldCheck size={11} />계정 정보는 대화 기록에 저장되지 않습니다.</p>}
  </div>;

  return <div className={`app-shell reference-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${hasMessages ? 'chat-shell' : 'welcome-shell'}`}>
    <aside className="sidebar" aria-label="대화 기록" inert={!sidebarOpen}>
      <div className="sidebar-brand"><div className="wordmark"><Brand /><span>WebTestPilot</span></div><button className="icon-button collapse-button" aria-label="사이드바 닫기" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={14} /></button></div>
      <button className="new-chat" aria-label="새 채팅" onClick={newChat}><span className="new-chat-icon"><Plus size={13} /></span><span>새로 만들기</span></button>
      <nav className="sidebar-nav" aria-label="워크스페이스">
        <button className={historyFilter === 'all' ? 'nav-selected' : ''} aria-pressed={historyFilter === 'all'} onClick={() => { setHistoryFilter('all'); setHistoryOpen(true); setSearch(''); }}>검사 기록</button>
        <button className={historyFilter === 'reports' ? 'nav-selected' : ''} aria-pressed={historyFilter === 'reports'} onClick={() => { setHistoryFilter('reports'); setHistoryOpen(true); setSearch(''); }}>보고서<span aria-hidden="true">{conversations.filter(item => item.messages.some(message => message.report)).length || ''}</span></button>
      </nav>
      <div className="search-box"><Search size={13} /><input ref={searchRef} value={search} onChange={event => { setSearch(event.target.value); setHistoryOpen(true); }} placeholder="대화 검색" aria-label="대화 검색" /><kbd>Ctrl K</kbd></div>
      <div className="history-heading"><button onClick={() => setHistoryOpen(value => !value)} aria-expanded={historyOpen}>{historyFilter === 'reports' ? '보고서가 있는 대화' : '최근 항목'} {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</button></div>
      <div className="history-list">{historyOpen && (groups.length ? groups.map(group => <div className="history-group" key={group.label}><p className="history-date">{group.label}</p>{group.items.map(item => <div className={`history-item ${currentId === item.id ? 'selected' : ''}`} key={item.id}>
        <button className="history-select" onClick={() => { setCurrentId(item.id); followScroll.current = true; }} title={item.title}>{activeIds.includes(item.id) && <LoaderCircle size={12} className="spin history-running" />}<span className="history-item-copy"><strong>{item.title}</strong><small>{conversationSite(item)}</small></span></button><button className="history-delete icon-button" aria-label={`${item.title} 대화 삭제`} onClick={() => setDeleteId(item.id)}><Trash2 size={12} /></button>
      </div>)}</div>) : <div className="history-empty">{historyFilter === 'reports' ? <FileText size={20} strokeWidth={1.4} /> : <History size={20} strokeWidth={1.4} />}<p>{search ? '검색 결과가 없어요' : historyFilter === 'reports' ? '아직 보고서가 없어요' : '아직 대화가 없어요'}</p><span>{search ? '다른 검색어로 찾아보세요.' : historyFilter === 'reports' ? '완료된 보고서를 여기서 다시 열 수 있어요.' : '새로운 검사를 시작해 보세요.'}</span></div>)}</div>
      <div className="sidebar-bottom">
        <button className="account-button" aria-label="QA팀 설정" title="QA팀 · API 키 및 모델 설정" onClick={() => setModal('settings')}><span className="account-avatar" aria-hidden="true">QA</span><span className="account-name">QA팀</span><Settings2 size={14} className="account-settings-icon" /></button>
        <button className="account-help" aria-label="도움말" title="도움말" onClick={() => setModal('help')}><CircleHelp size={14} /></button>
      </div>
    </aside>
    <main className="main-panel">
      <header className="topbar"><div className="topbar-left">{!sidebarOpen && <button className="icon-button" aria-label="사이드바 열기" onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={16} /></button>}{hasMessages && <span className="topbar-title">{conversation?.title}</span>}</div><div className="topbar-right"><button className="mode-badge" onClick={() => setModal('settings')}><span />{aiSettings?.keyConfigured ? modelName(selectedModel) : 'API 연결'}<ChevronDown size={10} /></button>{window.pilotDesktop && <div className="window-controls"><button aria-label="창 최소화" onClick={() => window.pilotDesktop?.minimize()}><Minus size={14} /></button><button aria-label={maximized ? '창 복원' : '창 최대화'} onClick={() => void window.pilotDesktop?.toggleMaximize()}><Maximize2 size={12} /></button><button className="window-close" aria-label="앱 닫기" onClick={() => window.pilotDesktop?.close()}><X size={16} /></button></div>}</div></header>
      {storageError && <div className="storage-warning" role="alert">저장 공간을 사용할 수 없어 대화가 보관되지 않을 수 있습니다.</div>}
      {aiError && <div className="storage-warning" role="alert">{aiError}</div>}{effectError && <div className="storage-warning" role="alert">{effectError}</div>}
      {hasMessages ? <>
        <div ref={scrollRef} className="conversation-scroll" onScroll={event => { const element = event.currentTarget; followScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}><div className="conversation-content">
          {conversation.messages.map(message => <Message key={message.id} message={message} busy={busy} credentialsReady={planCredentials.current.has(message.id)} onStart={() => void startTour(message.id)} onEdit={() => editTour(message.id)} onReportChange={report => updateReport(conversation.id, message.id, report)} animate={freshMessages.current.has(message.id)} onEntered={() => freshMessages.current.delete(message.id)} />)}
          <div className="sr-only" role="status" aria-live="polite">{busy ? '에이전트가 응답하고 있습니다.' : '응답이 완료되었습니다.'}</div>
        </div></div>{composer}
      </> : <div className="welcome"><div className="welcome-content"><div className="welcome-hero" ref={welcomeHeroRef}><WelcomeHero /></div>{composer}</div></div>}
      {departingHero && <div className="welcome-departure" style={departingHero} aria-hidden="true"><WelcomeHero /></div>}
    </main>
    {editingPlan && <Modal title="버그 탐색 설정 바꾸기" onClose={() => setEditingPlan(null)}><TourPlanEditor plan={editingPlan.plan} onChange={changeTourPlan} onSubmit={saveTour} error={planError} credentials={editingPlan.credentials} onCredentialsChange={credentials => setEditingPlan(previous => previous ? { ...previous, credentials } : null)} /></Modal>}
    {modal === 'settings' && <Modal title="API 및 앱 설정" onClose={() => setModal(null)}><SettingsPanel settings={aiSettings} onSaved={settings => { setAiSettings(settings); setAiError(''); }} running={activeIds.length > 0} /></Modal>}
    {modal === 'help' && <Modal title="WebPilot 시작하기" onClose={() => setModal(null)}><div className="help-content"><p>테스트할 웹사이트 주소와 확인하고 싶은 내용을 채팅으로 보내세요. 에이전트의 진행 과정과 응답이 대화에 표시됩니다.</p><p className="help-callout">URL을 보내면 먼저 버그 탐색 설정 카드가 표시됩니다. 설정을 확인하고 시작하기를 누르면 Microsoft Edge가 열립니다. 여러 URL이 있으면 첫 번째 주소를 엽니다. API 키를 연결하면 같은 출처의 페이지 정보를 모델에 전달하고 실제 클릭·입력·이동을 수행합니다. 프롬프트에 아이디: / 비밀번호: 를 각각 한 줄로 넣거나 버그 탐색 설정에서 계정을 지정하면 로그인도 진행합니다. 버그 판정은 하지 않습니다.</p><dl><div><dt>새 채팅</dt><dd><kbd>Ctrl</kbd> + <kbd>N</kbd></dd></div><div><dt>대화 검색</dt><dd><kbd>Ctrl</kbd> + <kbd>K</kbd></dd></div><div><dt>메시지 보내기</dt><dd><kbd>Enter</kbd></dd></div><div><dt>줄 바꾸기</dt><dd><kbd>Shift</kbd> + <kbd>Enter</kbd></dd></div></dl><p className="muted-note">대화는 현재 앱에 저장됩니다. 왼쪽 목록에서 다시 열거나 삭제할 수 있습니다.</p></div></Modal>}
    {modal === 'url' && <Modal title="웹사이트 추가" onClose={() => setModal(null)}><form onSubmit={addUrl} className="url-form"><label htmlFor="site-url">살펴볼 웹사이트 주소</label><div className="url-input"><Link2 size={17} /><input id="site-url" value={urlValue} onChange={event => { setUrlValue(event.target.value); setUrlError(''); }} placeholder="https://example.com" autoFocus /></div>{urlError && <p className="field-error" role="alert">{urlError}</p>}<p className="muted-note">주소를 메시지에 추가한 뒤, 원하는 테스트를 함께 요청하세요.</p><button className="primary-button" disabled={!urlValue.trim()}>메시지에 추가</button></form></Modal>}
    {deleteId && <Modal title="대화를 삭제할까요?" onClose={() => setDeleteId(null)}><p className="delete-description">이 기기에 저장된 대화와 응답이 삭제됩니다. 삭제한 대화는 복구할 수 없습니다.</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteId(null)}>취소</button><button className="danger-button" onClick={deleteConversation}>대화 삭제</button></div></Modal>}
  </div>;
}
