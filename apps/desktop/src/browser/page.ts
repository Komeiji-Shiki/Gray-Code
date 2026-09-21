import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { BrowserObservation } from '@graycode/contracts';
import { compactSnapshot, type SnapshotNode } from './snapshot';
import { browserKey } from './keys';

interface ElementReference { backendNodeId: number; sessionId?: string; frameId?: string }
interface PageLog { cursor: number; time: number; kind: 'console' | 'network' | 'error'; text: string }
interface AxNode { nodeId: string; parentId?: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; backendDOMNodeId?: number; properties?: Array<{ name: string; value: { value?: unknown } }> }

/** 只提供固定的页面操作。模型参数不能成为脚本、CDP 方法名或宿主接口。 */
export class BrowserPage {
  automated = false;
  private ready?: Promise<void>;
  private readonly references = new Map<string, ElementReference>();
  private readonly sessions = new Map<string, { targetId: string; url: string }>();
  private readonly records: PageLog[] = [];
  private logCursor = 0;
  private epoch = 0;
  private debuggerOwned = false;
  private observation?: Omit<BrowserObservation, 'tabId'>;
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
  invalidate(): void { this.references.clear(); this.observation = undefined; this.epoch++; }
  log(kind: PageLog['kind'], value: unknown): void {
    this.records.push({ cursor: ++this.logCursor, time: Date.now(), kind, text: String(value).slice(0, 3000) });
    if (this.records.length > 200) this.records.splice(0, this.records.length - 200);
  }
  logs(options: { since?: number; maxEntries?: number } = {}) {
    const entries = this.records.filter(record => options.since === undefined || record.cursor > options.since);
    const maximum = options.maxEntries ?? 50;
    return { entries: entries.slice(-maximum), nextCursor: this.logCursor, capacity: 200,
      truncated: entries.length > maximum || options.since !== undefined && options.since < (this.records[0]?.cursor ?? 1) - 1 };
  }
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
  async snapshot(signal: AbortSignal, options: { compact?: boolean; maxNodes?: number; ref?: string } = {}) {
    await this.connect(); signal.throwIfAborted();
    const scope = options.ref ? this.reference(options.ref) : undefined;
    this.invalidate(); const epoch = this.epoch; const prefix = randomUUID().slice(0, 8);
    const references = new Map<string, ElementReference>();
    const rows: SnapshotNode[] = []; const frames: Array<Record<string, unknown>> = [];
    const maximum = options.maxNodes ?? 250;
    let truncated = false;
    const read = async (frameId?: string, url?: string, sessionId?: string) => {
      if (rows.length >= maximum) { truncated = true; return; }
      const { nodes } = await this.command('Accessibility.getFullAXTree', { depth: 24, ...(frameId ? { frameId } : {}) }, signal, sessionId) as { nodes: AxNode[] };
      frames.push({ frameId: frameId ?? this.sessions.get(sessionId!)?.targetId, url });
      const root = scope && nodes.find(node => node.backendDOMNodeId === scope.backendNodeId);
      if (scope && !root) throw new Error('所选页面区域已经变化，请重新读取整个页面。');
      const selected = new Set<string>();
      const byId = new Map(nodes.map(node => [node.nodeId, node]));
      const children = new Map<string, string[]>();
      for (const node of nodes) if (node.parentId) {
        const siblings = children.get(node.parentId) ?? [];
        siblings.push(node.nodeId); children.set(node.parentId, siblings);
      }
      // 根据父子关系选择区域，不依赖调试协议返回节点的排列顺序。
      const pending = root ? [root.nodeId] : [];
      while (pending.length) {
        const id = pending.pop()!; selected.add(id);
        pending.push(...children.get(id) ?? []);
      }
      const depths = new Map<string, number>();
      const depthOf = (node: AxNode): number => {
        if (depths.has(node.nodeId)) return depths.get(node.nodeId)!;
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        const depth = parent ? depthOf(parent) + 1 : 0; depths.set(node.nodeId, depth); return depth;
      };
      for (const node of nodes) {
        if (scope && !selected.has(node.nodeId)) continue;
        const depth = depthOf(node) - (root ? depthOf(root) : 0);
        if (node.ignored || node.role?.value === 'InlineTextBox' || !node.name?.value && ['generic', 'none'].includes(node.role?.value ?? '')) continue;
        if (rows.length >= maximum) { truncated = true; break; }
        const id = node.backendDOMNodeId ? `${prefix}-${references.size + 1}` : undefined;
        if (id) references.set(id, { backendNodeId: node.backendDOMNodeId!, sessionId, frameId });
        const properties = Object.fromEntries((node.properties ?? []).filter(value => ['checked', 'selected', 'disabled', 'expanded', 'required', 'readonly', 'level', 'multiline'].includes(value.name)).map(value => [value.name, value.value.value]));
        rows.push({ ...(id ? { ref: id } : {}), frameId: frameId ?? this.sessions.get(sessionId!)?.targetId, depth, role: node.role?.value, name: node.name?.value?.slice(0, 1200),
          ...(node.value?.value !== undefined ? { value: String(node.value.value).slice(0, 1200) } : {}), ...properties });
      }
    };
    const visit = async (node: { frame: { id: string; url: string }; childFrames?: any[] }) => {
      try { await read(node.frame.id, node.frame.url); }
      catch (error) { signal.throwIfAborted(); frames.push({ frameId: node.frame.id, url: node.frame.url, unavailable: String(error) }); }
      for (const child of node.childFrames ?? []) await visit(child);
    };
    if (scope) {
      await read(scope.frameId, scope.sessionId ? this.sessions.get(scope.sessionId)?.url : undefined, scope.sessionId);
    } else {
      const tree = await this.command('Page.getFrameTree', {}, signal);
      await visit(tree.frameTree);
      for (const [sessionId, target] of this.sessions) {
        if (frames.some(frame => frame.frameId === target.targetId && !frame.unavailable)) continue;
        try { await read(undefined, target.url, sessionId); }
        catch (error) { signal.throwIfAborted(); frames.push({ frameId: target.targetId, url: target.url, unavailable: String(error) }); }
      }
    }
    if (epoch !== this.epoch) throw new Error('页面在读取时发生导航，请重新读取。');
    for (const [id, reference] of references) this.references.set(id, reference);
    return { url: this.contents.getURL(), title: this.contents.getTitle(), frames,
      format: options.compact === false ? 'full' : 'compact', nodes: options.compact === false ? rows : compactSnapshot(rows), truncated };
  }
  async screenshot(signal: AbortSignal, bounds: { width: number; height: number }, maxImageDimension = 1280) {
    await this.connect(); signal.throwIfAborted();
    try {
      // 输入派发完成时合成线程可能尚未提交滚动；等新帧后再采集，避免返回操作前的画面。
      await this.command('Runtime.evaluate', {
        expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))',
        awaitPromise: true, returnByValue: true,
      }, signal);
      await this.command('Page.getLayoutMetrics', {}, signal);
      const epoch = this.epoch, zoomFactor = this.contents.getZoomFactor();
      const picture = await this.pending(this.contents.capturePage(undefined, { stayHidden: false, stayAwake: false }), signal, 5000);
      const metrics = await this.command('Page.getLayoutMetrics', {}, signal);
      signal.throwIfAborted();
      if (epoch !== this.epoch) throw new Error('页面在截图时发生导航，请重新截图。');
      if (picture.isEmpty()) throw new Error('Current display surface not available for capture');
      const original = picture.getSize();
      const ratio = Math.min(1, maxImageDimension / Math.max(original.width, original.height));
      const image = ratio < 1 ? picture.resize({ width: Math.max(1, Math.round(original.width * ratio)), height: Math.max(1, Math.round(original.height * ratio)), quality: 'best' }) : picture;
      const observation: Omit<BrowserObservation, 'tabId'> = {
        id: randomUUID(), capturedAt: Date.now(), url: this.contents.getURL(), coordinateSpace: 'image',
        screenshot: { mimeType: 'image/png', ...image.getSize() },
        // 视图 DIP 尺寸包括滚动条，除以页面缩放后与整张截图一一对应。
        viewport: { width: bounds.width / zoomFactor, height: bounds.height / zoomFactor,
          scrollX: metrics.cssVisualViewport.pageX, scrollY: metrics.cssVisualViewport.pageY, zoomFactor },
      };
      this.observation = observation;
      return { observation, attachment: { mimeType: 'image/png', data: image.toPNG().toString('base64'), name: 'browser.png' } };
    } catch (error) {
      signal.throwIfAborted();
      if (/display surface.*not available|UnknownVizError/i.test(String(error))) throw Object.assign(new Error('当前网页的绘制表面不可用，请重新加载标签后观察。'), { code: 'BROWSER_VIEW_REQUIRED' });
      if ((error as { code?: string }).code === 'BROWSER_OPERATION_TIMEOUT') throw Object.assign(new Error('网页截图未及时完成，请稍后重新观察。'), { code: 'BROWSER_CAPTURE_TIMEOUT' });
      throw error;
    }
  }
  private async observed(id: unknown, signal: AbortSignal) {
    const value = this.observation;
    if (!value || id !== value.id || Date.now() - value.capturedAt > 120_000)
      throw Object.assign(new Error('截图观察已失效，请重新截图。'), { code: 'OBSERVATION_STALE' });
    const metrics = await this.command('Page.getLayoutMetrics', {}, signal);
    if (this.observation !== value || this.contents.getZoomFactor() !== value.viewport.zoomFactor
      || metrics.cssVisualViewport.pageX !== value.viewport.scrollX || metrics.cssVisualViewport.pageY !== value.viewport.scrollY)
      throw Object.assign(new Error('页面缩放或滚动位置已变化，请重新截图。'), { code: 'OBSERVATION_STALE' });
    return value;
  }
  private imagePoint(observation: Omit<BrowserObservation, 'tabId'>, x: unknown, y: unknown) {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x >= observation.screenshot.width || y >= observation.screenshot.height)
      throw new Error('坐标必须位于返回的截图范围内。');
    return { x: x * observation.viewport.width / observation.screenshot.width,
      y: y * observation.viewport.height / observation.screenshot.height };
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
    const observation = args.observationId ? await this.observed(args.observationId, signal) : undefined;
    const reference = args.ref || action === 'fill' || !observation && ['click', 'press'].includes(action) ? this.reference(args.ref) : undefined;
    if (['type', 'drag'].includes(action) && !observation) throw new Error('请提供最近截图的 observationId。');
    try {
      if (action === 'scroll') {
        if (!['up', 'down', 'left', 'right'].includes(String(args.direction))) throw new Error('请提供滚动方向。');
        const distance = typeof args.distance === 'number' ? args.distance : 600;
        const size = await this.command('Page.getLayoutMetrics', {}, signal);
        let x = size.cssVisualViewport.clientWidth / 2; let y = size.cssVisualViewport.clientHeight / 2;
        if (reference) { const point = await this.point(reference, signal); x = point.x; y = point.y; }
        else if (observation && (args.x !== undefined || args.y !== undefined)) {
          const point = this.imagePoint(observation, args.x, args.y); x = point.x; y = point.y;
        }
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, signal);
        await this.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y,
          deltaX: ['left', 'right'].includes(String(args.direction)) ? (args.direction === 'left' ? -distance : distance) : 0,
          deltaY: ['up', 'down'].includes(String(args.direction)) ? (args.direction === 'up' ? -distance : distance) : 0 }, signal);
      } else if (action === 'click') {
        const point = reference ? await this.point(reference, signal) : this.imagePoint(observation!, args.x, args.y);
        const button = args.button ?? 'left';
        if (!['left', 'middle', 'right'].includes(String(button))) throw new Error('不支持的鼠标按键。');
        const count = args.clickCount === 2 ? 2 : 1;
        await this.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' }, signal, reference?.sessionId);
        for (let clickCount = 1; clickCount <= count; clickCount++) {
          try { await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount }, signal, reference?.sessionId); }
          finally { await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount }, AbortSignal.timeout(1000), reference?.sessionId); }
        }
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
        } finally { await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, AbortSignal.timeout(1000)); }
      } else if (action === 'type') {
        if (typeof args.text !== 'string') throw new Error('请提供需要输入的文本。');
        await this.command('Input.insertText', { text: args.text }, signal);
      } else if (action === 'fill') {
        if (typeof args.text !== 'string') throw new Error('请提供需要填入的文本。');
        const objectId = await this.element(reference!, signal);
        const prepared = await this.command('Runtime.callFunctionOn', { objectId, returnByValue: true,
          functionDeclaration: `function() { if (!this.isConnected || this.disabled || this.readOnly) return false; if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) { if (this.type === 'file' || typeof this.select !== 'function') return false; this.focus(); this.select(); return true; } if (this.isContentEditable) { this.focus(); const range = document.createRange(); range.selectNodeContents(this); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; } return false; }` }, signal, reference!.sessionId);
        if (!prepared.result?.value) throw new Error('此元素不是可编辑文本框。');
        await this.command('Input.insertText', { text: args.text }, signal, reference!.sessionId);
      } else if (action === 'press') {
        const key = browserKey(String(args.key));
        if (reference) await this.command('DOM.focus', { backendNodeId: reference.backendNodeId }, signal, reference.sessionId);
        try { await this.command('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, signal, reference?.sessionId); }
        finally {
          const { text: _text, ...released } = key;
          await this.command('Input.dispatchKeyEvent', { type: 'keyUp', ...released }, AbortSignal.timeout(1000), reference?.sessionId);
        }
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
