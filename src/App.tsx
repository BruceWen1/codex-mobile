// -*- coding: utf-8 -*-
/**
 * App.tsx
 * Codex Mobile Conversation Interface
 * =====================
 * Presents original Codex sessions, login methods, execution events, and approvals.
 */
import { Capacitor } from '@capacitor/core';
import { ArrowUp, Check, ChevronDown, ChevronRight, Code2, FileText, Folder, FolderOpen, KeyRound, LoaderCircle, Menu, MessageSquare, Plus, Settings2, ShieldCheck, Square, Terminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

import { CodexClient } from './codex';
import type { RpcEvent } from './codex';
import { executeFileOperation, FILE_TOOL } from './files';
import { projectItem, reduceEvent } from './session';
import type { Message, Workspace } from './types';

/**
 * Codex-style geometric identity mark.
 * Renders a scalable monochrome mark for the mobile interface.
 *
 * Args:
 *     small (boolean): Whether the mark uses its compact header variant.
 * Returns:
 *     JSX.Element: Scalable identity mark.
 */
function CodexMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'codex-mark small' : 'codex-mark'} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M17 12H10V19L5 24L10 29V36H17M31 12H38V19L43 24L38 29V36H31M27 10L21 38" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/**
 * Render the mobile Codex client.
 *
 * Args:
 *     None.
 * Returns:
 *     JSX.Element: Mobile conversation, session drawer, settings, and approval surfaces.
 */
