import { inside, workspaceFilePath, workspaceRootFor } from '../../server/src/workspace/paths';
import { BaseWindow, BrowserWindow, WebContentsView, session, net, type Session } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserLayout, BrowserObservation, BrowserState, BrowserTab, ToolOutcome, VisualActionResult } from '@graycode/contracts';
import { authorizeEffects, type ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../server/src/application';
import type { BrowserHost } from '../../server/src/browser/port';
import { BrowserPage } from './browser/page';
import { BrowserProfiles } from './browser/profiles';
import { BrowserTransfers } from './browser/transfers';

interface OwnedTab {
  id: string; actorId: string; profileId: string; view: WebContentsView; page: BrowserPage;
  loading: boolean; error?: string; source?: { workspaceId: string; path: string };
  lease?: { runId: string; conversationId?: string; controller: AbortController };
  userControlled: boolean; queue: Promise<unknown>; modelInput: boolean;
  blockedDownload?: { filename: string; url: string };
}
interface BrowserOperation {
  id: string; fingerprint: string; tabId: string; runId: string; requestedAt: number; finishedAt?: number;
  status: VisualActionResult['status']; outcome?: ToolOutcome; error?: string;
}

export class DesktopBrowser implements BrowserHost {
  private readonly tabs = new Map<string, OwnedTab>();
  private readonly profiles: BrowserProfiles;
  private readonly transfers: BrowserTransfers;
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly previewRoots = new Map<string, { workspaceId: string; actorId: string; profileId: string; tabId: string; directory: string; files: Set<string> }>();
  private readonly active = new Map<string, string>();
  private lastLayout?: BrowserLayout;
  private closing = false;
  private captureWindow?: BaseWindow;
  private displayWindow?: BrowserWindow;
  private readonly restoreLayout = () => { if (this.lastLayout) this.layout(this.lastLayout); };
  constructor(private readonly application: PlatformApplication, private readonly getWindow: () => BrowserWindow | undefined,
    private readonly notify: (event: Record<string, unknown>) => void) {
    this.profiles = new BrowserProfiles(application);
    this.transfers = new BrowserTransfers(application);
    application.subscribe(event => {
      if (event.type !== 'file.changed') return;
      for (const tab of this.tabs.values()) {
        if (!tab.lease && [...this.previewRoots.values()].some(root => root.tabId === tab.id && root.workspaceId === event.workspaceId && root.files.has(String(event.absolute)))) tab.view.webContents.reloadIgnoringCache();
      }
    });
  }
  private actor(actorId: string): void {
    const actor = this.application.actor(actorId); const denied = actor ? authorizeEffects(actor, ['private_browser']) : '账号不可用。';
    if (denied) throw new Error(denied);
  }
  private tab(actorId: string, id: unknown): OwnedTab {
    this.actor(actorId);
    const value = typeof id === 'string' ? this.tabs.get(id) : undefined;
    if (!value || value.actorId !== actorId || value.view.webContents.isDestroyed()) throw new Error('网页标签不存在或不属于当前账号。');
    return value;
  }
  private describe(tab: OwnedTab): BrowserTab {
    const wc = tab.view.webContents;
    return { id: tab.id, profileId: tab.profileId, url: wc.getURL(), title: wc.getURL() === 'about:blank' ? '' : wc.getTitle(), loading: tab.loading,
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), error: tab.error,
      userControlled: tab.userControlled, ...(tab.lease ? { controlledBy: { runId: tab.lease.runId, conversationId: tab.lease.conversationId } } : {}) };
  }
  async state(actorId: string): Promise<BrowserState> {
    this.actor(actorId);
    return { profiles: await this.profiles.list(actorId), tabs: [...this.tabs.values()].filter(tab => tab.actorId === actorId).map(tab => this.describe(tab)), activeTabId: this.active.get(actorId) };
  }
  private changed(actorId: string): void {
    // 桌面仅订阅本机主人标签，不广播其他账号的网页与登录配置。
    if (!this.closing && actorId === 'owner') this.notify({ type: 'browser.changed' });
  }
  private allowed(url: string, profileId: string): boolean {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) || url === 'about:blank'
        || parsed.protocol === 'graycode-preview:' && this.previewRoots.get(parsed.host)?.profileId === profileId;
    } catch { return false; }
  }
  private async browserSession(actorId: string, profileId?: string): Promise<{ session: Session; profileId: string }> {
    const profile = await this.profiles.get(actorId, profileId);
    if (!this.sessions.has(profile.id)) this.sessions.set(profile.id, (async () => {
      const value = session.fromPartition(this.profiles.partition(profile));
      value.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      value.setPermissionCheckHandler(() => false);
      value.on('will-download', (event, item, contents) => {
        const tab = [...this.tabs.values()].find(tab => tab.view.webContents === contents);
        if (this.transfers.receive(contents, item)) return;
        if (tab?.page.automated) {
          tab.blockedDownload = { filename: item.getFilename(), url: item.getURL() };
          event.preventDefault(); tab.page.log('error', `下载需要保存路径：${tab.blockedDownload.filename}。使用 browser_files 的 download 操作。`);
        }
      });
      if (!(await value.protocol.isProtocolHandled('graycode-preview'))) await value.protocol.handle('graycode-preview', async request => {
        try {
          const url = new URL(request.url); const root = this.previewRoots.get(url.host);
          if (!root || root.profileId !== profile.id) return new Response('Preview is unavailable.', { status: 404 });
          const workspace = this.application.workspace(root.actorId, root.workspaceId, ['workspace_read']);
          const target = path.resolve(root.directory, decodeURIComponent(url.pathname).replace(/^\//, ''));
          if (!inside(root.directory, target)) throw new Error('预览路径不属于当前目录。');
          const file = await this.application.files.resolve(workspace, target);
          root.files.add(file);
          const response = await net.fetch(pathToFileURL(file).toString());
          const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        } catch { return new Response('Preview path is unavailable.', { status: 403 }); }
      });
      return value;
    })());
    return { session: await this.sessions.get(profile.id)!, profileId: profile.id };
  }
  private async create(actorId: string, profileId?: string, foreground = false): Promise<OwnedTab> {
    this.actor(actorId); const selected = await this.browserSession(actorId, profileId); this.actor(actorId);
    const parent = this.getWindow();
    const view = new WebContentsView({ webPreferences: { session: selected.session, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
      // 离屏宿主中的子页面也使用离屏合成，不依赖屏幕上存在原生显示表面。
      offscreen: parent?.webContents.isOffscreen() === true } });
    const id = randomUUID();
    const tab: OwnedTab = { id, actorId, profileId: selected.profileId, view, page: new BrowserPage(view.webContents, () => this.changed(actorId)), loading: false,
      userControlled: false, queue: Promise.resolve(), modelInput: false };
    this.tabs.set(id, tab);
    view.setBounds({ x: 0, y: 0, width: 1100, height: 800 }); view.setVisible(false);
    this.attach(tab);
    const wc = view.webContents;
    const publish = () => this.changed(actorId);
    wc.on('did-navigate', publish); wc.on('did-navigate-in-page', publish); wc.on('page-title-updated', publish);
    wc.on('did-start-loading', () => { tab.loading = true; tab.error = undefined; publish(); });
    wc.on('did-stop-loading', () => { tab.loading = false; publish(); });
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { tab.error = description; publish(); } });
    wc.on('render-process-gone', (_event, details) => { tab.error = `网页进程已结束：${details.reason}`; this.takeover(tab); publish(); });
    wc.on('will-frame-navigate', event => {
      const inlineFrame = !event.isMainFrame && (event.url === 'about:srcdoc' || event.url.startsWith('data:'));
      if (!inlineFrame && !this.allowed(event.url, tab.profileId)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => { if (!this.allowed(url, tab.profileId)) event.preventDefault(); });
    wc.setWindowOpenHandler(({ url }) => {
      if (tab.page.automated && !tab.lease) return { action: 'deny' };
      if (this.allowed(url, tab.profileId)) void this.popup(tab, url).catch(error => tab.page.log('error', String(error)));
      return { action: 'deny' };
    });
    wc.on('before-input-event', () => { if (tab.page.automated && !tab.modelInput) this.takeover(tab); });
    wc.on('before-mouse-event', () => { if (tab.page.automated && !tab.modelInput) this.takeover(tab); });
    tab.queue = wc.loadURL('about:blank').then(() => tab.page.connect());
    await tab.queue;
    if (foreground || !this.active.has(actorId)) this.active.set(actorId, id);
    this.changed(actorId); if (foreground) this.show(tab);
    return tab;
  }
  private async popup(source: OwnedTab, url: string): Promise<void> {
    const lease = source.lease;
    const tab = await this.create(source.actorId, source.profileId, !source.page.automated);
    tab.page.automated = source.page.automated;
    if (lease && !lease.controller.signal.aborted) {
      tab.lease = { runId: lease.runId, conversationId: lease.conversationId, controller: new AbortController() }; tab.page.automated = true;
    }
    await this.navigate(tab, url);
  }
  private async navigate(tab: OwnedTab, url: unknown, signal?: AbortSignal): Promise<void> {
    if (typeof url !== 'string' || !this.allowed(url, tab.profileId)) throw new Error('浏览器只接受 HTTP(S) 地址或当前登录配置的工作区预览。');
    signal?.throwIfAborted(); tab.error = undefined; tab.page.invalidate();
    const abort = () => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    try { await tab.view.webContents.loadURL(url); signal?.throwIfAborted(); }
    catch (error) {
      signal?.throwIfAborted();
      if (signal || (error as { code?: string }).code !== 'ERR_ABORTED') throw error;
    }
    finally { signal?.removeEventListener('abort', abort); }
  }
  private show(tab: OwnedTab): void {
    this.active.set(tab.actorId, tab.id);
    if (tab.actorId === 'owner') {
      this.notify({ type: 'browser.opened', tabId: tab.id, url: tab.view.webContents.getURL() });
      if (this.lastLayout) this.layout(this.lastLayout);
    }
    this.changed(tab.actorId);
  }
  private takeover(tab: OwnedTab): void {
    tab.userControlled = true; tab.lease?.controller.abort(new Error('用户已接管此网页标签。')); tab.lease = undefined;
    tab.page.invalidate(); tab.page.allowManualInput(); this.changed(tab.actorId);
    this.pauseIdleCapture();
  }
  layout(input: BrowserLayout): void {
    if (this.closing) return;
    this.lastLayout = input;
    const parent = this.getWindow(); if (!parent || parent.isDestroyed()) return;
    if (parent !== this.displayWindow) {
      this.displayWindow?.off('show', this.restoreLayout); this.displayWindow?.off('restore', this.restoreLayout);
      this.displayWindow = parent; parent.on('show', this.restoreLayout); parent.on('restore', this.restoreLayout);
    }
    const visible = input.visible && [input.x, input.y, input.width, input.height].every(Number.isFinite) && input.width > 0 && input.height > 0;
    const zoom = parent.webContents.getZoomFactor(); const [width, height] = parent.getContentSize();
    for (const tab of this.tabs.values()) {
      const active = tab.actorId === 'owner' && this.active.get('owner') === tab.id;
      if (active && visible && parent.isVisible() && !parent.isMinimized()) {
        if (!parent.contentView.children.includes(tab.view)) parent.contentView.addChildView(tab.view);
        const x = Math.max(0, Math.min(width - 1, Math.round(input.x * zoom))); const y = Math.max(0, Math.min(height - 1, Math.round(input.y * zoom)));
        const bounds = { x, y, width: Math.max(1, Math.min(width - x, Math.round(input.width * zoom))), height: Math.max(1, Math.min(height - y, Math.round(input.height * zoom))) };
        const previous = tab.view.getBounds();
        if (previous.width !== bounds.width || previous.height !== bounds.height) tab.page.invalidate();
        tab.view.setBounds(bounds);
        tab.view.setVisible(true);
      } else if (tab.lease) {
        this.attach(tab);
      } else {
        tab.view.setVisible(false);
      }
    }
    this.pauseIdleCapture();
  }
  private async preview(tab: OwnedTab, workspaceId: string, file: string, signal?: AbortSignal): Promise<void> {
    const workspace = this.application.workspace(tab.actorId, workspaceId, ['workspace_read']);
    const absolute = await this.application.files.resolve(workspace, file);
    const directory = workspaceRootFor(workspace, absolute)!.directory;
    const host = randomUUID();
    for (const [key, value] of this.previewRoots) if (value.tabId === tab.id) this.previewRoots.delete(key);
    this.previewRoots.set(host, { workspaceId, actorId: tab.actorId, profileId: tab.profileId, tabId: tab.id, directory, files: new Set() });
    tab.source = { workspaceId, path: workspaceFilePath(workspace, absolute) };
    await this.navigate(tab, `graycode-preview://${host}/${path.relative(directory, absolute).split(path.sep).map(encodeURIComponent).join('/')}`, signal);
  }
  async open(url: string): Promise<BrowserTab> { return await this.call('owner', 'browser.open', { url }) as BrowserTab; }
  async openFile(workspaceId: string, file: string): Promise<BrowserTab> { return await this.call('owner', 'browser.openFile', { workspaceId, path: file }) as BrowserTab; }
  async control(action: string, url?: string): Promise<unknown> { return this.call('owner', 'browser.control', { action, url }); }
  async call(actorId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.application.requireOwner(actorId);
    if (method === 'browser.layout') return this.layout(params as unknown as BrowserLayout);
    if (method === 'browser.state') return this.state(actorId);
    if (method === 'browser.profile.create') { const value = await this.profiles.create(actorId, params.name); this.changed(actorId); return value; }
    if (method === 'browser.profile.rename') { await this.profiles.rename(actorId, String(params.id), params.name); this.changed(actorId); return; }
    if (method === 'browser.newTab') {
      const tab = await this.create(actorId, params.profileId as string | undefined, true);
      if (params.url) await this.navigate(tab, params.url);
      return this.describe(tab);
    }
    if (method === 'browser.openFile') {
      let tab = [...this.tabs.values()].find(tab => tab.actorId === actorId && tab.source?.workspaceId === params.workspaceId && tab.source?.path === params.path);
      if (!tab) tab = await this.create(actorId, undefined, false);
      if (tab.page.automated) this.takeover(tab);
      await tab.queue.catch(() => {});
      await this.preview(tab, String(params.workspaceId), String(params.path)); this.show(tab); return this.describe(tab);
    }
    let tab: OwnedTab;
    const selectedId = params.tabId ?? this.active.get(actorId);
    if (method === 'browser.open' && !selectedId) tab = await this.create(actorId, params.profileId as string | undefined, true);
    else tab = this.tab(actorId, selectedId);
    if (method === 'browser.select') { this.show(tab); return this.describe(tab); }
    if (method === 'browser.takeover') { this.takeover(tab); return this.describe(tab); }
    if (method === 'browser.allowAutomation') { tab.userControlled = false; this.changed(actorId); return this.describe(tab); }
    if (method === 'browser.closeTab') { this.closeTab(tab); return this.state(actorId); }
    if (method === 'browser.open' || method === 'browser.control') {
      if (tab.page.automated) this.takeover(tab);
      await tab.queue.catch(() => {});
      const action = method === 'browser.open' ? 'navigate' : params.action;
      if (action === 'navigate') { tab.source = undefined; await this.navigate(tab, params.url); }
      else if (action === 'back' && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
      else if (action === 'forward' && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
      else if (action === 'reload') tab.view.webContents.reload();
      else if (action === 'stop') tab.view.webContents.stop();
      else if (action === 'devtools') { this.takeover(tab); tab.page.detach(); tab.view.webContents.openDevTools({ mode: 'detach' }); }
      else if (action !== 'back' && action !== 'forward') throw new Error('不支持的浏览器操作。');
      this.show(tab); return this.describe(tab);
    }
    throw new Error(`未知的浏览器请求：${method}`);
  }
  private claim(tab: OwnedTab, context: ToolContext): AbortSignal {
    this.actor(context.actorId); context.signal.throwIfAborted();
    if (tab.userControlled) throw new Error('用户已接管此标签，请等待用户允许模型操作，或新建自己的标签。');
    if (tab.lease && tab.lease.runId !== context.runId) throw new Error('此标签正在由另一个任务操作，请使用其他标签。');
    if (!tab.lease) {
      tab.lease = { runId: context.runId, conversationId: context.conversationId, controller: new AbortController() };
      tab.page.automated = true;
      this.changed(context.actorId);
    }
    return AbortSignal.any([context.signal, tab.lease.controller.signal]);
  }
  private attach(tab: OwnedTab): void {
    let parent: BaseWindow | undefined = this.getWindow();
    const foreground = parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
      && this.lastLayout?.visible && tab.actorId === 'owner' && this.active.get('owner') === tab.id;
    if (!foreground) {
      const bounds = tab.view.getBounds();
      if (!this.captureWindow || this.captureWindow.isDestroyed())
        this.captureWindow = new BaseWindow({ show: false, frame: false, opacity: 0, focusable: false, skipTaskbar: true,
          width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
      parent = this.captureWindow;
      parent.setIgnoreMouseEvents(true);
      const [width, height] = parent.getContentSize();
      if (width < bounds.width || height < bounds.height) parent.setContentSize(Math.max(width, bounds.width), Math.max(height, bounds.height));
      tab.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    }
    // Windows 需要已显示的原生表面才能绘制；透明宿主不接收输入、不占任务栏、不取得焦点。
    if (!parent!.contentView.children.includes(tab.view)) parent!.contentView.addChildView(tab.view);
    tab.view.setVisible(true);
    if (!foreground && !parent!.isVisible()) parent!.showInactive();
  }
  private pauseIdleCapture() {
    const host = this.captureWindow;
    if (host && !host.isDestroyed() && ![...this.tabs.values()].some(tab => tab.lease && host.contentView.children.includes(tab.view))) host.hide();
  }
  private async capture(tab: OwnedTab, signal: AbortSignal, dimension = 1280): Promise<ToolOutcome> {
    this.attach(tab);
    const frame = await tab.page.screenshot(signal, tab.view.getBounds(), dimension);
    const observation: BrowserObservation = { ...frame.observation, tabId: tab.id };
    return { success: true, data: observation, attachments: [frame.attachment] };
  }
  private async actionResult(tab: OwnedTab, outcome: ToolOutcome, signal: AbortSignal, dimension: number | undefined): Promise<ToolOutcome> {
    try {
      const captured = await this.capture(tab, signal, dimension);
      return { ...outcome, data: { ...outcome.data as Record<string, unknown>, observation: captured.data }, attachments: captured.attachments };
    } catch (error) {
      return { ...outcome, data: { ...outcome.data as Record<string, unknown>, observationError: {
        code: (error as { code?: string }).code ?? 'BROWSER_CAPTURE_FAILED', message: (error as Error).message } } };
    }
  }
  private async performAction(tab: OwnedTab, args: Record<string, unknown>, context: ToolContext, signal: AbortSignal): Promise<ToolOutcome> {
    if (!context.toolCallId) throw new Error('浏览器动作需要运行器提供唯一的工具调用 ID。');
    const id = createHash('sha256').update(JSON.stringify([context.actorId, context.runId, context.iteration, context.toolCallId])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const namespace = 'browser-actions';
    const previous = await this.application.storage.getRecord(namespace, id) as BrowserOperation | null;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('同一工具调用 ID 不能用于不同的浏览器动作。');
      if (previous.status !== 'completed' || !previous.outcome)
        return { success: false, code: 'BROWSER_ACTION_UNKNOWN', error: previous.error ?? '这次动作已经派发但结果未确认，请重新观察。',
          data: { operationId: id, status: previous.status, repeated: true } };
      return this.actionResult(tab, { ...previous.outcome, data: { ...previous.outcome.data as Record<string, unknown>, repeated: true } }, signal, args.maxImageDimension as number | undefined);
    }
    if (args.action !== 'navigate' && args.url !== tab.view.webContents.getURL()) throw new Error('页面地址已经变化或未提供，请重新读取后确认操作目标。');
    this.attach(tab);
    const operation: BrowserOperation = { id, fingerprint, tabId: tab.id, runId: context.runId, requestedAt: Date.now(), status: 'dispatching' };
    const record = { namespace, id, ownerId: context.conversationId ?? context.actorId };
    await this.application.storage.commitRecords([{ ...record, value: operation, expectedRevision: null }]);
    tab.blockedDownload = undefined;
    try {
      const wc = tab.view.webContents;
      signal.throwIfAborted();
      if (args.action === 'navigate') { tab.source = undefined; await this.navigate(tab, args.url, signal); }
      else if (args.action === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
      else if (args.action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
      else if (args.action === 'reload') wc.reload();
      else await tab.page.action(args, signal);
      signal.throwIfAborted(); operation.status = 'completed';
      const receipt: VisualActionResult = { operationId: id, status: 'completed' };
      const download = tab.blockedDownload as OwnedTab['blockedDownload'];
      operation.outcome = download ? { success: false, code: 'DOWNLOAD_DESTINATION_REQUIRED',
        error: '该操作触发文件下载，请通过 browser_files 指定保存路径。', data: { ...download, ...receipt } }
        : { success: true, data: { ...this.describe(tab), ...receipt } };
    } catch (error) {
      operation.status = (error as { code?: string }).code === 'OBSERVATION_STALE' ? 'failed' : 'unknown'; operation.error = (error as Error).message;
      operation.outcome = { success: false, code: (error as { code?: string }).code ?? 'BROWSER_ACTION_UNKNOWN', error: operation.error,
        data: { operationId: id, status: operation.status } };
    } finally { operation.finishedAt = Date.now(); await this.application.storage.putRecord({ ...record, value: operation }); }
    return this.actionResult(tab, operation.outcome!, signal, args.maxImageDimension as number | undefined);
  }
  async tool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    this.actor(context.actorId); context.signal.throwIfAborted();
    if (name === 'browser_tabs' && args.action === 'list') return { success: true, data: await this.state(context.actorId) };
    if (name === 'browser_tabs' && args.action === 'create') {
      if (args.url && args.path) throw new Error('url 和 path 只能提供一个。');
      if (args.path && !context.workspace) throw new Error('预览本地文件需要任务绑定工作区。');
      const tab = await this.create(context.actorId, args.profileId as string | undefined);
      const signal = this.claim(tab, context);
      if (args.url) await this.navigate(tab, args.url, signal);
      if (args.path) await this.preview(tab, context.workspace!.id, String(args.path), signal);
      return { success: true, data: this.describe(tab) };
    }
    const tab = this.tab(context.actorId, args.tabId);
    const operation = tab.queue.catch(() => {}).then(async (): Promise<ToolOutcome> => {
      const signal = this.claim(tab, context); tab.modelInput = true;
      try {
        if (name === 'browser_tabs' && args.action === 'close') { this.closeTab(tab); return { success: true }; }
        if (name === 'browser_tabs' && args.action === 'show') {
          if (context.actorId !== 'owner') throw new Error('只有本机主人可以把自己的网页显示在桌面工作台。');
          this.show(tab); return { success: true, data: { ...this.describe(tab), windowVisible: this.getWindow()?.isVisible() === true } };
        }
        if (name === 'browser_read') {
          if (args.action === 'snapshot') return { success: true, data: await tab.page.snapshot(signal, args) };
          if (args.action === 'screenshot') {
            return await this.capture(tab, signal, args.maxImageDimension as number | undefined);
          }
          if (args.action === 'logs') return { success: true, data: tab.page.logs(args) };
        }
        if (name === 'browser_action') {
          return await this.performAction(tab, args, context, signal);
        }
        if (name === 'browser_files') {
          if (args.url !== tab.view.webContents.getURL()) throw new Error('页面地址已经变化，请重新读取后确认文件传输目标。');
          const currentContext = { ...context, signal };
          if (args.action === 'upload') return { success: true, data: await this.transfers.upload(tab.page, args, currentContext) };
          if (args.action === 'download') return { success: true, data: await this.transfers.download(tab.page, args, currentContext) };
        }
        throw new Error('不支持的浏览器工具操作。');
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'BROWSER_VIEW_REQUIRED' || code === 'BROWSER_CAPTURE_TIMEOUT') return { success: false, code, error: String((error as Error).message), retryable: false, data: this.describe(tab) };
        throw error;
      } finally { tab.modelInput = false; }
    });
    tab.queue = operation; return operation;
  }
  finishRun(runId: string): void {
    for (const tab of this.tabs.values()) if (tab.lease?.runId === runId) {
      tab.lease.controller.abort(new Error('任务已结束。')); tab.lease = undefined; tab.page.invalidate(); this.changed(tab.actorId);
    }
    this.pauseIdleCapture();
  }
  private closeTab(tab: OwnedTab): void {
    tab.lease?.controller.abort(new Error('网页标签已关闭。')); this.tabs.delete(tab.id);
    for (const [host, value] of this.previewRoots) if (value.tabId === tab.id) this.previewRoots.delete(host);
    for (const parent of [this.getWindow(), this.captureWindow])
      if (parent && !parent.isDestroyed() && parent.contentView.children.includes(tab.view)) parent.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.active.get(tab.actorId) === tab.id) {
      const next = [...this.tabs.values()].find(item => item.actorId === tab.actorId);
      if (next) this.active.set(tab.actorId, next.id); else this.active.delete(tab.actorId);
    }
    if (this.lastLayout) this.layout(this.lastLayout); this.changed(tab.actorId);
    this.pauseIdleCapture();
  }
  close(): void {
    this.closing = true; for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    this.displayWindow?.off('show', this.restoreLayout); this.displayWindow?.off('restore', this.restoreLayout);
    if (this.captureWindow && !this.captureWindow.isDestroyed()) this.captureWindow.close();
  }
}
