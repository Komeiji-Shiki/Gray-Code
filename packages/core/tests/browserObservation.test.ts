import { EventEmitter } from 'node:events';
import { BrowserPage } from '../../../apps/desktop/src/browser/page';
import { compactSnapshot, type AxNode, type SnapshotNode } from '../../../apps/desktop/src/browser/snapshot';


const signal = () => new AbortController().signal;
const ax = (id: string, name: string, parentId?: string) => ({ nodeId: id, parentId, backendDOMNodeId: Number(id), role: { value: 'button' }, name: { value: name } });

function fixture(nodes: AxNode[]) {
  let attached = false;
  const sendCommand = jest.fn(async (method: string, params?: any, sessionId?: string): Promise<any> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame', url: 'https://fixture.test/' } } };
    if (method === 'Accessibility.getFullAXTree') return { nodes };
    if (method === 'Accessibility.getPartialAXTree') return { nodes: nodes.filter(node => node.backendDOMNodeId === params.backendNodeId) };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'fixture-node' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY: 0 } };
    return {};
  });
  const debug = Object.assign(new EventEmitter(), { sendCommand, isAttached: () => attached, attach: () => { attached = true; } });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debug, isDestroyed: () => false, isDevToolsOpened: () => false,
    getURL: () => 'https://fixture.test/', getTitle: () => '验收网页', getZoomFactor: (): number => 1, capturePage: jest.fn(),
  });
  return { page: new BrowserPage(contents as any, () => {}), contents, sendCommand };
}

test.each(['screenshot', 'action', 'upload'] as const)('%s 在调试连接准备期间取消，迟到连接不再触发页面操作', async kind => {
  const call = (page: BrowserPage, abortSignal: AbortSignal) => kind === 'screenshot'
    ? page.screenshot(abortSignal, { width: 800, height: 600 })
    : kind === 'action' ? page.action({ action: 'type', ref: 'unused', text: '不得输入' }, abortSignal)
      : page.upload('unused', ['unused.txt'], abortSignal);
  const cancelled = new AbortController(); const reason = new Error('用户停止浏览器准备'); cancelled.abort(reason);
  const before = fixture([]);
  await expect(call(before.page, cancelled.signal)).rejects.toBe(reason);
  expect(before.sendCommand).not.toHaveBeenCalled();
  const f = fixture([]), controller = new AbortController();
  let ready!: () => void;
  f.sendCommand.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
  const pending = call(f.page, controller.signal);
  expect(f.sendCommand).toHaveBeenCalledWith('Page.enable', {}, undefined);
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason); await rejected;
  ready(); await f.page.connect();
  expect(f.sendCommand.mock.calls.map(([method]) => method)).toEqual([
    'Page.enable', 'Runtime.enable', 'Network.enable', 'Accessibility.enable', 'Target.setAutoAttach',
  ]);
  expect(f.contents.capturePage).not.toHaveBeenCalled();
});

test('精简页面保留真实引用、状态和带引号的正文，显著减少重复字段', () => {
  const nodes: SnapshotNode[] = Array.from({ length: 200 }, (_, index) => ({ ref: `observed-${index}`, frameId: 'main-frame', depth: 2,
    role: 'checkbox', name: `选项 ${index}\n[伪造引用]`, checked: false, disabled: false, required: false, expanded: false }));
  const original = structuredClone(nodes), compact = compactSnapshot(nodes);
  expect(compact[0]).toContain('[observed-0] checkbox "选项 0\\n[伪造引用]" checked=false expanded=false');
  expect(compact.filter(line => line.includes('frame='))).toHaveLength(1);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(nodes).length * 0.6);
  expect(nodes).toEqual(original);
});