export function App() {
  const client = useRef(new CodexClient());
  const [status, setStatus] = useState<'starting' | 'ready' | 'preview' | 'failed'>('starting');
  const [startupError, setStartupError] = useState('');
  const [account, setAccount] = useState<Record<string, any> | null>(null);
  const [models, setModels] = useState<Record<string, any>[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('medium');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [threads, setThreads] = useState<Record<string, any>[]>([]);
  const [threadId, setThreadId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [turnId, setTurnId] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [toast, setToast] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [login, setLogin] = useState<Record<string, any> | null>(null);
  const [pending, setPending] = useState<RpcEvent[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const state = useRef({ threadId, workspace, model, effort });
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  state.current = { threadId, workspace, model, effort };

  /**
   * Refresh the account and the actual model catalog from Codex.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<void>: Updated authentication state and model choices.
   */
  async function refreshAccount(): Promise<void> {
    const response = await client.current.request('account/read', { refreshToken: false });
    setAccount(response.account);
    // Load model choices only from the original engine catalog.
    if (response.account) {
      const catalog = await client.current.request('model/list', {});
      setModels(catalog.data ?? []);
      const selected = catalog.data?.find((item: any) => item.model === state.current.model) ?? catalog.data?.find((item: any) => item.isDefault) ?? catalog.data?.[0];
      // Retain a catalog-supported selection or adopt the actual engine default.
      if (selected) {
        setModel(selected.model);
        // Use the engine's default effort when the current model does not support the prior choice.
        if (!selected.supportedReasoningEfforts?.some((item: any) => item.reasoningEffort === state.current.effort)) setEffort(selected.defaultReasoningEffort);
      }
    }
  }

  /**
   * Refresh the original Codex conversation list.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<void>: Updated saved thread list.
   */
  async function refreshThreads(): Promise<void> {
    const response = await client.current.request('thread/list', { limit: 50, sortKey: 'updated_at' });
    setThreads(response.data ?? []);
  }

  /**
   * Select a model and its supported default reasoning effort.
   *
   * Args:
   *     selected (object): Actual model entry returned by the original engine.
   * Returns:
   *     void: The next turn uses the selected model and its supported effort.
   */
  function selectModel(selected: Record<string, any>): void {
    setModel(selected.model);
    setEffort(selected.defaultReasoningEffort);
    setModelMenu(false);
  }

  /**
   * Consume a real upstream engine event.
   *
   * Args:
   *     event (RpcEvent): Original notification or server-initiated request.
   * Returns:
   *     void: Updated transcript, account state, or pending approval queue.
   */
  function receive(event: RpcEvent): void {
    // Preserve pending original server requests for explicit user decisions.
    if (event.id !== undefined) {
      // Execute read-only file inspections under the selected native directory grant.
      if (event.method === 'item/tool/call' && event.params.tool === 'mobile_files' && ['list', 'stat', 'read'].includes(event.params.arguments?.operation)) {
        void executeRead(event);
        return;
      }
      setPending((current) => [...current, event]);
      return;
    }
    // Refresh authentication after the upstream login completes.
    if (event.method === 'account/login/completed' || event.method === 'account/updated') {
      setLoginBusy(false);
      setLogin(null);
      void refreshAccount().catch((error) => setToast(error.message));
      // Surface the original authentication failure when reported.
      if (event.params.success === false) setToast(event.params.error ?? '登录未完成。');
    }
    // Apply transcript updates only to the currently selected conversation.
    if (event.params.threadId === state.current.threadId) {
      setMessages((current) => reduceEvent(current, event));
      // Track the original turn identifier for interruption.
      if (event.method === 'turn/started') { setBusy(true); setTurnId(event.params.turn.id); }
      // Complete the visible turn only after the actual engine completion event.
      if (event.method === 'turn/completed') { setBusy(false); setTurnId(''); void refreshThreads(); }
    }
    // Display original execution or native transport failures.
    if (event.method === 'error' || event.method === 'mobile/error') {
      setToast(event.params.error?.message ?? event.params.message ?? '执行失败。');
    }
    // Resynchronize authoritative state after a reported event delivery gap.
    if (event.method === 'mobile/lagged' && state.current.threadId) void loadThread(state.current.threadId);
    // Clear requests that the original engine has resolved or cancelled.
    if (event.method === 'serverRequest/resolved') setPending((current) => current.filter((request) => request.id !== event.params.requestId));
  }

  /**
   * Execute a read-only engine file request within the current native grant.
   *
   * Args:
   *     event (RpcEvent): Actual original dynamic-tool request.
   * Returns:
   *     Promise<void>: The actual filesystem result or failure is returned to Codex.
   */
  async function executeRead(event: RpcEvent): Promise<void> {
    try {
      // Require a current directory and a request for the selected conversation.
      if (!state.current.workspace || event.params.threadId !== state.current.threadId) throw new Error('The requested mobile workspace is not active.');
      const result = await executeFileOperation(client.current, state.current.workspace.path, event.params.arguments);
      await client.current.respond(event.id!, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] });
    } catch (error) {
      await client.current.respond(event.id!, { success: false, contentItems: [{ type: 'inputText', text: String(error) }] });
    }
  }

  /**
   * Initialize the native Codex host and query its original state.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<void>: Initialization completes or exposes its actual failure.
   */
  async function initialize(): Promise<void> {
    try {
      const selected = await client.current.start(receive);
      setWorkspace(selected);
      setStatus('ready');
      // Keep an initialized local engine usable when a catalog refresh reports a network error.
      await refreshAccount().catch((error) => setToast(String(error)));
      await refreshThreads().catch((error) => setToast(String(error)));
    } catch (error) {
      setStatus(Capacitor.isNativePlatform() ? 'failed' : 'preview');
      setStartupError(String(error));
    }
  }

  // Attach the interface to the process-local engine for its visible lifetime.
  useEffect(() => {
    void initialize();
    return () => client.current.stop();
  }, []);

  // Keep the visible transcript scrolled to newly received engine content.
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [messages, busy]);

  // Expire transient notices while preserving persistent engine state in settings.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Load and resume an original saved Codex conversation.
   *
   * Args:
   *     id (string): Original Codex thread identifier.
   * Returns:
   *     Promise<void>: Authoritative history is rendered and ready for continuation.
   */
  async function loadThread(id: string): Promise<void> {
    // Preserve the active task's directory and approvals until execution finishes.
    if (busy && id !== threadId) { setToast('当前任务正在执行，请先停止任务再切换会话。'); return; }
    try {
      const response = await client.current.request('thread/resume', { threadId: id });
      const items = (response.thread.turns ?? []).flatMap((turn: any) => turn.items).map(projectItem).filter(Boolean);
      setThreadId(id);
      state.current.threadId = id;
      setMessages(items);
      const cwd = response.thread.cwd;
      // Restore the original working directory before continuing a saved thread.
      if (cwd) {
        const selected: Workspace = { id: 'thread-' + id, name: cwd.split('/').filter(Boolean).at(-1) ?? '当前目录', kind: 'selected', path: cwd };
        setWorkspace(selected);
        state.current.workspace = selected;
      }
      const lastTurn = response.thread.turns?.at(-1);
      setBusy(lastTurn?.status === 'inProgress');
      setTurnId(lastTurn?.status === 'inProgress' ? lastTurn.id : '');
      setDrawer(false);
    } catch (error) { setToast(String(error)); }
  }

  /**
   * Submit the current task through the original Codex turn API.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<void>: The original engine starts a turn or reports its failure.
   */
  async function send(): Promise<void> {
    // Keep preview submission explicit about its available execution capability.
    if (status !== 'ready') { setToast(startupError || 'Codex 内核正在启动。'); return; }
    // Present the existing authentication choices before an unauthenticated request.
    if (!account) { setSettings(true); return; }
    // Submit only a nonempty task while the selected conversation is idle.
    if (!draft.trim() || busy || !workspace) return;
    const text = draft.trim();
    setBusy(true);
    setDraft('');
    try {
      let id = threadId;
      // Create an original durable thread when the mobile view has no active session.
      if (!id) {
        const response = await client.current.request('thread/start', {
          model: model || null,
          cwd: workspace.path,
          approvalPolicy: 'on-request',
          sandbox: client.current.shellAvailable ? 'danger-full-access' : 'read-only',
          dynamicTools: [FILE_TOOL],
          developerInstructions: 'Work on the authorized mobile directory. Use mobile_files for device file operations. Its paths are relative to the current directory. Report only observed results. Reply in Chinese.',
          // Mobile operating-system sandboxes enforce native application permissions.
          // Enable original command execution only with a packaged native execution helper.
          config: { 'features.shell_tool': client.current.shellAvailable },
        });
        id = response.thread.id;
        setThreadId(id);
        state.current.threadId = id;
      }
      setMessages((current) => [...current, { id: 'local-' + crypto.randomUUID(), role: 'user', text }]);
      const response = await client.current.request('turn/start', {
        threadId: id,
        input: [{ type: 'text', text, text_elements: [] }],
        model: model || null,
        effort,
      });
      setTurnId(response.turn.id);
    } catch (error) { setToast(String(error)); setBusy(false); setDraft(text); }
  }

  /**
   * Interrupt the actual active Codex turn.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<void>: The original interrupt request is delivered to the engine.
   */
  async function interrupt(): Promise<void> {
    // Send interruption only for an actual running turn.
    if (threadId && turnId) await client.current.request('turn/interrupt', { threadId, turnId });
  }

  /**
   * Create an empty view for the next Codex conversation.
   *
   * Args:
   *     None.
   * Returns:
   *     void: The current session remains saved by the engine.
   */
  function newConversation(): void {
    // Keep a running turn visible until it is completed or interrupted.
    if (busy) { setToast('当前任务正在执行，请先停止任务。'); return; }
    setThreadId(''); state.current.threadId = ''; setMessages([]); setDrawer(false); setDraft('');
  }

  /**
   * Select an operating-system-authorized working directory.
   *
   * Args:
   *     None.
   * Returns:
   *     Promise<void>: The selected directory becomes the next conversation's workspace.
   */
  async function selectDirectory(): Promise<void> {
    // Require the actual native permission interface for device directories.
    if (status !== 'ready') { setToast(startupError); return; }
    try {
      const selected = await client.current.selectDirectory();
      setWorkspace(selected); setWorkspaceMenu(false); newConversation();
    } catch (error) { setToast(String(error)); }
  }

  /**
   * Start either original Codex login method.
   *
   * Args:
   *     type (string): ChatGPT device authorization or API key login.
   * Returns:
   *     Promise<void>: The upstream login starts and its result is displayed.
   */
  async function signIn(type: 'chatgptDeviceCode' | 'apiKey'): Promise<void> {
    // Keep both authentication routes tied to the actual embedded engine.
    if (status !== 'ready') { setToast(startupError); return; }
    setLoginBusy(true);
    try {
      const response = await client.current.request('account/login/start', type === 'apiKey' ? { type, apiKey: apiKey.trim() } : { type });
      setApiKey('');
      // Present the original device-code authorization without a mobile-specific OAuth client.
      if (response.type === 'chatgptDeviceCode') {
        setLogin(response);
        await client.current.openUrl(response.verificationUrl);
      } else { setLoginBusy(false); await refreshAccount(); }
    } catch (error) { setLoginBusy(false); setApiKey(''); setToast(String(error)); }
  }

  /**
   * Resolve the currently displayed original server request.
   *
   * Args:
   *     allow (boolean): User decision for this request.
   * Returns:
   *     Promise<void>: The matching protocol response is delivered to Codex.
   */
  async function resolveRequest(allow: boolean): Promise<void> {
    const event = pending[0];
    // Keep an absent request from generating a protocol response.
    if (!event || event.id === undefined) return;
    try {
      // Route mobile file operations through the original filesystem surface.
      if (event.method === 'item/tool/call' && event.params.tool === 'mobile_files') {
        let result;
        // Execute only the operation that the user has accepted for this request.
        if (allow && state.current.workspace && event.params.threadId === state.current.threadId) {
          try {
            const output = await executeFileOperation(client.current, state.current.workspace.path, event.params.arguments);
            result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] };
          } catch (error) { result = { success: false, contentItems: [{ type: 'inputText', text: String(error) }] }; }
        } else { result = { success: false, contentItems: [{ type: 'inputText', text: 'The user declined this operation.' }] }; }
        await client.current.respond(event.id, result);
      } else if (event.method.includes('requestUserInput')) {
        const result = Object.fromEntries((event.params.questions ?? []).map((question: any) => [question.id, { answers: [answers[question.id] ?? ''] }]));
        await client.current.respond(event.id, { answers: allow ? result : {} });
      } else if (event.method === 'item/permissions/requestApproval') {
        await client.current.respond(event.id, { permissions: allow ? event.params.permissions : {}, scope: 'turn' });
      } else if (event.method.includes('requestApproval')) {
        await client.current.respond(event.id, { decision: allow ? 'accept' : 'decline' });
      } else { await client.current.reject(event.id, 'This mobile interface does not handle the requested interaction.'); }
      setPending((current) => current.slice(1)); setAnswers({});
    } catch (error) { setToast(String(error)); }
  }

  const activeRequest = pending[0];
  const activeTitle = threads.find((thread) => thread.id === threadId)?.name ?? threads.find((thread) => thread.id === threadId)?.preview;
  const modelLabel = (models.find((item) => item.model === model)?.displayName ?? model) || '默认模型';
  const effortOptions = models.find((item) => item.model === model)?.supportedReasoningEfforts ?? [{ reasoningEffort: 'medium' }];
  const effortLabels: Record<string, string> = { none: '默认', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '最高', max: '最大', ultra: 'Ultra' };
  const statusLabel = { starting: '正在启动', ready: '本机运行', preview: '界面预览', failed: '内核未就绪' }[status];

  return <div className="app-shell">
    <header className="topbar">
      <button className="icon-button" aria-label="打开会话列表" onClick={() => setDrawer(true)}><Menu size={21} /></button>
      <div className="brand"><CodexMark small /><span>Codex</span><span className="mobile-label">mobile</span></div>
      <button className="icon-button" aria-label="新对话" onClick={newConversation}><Plus size={23} /></button>
    </header>

    <main ref={scroll} className={messages.length ? 'conversation' : 'home'}>
      {messages.length === 0 ? <>
        <div className="home-identity"><div className="identity-tile"><CodexMark /></div><span className="eyebrow">CODEX · MOBILE</span></div>
        <h1>今天想做什么？</h1>
        <p className="home-description">把任务交给 Codex，<br />在手机上继续你的工作。</p>
        <div className="workspace-card" onClick={() => setWorkspaceMenu(true)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setWorkspaceMenu(true); }}>
          <div className="folder-tile"><FolderOpen size={22} strokeWidth={1.5} /></div>
          <div><span className="label">当前工作目录</span><strong>{workspace?.name ?? '选择手机文件夹'}</strong></div>
          <ChevronRight size={18} />
        </div>
        <div className="suggestions"><span>从一个任务开始</span>
          {[{ icon: Folder, title: '整理文件', text: '查看当前目录，按文件类型整理文件，执行前说明方案。' }, { icon: FileText, title: '处理数据', text: '查看当前目录中的数据文件，说明结构和可以进行的处理。' }, { icon: Terminal, title: '检查目录', text: '列出当前目录的文件，并总结目录结构。' }].map(({ icon: Icon, title, text }) => <button key={title} onClick={() => { setDraft(text); input.current?.focus(); }}><Icon size={17} strokeWidth={1.6} /><span>{title}</span><ArrowUp size={15} /></button>)}
        </div>
      </> : <>
        <div className="conversation-heading"><span>{activeTitle ?? '当前任务'}</span><span><Folder size={13} /> {workspace?.name}</span></div>
        {messages.map((message) => <div className={`message ${message.role}`} key={message.id}>
          {message.role === 'assistant' && <div className="assistant-label"><CodexMark small /><span>Codex</span></div>}
          {message.role === 'tool' ? <div className="tool-line">{message.status === 'running' ? <LoaderCircle className="spin" size={15} /> : message.status === 'completed' ? <Check size={15} /> : <X size={15} />}<code>{message.text}</code><span>{message.status === 'running' ? '执行中' : message.status === 'completed' ? '已完成' : '失败'}</span></div> : <ReactMarkdown>{message.text}</ReactMarkdown>}
        </div>)}
        {busy && <div className="working"><LoaderCircle size={15} className="spin" />Codex 正在工作</div>}
      </>}
    </main>

    <footer className="composer-area">
      <div className="composer">
        <textarea ref={input} aria-label="输入任务" placeholder="描述你的任务…" value={draft} rows={2} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <div className="composer-bottom"><div className="composer-context">
          <button className="workspace-chip" onClick={() => setWorkspaceMenu(true)}><Folder size={14} /><span>{workspace?.name ?? '选择目录'}</span><ChevronDown size={12} /></button>
          <button className="model-chip" onClick={() => setModelMenu(true)}><span>{modelLabel}</span><ChevronDown size={12} /></button>
        </div><button className="send-button" aria-label={busy ? '停止任务' : '发送任务'} disabled={!busy && !draft.trim()} onClick={() => void (busy ? interrupt() : send())}>{busy ? <Square size={16} fill="currentColor" /> : <ArrowUp size={20} />}</button></div>
      </div>
      <div className="footer-meta"><span><span className={`status-dot ${status}`} />{statusLabel}</span><button onClick={() => setSettings(true)}><Settings2 size={12} />{account ? '设置' : '登录 Codex'}</button></div>
    </footer>

    {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast('')} aria-label="关闭提示"><X size={14} /></button></div>}

    {drawer && <div className="overlay" onClick={() => setDrawer(false)}><aside className="drawer" onClick={(event) => event.stopPropagation()}>
      <div className="drawer-header"><div className="brand"><CodexMark small />Codex</div><button className="icon-button" aria-label="关闭会话列表" onClick={() => setDrawer(false)}><X size={19} /></button></div>
      <button className="new-chat" onClick={newConversation}><Plus size={18} />新对话<span>⌘ N</span></button>
      <div className="drawer-label">会话</div>
      <div className="thread-list">{threads.length ? threads.map((thread) => <button className={thread.id === threadId ? 'selected' : ''} key={thread.id} onClick={() => void loadThread(thread.id)}><MessageSquare size={16} /><span>{thread.name ?? thread.preview ?? '未命名会话'}</span></button>) : <div className="empty-sessions"><MessageSquare size={25} strokeWidth={1.3} /><p>你的任务会保存在这里</p><span>开始对话，继续工作。</span></div>}</div>
      <button className="drawer-settings" onClick={() => { setDrawer(false); setSettings(true); }}><div className="avatar">{account?.email?.[0]?.toUpperCase() ?? 'C'}</div><div><strong>{account?.email ?? '登录 Codex'}</strong><span>{account?.planType ?? 'ChatGPT 或 API Key'}</span></div><Settings2 size={17} /></button>
    </aside></div>}

    {(settings || modelMenu || workspaceMenu || activeRequest) && <div className="sheet-overlay" onClick={() => { if (!activeRequest) { setSettings(false); setModelMenu(false); setWorkspaceMenu(false); } }}><section className="sheet" onClick={(event) => event.stopPropagation()}>
      <div className="sheet-handle" />
      {settings && !activeRequest && <>
        <div className="sheet-heading"><h2>Codex 设置</h2><button className="icon-button" aria-label="关闭设置" onClick={() => setSettings(false)}><X size={18} /></button></div>
        <div className="engine-status"><Code2 size={20} /><div><strong>{statusLabel}</strong><span>{status === 'ready' ? '登录、会话与任务由本机 Codex 内核管理' : startupError}</span></div></div>
        {account ? <div className="account-block"><ShieldCheck size={23} /><strong>{account.email ?? 'API Key 已配置'}</strong><span>{account.planType ?? 'OpenAI API'}</span><button className="secondary-button" onClick={() => void client.current.request('account/logout').then(refreshAccount).catch((error) => setToast(error.message))}>退出登录</button></div> : <>
          <p className="sheet-description">使用你已有的 Codex 登录方式。</p>
          <button className="primary-button" disabled={loginBusy} onClick={() => void signIn('chatgptDeviceCode')}>{loginBusy ? <LoaderCircle size={17} className="spin" /> : <CodexMark small />}使用 ChatGPT 登录</button>
          {login && <div className="device-code"><span>在授权页面输入此代码</span><strong>{login.userCode}</strong><button onClick={() => void client.current.openUrl(login.verificationUrl)}>重新打开授权页面</button><button onClick={() => void client.current.request('account/login/cancel', { loginId: login.loginId }).then(() => { setLogin(null); setLoginBusy(false); }).catch((error) => setToast(error.message))}>取消登录</button></div>}
          <div className="divider"><span>或使用 API Key</span></div>
          <label className="field-label" htmlFor="api-key">OpenAI API Key</label><div className="key-input"><KeyRound size={16} /><input id="api-key" type="password" autoComplete="off" placeholder="sk-…" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
          <button className="secondary-button" disabled={loginBusy || !apiKey.trim()} onClick={() => void signIn('apiKey')}>使用 API Key 登录</button>
        </>}
        <div className="settings-footnote">Codex Mobile · 0.1.0</div>
      </>}
      {modelMenu && !activeRequest && <><div className="sheet-heading"><h2>模型与推理</h2><button className="icon-button" aria-label="关闭模型选择" onClick={() => setModelMenu(false)}><X size={18} /></button></div>
        {models.length ? models.map((item) => <button className="sheet-choice" key={item.id} onClick={() => selectModel(item)}><div><strong>{item.displayName}</strong><span>{item.description}</span></div>{model === item.model && <Check size={18} />}</button>) : <p className="sheet-description">登录后，从 Codex 读取可用模型。</p>}
        <label className="field-label" htmlFor="effort">推理强度</label><select id="effort" value={effort} onChange={(event) => setEffort(event.target.value)}>{effortOptions.map((item: any) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabels[item.reasoningEffort] ?? item.reasoningEffort}</option>)}</select>
      </>}
      {workspaceMenu && !activeRequest && <><div className="sheet-heading"><h2>工作目录</h2><button className="icon-button" aria-label="关闭目录选择" onClick={() => setWorkspaceMenu(false)}><X size={18} /></button></div>
        <p className="sheet-description">Codex 会在选定目录中读取和处理文件。</p>
        <div className="current-workspace"><FolderOpen size={22} /><div><strong>{workspace?.name ?? '尚未选择目录'}</strong><span>{workspace ? '当前工作目录' : '通过系统授权选择手机文件夹'}</span></div></div>
        <button className="primary-button" disabled={busy} onClick={() => void selectDirectory()}><Folder size={17} />选择手机文件夹</button>
      </>}
      {activeRequest && <><div className="sheet-heading"><h2>{activeRequest.method.includes('requestUserInput') ? 'Codex 需要你的选择' : '允许执行此操作？'}</h2><ShieldCheck size={22} /></div>
        <p className="sheet-description">{activeRequest.params.reason ?? activeRequest.params.command ?? activeRequest.params.tool ?? '确认当前任务中的操作。'}</p>
        {activeRequest.method.includes('requestUserInput') ? (activeRequest.params.questions ?? []).map((question: any) => <div className="question" key={question.id}><label>{question.question}</label>{question.options?.map((option: any) => <button className={answers[question.id] === option.label ? 'selected' : ''} key={option.label} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}>{option.label}</button>)}<input placeholder="输入你的回答" value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /></div>) : <pre className="approval-detail">{JSON.stringify(activeRequest.params.arguments ?? activeRequest.params.permissions ?? activeRequest.params.commandActions ?? activeRequest.params, null, 2)}</pre>}
        <div className="approval-buttons"><button className="secondary-button" onClick={() => void resolveRequest(false)}>拒绝</button><button className="primary-button" onClick={() => void resolveRequest(true)}>{activeRequest.method.includes('requestUserInput') ? '提交选择' : '允许此次操作'}</button></div>
      </>}
    </section></div>}
  </div>;
}
