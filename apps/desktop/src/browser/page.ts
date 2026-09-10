import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';

interface ElementReference { backendNodeId: number; sessionId?: string; frameId?: string }
interface PageLog { time: number; kind: 'console' | 'network' | 'error'; text: string }
interface AxNode { nodeId: string; parentId?: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; backendDOMNodeId?: number; properties?: Array<{ name: string; value: { value?: unknown } }> }

/** 只提供固定的页面操作。模型参数不能成为脚本、CDP 方法名或宿主接口。 */
export class BrowserPage {
  automated = false;
  private ready?: Promise<void>;
  private readonly references = new Map<string, ElementReference>();
  private readonly sessions = new Map<string, { targetId: string; url: string }>();
  private readonly records: PageLog[] = [];
  private epoch = 0;
  private debuggerOwned = false;
  constructor(readonly contents: WebContents, private readonly changed: () => void) {
    contents.on('did-start-navigation', () => this.invalidate());
    contents.debugger.on('detach', (_event, reason) => {
      this.ready = undefined; this.debuggerOwned = false; this.sessions.clear(); this.invalidate();
      this.log('error', `页面调试连接已断开：${reason}`); changed();
    });
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
        this.sessions.set(params.sessionId, params.targetInfo);
        void this.enable(params.sessionId).catch(error => this.log('error', String(error)));
      }
      if (method === 'Target.detachedFromTarget') { this.sessions.delete(params.sessionId); this.invalidate(); }
      if (method === 'Runtime.consoleAPICalled') this.log('console', `${params.type}: ${(params.args ?? []).map((value: { value?: unknown; description?: string }) => value.value ?? value.description ?? '').join(' ')}`);
      if (method === 'Runtime.exceptionThrown') this.log('error', params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '页面脚本异常');
      if (method === 'Network.responseReceived') this.log('network', `${params.response.status} ${params.type} ${params.response.url}`);
      if (method === 'Network.loadingFailed') this.log('network', `${params.type} ${params.errorText}`);
      if (method === 'Page.frameNavigated' || method === 'DOM.documentUpdated') this.invalidate();
      // 不打开系统对话框阻塞后台任务；页面提示保留在日志中。
      if (method === 'Page.javascriptDialogOpening' && this.automated) {
        this.log('console', `${params.type}: ${params.message}`);
        void contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }, sessionId).catch(() => {});
      }
    });
  }
  invalidate(): void { this.references.clear(); this.epoch++; }
  log(kind: PageLog['kind'], value: unknown): void {
    this.records.push({ time: Date.now(), kind, text: String(value).slice(0, 3000) });
    if (this.records.length > 200) this.records.splice(0, this.records.length - 200);
  }
  logs() { return { entries: [...this.records], capacity: 200 }; }
  private async enable(sessionId?: string): Promise<void> {
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Accessibility.enable']) await this.contents.debugger.sendCommand(method, {}, sessionId);
    await this.contents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
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
    return this.pending(this.contents.debugger.sendCommand(method, params, sessionId), signal);
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
  async snapshot(signal: AbortSignal) {
    await this.connect(); signal.throwIfAborted();
    this.invalidate(); const epoch = this.epoch; const prefix = randomUUID().slice(0, 8);
    const references = new Map<string, ElementReference>();
    const rows: Array<Record<string, unknown>> = []; const frames: Array<Record<string, unknown>> = [];
    let truncated = false;
    const read = async (frameId?: string, url?: string, sessionId?: string) => {
      if (rows.length >= 1000) { truncated = true; return; }
      const { nodes } = await this.command('Accessibility.getFullAXTree', { depth: 24, ...(frameId ? { frameId } : {}) }, signal, sessionId) as { nodes: AxNode[] };
      frames.push({ frameId: frameId ?? this.sessions.get(sessionId!)?.targetId, url });
      const depths = new Map<string, number>();
      for (const node of nodes) {
        const depth = node.parentId ? (depths.get(node.parentId) ?? 0) + 1 : 0; depths.set(node.nodeId, depth);
        if (node.ignored || node.role?.value === 'InlineTextBox' || !node.name?.value && ['generic', 'none'].includes(node.role?.value ?? '')) continue;
        if (rows.length >= 1000) { truncated = true; break; }
        const id = node.backendDOMNodeId ? `${prefix}-${references.size + 1}` : undefined;
        if (id) references.set(id, { backendNodeId: node.backendDOMNodeId!, sessionId, frameId });
        const properties = Object.fromEntries((node.properties ?? []).filter(value => ['checked', 'selected', 'disabled', 'expanded', 'required', 'readonly', 'level', 'multiline'].includes(value.name)).map(value => [value.name, value.value.value]));
        rows.push({ ...(id ? { ref: id } : {}), frameId, depth, role: node.role?.value, name: node.name?.value?.slice(0, 1200),
          ...(node.value?.value !== undefined ? { value: String(node.value.value).slice(0, 1200) } : {}), ...properties });
      }
    };
    const tree = await this.command('Page.getFrameTree', {}, signal);
    const visit = async (node: { frame: { id: string; url: string }; childFrames?: any[] }) => {
      try { await read(node.frame.id, node.frame.url); }
      catch (error) { signal.throwIfAborted(); frames.push({ frameId: node.frame.id, url: node.frame.url, unavailable: String(error) }); }
      for (const child of node.childFrames ?? []) await visit(child);
    };
    await visit(tree.frameTree);
    for (const [sessionId, target] of this.sessions) {
      if (frames.some(frame => frame.frameId === target.targetId && !frame.unavailable)) continue;
      try { await read(undefined, target.url, sessionId); }
      catch (error) { signal.throwIfAborted(); frames.push({ frameId: target.targetId, url: target.url, unavailable: String(error) }); }
    }
    if (epoch !== this.epoch) throw new Error('页面在读取时发生导航，请重新读取。');
    for (const [id, reference] of references) this.references.set(id, reference);
    return { url: this.contents.getURL(), title: this.contents.getTitle(), frames, nodes: rows, truncated };
  }
  async screenshot(signal: AbortSignal) {
    signal.throwIfAborted(); const epoch = this.epoch;
    try {
      // 捕获不会显示或聚焦窗口；尚无原生绘制表面时明确返回状态，不销毁标签。
      const picture = await this.pending(this.contents.capturePage(undefined, { stayHidden: false, stayAwake: false }), signal, 5000);
      signal.throwIfAborted();
      if (epoch !== this.epoch) throw new Error('页面在截图时发生导航，请重新截图。');
      if (picture.isEmpty()) throw new Error('Current display surface not available for capture');
      return { mimeType: 'image/png', data: picture.toPNG().toString('base64'), name: 'browser.png' };
    } catch (error) {
      signal.throwIfAborted();
      if (/display surface.*not available|UnknownVizError/i.test(String(error))) throw Object.assign(new Error('网页尚无可捕获的画面。请先在工作台显示该标签；窗口隐藏时需要用户打开应用。可继续使用页面结构读取，不要重复尝试同一截图。'), { code: 'BROWSER_VIEW_REQUIRED' });
      if ((error as { code?: string }).code === 'BROWSER_OPERATION_TIMEOUT') throw Object.assign(new Error('网页截图未及时完成。可以继续读取页面结构；请在网页重新显示或恢复后再截图。'), { code: 'BROWSER_CAPTURE_TIMEOUT' });
      throw error;
    }
  }
  private reference(value: unknown): ElementReference {
    const reference = typeof value === 'string' ? this.references.get(value) : undefined;
    if (!reference) throw new Error('元素引用不存在或已经失效，请重新读取页面。');
    return reference;
  }
  private async element(reference: ElementReference, signal: AbortSignal) {
    const { object } = await this.command('DOM.resolveNode', { backendNodeId: reference.backendNodeId, objectGroup: 'graycode-browser' }, signal, reference.sessionId);
    if (!object?.objectId) throw new Error('页面元素已移除，请重新读取。');
    return object.objectId as string;
  }
  async action(args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    await this.connect(); signal.throwIfAborted();
    await this.command('Page.setInterceptFileChooserDialog', { enabled: true }, signal);
    const action = String(args.action);
    const reference = ['click', 'fill', 'press'].includes(action) || args.ref ? this.reference(args.ref) : undefined;
    try {
      if (action === 'scroll') {
        if (!['up', 'down', 'left', 'right'].includes(String(args.direction))) throw new Error('请提供滚动方向。');
        const distance = typeof args.distance === 'number' ? args.distance : 600;
        const size = await this.command('Page.getLayoutMetrics', {}, signal);
        let x = size.cssVisualViewport.clientWidth / 2; let y = size.cssVisualViewport.clientHeight / 2;
        if (reference) { const point = await this.point(reference, signal); x = point.x; y = point.y; }
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, signal);
        await this.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y,
          deltaX: ['left', 'right'].includes(String(args.direction)) ? (args.direction === 'left' ? -distance : distance) : 0,
          deltaY: ['up', 'down'].includes(String(args.direction)) ? (args.direction === 'up' ? -distance : distance) : 0 }, signal);
      } else if (action === 'click') {
        const point = await this.point(reference!, signal);
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' }, signal, reference!.sessionId);
        await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, signal, reference!.sessionId);
        await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, signal, reference!.sessionId);
      } else if (action === 'fill') {
        if (typeof args.text !== 'string') throw new Error('请提供需要填入的文本。');
        const objectId = await this.element(reference!, signal);
        const prepared = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
          functionDeclaration: `function() { if (!this.isConnected || this.disabled || this.readOnly) return false; if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) { if (this.type === 'file' || typeof this.select !== 'function') return false; this.focus(); this.select(); return true; } if (this.isContentEditable) { this.focus(); const range = document.createRange(); range.selectNodeContents(this); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; } return false; }` }, signal, reference!.sessionId);
        if (!prepared.result?.value) throw new Error('此元素不是可编辑文本框。');
        await this.command('Input.insertText', { text: args.text }, signal, reference!.sessionId);
      } else if (action === 'press') {
        const keys: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
          Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
          Escape: { code: 'Escape', windowsVirtualKeyCode: 27 }, Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
          ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 }, ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
          ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 }, Space: { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
        };
        const key = keys[String(args.key)]; if (!key) throw new Error('不支持的按键。');
        await this.command('DOM.focus', { backendNodeId: reference!.backendNodeId }, signal, reference!.sessionId);
        await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: args.key === 'Space' ? ' ' : args.key, ...key }, signal, reference!.sessionId);
        await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: args.key === 'Space' ? ' ' : args.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode }, signal, reference!.sessionId);
      } else throw new Error('不支持的页面操作。');
    } finally {
      this.invalidate();
      if (this.contents.debugger.isAttached()) void this.contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'graycode-browser' }, reference?.sessionId).catch(() => {});
    }
  }
  private async point(reference: ElementReference, signal: AbortSignal): Promise<{ x: number; y: number }> {
    await this.command('DOM.scrollIntoViewIfNeeded', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId);
    const objectId = await this.element(reference, signal);
    const result = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
      functionDeclaration: `function() { const r = this.getBoundingClientRect(); const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2))); return this.isConnected && !this.disabled && (hit === this || this.contains(hit)); }` }, signal, reference.sessionId);
    if (!result.result?.value) throw new Error('此元素当前不可点击或被其他内容遮挡，请重新读取页面。');
    const resultQuads = await this.command('DOM.getContentQuads', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId);
    const quad = resultQuads.quads?.[0] as number[] | undefined;
    if (!quad || quad.length !== 8) throw new Error('此元素当前不可见。');
    return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
  }
  detach(): void {
    this.invalidate();
    if (this.debuggerOwned && this.contents.debugger.isAttached()) this.contents.debugger.detach();
  }
  allowManualInput(): void {
    this.automated = false;
    if (this.debuggerOwned && this.contents.debugger.isAttached()) void this.contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
  async upload(value: unknown, files: string[], signal: AbortSignal): Promise<void> {
    await this.connect(); const reference = this.reference(value);
    const { node } = await this.command('DOM.describeNode', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId);
    const attributes = node.attributes as string[] | undefined;
    const type = attributes?.findIndex((value, index) => index % 2 === 0 && value === 'type');
    if (node.nodeName !== 'INPUT' || type === undefined || type < 0 || attributes?.[type + 1]?.toLowerCase() !== 'file') throw new Error('此引用不是文件选择控件。');
    try { await this.command('DOM.setFileInputFiles', { backendNodeId: reference.backendNodeId, files }, signal, reference.sessionId); }
    finally { this.invalidate(); }
  }
}