test('区域读取和连续动作沿用有效引用，导航后失效', async () => {
  // 子节点先出现，区域选择也应完整。
  const f = fixture([ax('3', '输入字段', '2'), ax('1', '网页'), ax('2', '表单', '1'), ax('4', '其他区域', '1')]);
  const first = await f.page.snapshot(signal(), { compact: false });
  const region = (first.nodes as SnapshotNode[]).find(node => node.name === '表单')!.ref!;
  const scoped = await f.page.snapshot(signal(), { ref: region, compact: false });
  const rows = scoped.nodes as SnapshotNode[];
  expect(rows.map(row => row.name)).toEqual(['表单', '输入字段']);
  expect(rows.find(row => row.name === '表单')!.depth).toBe(0);
  expect(rows.map(row => row.ref)).toContain(region);
  await f.page.action({ action: 'press', ref: region, key: 'Enter' }, signal());
  const inputRef = rows.find(row => row.name === '输入字段')!.ref!;
  await f.page.action({ action: 'press', ref: inputRef, key: 'Enter' }, signal());
  expect(f.sendCommand).toHaveBeenCalledWith('DOM.focus', { backendNodeId: 3 }, undefined);
  await f.page.action({ action: 'press', ref: inputRef, key: 'Enter' }, signal());
  const current = await f.page.snapshot(signal(), { compact: false });
  f.contents.emit('did-start-navigation');
  await expect(f.page.snapshot(signal(), { ref: (current.nodes as SnapshotNode[])[0].ref })).rejects.toThrow('元素引用不存在');
});

test('默认节点预算明确报告截断，并允许按需扩大读取', async () => {
  const f = fixture(Array.from({ length: 300 }, (_, index) => ax(String(index + 1), `条目 ${index}`)));
  const compact = await f.page.snapshot(signal());
  expect(compact).toMatchObject({ format: 'compact', truncated: true }); expect(compact.nodes).toHaveLength(250);
  const expanded = await f.page.snapshot(signal(), { maxNodes: 500, compact: false });
  expect(expanded).toMatchObject({ format: 'full', truncated: false }); expect(expanded.nodes).toHaveLength(300);
});

test('筛选发生在分页之前，后面的链接、描述和深层控件仍能读取', async () => {
  const nodes: AxNode[] = Array.from({ length: 310 }, (_, index) => ax(String(index + 1), `导航 ${index}`));
  nodes.push({ ...ax('400', '论文全文'), role: { value: 'link' }, description: { value: '同行评审' },
    properties: [{ name: 'url', value: { value: 'https://fixture.test/paper/DOI-123' } }] });
  const f = fixture(nodes);
  const first = await f.page.snapshot(signal(), { maxNodes: 100, compact: false });
  expect(first).toMatchObject({ total: 311, nextOffset: 100, returned: 100 });
  const rest = await f.page.snapshot(signal(), { offset: 300, compact: false });
  expect(rest).toMatchObject({ total: 311, offset: 300, returned: 11, truncated: false });
  expect((rest.nodes as SnapshotNode[]).at(-1)).toMatchObject({ name: '论文全文', url: 'https://fixture.test/paper/DOI-123', description: '同行评审' });
  for (const query of ['doi-123', '同行评审']) {
    const found = await f.page.snapshot(signal(), { query, role: 'link', interactiveOnly: true, compact: false });
    expect(found).toMatchObject({ total: 1, returned: 1, truncated: false });
    expect((found.nodes as SnapshotNode[])[0].name).toBe('论文全文');
  }
  expect(f.sendCommand).toHaveBeenCalledWith('Accessibility.getFullAXTree', { frameId: 'main-frame' }, undefined);
});

