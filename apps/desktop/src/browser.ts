import { inside, workspaceFilePath, workspaceRootFor } from '../../server/src/workspace/paths';
import { BaseWindow, BrowserWindow, WebContentsView, session, net, type Session, type BrowserWindowConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserLayout, BrowserScreenshot, BrowserState, BrowserTab, ToolOutcome } from '@graycode/contracts';
import { authorizeEffects, type ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../server/src/application';
import type { BrowserHost } from '../../server/src/browser/port';
import { BrowserPage } from './browser/page';
import { validateActionArguments } from './browser/pageActions';
import { BrowserProfiles } from './browser/profiles';
import { isActiveMouseInput } from './browser/input';
import { BrowserTransfers } from './browser/transfers';
import { actionObservationOptions, type ActionObservationOptions } from '../../server/src/browser/observationOptions';

interface OwnedTab {
  id: string; actorId: string; profileId: string; view: WebContentsView; page: BrowserPage;
  loading: boolean; error?: string; source?: { workspaceId: string; path: string };
  lease?: { runId: string; conversationId?: string; controller: AbortController };
  /** 用户接管时正在操作或读取此标签的运行；只拒绝这些运行继续操作，运行结束后下一轮自动交还给模型。 */
  blockedRuns: Set<string>;
  queue: Promise<unknown>; modelInput: boolean;
  /** 进行中的读取及其运行；读取不申领租约，但同样可被用户输入打断。 */
  readers: Map<AbortController, string>;
  actionPopups?: ActionPopups;
  /** 与 webContents 当前的后台节流设置一致；capturing 计数并行截图，最后一个结束后才允许恢复节流。 */
  throttled: boolean; capturing: number;
}
interface PopupResult {
  requestedUrl: string; status: 'opening' | 'opened' | 'failed'; tab?: OwnedTab; error?: string;
}
interface ActionPopups {
  signal: AbortSignal; entries: PopupResult[]; pending: Promise<void>[];
}
/** 在派发输入前就失败的错误码：动作一定没有执行，模型可以修正后重试。 */
const notDispatched = new Set(['INVALID_ARGUMENTS', 'OBSERVATION_STALE', 'BROWSER_TARGET_MISSING', 'BROWSER_NO_GEOMETRY', 'BROWSER_DIALOG_PENDING']);

export class DesktopBrowser implements BrowserHost {
  private readonly tabs = new Map<string, OwnedTab>();
  private readonly profiles: BrowserProfiles;
  private readonly transfers: BrowserTransfers;
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly previewRoots = new Map<string, { workspaceId: string; actorId: string; profileId: string; tabId: string; directory: string; files: Set<string> }>();
  private readonly active = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private lastLayout?: BrowserLayout;
  private closing = false;
  private captureWindow?: BaseWindow;
  private displayWindow?: BrowserWindow;
  private readonly restoreLayout = () => { if (this.lastLayout) this.layout(this.lastLayout); };
  // 最小化或隐藏工作台不会触发 layout；当前标签此时同样不可见，要按状态恢复节流。
  private readonly windowHidden = () => { for (const tab of this.tabs.values()) this.throttle(tab); };
  constructor(private readonly application: PlatformApplication, private readonly getWindow: () => BrowserWindow | undefined,
    private readonly notify: (event: Record<string, unknown>) => void) {
    this.profiles = new BrowserProfiles(application);
    this.transfers = new BrowserTransfers(application);
    this.unsubscribe = application.subscribe(event => {
      if (event.type !== 'file.changed') return;
      const absolute = String(event.absolute);
      // 每个预览标签只有一个目录记录，按记录直接查找标签，避免标签与目录之间的重复遍历。
      for (const root of this.previewRoots.values()) {
        if (root.workspaceId !== event.workspaceId || !root.files.has(absolute)) continue;
        const tab = this.tabs.get(root.tabId);
        if (tab && !tab.lease) tab.view.webContents.reloadIgnoringCache();
      }
    });
  }
  private actor(actorId: string): void {
    const actor = this.application.actor(actorId); const denied = actor ? authorizeEffects(actor, ['private_browser']) : '账号不可用。';
    if (denied) throw new Error(denied);
  }
  private tab(actorId: string, id: unknown): OwnedTab {
    const value = typeof id === 'string' ? this.tabs.get(id) : undefined;
    if (!value || value.actorId !== actorId || value.view.webContents.isDestroyed()) {
      const available = [...this.tabs.values()].filter(tab => tab.actorId === actorId).map(tab => tab.id);
      throw new Error(`网页标签不存在或已关闭；当前可用标签：${available.join('、') || '无'}。`);
    }
    return value;
  }
  /** 桌面界面使用的完整标签状态。 */
  private describe(tab: OwnedTab): BrowserTab {
    const wc = tab.view.webContents;
    return { id: tab.id, profileId: tab.profileId, url: wc.getURL(), title: wc.getURL() === 'about:blank' ? '' : wc.getTitle(), loading: tab.loading,
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), error: tab.error,
      userControlled: tab.blockedRuns.size > 0, ...(tab.lease ? { controlledBy: { runId: tab.lease.runId, conversationId: tab.lease.conversationId } } : {}) };
  }
  /** 交给模型的标签状态：只保留下一步决策需要的字段，默认值省略。 */
  private modelTab(tab: OwnedTab, runId?: string): Record<string, unknown> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return { id: tab.id, closed: true };
    return { id: tab.id, url: wc.getURL(), title: wc.getURL() === 'about:blank' ? '' : wc.getTitle(),
      ...(tab.loading ? { loading: true } : {}), ...(tab.error ? { error: tab.error } : {}),
      ...(tab.blockedRuns.size ? { userControlled: true } : {}), ...(tab.lease && tab.lease.runId !== runId ? { otherTask: true } : {}) };
  }
  async state(actorId: string): Promise<BrowserState> {
    return { profiles: await this.profiles.list(actorId), tabs: [...this.tabs.values()].filter(tab => tab.actorId === actorId).map(tab => this.describe(tab)), activeTabId: this.active.get(actorId) };
  }
  private async modelState(context: ToolContext): Promise<Record<string, unknown>> {
    const profiles = await this.profiles.list(context.actorId);
    return { tabs: [...this.tabs.values()].filter(tab => tab.actorId === context.actorId).map(tab => ({ ...this.modelTab(tab, context.runId), profileId: tab.profileId })),
      activeTabId: this.active.get(context.actorId), profiles: profiles.map(({ id, name }) => ({ id, name })) };
  }
  /** 动作或读取期间新出现、尚未保存的下载；已保存的下载不再重复报告。 */
  private downloads(tab: OwnedTab, known?: Set<string>) {
    return this.transfers.list(tab.view.webContents.id).filter(item => item.status !== 'saved' && !known?.has(item.downloadId));
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
      // 协议初始化失败后允许重试；监听只在成功后注册，不能随重试重复添加。
      value.on('will-download', (event, item, contents) => {
        const tab = [...this.tabs.values()].find(tab => tab.view.webContents === contents);
        if (contents && this.transfers.receive(contents, item, tab?.page.automated ? { retain: true, signal: tab.lease?.controller.signal } : undefined)) this.changed(tab?.actorId ?? actorId);
        else if (tab?.page.automated) event.preventDefault();
      });
      return value;
    })().catch(error => { this.sessions.delete(profile.id); throw error; }));
    return { session: await this.sessions.get(profile.id)!, profileId: profile.id };
  }
  private async create(actorId: string, profileId?: string, foreground = false, signal?: AbortSignal): Promise<OwnedTab> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error('浏览器正在关闭。');
    const selected = await this.browserSession(actorId, profileId);
    signal?.throwIfAborted();
    if (this.closing) throw new Error('浏览器正在关闭。');
    const parent = this.getWindow();
    const view = new WebContentsView({ webPreferences: { session: selected.session, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
      // 离屏宿主中的子页面也使用离屏合成，不依赖屏幕上存在原生显示表面。
      offscreen: parent?.webContents.isOffscreen() === true } });
    const tab = this.registerTab(actorId, selected.profileId, view);
    const id = tab.id, wc = view.webContents;
    tab.queue = wc.loadURL('about:blank').then(() => {
      if (this.closing || !this.tabs.has(id)) throw new Error('网页标签已关闭。');
      return tab.page.connect();
    });
    const abort = () => { if (this.tabs.has(id) && !tab.blockedRuns.size) this.closeTab(tab); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted(); await tab.queue; signal?.throwIfAborted();
      if (this.closing || !this.tabs.has(id)) throw new Error('网页标签已关闭。');
    } catch (error) {
      // 初始化失败的临时标签需要释放，但不能关闭已经被人工接管的页面。
      if (this.tabs.has(id) && !tab.blockedRuns.size) this.closeTab(tab);
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
    if (foreground || !this.active.has(actorId)) this.active.set(actorId, id);
    this.changed(actorId); if (foreground) this.show(tab);
    // 创建时关闭节流只为初始化不被拖慢；此后由显示、租约和截图状态决定。
    this.throttle(tab);
    return tab;
  }
  private registerTab(actorId: string, profileId: string, view: WebContentsView): OwnedTab {
    const id = randomUUID();
    const tab: OwnedTab = { id, actorId, profileId, view, page: new BrowserPage(view.webContents, () => this.changed(actorId)), loading: false,
      blockedRuns: new Set(), queue: Promise.resolve(), modelInput: false, throttled: false, capturing: 0, readers: new Map() };
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
    wc.once('destroyed', () => { if (this.tabs.has(id)) this.closeTab(tab); });
    wc.on('will-frame-navigate', event => {
      const inlineFrame = !event.isMainFrame && (event.url === 'about:srcdoc' || event.url.startsWith('data:'));
      if (!inlineFrame && !this.allowed(event.url, tab.profileId)) event.preventDefault();
    });
    wc.on('will-redirect', (event, url) => { if (!this.allowed(url, tab.profileId)) event.preventDefault(); });
    wc.setWindowOpenHandler(details => {
      const { url } = details;
      if (!this.allowed(url, tab.profileId) || tab.page.automated && (!tab.lease || tab.actionPopups?.signal.aborted)) return { action: 'deny' };
      // 接管 Chromium 创建的实际子页面，保留 opener、POST 正文及窗口名称。
      return { action: 'allow', createWindow: options => this.popup(tab, url, options, details.disposition === 'background-tab').view.webContents };
    });
    // before-input-event only emits keyboard input; showing/focusing a tab is not a takeover.
    wc.on('before-input-event', () => {
      if ((tab.page.automated || tab.readers.size > 0) && !tab.modelInput) this.takeover(tab);
    });
    wc.on('before-mouse-event', (_event, mouse) => {
      if ((tab.page.automated || tab.readers.size > 0) && !tab.modelInput && isActiveMouseInput(mouse)) this.takeover(tab);
    });
    return tab;
  }
  private popup(source: OwnedTab, requestedUrl: string, options: BrowserWindowConstructorOptions, background: boolean): OwnedTab {
    const tracking = source.actionPopups;
    tracking?.signal.throwIfAborted();
    const view = new WebContentsView({ ...options, webPreferences: { ...options.webPreferences, session: source.view.webContents.session,
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: source.view.webContents.isOffscreen() } });
    const tab = this.registerTab(source.actorId, source.profileId, view);
    tab.page.automated = source.page.automated;
    if (source.lease) tab.lease = { runId: source.lease.runId, conversationId: source.lease.conversationId, controller: new AbortController() };
    const result: PopupResult = { requestedUrl, status: 'opening', tab };
    tracking?.entries.push(result);
    const signal = tab.lease ? AbortSignal.any([tab.lease.controller.signal, source.lease!.controller.signal, ...(tracking ? [tracking.signal] : [])]) : undefined;
    // 已提供 WebContents 时沿用 Chromium 的原导航；后台链接延迟创建页面，需要启动首次导航。
    const deferred = background && !(options as { webContents?: unknown }).webContents;
    tab.queue = this.documentLoaded(tab, signal, deferred ? () => view.webContents.loadURL(requestedUrl) : undefined).then(() => tab.page.connect()).then(() => { result.status = 'opened'; })
      .catch(error => {
        result.status = 'failed'; result.error = error instanceof Error ? error.message : String(error); tab.page.log('error', result.error);
        if (signal?.aborted && !tab.blockedRuns.size && this.tabs.has(tab.id)) this.closeTab(tab);
      });
    tracking?.pending.push(tab.queue as Promise<void>);
    if (!tab.page.automated) this.show(tab);
    this.throttle(tab); this.changed(tab.actorId);
    return tab;
  }
  private documentLoaded(tab: OwnedTab, signal?: AbortSignal, start?: () => Promise<void>): Promise<void> {
    const wc = tab.view.webContents;
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        wc.off('dom-ready', ready); wc.off('did-fail-load', failed); wc.off('destroyed', closed);
        error ? reject(error) : resolve();
      };
      const ready = () => done();
      const closed = () => done(new Error('网页标签已关闭。'));
      const failed = (_event: unknown, code: number, message: string, _url: string, main: boolean) => { if (main && code !== -3) done(new Error(message)); };
      const abort = () => { if (!wc.isDestroyed()) wc.stop(); done(signal?.reason ?? new Error('导航已取消。')); };
      const timer = setTimeout(() => done(Object.assign(new Error('导航等待超时，标签已保留，可继续读取当前页面。'), { code: 'BROWSER_NAVIGATION_TIMEOUT' })), 15000);
      wc.on('dom-ready', ready); wc.on('did-fail-load', failed); wc.on('destroyed', closed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (start) void start().then(ready, error => { if (error?.code !== 'ERR_ABORTED') done(error); });
    });
  }
  private describePopups(tracking: ActionPopups): Record<string, unknown>[] {
    return tracking.entries.map(result => {
      const alive = result.tab && this.tabs.has(result.tab.id) && !result.tab.view.webContents.isDestroyed();
      return { requestedUrl: result.requestedUrl, ...(alive ? this.modelTab(result.tab!, result.tab!.lease?.runId) : result.tab ? { id: result.tab.id } : {}),
        status: result.tab && !alive ? 'closed' : result.status, ...(result.error ? { error: result.error } : {}) };
    });
  }
  private async settlePopups(tracking: ActionPopups): Promise<void> {
    if (!tracking.pending.length || tracking.signal.aborted) return;
    // 仅等已观察到的新页，慢站点不能无限拖住原动作；未完成项明确保留 opening 状态。
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([Promise.all(tracking.pending), new Promise<void>(resolve => {
        abort = resolve; tracking.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(resolve, 1000);
        if (tracking.signal.aborted) resolve();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) tracking.signal.removeEventListener('abort', abort);
    }
  }
  private async navigate(tab: OwnedTab, url: unknown, signal?: AbortSignal): Promise<void> {
    if (typeof url !== 'string' || !this.allowed(url, tab.profileId)) throw new Error('浏览器只接受 HTTP(S) 地址或当前登录配置的工作区预览。');
    signal?.throwIfAborted(); tab.error = undefined; tab.page.invalidate();
    await this.documentLoaded(tab, signal, () => tab.view.webContents.loadURL(url));
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
    if (tab.lease) tab.blockedRuns.add(tab.lease.runId);
    for (const [reader, runId] of tab.readers) { tab.blockedRuns.add(runId); reader.abort(new Error('用户已接管此网页标签。')); }
    tab.lease?.controller.abort(new Error('用户已接管此网页标签。')); tab.lease = undefined;
    tab.page.invalidate(); tab.page.allowManualInput(); this.changed(tab.actorId);
    this.throttle(tab); this.pauseIdleCapture();
  }
  layout(input: BrowserLayout): void {
    if (this.closing) return;
    this.lastLayout = input;
    const parent = this.getWindow(); if (!parent || parent.isDestroyed()) return;
    if (parent !== this.displayWindow) {
      this.unbindDisplayWindow();
      this.displayWindow = parent; parent.on('show', this.restoreLayout); parent.on('restore', this.restoreLayout);
      parent.on('hide', this.windowHidden); parent.on('minimize', this.windowHidden);
    }
    const visible = input.visible && [input.x, input.y, input.width, input.height].every(Number.isFinite) && input.width > 0 && input.height > 0;
    const zoom = parent.webContents.getZoomFactor(); const [width, height] = parent.getContentSize();
    for (const tab of this.tabs.values()) {
      const active = tab.actorId === 'owner' && this.active.get('owner') === tab.id;
      if (active && visible && parent.isVisible() && !parent.isMinimized()) {
        if (!parent.contentView.children.includes(tab.view)) parent.contentView.addChildView(tab.view);
        const x = Math.max(0, Math.min(width - 1, Math.round(input.x * zoom))); const y = Math.max(0, Math.min(height - 1, Math.round(input.y * zoom)));
        const bounds = { x, y, width: Math.max(1, Math.min(width - x, Math.round(input.width * zoom))), height: Math.max(1, Math.min(height - y, Math.round(input.height * zoom))) };
        tab.view.setBounds(bounds);
        tab.view.setVisible(true);
        this.throttle(tab, true);
      } else if (tab.lease || tab.capturing > 0) {
        this.attach(tab); this.throttle(tab, false);
      } else {
        tab.view.setVisible(false); this.throttle(tab, false);
      }
    }
    this.pauseIdleCapture();
  }
  private unbindDisplayWindow(): void {
    this.displayWindow?.off('show', this.restoreLayout); this.displayWindow?.off('restore', this.restoreLayout);
    this.displayWindow?.off('hide', this.windowHidden); this.displayWindow?.off('minimize', this.windowHidden);
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
    if (method === 'browser.allowAutomation') { tab.blockedRuns.clear(); this.changed(actorId); return this.describe(tab); }
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
    context.signal.throwIfAborted();
    if (tab.blockedRuns.has(context.runId)) throw new Error('用户在本次任务中接管了此标签，请改用其他标签；下一轮任务可以重新使用它。');
    if (tab.lease && tab.lease.runId !== context.runId) throw new Error('此标签正在由另一个任务操作，请使用其他标签。');
    if (!tab.lease) {
      tab.lease = { runId: context.runId, conversationId: context.conversationId, controller: new AbortController() };
      tab.page.automated = true;
      this.changed(context.actorId); this.throttle(tab);
    }
    return AbortSignal.any([context.signal, tab.lease.controller.signal]);
  }
  /** 用户在工作台上能看到的标签；与 layout 显示子视图的条件一致。 */
  private foreground(tab: OwnedTab): boolean {
    const parent = this.getWindow();
    return !!parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
      && !!this.lastLayout?.visible && tab.actorId === 'owner' && this.active.get('owner') === tab.id;
  }
  /**
   * 只有可见、正在被任务操作或正在截图的标签关闭后台节流。空闲的隐藏标签恢复节流后，
   * 动画、rAF 与定时器按 Chromium 后台规则降频，document.visibilityState 也会变为 hidden。
   * 截图等待的 rAF 在节流的隐藏页上不会触发，所以截图期间必须保持关闭，见 capture。
   */
  private throttle(tab: OwnedTab, foreground = this.foreground(tab)): void {
    const wc = tab.view.webContents;
    const allowed = !foreground && !tab.lease && tab.readers.size === 0 && tab.capturing === 0;
    if (allowed === tab.throttled || wc.isDestroyed()) return;
    wc.setBackgroundThrottling(allowed); tab.throttled = allowed;
  }
  /** 释放后的后台标签要真正隐藏：透明宿主可能因其他任务的标签继续显示，页面进入 hidden 才会实际节流。 */
  private settle(tab: OwnedTab): void {
    const foreground = this.foreground(tab);
    if (!foreground && !tab.lease && tab.capturing === 0 && !tab.view.webContents.isDestroyed()) tab.view.setVisible(false);
    this.throttle(tab, foreground);
  }
  private attach(tab: OwnedTab): void {
    let parent: BaseWindow | undefined = this.getWindow();
    const foreground = this.foreground(tab);
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
    if (host && !host.isDestroyed() && ![...this.tabs.values()].some(tab => (tab.lease || tab.capturing > 0 || tab.readers.size > 0) && host.contentView.children.includes(tab.view))) host.hide();
  }
  private async capture(tab: OwnedTab, signal: AbortSignal, dimension = 1280): Promise<{ screenshot: BrowserScreenshot; url: string; attachment: NonNullable<ToolOutcome['attachments']>[number] }> {
    // 截图通常已持有租约；单独计数是为了租约在截图中途被接管或结束时，仍在等帧和采集完成后才恢复节流。
    tab.capturing++; this.throttle(tab);
    try {
      this.attach(tab);
      return await tab.page.screenshot(signal, tab.view.getBounds(), dimension);
    } finally { tab.capturing--; this.settle(tab); this.pauseIdleCapture(); }
  }
  /** 动作或新页面之后的观察：页面状态在前，随后是按 after 读取的快照或截图；观察失败不改变动作结果。 */
  private async actionResult(tab: OwnedTab, outcome: ToolOutcome, signal: AbortSignal, options: ActionObservationOptions, context: ToolContext, known?: Set<string>): Promise<ToolOutcome> {
    const observed: Record<string, unknown> = {};
    let captured: Awaited<ReturnType<DesktopBrowser['capture']>> | undefined, captureRevision: number | undefined;
    const failure = (error: unknown, kind: 'CAPTURE' | 'SNAPSHOT') => ({
      code: (error as { code?: string })?.code ?? `BROWSER_${kind}_FAILED`,
      message: `${error instanceof Error ? error.message : String(error)} 观察失败不代表动作失败；请用 browser_read 重新观察，不要重复刚才的动作。`,
    });
    // 弹窗挡住页面脚本，此时观察只会超时；模型先处理 dialog。
    if (options.after !== 'none' && !tab.page.interactionState().dialog) {
      if (options.after === 'screenshot' || options.after === 'both') {
        try { captured = await this.capture(tab, signal, options.maxImageDimension); captureRevision = tab.page.revision; }
        catch (error) { observed.observationError = failure(error, 'CAPTURE'); }
      }
      if (options.after === 'snapshot' || options.after === 'both') {
        try { observed.snapshot = await tab.page.snapshotAfterAction(signal, options.snapshotOptions); }
        catch (error) { observed.snapshotError = failure(error, 'SNAPSHOT'); }
      }
    }
    // 页面状态在补读结束后描述，不能返回派发时的旧 url/title。
    const page = this.modelTab(tab, context.runId);
    // 两次观察之间即使同址重载也可能使旧坐标失效，只保留仍属于当前文档的图像。
    if (captured && (captureRevision !== tab.page.revision || captured.url !== page.url)) {
      captured = undefined;
      observed.observationError = failure(Object.assign(new Error('页面在后续观察期间发生变化，旧截图已省略。'), { code: 'BROWSER_PAGE_CHANGED' }), 'CAPTURE');
    }
    const downloads = tab.view.webContents.isDestroyed() ? [] : this.downloads(tab, known);
    return { ...outcome, data: { ...page, ...outcome.data as Record<string, unknown>, ...tab.page.interactionState(),
      ...(downloads.length ? { downloads } : {}), ...(captured ? { screenshot: captured.screenshot } : {}), ...observed },
    ...(captured ? { attachments: [captured.attachment] } : {}) };
  }
  private async performAction(tab: OwnedTab, args: Record<string, unknown>, context: ToolContext, signal: AbortSignal): Promise<ToolOutcome> {
    const options = actionObservationOptions(args);
    validateActionArguments(args);
    if (args.action === 'navigate' && !this.allowed(String(args.url), tab.profileId))
      return { success: false, code: 'INVALID_ARGUMENTS', error: 'navigate 需要有效的 HTTP(S) 地址或工作区预览地址。', data: { status: 'failed' } };
    this.attach(tab);
    const wc = tab.view.webContents;
    const known = new Set(this.transfers.list(wc.id).map(item => item.downloadId));
    const tracking: ActionPopups = { signal, entries: [], pending: [] };
    tab.actionPopups = tracking;
    try {
      let outcome: ToolOutcome;
      try {
        signal.throwIfAborted();
        let feedback: Record<string, unknown> | undefined;
        if (args.action === 'navigate') { tab.source = undefined; await this.navigate(tab, args.url, signal); }
        else if (args.action === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
        else if (args.action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
        else if (args.action === 'reload') wc.reload();
        else {
          tab.modelInput = true;
          try { feedback = { ...await tab.page.action(args, signal) }; } finally { tab.modelInput = false; }
        }
        signal.throwIfAborted();
        outcome = { success: true, data: feedback ?? {} };
      } catch (error) {
        const code = (error as { code?: string }).code;
        outcome = { success: false, code: code ?? 'BROWSER_ACTION_UNKNOWN', error: (error as Error).message,
          data: { status: code && notDispatched.has(code) ? 'failed' : 'unknown' } };
      }
      await this.settlePopups(tracking);
      const observed = await this.actionResult(tab, outcome, signal, options, context, known);
      return tracking.entries.length ? { ...observed, data: { ...observed.data as Record<string, unknown>, openedTabs: this.describePopups(tracking) } } : observed;
    } finally { tab.actionPopups = undefined; }
  }
  private async createForTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    if (args.url && args.path) throw Object.assign(new Error('url 和 path 只能提供一个。'), { code: 'INVALID_ARGUMENTS' });
    if (args.path && !context.workspace) throw new Error('预览本地文件需要任务绑定工作区。');
    const options = actionObservationOptions(args, args.url || args.path ? 'snapshot' : 'none');
    const tab = await this.create(context.actorId, args.profileId as string | undefined, false, context.signal);
    const signal = this.claim(tab, context);
    try {
      if (args.url) await this.navigate(tab, args.url, signal);
      if (args.path) await this.preview(tab, context.workspace!.id, String(args.path), signal);
    } catch (error) {
      return { success: false, code: (error as { code?: string }).code ?? 'BROWSER_NAVIGATION_FAILED',
        error: error instanceof Error ? error.message : String(error), data: this.modelTab(tab, context.runId) };
    }
    return this.actionResult(tab, { success: true }, signal, options, context);
  }
  async tool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    // 运行器已在执行前授权；这里只确认账号仍然存在，避免排队期间被删除的账号继续访问私人页面。
    this.actor(context.actorId); context.signal.throwIfAborted();
    try {
      if (name === 'browser_tabs' && args.action === 'list') return { success: true, data: await this.modelState(context) };
      if (name === 'browser_tabs' && args.action === 'create') return await this.createForTool(args, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'INVALID_ARGUMENTS') return { success: false, code: 'INVALID_ARGUMENTS', error: (error as Error).message };
      throw error;
    }
    const tab = this.tab(context.actorId, args.tabId);
    const operation = tab.queue.catch(() => {}).then(async (): Promise<ToolOutcome> => {
      this.tab(context.actorId, tab.id); context.signal.throwIfAborted();
      const reader = name === 'browser_read' ? new AbortController() : undefined;
      if (reader) { tab.readers.set(reader, context.runId); this.throttle(tab); }
      const signal = reader ? AbortSignal.any([context.signal, reader.signal]) : this.claim(tab, context);
      try {
        if (name === 'browser_tabs' && args.action === 'close') { this.closeTab(tab); return { success: true }; }
        if (name === 'browser_tabs' && args.action === 'show') {
          if (context.actorId !== 'owner') throw new Error('只有本机主人可以把自己的网页显示在桌面工作台。');
          this.show(tab); return { success: true, data: { ...this.modelTab(tab, context.runId), windowVisible: this.getWindow()?.isVisible() === true } };
        }
        if (name === 'browser_read') {
          if (args.action === 'state') return { success: true, data: { ...this.modelTab(tab, context.runId), ...tab.page.interactionState(), downloads: this.downloads(tab) } };
          if (args.action === 'text') return { success: true, data: await tab.page.readText(signal, args as { ref?: string; startChar?: number; maxChars?: number }) };
          if (args.action === 'snapshot') return { success: true, data: await tab.page.snapshot(signal, args) };
          if (args.action === 'wait') {
            const data = await tab.page.waitForSnapshot(signal, args);
            return data.conditionMet ? { success: true, data }
              : { success: false, code: 'BROWSER_WAIT_TIMEOUT', error: '等待结束，页面尚未满足指定条件；请检查当前页面，不要重复提交之前的动作。', data };
          }
          if (args.action === 'screenshot') {
            const frame = await this.capture(tab, signal, args.maxImageDimension as number | undefined);
            return { success: true, data: { ...this.modelTab(tab, context.runId), screenshot: frame.screenshot }, attachments: [frame.attachment] };
          }
          if (args.action === 'logs') return { success: true, data: tab.page.logs(args as { since?: number; maxEntries?: number; kind?: 'console' | 'network' | 'error' }) };
        }
        if (name === 'browser_action') return await this.performAction(tab, args, context, signal);
        if (name === 'browser_files') {
          const currentContext = { ...context, signal };
          if (args.action === 'upload') return { success: true, data: await this.transfers.upload(tab.page, args, currentContext) };
          if (args.action === 'download') return { success: true, data: await this.transfers.download(tab.page, args, currentContext, async () => {
            tab.modelInput = true;
            try { return await tab.page.action({ action: 'click', ref: args.ref }, signal); }
            finally { tab.modelInput = false; }
          }) };
        }
        throw new Error('不支持的浏览器工具操作。');
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'INVALID_ARGUMENTS') return { success: false, code, error: (error as Error).message, data: { status: 'failed' } };
        // 纯观察的暂时超时可以安全重读；不要把这个标记加到 browser_action 上，动作可能已经完成。
        if (code === 'BROWSER_VIEW_REQUIRED' || code === 'BROWSER_CAPTURE_TIMEOUT') return { success: false, code, error: String((error as Error).message), retryable: code === 'BROWSER_CAPTURE_TIMEOUT', data: this.modelTab(tab, context.runId) };
        throw error;
      } finally {
        tab.modelInput = false;
        if (reader) { tab.readers.delete(reader); this.settle(tab); this.pauseIdleCapture(); }
      }
    });
    tab.queue = operation; return operation;
  }
  /** 运行结束交还标签：释放租约并恢复人工模式，用户之后的点击不再算作接管，下一轮任务可以直接使用。 */
  finishRun(runId: string): void {
    for (const tab of this.tabs.values()) {
      const unblocked = tab.blockedRuns.delete(runId);
      if (tab.lease?.runId === runId) {
        tab.lease.controller.abort(new Error('任务已结束。')); tab.lease = undefined;
        tab.page.allowManualInput(); this.settle(tab); this.changed(tab.actorId);
      } else if (unblocked) this.changed(tab.actorId);
    }
    this.pauseIdleCapture();
  }
  private closeTab(tab: OwnedTab): void {
    void this.transfers.cancel(tab.view.webContents.id).catch(error => tab.page.log('error', error));
    for (const reader of tab.readers.keys()) reader.abort(new Error('网页标签已关闭。'));
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
    this.closing = true; this.unsubscribe(); for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    void this.transfers.dispose().catch(error => console.error('浏览器临时下载清理失败', error));
    this.unbindDisplayWindow();
    if (this.captureWindow && !this.captureWindow.isDestroyed()) this.captureWindow.close();
  }
}
