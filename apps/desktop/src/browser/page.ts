import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserObservation, BrowserActionFeedback, BrowserHitTarget } from '@graycode/contracts';
import { compactSnapshot, snapshotClickables, snapshotRows, snapshotUrl, type AxNode, type SnapshotNode, type SnapshotOptions } from './snapshot';
import { browserKey } from './keys';
import { checkedState, pointInElement, prepareTextInput, selectElement } from './elements';
import { validateActionArguments, readElementText, readElementState, type BrowserDialog, type BrowserFileChooser, type BrowserInteractionState } from './pageActions';
import { nativePromptScripts } from './pageDialogs';
export { validateActionArguments } from './pageActions';

interface ElementReference { backendNodeId: number; sessionId?: string; frameId?: string }
const referenceKey = (reference: Pick<ElementReference, 'backendNodeId' | 'sessionId' | 'frameId'>) => JSON.stringify([reference.sessionId, reference.frameId, reference.backendNodeId]);
interface PageLog { cursor: number; time: number; kind: 'console' | 'network' | 'error'; text: string }
/** 一次完整读取的原始 AX 节点；marker 是读树前在该框架隔离世界里布置的变更标记。 */
interface FrameRead { frameId?: string; identity?: string; sessionId?: string; nodes: AxNode[]; wholeDocument?: boolean; marker?: { contextId: number; id: number } }
interface PageRead { epoch: number; topology: number; frames: Array<Record<string, unknown>>; reads: FrameRead[] }

// 在隔离世界按文档复用观察器；读取时只取版本，避免每次重新遍历整个文档和 Shadow DOM。
// 覆盖 DOM 增删、属性与文字变化、输入和焦点事件，以及已有和新增子树中的开放 shadow root；
// 脚本直接赋值 value、封闭 shadow root 和纯 CSS 状态变化不在范围内，所以标记只用于续页复用和等待间隔，不替代重读。
const watchExpression = `(() => {
  let state = globalThis.__graycodeSnapshotWatch;
  if (state?.document === document) return state.id;
  state?.observer.disconnect();
  state = globalThis.__graycodeSnapshotWatch = { id: 1, document, roots: new WeakSet() };
  const visit = root => {
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if ((root.nodeType === 9 || root.nodeType === 11) && !state.roots.has(root)) {
      state.roots.add(root); state.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    if (root.shadowRoot) visit(root.shadowRoot);
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
  };
  const mark = records => {
    state.id++;
    if (Array.isArray(records)) for (const record of records) for (const node of record.addedNodes) visit(node);
  };
  state.observer = new MutationObserver(mark);
  for (const type of ['input', 'change', 'focusin', 'focusout']) document.addEventListener(type, mark, true);
  visit(document); return state.id;
})()`;
const unchangedExpression = '(() => { const state = globalThis.__graycodeSnapshotWatch; return state?.document === document ? state.id : 0; })()';
/** 续页复用上限；标记覆盖不到的变化最多延迟这么久，也限制大页面原始树在内存中的停留时间。 */
const continuationLifetime = 30_000;