test('正文按父子顺序聚合碎片且保留链接引用，长文本预算支持续查与查询片段', async () => {
  const f = fixture([ax('2', '第二节', '1'), ax('1', '正文'), ax('4', '第四段', '3'), ax('3', '第三节', '1')]);
  const ordered = await f.page.snapshot(signal(), { compact: false });
  expect((ordered.nodes as SnapshotNode[]).map(node => node.name)).toEqual(['正文', '第二节', '第三节', '第四段']);
  let id = 10;
  const characters = (text: string, parentId: string) => Array.from(text, name => ({ ...ax(String(id++), name, parentId), role: { value: 'StaticText' } }));
  const fragmented = fixture([
    { ...ax('1', '网页'), role: { value: 'RootWebArea' } },
    { ...ax('2', '', '1'), role: { value: 'paragraph' } },
    { ...ax('3', '', '2'), role: { value: 'generic' }, ignored: true }, ...characters('阅读', '3'),
    { ...ax('4', '参考资料', '2'), role: { value: 'link' }, properties: [{ name: 'url', value: { value: 'https://fixture.test/reference' } }] },
    ...characters('参考资料', '4'), ...characters('后继续。', '2'),
    { ...ax('5', '', '1'), role: { value: 'paragraph' } }, ...characters('下一段。', '5'),
  ]);
  const paragraphs = await fragmented.page.snapshot(signal(), { compact: false });
  expect((paragraphs.nodes as SnapshotNode[]).map(node => [node.role, node.name])).toEqual([
    ['RootWebArea', '网页'], ['paragraph', '阅读参考资料后继续。'], ['link', '参考资料'], ['paragraph', '下一段。'],
  ]);
  const found = await fragmented.page.snapshot(signal(), { query: '阅读参考资料后继续。', maxNodes: 1, compact: false });
  expect(found).toMatchObject({ total: 1, returned: 1, truncated: false });
  const links = await fragmented.page.snapshot(signal(), { ref: (found.nodes as SnapshotNode[])[0].ref, interactiveOnly: true, compact: false });
  expect((links.nodes as SnapshotNode[])[0]).toMatchObject({ role: 'link', name: '参考资料', url: 'https://fixture.test/reference', ref: expect.any(String) });
  await fragmented.page.action({ action: 'press', ref: (links.nodes as SnapshotNode[])[0].ref, key: 'Enter' }, signal());
  expect(fragmented.sendCommand).toHaveBeenCalledWith('DOM.focus', { backendNodeId: 4 }, undefined);
  const long = fixture(Array.from({ length: 40 }, (_, index) => ax(String(index + 1), '长'.repeat(6000) + '关键结论')));
  const page = await long.page.snapshot(signal(), { query: '关键结论', compact: false });
  expect(page).toMatchObject({ total: 40, truncated: false });
  expect((page.nodes as SnapshotNode[])[0]).toMatchObject({ name: expect.stringContaining('关键结论'), textTruncated: true });
  const limited = await long.page.snapshot(signal(), { compact: false });
  expect(limited).toMatchObject({ total: 40, characterLimit: 60000, truncated: true });
  expect(limited.nextOffset).toBe(limited.returned);
});

test('frameId 可以读取超出首页预算的嵌入页，失败的 OOPIF 重读后不误报 partial', async () => {
  const f = fixture([ax('1', '框架结果')]);
  f.contents.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child-frame', url: 'https://frame.test/' } });
  const command = f.sendCommand.getMockImplementation()!;
  f.sendCommand.mockImplementation(async (method, params, sessionId) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame', url: 'https://fixture.test/' }, childFrames: [{ frame: { id: 'child-frame', url: 'https://frame.test/' } }] } };
    if (method === 'Accessibility.getFullAXTree' && !sessionId) throw new Error('different target');
    return command(method, params, sessionId);
  });
  const result = await f.page.snapshot(signal(), { frameId: 'child-frame', compact: false });
  expect(result).toMatchObject({ total: 1, partial: false, frames: [{ frameId: 'child-frame', url: 'https://frame.test/' }] });
  expect((result.nodes as SnapshotNode[])[0].frameId).toBe('child-frame');
  await expect(f.page.snapshot(signal(), { frameId: 'missing' })).rejects.toThrow('页面框架不存在');
});

test('区域分页保留独立续查引用，日期及可聚焦自定义控件参与交互筛选', async () => {
  const f = fixture([ax('1', '表单'), { ...ax('2', '日期', '1'), role: { value: 'Date' } },
    { ...ax('3', '', '1'), role: { value: 'generic' }, properties: [{ name: 'focusable', value: { value: true } }] }, ax('4', '表单外')]);
  const full = await f.page.snapshot(signal(), { compact: false });
  const ref = (full.nodes as SnapshotNode[])[0].ref!;
  const page = await f.page.snapshot(signal(), { ref, interactiveOnly: true, maxNodes: 1, compact: false });
  expect(page).toMatchObject({ total: 3, nextOffset: 1, scopeRef: expect.any(String) });
  const next = await f.page.snapshot(signal(), { ref: page.scopeRef, offset: 1, interactiveOnly: true, compact: false });
  expect((next.nodes as SnapshotNode[]).map(node => node.role)).toEqual(['Date', 'generic']);
  expect(next).toMatchObject({ total: 3, returned: 2, truncated: false });
});

test('快照查询不使未改变页面的截图失效，hover 只移动鼠标', async () => {
  const f = fixture([ax('1', '菜单')]);
  f.contents.capturePage.mockResolvedValue({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 720 }), toPNG: () => Buffer.from('fixture') });
  const screenshot = await f.page.screenshot(signal(), { width: 1280, height: 720 });
  await f.page.snapshot(signal(), { query: '菜单' });
  await f.page.action({ action: 'hover', observationId: screenshot.observation.id, x: 120, y: 60 }, signal());
  const inputs = f.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent');
  expect(inputs).toEqual([['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 60, button: 'none' }, undefined]]);
});

test('条件等待观察真实更新，超时与取消分别返回，未知框架不能证明文字消失', async () => {
  jest.useFakeTimers();
  const nodes = [ax('1', '加载中')], f = fixture(nodes), controller = new AbortController();
  try {
    const waiting = f.page.waitForSnapshot(signal(), { query: '结果就绪', timeoutMs: 2000 });
    await jest.advanceTimersByTimeAsync(250); nodes.push(ax('2', '结果就绪'));
    await jest.advanceTimersByTimeAsync(250);
    expect(await waiting).toMatchObject({ conditionMet: true, timedOut: false, total: 1 });
    const absent = await f.page.waitForSnapshot(signal(), { query: '从未出现', state: 'absent', timeoutMs: 2000 });
    expect(absent.conditionMet).toBe(true);
    const cancelled = f.page.waitForSnapshot(controller.signal, { query: '不会出现', timeoutMs: 30000 });
    const rejected = expect(cancelled).rejects.toThrow('用户取消');
    await jest.advanceTimersByTimeAsync(100); controller.abort(new Error('用户取消')); await rejected;
  } finally { jest.useRealTimers(); }
  // AbortSignal.timeout 使用真实时钟，短上限避免假计时器掩盖截止行为。
  const command = f.sendCommand.getMockImplementation()!;
  f.sendCommand.mockImplementation(async (method, ...args) => {
    if (method === 'Accessibility.getFullAXTree') throw new Error('frame unavailable');
    return command(method, ...args);
  });
  const timeout = await f.page.waitForSnapshot(signal(), { query: '加载中', state: 'absent', timeoutMs: 100 });
  expect(timeout).toMatchObject({ conditionMet: false, timedOut: true, partial: true });
  const connecting = fixture([]);
  connecting.sendCommand.mockImplementation(() => new Promise(() => {}));
  expect(await connecting.page.waitForSnapshot(signal(), { query: '结果', timeoutMs: 100 })).toMatchObject({ conditionMet: false, timedOut: true });
});

test('截图保持比例并报告实际尺寸，小图片不放大', async () => {
  const f = fixture([]);
  const small = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 720 }), toPNG: () => Buffer.from('fixture'), resize: jest.fn() };
  const large = { ...small, getSize: () => ({ width: 3840, height: 2160 }), resize: jest.fn(() => small) };
  f.contents.capturePage.mockResolvedValueOnce(large).mockResolvedValueOnce(small);
  expect(await f.page.screenshot(signal(), { width: 1280, height: 720 })).toMatchObject({ observation: { screenshot: { width: 1280, height: 720, mimeType: 'image/png' } } });
  expect(large.resize).toHaveBeenCalledWith({ width: 1280, height: 720, quality: 'best' });
  await f.page.screenshot(signal(), { width: 1280, height: 720 }, 2560); expect(small.resize).not.toHaveBeenCalled();
});