/** 只提供固定的页面操作。模型参数不能成为脚本、CDP 方法名或宿主接口。 */
export class BrowserPage {
  automated = false;
  private ready?: Promise<void>;
  private readonly references = new Map<string, ElementReference>();
  private readonly referenceIds = new Map<string, string>();
  private readonly sessions = new Map<string, { targetId: string; url: string }>();
  private readonly records: PageLog[] = [];
  private logCursor = 0;
  private epoch = 0;
  private debuggerOwned = false;
  private dialog?: BrowserDialog & { sessionId?: string };
  private fileChooser?: BrowserFileChooser;
  private readonly dialogWaiters = new Set<() => void>();
  private readonly promptScripts = nativePromptScripts(`graycode-prompt-${randomUUID()}`);
  private observation?: Omit<BrowserObservation, 'tabId'>;
  private mainDocumentPending = false;
  /** 框架或 OOPIF 会话增减时递增；只用于判断缓存的读取是否还覆盖全部框架，不影响引用或截图。 */
  private topology = 0;
  private continuation?: { key: string; offset: number; read: PageRead; timer: ReturnType<typeof setTimeout> };
  constructor(readonly contents: WebContents, private readonly changed: () => void) {
    contents.on('did-start-navigation', details => {
      if (details?.isMainFrame && !details.isSameDocument) { this.invalidate(); this.mainDocumentPending = true; }
      else this.forget();
    });
    const ready = () => { this.mainDocumentPending = false; };
    contents.on('dom-ready', ready); contents.on('did-stop-loading', ready);
    contents.debugger.on('detach', (_event, reason) => {
      this.ready = undefined; this.debuggerOwned = false; this.sessions.clear(); this.invalidate();
      this.log('error', `页面调试连接已断开：${reason}`); changed();
    });
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
        this.sessions.set(params.sessionId, params.targetInfo); this.topology++;
        void this.enable(params.sessionId).catch(error => this.log('error', String(error)));
      }
      if (method === 'Target.detachedFromTarget' && this.sessions.delete(params.sessionId)) { this.topology++; this.forget(); }
      if (method === 'Page.frameAttached' || method === 'Page.frameDetached') this.topology++;
      if (method === 'Runtime.consoleAPICalled') this.log('console', `${params.type}: ${(params.args ?? []).map((value: { value?: unknown; description?: string }) => value.value ?? value.description ?? '').join(' ')}`);
      if (method === 'Runtime.exceptionThrown') this.log('error', params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '页面脚本异常');
      if (method === 'Network.responseReceived') this.log('network', `${params.response.status} ${params.type} ${params.response.url}`);
      if (method === 'Network.loadingFailed') this.log('network', `${params.type} ${params.errorText}`);
      if (method === 'Page.frameNavigated') {
        if (!sessionId && !params.frame?.parentId) this.invalidate();
        else { this.topology++; this.forget(); }
      }
      if (method === 'DOM.documentUpdated') this.forget();
      // 对话框是模型可以处理的页面状态；唤醒在途命令，让动作先返回提示而不是等待页面脚本恢复。
      if (method === 'Page.javascriptDialogOpening') {
        this.log('console', `${params.type}: ${params.message}`);
        this.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url, sessionId: sessionId || undefined };
        for (const notify of this.dialogWaiters) notify();
        changed();
      }
      if (method === 'Page.javascriptDialogClosed') { this.dialog = undefined; changed(); }
      if (method === 'Page.fileChooserOpened') {
        let ref: string | undefined;
        if (typeof params.backendNodeId === 'number') ref = this.registerReference({ backendNodeId: params.backendNodeId, frameId: params.frameId, sessionId: sessionId || undefined });
        this.fileChooser = { ref, multiple: params.mode === 'selectMultiple', frameId: params.frameId };
        changed();
      }
    });
  }
  get revision(): number { return this.epoch; }
  invalidate(): void { this.references.clear(); this.referenceIds.clear(); this.dialog = undefined; this.fileChooser = undefined; this.invalidateVisual(); }
  interactionState(): BrowserInteractionState {
    const { sessionId: _session, ...dialog } = this.dialog ?? {};
    return { ...(this.dialog ? { dialog: dialog as BrowserDialog } : {}), ...(this.fileChooser ? { fileChooser: { ...this.fileChooser } } : {}) };
  }
  private registerReference(reference: ElementReference): string {
    const key = referenceKey(reference), id = this.referenceIds.get(key) ?? randomUUID().slice(0, 8);
    this.references.set(id, reference); this.referenceIds.set(key, id); return id;
  }
  // 页面变化使在途快照重新读取，截图仍保留坐标映射，模型可以继续使用已知位置尝试操作。
  private invalidateVisual(): void { this.epoch++; this.forget(); }
  private forget(): void {
    if (this.continuation) clearTimeout(this.continuation.timer);
    this.continuation = undefined;
  }
  log(kind: PageLog['kind'], value: unknown): void {
    this.records.push({ cursor: ++this.logCursor, time: Date.now(), kind, text: String(value).slice(0, 3000) });
    if (this.records.length > 200) this.records.splice(0, this.records.length - 200);
  }
  logs(options: { since?: number; maxEntries?: number } = {}) {
    const entries = this.records.filter(record => options.since === undefined || record.cursor > options.since);
    const maximum = options.maxEntries ?? 50;
    const page = options.since === undefined ? entries.slice(-maximum) : entries.slice(0, maximum);
    const outputLost = options.since !== undefined && options.since < (this.records[0]?.cursor ?? 1) - 1;
    return { entries: page, nextCursor: page.at(-1)?.cursor ?? this.logCursor, capacity: 200,
      hasMore: options.since !== undefined && entries.length > maximum, outputLost,
      truncated: entries.length > maximum || outputLost };
  }
  private async enable(sessionId?: string): Promise<void> {
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Accessibility.enable']) await this.contents.debugger.sendCommand(method, {}, sessionId);
    // 先布置原生监听器，再恢复网页入口；runImmediately 同时覆盖已打开的页面与同进程框架。
    await this.contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: this.promptScripts.isolated, worldName: 'graycode-native-dialogs', runImmediately: true }, sessionId);
    await this.contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: this.promptScripts.main, runImmediately: true }, sessionId);
    await this.contents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    if (this.automated) await this.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
  }
  async connect(): Promise<void> {
    if (this.contents.isDestroyed()) throw new Error('网页标签已关闭。');
    if (this.contents.isDevToolsOpened()) throw new Error('开发者工具正在使用此标签，请先关闭开发者工具再继续模型操作。');
    if (!this.ready) {
      if (this.contents.debugger.isAttached() && !this.debuggerOwned) throw new Error('此标签的调试连接已被其他组件占用。');
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
      this.debuggerOwned = true;
      this.ready = this.enable().catch(error => { this.ready = undefined; throw error; });
    }
    await this.ready;
  }
  private async command(method: string, params: Record<string, unknown>, signal: AbortSignal, sessionId?: string): Promise<any> {
    signal.throwIfAborted();
    if (method === 'Page.handleJavaScriptDialog') return this.pending(this.contents.debugger.sendCommand(method, params, sessionId), signal);
    const blocked = () => Object.assign(new Error('页面正在等待处理原生对话框，请使用 dialog 接受或取消。'), { code: 'BROWSER_DIALOG_PENDING' });
    if (this.dialog) throw blocked();
    let notify!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => { notify = () => reject(blocked()); this.dialogWaiters.add(notify); });
    try { return await this.pending(Promise.race([this.contents.debugger.sendCommand(method, params, sessionId), interrupted]), signal); }
    finally { this.dialogWaiters.delete(notify); }
  }
  private async pending<T>(work: Promise<T>, signal: AbortSignal, timeout = 15000): Promise<T> {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason ?? new Error('操作已停止。'));
          signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(Object.assign(new Error('页面操作超时，请重新读取当前页面。'), { code: 'BROWSER_OPERATION_TIMEOUT' })), timeout);
        }),
      ]);
      signal.throwIfAborted(); return result;
    } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }
  async snapshot(signal: AbortSignal, options: SnapshotOptions = {}) {
    return (await this.observe(signal, options)).result;
  }
  async readText(signal: AbortSignal, options: { ref: string; startChar?: number; maxChars?: number }) {
    signal.throwIfAborted();
    const startChar = options.startChar ?? 0, maxChars = options.maxChars ?? 12000;
    if (!Number.isInteger(startChar) || startChar < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 60000)
      throw Object.assign(new Error('startChar 必须是非负整数，maxChars 必须介于 1 与 60000。'), { code: 'INVALID_ARGUMENTS' });
    await this.pending(this.connect(), signal);
    const reference = this.reference(options.ref);
    try {
      const objectId = await this.element(reference, signal);
      const result = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: readElementText,
        arguments: [{ value: startChar }, { value: maxChars }] }, signal, reference.sessionId);
      const value = result.result?.value as { text: string; total: number } | null;
      if (!value) throw Object.assign(new Error('页面元素已移除，请重新读取。'), { code: 'BROWSER_TARGET_MISSING' });
      const nextChar = startChar + value.text.length < value.total ? startChar + value.text.length : undefined;
      return { ref: options.ref, text: value.text, startChar, returned: value.text.length, total: value.total, nextChar, truncated: nextChar !== undefined };
    } finally {
      if (this.contents.debugger.isAttached()) void this.contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'graycode-browser' }, reference.sessionId).catch(() => {});
    }
  }
  private async observe(signal: AbortSignal, options: SnapshotOptions) {
    signal.throwIfAborted(); await this.pending(this.connect(), signal);
    const scope = options.ref ? this.reference(options.ref) : undefined;
    // 同一 DOM 节点继续使用原引用，名称和路由变化由新快照展示，不要求模型重新绑定。
    const epoch = this.epoch; const prefix = randomUUID().slice(0, 8);
    const references = new Map<string, ElementReference>();
    let scopeRef: string | undefined;
    const rows: SnapshotNode[] = [];
    const maximum = options.maxNodes ?? 250, offset = options.offset ?? 0;
    // 连续分页在文档未导航、标记未变时复用上一页的原始树：大页面一次完整读取可达数秒，
    // 而且同一棵树上的 offset 不会因两次读取之间的插入而错位。只接受严格的续页（同一筛选、offset 等于上次
    // nextOffset），其他读取始终重新获取当前页面。分页不会使前一页的有效引用失效。
    const key = JSON.stringify([scope?.backendNodeId, scope?.sessionId, scope?.frameId, options.frameId, options.query, options.role, options.interactiveOnly === true]);
    const previous = this.continuation; this.forget();
    const reused = previous && previous.key === key && previous.offset === offset && await this.unchanged(previous.read, signal) ? previous.read : undefined;
    const read = reused ?? await this.collect(signal, options, scope);
    if (scope) {
      const node = read.reads.find(frame => frame.sessionId === scope.sessionId && frame.frameId === scope.frameId)?.nodes.find(node => node.backendDOMNodeId === scope.backendNodeId);
      if (node) {
        scopeRef = String(options.ref);
        references.set(scopeRef, scope);
      }
    }
    let total = 0, characters = 0, budgetReached = false;
    for (const { frameId, identity, sessionId, nodes } of read.reads) {
      // 深层组件不截断树深度；输出预算在筛选之后应用，后面的正文和 iframe 仍可检索。
      for (const { node, row } of snapshotRows(nodes, options, scope?.backendNodeId)) {
        if (total++ < offset || rows.length >= maximum || budgetReached) continue;
        const size = JSON.stringify(row).length;
        if (characters + size > 60000 && rows.length) { budgetReached = true; continue; }
        characters += size;
        const reference = node.backendDOMNodeId ? { backendNodeId: node.backendDOMNodeId, sessionId, frameId } : undefined;
        const previousId = reference && (scopeRef && referenceKey(reference) === referenceKey(scope!) ? scopeRef : this.referenceIds.get(referenceKey(reference)));
        const id = reference ? previousId ?? `${prefix}-${rows.length + 1}` : undefined;
        if (id) references.set(id, reference!);
        rows.push({ ...(id ? { ref: id } : {}), frameId: identity, ...row });
      }
    }
    const frames: PageRead['frames'] = read.frames.map(frame => ({ ...frame, ...(typeof frame.url === 'string' ? { url: snapshotUrl(frame.url) } : {}) }));
    if (options.frameId && !frames.length) throw new Error('页面框架不存在或已经变化，请先读取整个页面确认 frameId。');
    if (epoch !== this.epoch || read.epoch !== epoch) throw Object.assign(new Error('页面在读取时发生导航，请重新读取。'), { code: 'BROWSER_PAGE_CHANGED' });
    // 原始树覆盖筛选外的节点；只移除已经离开文档的引用，属性变化继续复用节点身份。
    for (const frame of read.reads) if (frame.wholeDocument) {
      const nodeIds = new Set(frame.nodes.map(node => node.backendDOMNodeId));
      for (const [id, reference] of this.references) if (reference.sessionId === frame.sessionId && reference.frameId === frame.frameId && !nodeIds.has(reference.backendNodeId) && id !== this.fileChooser?.ref) {
        this.references.delete(id); this.referenceIds.delete(referenceKey(reference));
      }
    }
    for (const [id, reference] of references) { this.references.set(id, reference); this.referenceIds.set(referenceKey(reference), id); }
    const nextOffset = offset + rows.length < total ? offset + rows.length : undefined;
    const partial = frames.some(frame => frame.unavailable);
    // 不完整的读取不复用，续页时还能重试失败的框架；缺少标记的框架无法证明未变，也不保留。
    if (nextOffset !== undefined && !partial && read.reads.every(item => item.marker)) {
      const timer = setTimeout(() => { if (this.continuation?.timer === timer) this.continuation = undefined; }, continuationLifetime);
      timer.unref?.();
      this.continuation = { key, offset: nextOffset, read, timer };
    }
    return { read, result: { url: this.contents.getURL(), title: this.contents.getTitle(), frames,
      format: options.compact === false ? 'full' : 'compact', nodes: options.compact === false ? rows : compactSnapshot(rows),
      offset, returned: rows.length, total, nextOffset, truncated: nextOffset !== undefined,
      partial, ...(scopeRef ? { scopeRef } : {}), ...(budgetReached ? { characterLimit: 60000 } : {}) } };
  }
  /** 按框架顺序读取完整 AX 树；框架顺序和失败重试规则决定输出顺序。 */
  private async collect(signal: AbortSignal, options: SnapshotOptions, scope?: ElementReference): Promise<PageRead> {
    const read: PageRead = { epoch: this.epoch, topology: this.topology, frames: [], reads: [] };
    const frames = read.frames;
    const interactions = new Map<string | undefined, Promise<Map<string, Set<number>>>>();
    const load = async (frameId?: string, url?: string, sessionId?: string) => {
      const identity = frameId ?? this.sessions.get(sessionId!)?.targetId;
      if (options.frameId && options.frameId !== identity) return;
      // 标记先于读树布置，读取期间发生的变化也会让后续复用失效。
      const marker = await this.watch(identity, sessionId, signal);
      const { nodes } = await this.command(scope ? 'Accessibility.queryAXTree' : 'Accessibility.getFullAXTree',
        scope ? { backendNodeId: scope.backendNodeId } : frameId ? { frameId } : {}, signal, sessionId) as { nodes: AxNode[] };
      // 同一次观察中每个目标只取一次 DOM 线索，JS 路由节点不再依赖 ARIA 或 tabindex 才能被识别。
      // 明确查找语义角色时，AX 已完整提供候选；通用区域和交互筛选继续补充自定义 JS 控件线索。
      const needsInteractions = !options.role || ['generic', 'none', 'node'].includes(options.role.toLowerCase());
      if (needsInteractions && !interactions.has(sessionId)) interactions.set(sessionId,
        this.command('DOMSnapshot.captureSnapshot', { computedStyles: ['cursor'] }, signal, sessionId).then(snapshotClickables)
          .catch(() => { signal.throwIfAborted(); return new Map<string, Set<number>>(); }));
      const clickable = needsInteractions ? (await interactions.get(sessionId)!).get(identity!) : undefined;
      const observedNodes = clickable?.size ? nodes.map(node => clickable.has(node.backendDOMNodeId!) ? { ...node, clickable: true } : node) : nodes;
      const failed = frames.findIndex(frame => frame.frameId === identity && frame.unavailable);
      if (failed >= 0) frames.splice(failed, 1);
      frames.push({ frameId: identity, url });
      read.reads.push({ frameId, identity, sessionId, nodes: observedNodes, marker, wholeDocument: !scope });
    };
    const visit = async (node: { frame: { id: string; url: string }; childFrames?: any[] }) => {
      try { await load(node.frame.id, node.frame.url); }
      catch (error) { signal.throwIfAborted(); frames.push({ frameId: node.frame.id, url: node.frame.url, unavailable: String(error) }); }
      for (const child of node.childFrames ?? []) await visit(child);
    };
    if (scope) {
      await load(scope.frameId, scope.sessionId ? this.sessions.get(scope.sessionId)?.url : undefined, scope.sessionId);
    } else {
      const tree = await this.command('Page.getFrameTree', {}, signal);
      await visit(tree.frameTree);
      for (const [sessionId, target] of this.sessions) {
        if (frames.some(frame => frame.frameId === target.targetId && !frame.unavailable)) continue;
        try { await load(undefined, target.url, sessionId); }
        catch (error) { signal.throwIfAborted(); frames.push({ frameId: target.targetId, url: target.url, unavailable: String(error) }); }
      }
    }
    return read;
  }
  /** 布置变更标记；失败只表示这次读取不可复用，不影响快照本身。 */
  private async watch(frameId: string | undefined, sessionId: string | undefined, signal: AbortSignal): Promise<FrameRead['marker']> {
    if (!frameId) return undefined;
    try {
      const world = await this.pending(this.contents.debugger.sendCommand('Page.createIsolatedWorld', { frameId, worldName: 'graycode-snapshot' }, sessionId), signal, 1000);
      const contextId = world?.executionContextId;
      if (typeof contextId !== 'number') return undefined;
      const armed = await this.pending(this.contents.debugger.sendCommand('Runtime.evaluate', { expression: watchExpression, contextId, returnByValue: true }, sessionId), signal, 1000);
      const id = armed?.result?.value;
      return typeof id === 'number' && id > 0 ? { contextId, id } : undefined;
    } catch { signal.throwIfAborted(); return undefined; }
  }
  /** 只有文档未导航、框架未增减且每个框架的标记都未触发时才算未变化；任何读取失败都按已变化处理。 */
  private async unchanged(read: PageRead, signal: AbortSignal): Promise<boolean> {
    if (read.epoch !== this.epoch || read.topology !== this.topology || !read.reads.length || read.frames.some(frame => frame.unavailable)) return false;
    for (const { marker, sessionId } of read.reads) {
      if (!marker) return false;
      try {
        const checked = await this.pending(this.contents.debugger.sendCommand('Runtime.evaluate', { expression: unchangedExpression, contextId: marker.contextId, returnByValue: true }, sessionId), signal, 1000);
        if (checked?.result?.value !== marker.id) return false;
      } catch { signal.throwIfAborted(); return false; }
    }
    return read.epoch === this.epoch && read.topology === this.topology;
  }

  private async documentReady(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.mainDocumentPending) return;
    let ready!: () => void;
    const work = new Promise<void>(resolve => {
      ready = resolve;
      this.contents.on('dom-ready', ready); this.contents.on('did-stop-loading', ready);
      if (!this.mainDocumentPending) resolve();
    });
    try { await this.pending(work, signal); }
    finally { this.contents.off('dom-ready', ready); this.contents.off('did-stop-loading', ready); }
  }
  async snapshotAfterAction(signal: AbortSignal, options: SnapshotOptions = {}) {
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(5000), closed = new AbortController();
    const waiting = AbortSignal.any([signal, deadline, closed.signal]);
    const destroyed = () => closed.abort(new Error('网页标签已关闭。'));
    this.contents.once('destroyed', destroyed);
    try {
      if (this.contents.isDestroyed()) destroyed();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.pending(this.connect(), waiting);
          await this.documentReady(waiting);
          const epoch = this.epoch;
          // 后台隐藏页可能不派发绘制帧；AX 读取只需文档解析与同步布局，不能等 requestAnimationFrame。
          await this.command('Runtime.evaluate', {
            expression: 'new Promise(resolve => { const ready = () => { document.documentElement?.getBoundingClientRect(); resolve(null); }; if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true }); else ready(); })',
            awaitPromise: true, returnByValue: true,
          }, waiting);
          if (epoch !== this.epoch || this.mainDocumentPending) continue;
          return await this.snapshot(waiting, options);
        } catch (error) {
          waiting.throwIfAborted();
          const changed = (error as { code?: string }).code === 'BROWSER_PAGE_CHANGED'
            || /Execution context was destroyed|Cannot find context with specified id|Cannot find default execution context|Inspected target navigated or closed/i.test(String(error));
          if (!changed) throw error;
        }
      }
      throw Object.assign(new Error('页面持续发生导航，请用 browser_read 重新观察。'), { code: 'BROWSER_PAGE_CHANGED' });
    } catch (error) {
      signal.throwIfAborted(); closed.signal.throwIfAborted();
      if (deadline.aborted) throw Object.assign(new Error('动作后的页面观察等待超时，请用 browser_read 重新观察。'), { code: 'BROWSER_SNAPSHOT_TIMEOUT' });
      throw error;
    } finally { this.contents.off('destroyed', destroyed); }
  }

  async waitForSnapshot(signal: AbortSignal, options: SnapshotOptions & { timeoutMs?: number; state?: string; url?: string; urlChanged?: boolean }) {
    if (options.url !== undefined || options.urlChanged === true || options.ref) return this.waitForState(signal, options);
    if (!options.query?.trim()) throw Object.assign(new Error('wait 需要 query、ref、url 或 urlChanged 指定等待条件。'), { code: 'INVALID_ARGUMENTS' });
    if (options.offset) throw Object.assign(new Error('wait 不使用分页 offset。'), { code: 'INVALID_ARGUMENTS' });
    if (options.state !== undefined && !['present', 'absent'].includes(options.state)) throw Object.assign(new Error('文字等待的 state 只能是 present 或 absent。'), { code: 'INVALID_ARGUMENTS' });
    const timeoutMs = options.timeoutMs ?? 10000, started = Date.now();
    const deadline = AbortSignal.timeout(timeoutMs), waiting = AbortSignal.any([signal, deadline]);
    // 标记未触发时跳过完整重读，但至少每隔 refresh 重读一次：标记看不到脚本赋值、封闭 shadow root 与纯 CSS 变化，
    // 条件是否满足始终只由实际读取结果判断。短等待按比例缩短间隔，避免漏掉截止前的变化。
    const refresh = Math.min(1000, Math.max(200, timeoutMs / 4));
    let snapshot: Awaited<ReturnType<BrowserPage['snapshot']>> | undefined;
    let last: { read: PageRead; at: number } | undefined;
    try {
      while (true) {
        try {
          if (!last || Date.now() - last.at >= refresh || !await this.unchanged(last.read, waiting)) {
            const observed = await this.observe(waiting, options);
            snapshot = observed.result; last = { read: observed.read, at: Date.now() };
            const conditionMet = options.state === 'absent' ? snapshot.total === 0 && !snapshot.partial : snapshot.total > 0;
            if (conditionMet) return { ...snapshot, conditionMet: true, timedOut: false, waitedMs: Date.now() - started };
          }
        } catch (error) {
          waiting.throwIfAborted();
          if ((error as { code?: string }).code !== 'BROWSER_PAGE_CHANGED') throw error;
          snapshot = undefined; last = undefined;
        }
        await delay(200, undefined, { signal: waiting });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.aborted) throw error;
      return { ...snapshot, conditionMet: false, timedOut: true, waitedMs: Date.now() - started };
    }
  }
  /** URL 和控件状态只读取必要状态，避免每次轮询重新采集完整 AX 与 DOM 树。 */
  private async waitForState(signal: AbortSignal, options: SnapshotOptions & { timeoutMs?: number; state?: string; url?: string; urlChanged?: boolean }) {
    signal.throwIfAborted();
    const state = options.state ?? 'visible';
    if (options.ref && !['visible', 'hidden', 'present', 'absent', 'enabled', 'disabled', 'checked', 'unchecked'].includes(state))
      throw Object.assign(new Error('ref 等待支持 visible、hidden、enabled、disabled、checked 或 unchecked。'), { code: 'INVALID_ARGUMENTS' });
    if (options.offset || options.url !== undefined && options.urlChanged || options.ref && (options.url !== undefined || options.urlChanged))
      throw Object.assign(new Error('wait 每次只指定一种条件，不使用分页 offset。'), { code: 'INVALID_ARGUMENTS' });
    const timeoutMs = options.timeoutMs ?? 10000, started = Date.now(), initialUrl = this.contents.getURL();
    const deadline = AbortSignal.timeout(timeoutMs), waiting = AbortSignal.any([signal, deadline]);
    const reference = options.ref ? this.reference(options.ref) : undefined;
    let elementState: { visible?: boolean; missing?: boolean; enabled?: boolean; disabled?: boolean; checked?: boolean } | undefined;
    try {
      if (reference) await this.pending(this.connect(), waiting);
      while (true) {
        const url = this.contents.getURL();
        let conditionMet = options.urlChanged ? url !== initialUrl : options.url !== undefined ? url === options.url : false;
        if (reference) {
          try {
            const objectId = await this.element(reference, waiting);
            const read = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: readElementState }, waiting, reference.sessionId);
            elementState = read.result?.value;
          } catch (error) {
            waiting.throwIfAborted();
            if ((error as { code?: string }).code !== 'BROWSER_TARGET_MISSING') throw error;
            elementState = { visible: false, missing: true };
          }
          conditionMet = !!elementState && (state === 'hidden' ? !elementState.visible
            : state === 'absent' ? elementState.missing === true : state === 'present' ? !elementState.missing
              : state === 'unchecked' ? !elementState.missing && elementState.checked === false
                : state === 'checked' ? !elementState.missing && elementState.checked === true
                  : !elementState.missing && elementState[state as 'visible' | 'enabled' | 'disabled'] === true);
        }
        if (conditionMet) return { url, ref: options.ref, state, elementState, initialUrl: options.urlChanged ? initialUrl : undefined,
          conditionMet: true, timedOut: false, waitedMs: Date.now() - started };
        await delay(200, undefined, { signal: waiting });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.aborted) throw error;
      return { url: this.contents.getURL(), ref: options.ref, state, elementState, initialUrl: options.urlChanged ? initialUrl : undefined,
        conditionMet: false, timedOut: true, waitedMs: Date.now() - started };
    } finally {
      if (reference && this.contents.debugger.isAttached()) void this.contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'graycode-browser' }, reference.sessionId).catch(() => {});
    }
  }
  async screenshot(signal: AbortSignal, bounds: { width: number; height: number }, maxImageDimension = 1280) {
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(15000), closed = new AbortController();
    const waiting = AbortSignal.any([signal, deadline, closed.signal]);
    const destroyed = () => closed.abort(new Error('网页标签已关闭。'));
    this.contents.once('destroyed', destroyed);
    // 区分等待绘制帧与采集超时，便于定位后台渲染条件；失败仍只重试观察，不能据此重做页面动作。
    let stage = '等待页面文档';
    try {
      if (this.contents.isDestroyed()) destroyed();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.pending(this.connect(), waiting);
          stage = '等待页面文档';
          await this.documentReady(waiting);
          const epoch = this.epoch;
          stage = '等待页面绘制帧';
          // 输入派发完成时合成线程可能尚未提交滚动；等新帧后再采集，避免返回操作前的画面。
          await this.command('Runtime.evaluate', {
            expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))',
            awaitPromise: true, returnByValue: true,
          }, waiting);
          stage = '读取截图前布局';
          await this.command('Page.getLayoutMetrics', {}, waiting);
          const zoomFactor = this.contents.getZoomFactor();
          stage = '采集页面图像';
          const picture = await this.pending(this.contents.capturePage(undefined, { stayHidden: false, stayAwake: false }), waiting, 5000);
          stage = '读取截图后布局';
          const metrics = await this.command('Page.getLayoutMetrics', {}, waiting);
          waiting.throwIfAborted();
          if (epoch !== this.epoch || this.mainDocumentPending) throw Object.assign(new Error('页面在截图时发生导航，请重新截图。'), { code: 'BROWSER_PAGE_CHANGED' });
          if (picture.isEmpty()) throw new Error('Current display surface not available for capture');
          const original = picture.getSize();
          const ratio = Math.min(1, maxImageDimension / Math.max(original.width, original.height));
          const image = ratio < 1 ? picture.resize({ width: Math.max(1, Math.round(original.width * ratio)), height: Math.max(1, Math.round(original.height * ratio)), quality: 'best' }) : picture;
          const observation: Omit<BrowserObservation, 'tabId'> = {
            id: randomUUID(), capturedAt: Date.now(), url: this.contents.getURL(), coordinateSpace: 'image',
            screenshot: { mimeType: 'image/png', ...image.getSize() },
            imageToViewportScale: { x: bounds.width / zoomFactor / image.getSize().width, y: bounds.height / zoomFactor / image.getSize().height },
            // 视图 DIP 尺寸包括滚动条，除以页面缩放后与整张截图一一对应。
            viewport: { width: bounds.width / zoomFactor, height: bounds.height / zoomFactor,
              scrollX: metrics.cssVisualViewport.pageX, scrollY: metrics.cssVisualViewport.pageY, zoomFactor },
          };
          this.observation = observation;
          return { observation, attachment: { mimeType: 'image/png', data: image.toPNG().toString('base64'), name: 'browser.png' } };
        } catch (error) {
          waiting.throwIfAborted();
          const changed = (error as { code?: string }).code === 'BROWSER_PAGE_CHANGED'
            || /Execution context was destroyed|Cannot find context with specified id|Cannot find default execution context|Inspected target navigated or closed/i.test(String(error));
          if (!changed || attempt === 1) throw error;
          // 导航可能销毁正在等绘制的上下文；只等待新文档并重读一次截图，共用原截止时间。
        }
      }
      throw Object.assign(new Error('页面持续发生导航，请重新观察。'), { code: 'BROWSER_PAGE_CHANGED' });
    } catch (error) {
      signal.throwIfAborted(); closed.signal.throwIfAborted();
      // 观察失败不要求 reload：重新加载可能重复提交网页表单，snapshot 可独立用于检查当前状态。
      if (/display surface.*not available|UnknownVizError/i.test(String(error))) throw Object.assign(new Error('当前网页的绘制表面不可用。可先用 browser_read 的 snapshot 读取页面状态，再用 screenshot 重新观察。'), { code: 'BROWSER_VIEW_REQUIRED' });
      if (deadline.aborted || (error as { code?: string }).code === 'BROWSER_OPERATION_TIMEOUT') throw Object.assign(new Error(`网页截图超时（${stage}）。可稍后用 browser_read 的 screenshot 重试，或用 snapshot 读取页面状态。`), { code: 'BROWSER_CAPTURE_TIMEOUT' });
      throw error;
    } finally { this.contents.off('destroyed', destroyed); }
  }
  private observed(id?: unknown) {
    const value = this.observation;
    if (!value || id !== undefined && id !== value.id)
      throw Object.assign(new Error(value ? `找不到截图 ${String(id)}，最近截图为 ${value.id}；也可省略 observationId 使用最近截图。` : '还没有截图，请先截图，或使用元素 ref 定位。'), { code: 'OBSERVATION_STALE' });
    return value;
  }
  private imagePoint(observation: Omit<BrowserObservation, 'tabId'>, x: unknown, y: unknown) {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x >= observation.screenshot.width || y >= observation.screenshot.height)
      throw Object.assign(new Error('坐标必须位于返回的截图范围内。'), { code: 'INVALID_ARGUMENTS' });
    return { x: x * observation.viewport.width / observation.screenshot.width,
      y: y * observation.viewport.height / observation.screenshot.height };
  }
  private reference(value: unknown): ElementReference {
    const reference = typeof value === 'string' ? this.references.get(value) : undefined;
    if (!reference) throw Object.assign(new Error('找不到这个元素引用，请读取当前页面取得目标 ref。'), { code: 'BROWSER_TARGET_MISSING' });
    return reference;
  }
  private async element(reference: ElementReference, signal: AbortSignal) {
    const { object } = await this.command('DOM.resolveNode', { backendNodeId: reference.backendNodeId, objectGroup: 'graycode-browser' }, signal, reference.sessionId)
      .catch(error => {
        if (/No node with given id|Could not find node|Node with given id does not belong/i.test(String(error)))
          throw Object.assign(new Error('页面元素已移除，请重新读取。'), { code: 'BROWSER_TARGET_MISSING' });
        throw error;
      });
    if (!object?.objectId) throw Object.assign(new Error('页面元素已移除，请重新读取。'), { code: 'BROWSER_TARGET_MISSING' });
    return object.objectId as string;
  }
  private async validateReference(reference: ElementReference, signal: AbortSignal): Promise<void> {
    const objectId = await this.element(reference, signal);
    const connected = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
      functionDeclaration: 'function() { return this.isConnected === true; }' }, signal, reference.sessionId);
    if (connected.result?.value !== true) {
      const key = referenceKey(reference), id = this.referenceIds.get(key);
      if (id) this.references.delete(id);
      this.referenceIds.delete(key);
      throw Object.assign(new Error('页面元素已移除，请重新读取目标区域。'), { code: 'BROWSER_TARGET_MISSING' });
    }
  }
  async action(args: Record<string, unknown>, signal: AbortSignal): Promise<BrowserActionFeedback & BrowserInteractionState> {
    signal.throwIfAborted(); validateActionArguments(args); await this.pending(this.connect(), signal);
    const action = String(args.action);
    if (action === 'dialog') {
      const pendingDialog = this.dialog;
      if (!pendingDialog) throw Object.assign(new Error('页面没有等待处理的原生对话框。'), { code: 'BROWSER_TARGET_MISSING' });
      // 接受后页面可能马上打开下一个对话框，不能在回执时再清空刚刚收到的新状态。
      this.dialog = undefined;
      try { await this.command('Page.handleJavaScriptDialog', { accept: args.accept, ...(args.promptText !== undefined ? { promptText: args.promptText } : {}) }, signal, pendingDialog.sessionId); }
      catch (error) { this.dialog ??= pendingDialog; throw error; }
      this.invalidateVisual(); return this.interactionState();
    }
    for (const sessionId of [undefined, ...this.sessions.keys()]) await this.command('Page.setInterceptFileChooserDialog', { enabled: true }, signal, sessionId);
    const reference = args.ref && action !== 'drag' ? this.reference(args.ref) : undefined;
    // 元素引用优先；坐标动作才读取截图，省略 ID 时沿用最近截图，键盘操作可直接使用当前焦点。
    const usesImage = !reference && (['click', 'hover', 'drag'].includes(action) || action === 'scroll' && (args.x !== undefined || args.y !== undefined));
    const observation = usesImage ? this.observed(args.observationId) : undefined;
    if (observation) {
      this.imagePoint(observation, args.x, args.y);
      if (action === 'drag') this.imagePoint(observation, args.toX, args.toY);
    }
    const feedback: BrowserActionFeedback = {};
    try {
      if (reference) await this.validateReference(reference, signal);
      if (action === 'scroll') {
        const distance = typeof args.distance === 'number' ? args.distance : 600;
        const size = await this.command('Page.getLayoutMetrics', {}, signal);
        let x = size.cssVisualViewport.clientWidth / 2; let y = size.cssVisualViewport.clientHeight / 2;
        if (reference) { const point = await this.point(reference, signal); x = point.x; y = point.y; }
        else if (observation && (args.x !== undefined || args.y !== undefined)) {
          const point = this.imagePoint(observation, args.x, args.y); x = point.x; y = point.y;
        }
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, signal, reference?.sessionId);
        await this.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y,
          deltaX: ['left', 'right'].includes(String(args.direction)) ? (args.direction === 'left' ? -distance : distance) : 0,
          deltaY: ['up', 'down'].includes(String(args.direction)) ? (args.direction === 'up' ? -distance : distance) : 0 }, signal, reference?.sessionId);
      } else if (['click', 'hover', 'check'].includes(action)) {
        if (action === 'check') {
          const state = await this.checkState(reference!, signal);
          if (state.checked === args.checked) return feedback;
          if (state.radio && !args.checked) throw Object.assign(new Error('单选框不能直接取消，请选择同组的其他选项。'), { code: 'INVALID_ARGUMENTS' });
        }
        let point: Awaited<ReturnType<BrowserPage['point']>>;
        try { point = reference ? await this.point(reference, signal) : this.imagePoint(observation!, args.x, args.y); }
        catch (error) {
          signal.throwIfAborted();
          if (reference && action === 'click' && (args.button ?? 'left') === 'left' && (args.clickCount ?? 1) === 1
            && (error as { code?: string }).code === 'BROWSER_NO_GEOMETRY') {
            const objectId = await this.element(reference, signal);
            const clicked = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
              functionDeclaration: `function() { const element = this.nodeType === 3 ? this.parentElement : this; if (!element?.isConnected || typeof element.click !== 'function') return false;
                const hit = { tagName: element.tagName.toLowerCase(), role: element.getAttribute('role') || undefined, name: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 160) };
                element.click(); return hit; }` }, signal, reference.sessionId);
            if (clicked.result?.value) return { pointer: { source: 'element', method: 'dom-click', hit: clicked.result.value }, ...this.interactionState() };
          }
          throw error;
        }
        const button = args.button ?? 'left';
        const count = args.clickCount === 2 ? 2 : 1;
        const viewport = { x: point.x, y: point.y };
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...viewport, button: 'none' }, signal, reference?.sessionId);
        feedback.pointer = { source: reference ? 'element' : 'image', method: 'pointer', viewport,
          ...(observation ? { observationId: observation.id, image: { x: Number(args.x), y: Number(args.y) } } : {}),
          hit: point.hit ?? await this.hitAtPoint(viewport, signal, reference?.sessionId),
          ...(point.overlapped ? { overlapped: true } : {}) };
        if (action === 'hover') return { ...feedback, ...this.interactionState() };
        for (let clickCount = 1; clickCount <= count; clickCount++) {
          try { await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...viewport, button, clickCount }, signal, reference?.sessionId); }
          finally { await this.releaseInput('Input.dispatchMouseEvent', { type: 'mouseReleased', ...viewport, button, clickCount }, reference?.sessionId); }
        }
        if (action === 'check' && (await this.checkState(reference!, signal)).checked !== args.checked)
          throw new Error('已点击选项，但页面尚未确认目标状态，请重新观察，不要重复切换。');
      } else if (action === 'drag') {
        const from = this.imagePoint(observation!, args.x, args.y), to = this.imagePoint(observation!, args.toX, args.toY);
        const duration = Number(args.durationMs ?? 300), steps = Math.max(2, Math.ceil(duration / 16));
        let point = from;
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' }, signal);
        try {
          await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, signal);
          for (let step = 1; step <= steps; step++) {
            signal.throwIfAborted();
            point = { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps };
            await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 }, signal);
            await new Promise(resolve => setTimeout(resolve, duration / steps));
          }
        } finally { await this.releaseInput('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }); }
      } else if (action === 'type') {
        if (reference) await this.command('DOM.focus', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId);
        await this.command('Input.insertText', { text: args.text }, signal, reference?.sessionId);
      } else if (action === 'fill') {
        const objectId = await this.element(reference!, signal);
        const prepared = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
          functionDeclaration: prepareTextInput, arguments: [{ value: args.text }] }, signal, reference!.sessionId);
        const status = prepared.result?.value;
        if (status === 'invalid-value') throw Object.assign(new Error('文本不符合该输入框的原生格式，请按页面要求填写数值或日期。'), { code: 'INVALID_ARGUMENTS' });
        if (status !== 'filled' && status !== 'selected') throw Object.assign(new Error('此元素不是可编辑文本框。'), { code: 'INVALID_ARGUMENTS' });
        if (status === 'selected') {
          // insertText('') 不会删除选择区，空值必须派发真正的删除键。
          if (args.text) await this.command('Input.insertText', { text: args.text }, signal, reference!.sessionId);
          else await this.press('Backspace', signal, reference!.sessionId);
        }
      } else if (action === 'select') {
        const objectId = await this.element(reference!, signal);
        const selected = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
          functionDeclaration: selectElement, arguments: [{ value: args.values }, { value: args.labels }] }, signal, reference!.sessionId);
        if (selected.exceptionDetails) throw new Error('下拉框操作失败，请重新观察页面。');
        if (selected.result?.value !== null) throw Object.assign(new Error(selected.result?.value ?? '下拉框当前不可操作。'), { code: 'INVALID_ARGUMENTS' });
      } else if (action === 'press') {
        if (reference) await this.command('DOM.focus', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId);
        await this.press(String(args.key), signal, reference?.sessionId);
      } else throw new Error('不支持的页面操作。');
      return { ...feedback, ...this.interactionState() };
    } catch (error) {
      signal.throwIfAborted();
      if ((error as { code?: string }).code === 'BROWSER_DIALOG_PENDING' && this.dialog) return { ...feedback, ...this.interactionState() };
      throw error;
    } finally {
      this.invalidateVisual();
      if (this.contents.debugger.isAttached()) void this.contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'graycode-browser' }, reference?.sessionId).catch(() => {});
    }
  }
  private async press(value: string, signal: AbortSignal, sessionId?: string): Promise<void> {
    const key = browserKey(value);
    try { await this.command('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, signal, sessionId); }
    finally {
      const { text: _text, ...released } = key;
      await this.releaseInput('Input.dispatchKeyEvent', { type: 'keyUp', ...released }, sessionId);
    }
  }
  private async releaseInput(method: string, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    let notify!: () => void;
    const interrupted = new Promise<void>(resolve => { notify = resolve; this.dialogWaiters.add(notify); });
    try {
      // mouseReleased/keyUp 本身也可能打开对话框。必须实际派发释放，再同时等待确认或弹窗事件。
      const work = this.contents.debugger.sendCommand(method, params, sessionId);
      if (this.dialog) { void work.catch(() => {}); return; }
      await this.pending(Promise.race([work, interrupted]), AbortSignal.timeout(1000));
    } finally { this.dialogWaiters.delete(notify); }
  }
  private async checkState(reference: ElementReference, signal: AbortSignal) {
    const objectId = await this.element(reference, signal);
    const result = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: checkedState }, signal, reference.sessionId);
    const state = result.result?.value;
    if (!state || state.error) throw Object.assign(new Error(state?.error ?? '无法读取选项状态。'), { code: 'INVALID_ARGUMENTS' });
    return { checked: state.checked === true || state.checked === 'true' ? true : state.checked === false || state.checked === 'false' ? false : 'mixed', radio: state.radio };
  }
  private async hitAtPoint(point: { x: number; y: number }, signal: AbortSignal, sessionId?: string): Promise<BrowserHitTarget | undefined> {
    const result = await this.command('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      let element = document.elementFromPoint(${point.x}, ${point.y});
      while (element?.shadowRoot) { const inner = element.shadowRoot.elementFromPoint(${point.x}, ${point.y}); if (!inner || inner === element) break; element = inner; }
      if (!element) return undefined;
      return { tagName: element.tagName.toLowerCase(), role: element.getAttribute('role') || undefined,
        name: (element.getAttribute('aria-label') || element.getAttribute('alt') || (['BODY', 'HTML'].includes(element.tagName) ? '' : element.textContent) || '').trim().slice(0, 160) };
    })()` }, signal, sessionId);
    return result.result?.value;
  }
  private async point(reference: ElementReference, signal: AbortSignal): Promise<{ x: number; y: number; hit?: BrowserHitTarget; overlapped?: boolean }> {
    const objectId = await this.element(reference, signal);
    const result = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
      functionDeclaration: pointInElement }, signal, reference.sessionId);
    const location = result.result?.value;
    if (!location) throw Object.assign(new Error('元素没有可用的位置。'), { code: 'BROWSER_NO_GEOMETRY' });
    const resultQuads = await this.command('DOM.getContentQuads', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId).catch(error => { signal.throwIfAborted(); return undefined; });
    const quad = resultQuads?.quads?.[location.index] as number[] | undefined;
    if (!quad || quad.length !== 8) return { x: location.x, y: location.y, hit: location.hit, overlapped: location.overlapped };
    return { x: quad[0] + (quad[2] - quad[0]) * location.u + (quad[6] - quad[0]) * location.v,
      y: quad[1] + (quad[3] - quad[1]) * location.u + (quad[7] - quad[1]) * location.v,
      hit: location.hit, overlapped: location.overlapped };
  }
  detach(): void {
    this.invalidate();
    if (this.debuggerOwned && this.contents.debugger.isAttached()) this.contents.debugger.detach();
  }
  allowManualInput(): void {
    this.automated = false;
    if (this.debuggerOwned && this.contents.debugger.isAttached()) for (const sessionId of [undefined, ...this.sessions.keys()])
      void this.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId).catch(() => {});
  }
  async upload(value: unknown, files: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await this.pending(this.connect(), signal);
    const reference = this.reference(value);
    await this.validateReference(reference, signal);
    const { node } = await this.command('DOM.describeNode', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId);
    const attributes = node.attributes as string[] | undefined;
    const type = attributes?.findIndex((value, index) => index % 2 === 0 && value === 'type');
    if (node.nodeName !== 'INPUT' || type === undefined || type < 0 || attributes?.[type + 1]?.toLowerCase() !== 'file') throw new Error('此引用不是文件选择控件。');
    const multiple = attributes?.some((value, index) => index % 2 === 0 && value === 'multiple');
    if (!multiple && files.length > 1) throw Object.assign(new Error('此文件控件只允许选择一个文件。'), { code: 'INVALID_ARGUMENTS' });
    try {
      await this.command('DOM.setFileInputFiles', { backendNodeId: reference.backendNodeId, files }, signal, reference.sessionId);
      if (this.fileChooser?.ref === value) this.fileChooser = undefined;
    }
    finally { this.invalidateVisual(); }
  }
}