test('截图坐标转换为页面坐标，并使旧观察在动作或缩放后失效', async () => {
  const f = fixture([]);
  const picture = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from('fixture') };
  f.contents.capturePage.mockResolvedValue(picture);
  const zoom = jest.spyOn(f.contents, 'getZoomFactor').mockReturnValue(1.25);
  const frame = await f.page.screenshot(signal(), { width: 800, height: 500 });
  const args = { action: 'click', observationId: frame.observation.id, x: 640, y: 400 };
  await f.page.action(args, signal());
  expect(f.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 320, y: 200 }), undefined);
  await expect(f.page.action(args, signal())).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
  const current = await f.page.screenshot(signal(), { width: 800, height: 500 });
  zoom.mockReturnValue(1.5);
  await expect(f.page.action({ ...args, observationId: current.observation.id }, signal())).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
});

test('日志游标只读取新增记录，缓冲丢失和条数限制均报告截断', () => {
  const f = fixture([]);
  for (let index = 0; index < 80; index++) f.page.log('console', `记录 ${index}`);
  const first = f.page.logs(); expect(first.entries).toHaveLength(50); expect(first.truncated).toBe(true);
  f.page.log('network', '新的响应');
  expect(f.page.logs({ since: first.nextCursor })).toMatchObject({ entries: [{ text: '新的响应' }], truncated: false });
  expect(f.page.logs({ since: 81 }).entries).toEqual([]);
  for (let index = 0; index < 200; index++) f.page.log('console', index);
  expect(f.page.logs({ since: 0, maxEntries: 200 }).truncated).toBe(true);
});

// 不只验证错误码：同一“截图超时”必须说明卡在绘制同步还是 native capture，且不要求 reload。
test.each(['frame', 'capture'] as const)('截图超时注明阶段并允许下一次独立读取（%s）', async stage => {
  jest.useFakeTimers();
  const f = fixture([]);
  const picture = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from('fixture') };
  f.contents.capturePage.mockResolvedValue(picture);
  const command = f.sendCommand.getMockImplementation()!;
  f.sendCommand.mockImplementation((method, ...args) => stage === 'frame' && method === 'Runtime.evaluate'
    ? new Promise(() => {}) : command(method, ...args));
  if (stage === 'capture') f.contents.capturePage.mockImplementationOnce(() => new Promise(() => {}));
  try {
    const capturing = f.page.screenshot(signal(), { width: 1280, height: 800 });
    const failed = expect(capturing).rejects.toMatchObject({ code: 'BROWSER_CAPTURE_TIMEOUT', message: expect.stringContaining(stage === 'frame' ? '等待页面绘制帧' : '采集页面图像') });
    await jest.advanceTimersByTimeAsync(stage === 'frame' ? 15000 : 5000); await failed;
    f.sendCommand.mockImplementation(command);
    await expect(f.page.screenshot(signal(), { width: 1280, height: 800 })).resolves.toMatchObject({ attachment: { mimeType: 'image/png' } });
  } finally { jest.useRealTimers(); }
});

test('原生绘制表面不可用时建议读快照，不要求可能重复提交的 reload', async () => {
  const f = fixture([]);
  f.contents.capturePage.mockRejectedValueOnce(new Error('Current display surface not available for capture'));
  await expect(f.page.screenshot(signal(), { width: 1280, height: 800 })).rejects.toMatchObject({
    code: 'BROWSER_VIEW_REQUIRED', message: expect.stringContaining('snapshot'),
  });
  await expect(f.page.snapshot(signal())).resolves.toMatchObject({ format: 'compact' });
});

test('动作后快照等主文档解析与同步布局，后台无绘制帧也能读取', async () => {
  const f = fixture([ax('1', '正文')]);
  const command = f.sendCommand.getMockImplementation()!, layout = jest.fn(), paint = jest.fn();
  f.sendCommand.mockImplementation(async (method, params, sessionId) => {
    if (method === 'Runtime.evaluate') {
      // 隐藏网页的 requestAnimationFrame 不触发；直接执行实际注入的表达式检查等待条件。
      await new Function('document', 'requestAnimationFrame', `return ${params.expression}`)(
        { readyState: 'complete', documentElement: { getBoundingClientRect: layout } }, paint);
      return {};
    }
    return command(method, params, sessionId);
  });
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  const reading = f.page.snapshotAfterAction(signal(), { query: '不存在的内容' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.sendCommand.mock.calls.some(([method]) => method === 'Accessibility.getFullAXTree')).toBe(false);
  f.contents.emit('dom-ready');
  expect(await reading).toMatchObject({ total: 0, partial: false });
  expect(layout).toHaveBeenCalledTimes(1); expect(paint).not.toHaveBeenCalled();
  expect(f.contents.listenerCount('dom-ready')).toBe(1); expect(f.contents.listenerCount('destroyed')).toBe(0);
});

test('动作后快照在导航与上下文销毁时只重读观察', async () => {
  const f = fixture([ax('1', '新文档')]);
  const command = f.sendCommand.getMockImplementation()!; let checkpoint = 0, reads = 0;
  f.sendCommand.mockImplementation(async (method, ...args) => {
    if (method === 'Runtime.evaluate' && checkpoint++ === 0) throw new Error('Execution context was destroyed.');
    if (method === 'Accessibility.getFullAXTree' && reads++ === 0) f.page.invalidate();
    return command(method, ...args);
  });
  expect(await f.page.snapshotAfterAction(signal(), { compact: false })).toMatchObject({ nodes: [{ name: '新文档' }] });
  expect(checkpoint).toBe(3); expect(reads).toBe(2);
  expect(f.sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
});

test.each(['取消', '关闭'])('动作后观察在%s时及时退出并清理等待监听', async kind => {
  const f = fixture([]), controller = new AbortController();
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  const reading = f.page.snapshotAfterAction(controller.signal);
  const rejected = expect(reading).rejects.toThrow(kind === '取消' ? '用户取消' : '网页标签已关闭');
  await new Promise<void>(resolve => setImmediate(resolve));
  if (kind === '取消') controller.abort(new Error('用户取消')); else f.contents.emit('destroyed');
  await rejected;
  expect(f.contents.listenerCount('dom-ready')).toBe(1); expect(f.contents.listenerCount('did-stop-loading')).toBe(1);
  expect(f.contents.listenerCount('destroyed')).toBe(0);
});

test('持续导航最多尝试三次，非导航故障立即返回', async () => {
  const f = fixture([]), read = jest.spyOn(f.page, 'snapshot').mockRejectedValue(Object.assign(new Error('导航'), { code: 'BROWSER_PAGE_CHANGED' }));
  await expect(f.page.snapshotAfterAction(signal())).rejects.toMatchObject({ code: 'BROWSER_PAGE_CHANGED' });
  expect(read).toHaveBeenCalledTimes(3);
  read.mockClear().mockRejectedValue(new Error('调试连接不可用'));
  await expect(f.page.snapshotAfterAction(signal())).rejects.toThrow('调试连接不可用');
  expect(read).toHaveBeenCalledTimes(1);
});

test('动作后观察共享五秒截止，停止加载也可释放文档等待', async () => {
  jest.useFakeTimers();
  const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(new Error('deadline')), ms); return controller.signal;
  });
  const f = fixture([]);
  try {
    f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    const reading = f.page.snapshotAfterAction(signal());
    const failed = expect(reading).rejects.toMatchObject({ code: 'BROWSER_SNAPSHOT_TIMEOUT' });
    await jest.advanceTimersByTimeAsync(5000); await failed;
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(f.contents.listenerCount('dom-ready')).toBe(1);
    f.contents.emit('did-stop-loading');
    await expect(f.page.snapshotAfterAction(signal())).resolves.toMatchObject({ total: 0 });
  } finally { timeout.mockRestore(); jest.useRealTimers(); }
});

// 模拟隔离世界里的变更标记：change() 相当于 MutationObserver 触发，unavailable 模拟创建世界失败。
function watched(nodes: AxNode[]) {
  const f = fixture(nodes), base = f.sendCommand.getMockImplementation()!;
  const marker = { id: 0, changed: true, unavailable: false };
  f.sendCommand.mockImplementation(async (method, params, sessionId) => {
    if (method === 'Page.createIsolatedWorld') { if (marker.unavailable) throw new Error('no world'); return { executionContextId: 7 }; }
    if (method === 'Runtime.evaluate' && params?.contextId === 7) {
      if (String(params.expression).includes('MutationObserver')) { marker.changed = false; return { result: { value: ++marker.id } }; }
      return { result: { value: marker.changed ? 0 : marker.id } };
    }
    return base(method, params, sessionId);
  });
  const reads = () => f.sendCommand.mock.calls.filter(([method]) => method === 'Accessibility.getFullAXTree').length;
  return { ...f, marker, reads, change: () => { marker.changed = true; } };
}

test('连续分页在页面未变时复用同一棵树，变化、换筛选、导航、动作和框架增减都重新读取', async () => {
  const f = watched(Array.from({ length: 30 }, (_, index) => ax(String(index + 1), `条目 ${index}`)));
  const first = await f.page.snapshot(signal(), { maxNodes: 10, compact: false });
  expect(first).toMatchObject({ total: 30, nextOffset: 10 }); expect(f.reads()).toBe(1);
  const second = await f.page.snapshot(signal(), { offset: 10, maxNodes: 10, compact: false });
  expect(f.reads()).toBe(1);
  // 分页保留先前观察到的元素引用，直到节点或文档真正改变。
  expect(second).toMatchObject({ total: 30, offset: 10, returned: 10, nextOffset: 20, partial: false });
  expect((second.nodes as SnapshotNode[]).map(node => node.name)).toEqual(Array.from({ length: 10 }, (_, index) => `条目 ${index + 10}`));
  await expect(f.page.action({ action: 'press', ref: (first.nodes as SnapshotNode[])[0].ref, key: 'Enter' }, signal())).resolves.toBeUndefined();
  f.change();
  expect(await f.page.snapshot(signal(), { offset: 20, maxNodes: 10, compact: false })).toMatchObject({ offset: 20, returned: 10, truncated: false });
  expect(f.reads()).toBe(2);
  // 不是严格续页（筛选不同或 offset 不等于上次 nextOffset）时始终读取当前页面。
  await f.page.snapshot(signal(), { maxNodes: 10 }); expect(f.reads()).toBe(3);
  await f.page.snapshot(signal(), { offset: 10, maxNodes: 10, query: '条目' }); expect(f.reads()).toBe(4);
  await f.page.snapshot(signal(), { maxNodes: 10 }); await f.page.snapshot(signal(), { offset: 15, maxNodes: 10 }); expect(f.reads()).toBe(6);
  await f.page.snapshot(signal(), { offset: 25, maxNodes: 10 }); expect(f.reads()).toBe(6);
  // 返回两页之间发生 between 时的完整读取次数。
  const pages = async (between: (page: { nodes: unknown }) => unknown) => {
    const before = f.reads(), page = await f.page.snapshot(signal(), { maxNodes: 10, compact: false });
    await between(page); await f.page.snapshot(signal(), { offset: 10, maxNodes: 10 });
    return f.reads() - before;
  };
  expect(await pages(() => {})).toBe(1);
  expect(await pages(() => f.contents.emit('did-start-navigation'))).toBe(2);
  expect(await pages(() => f.contents.debugger.emit('message', {}, 'Page.frameAttached', { frameId: 'late-frame' }))).toBe(2);
  expect(await pages(page => f.page.action({ action: 'press', ref: (page.nodes as SnapshotNode[])[0].ref, key: 'Enter' }, signal()))).toBe(2);
  // 标记不可用时无法证明未变，退回每次完整读取。
  f.marker.unavailable = true;
  expect(await pages(() => {})).toBe(2);
});

test('续页缓存有时限，超时后释放原始树并重新读取', async () => {
  jest.useFakeTimers();
  try {
    const f = watched(Array.from({ length: 30 }, (_, index) => ax(String(index + 1), `条目 ${index}`)));
    await f.page.snapshot(signal(), { maxNodes: 10 });
    await jest.advanceTimersByTimeAsync(30_000);
    await f.page.snapshot(signal(), { offset: 10, maxNodes: 10 });
    expect(f.reads()).toBe(2);
  } finally { jest.useRealTimers(); }
});

test('条件等待在标记未变时跳过完整重读，变化后立即重读，标记看不到的变化仍按间隔兜底', async () => {
  jest.useFakeTimers();
  const nodes = [ax('1', '加载中')], f = watched(nodes);
  try {
    const waiting = f.page.waitForSnapshot(signal(), { query: '结果就绪', timeoutMs: 10000 });
    await jest.advanceTimersByTimeAsync(700);
    expect(f.reads()).toBe(1);
    nodes.push(ax('2', '结果就绪')); f.change();
    await jest.advanceTimersByTimeAsync(200);
    expect(await waiting).toMatchObject({ conditionMet: true, total: 1 }); expect(f.reads()).toBe(2);
    // 脚本直接赋值等标记覆盖不到的变化：最多每秒完整重读一次，条件仍由实际读取结果判断。
    const absent = f.page.waitForSnapshot(signal(), { query: '加载中', state: 'absent', timeoutMs: 10000 });
    await jest.advanceTimersByTimeAsync(0); expect(f.reads()).toBe(3);
    nodes.shift();
    await jest.advanceTimersByTimeAsync(800); expect(f.reads()).toBe(3);
    await jest.advanceTimersByTimeAsync(400);
    expect(await absent).toMatchObject({ conditionMet: true, total: 0 }); expect(f.reads()).toBe(4);
  } finally { jest.useRealTimers(); }
});


test('节点被复用成其他含义或移除时拒绝旧引用，重新观察会给出新引用', async () => {
  const node = ax('1', '保存'), f = fixture([node]);
  const first = await f.page.snapshot(signal(), { compact: false });
  const ref = (first.nodes as SnapshotNode[])[0].ref!;
  node.name.value = '删除';
  await expect(f.page.action({ action: 'press', ref, key: 'Enter' }, signal())).rejects.toThrow('操作含义已经变化');
  const current = await f.page.snapshot(signal(), { compact: false });
  expect((current.nodes as SnapshotNode[])[0].ref).not.toBe(ref);
  const base = f.sendCommand.getMockImplementation()!;
  f.sendCommand.mockImplementation(async (method, params, session) => method === 'Runtime.callFunctionOn'
    ? { result: { value: false } } : base(method, params, session));
  await expect(f.page.action({ action: 'press', ref: (current.nodes as SnapshotNode[])[0].ref, key: 'Enter' }, signal())).rejects.toThrow('页面元素已移除');
  expect(f.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchKeyEvent')).toHaveLength(0);
});
