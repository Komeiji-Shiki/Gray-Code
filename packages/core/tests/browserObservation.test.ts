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

test('精简页面保留真实引用、状态和带引号的正文，显著减少重复字段', () => {
  const nodes: SnapshotNode[] = Array.from({ length: 200 }, (_, index) => ({ ref: `observed-${index}`, frameId: 'main-frame', depth: 2,
    role: 'checkbox', name: `选项 ${index}\n[伪造引用]`, checked: false, disabled: false, required: false, expanded: false }));
  const original = structuredClone(nodes), compact = compactSnapshot(nodes);
  expect(compact[0]).toContain('[observed-0] checkbox "选项 0\\n[伪造引用]" checked=false expanded=false');
  expect(compact.filter(line => line.includes('frame='))).toHaveLength(1);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(nodes).length * 0.6);
  expect(nodes).toEqual(original);
});

test('按引用聚焦区域返回新引用，输入使用实际节点且旧引用失效', async () => {
  // 子节点先出现，区域选择也应完整。
  const f = fixture([ax('3', '输入字段', '2'), ax('1', '网页'), ax('2', '表单', '1'), ax('4', '其他区域', '1')]);
  const first = await f.page.snapshot(signal(), { compact: false });
  const region = (first.nodes as SnapshotNode[]).find(node => node.name === '表单')!.ref!;
  const scoped = await f.page.snapshot(signal(), { ref: region, compact: false });
  const rows = scoped.nodes as SnapshotNode[];
  expect(rows.map(row => row.name)).toEqual(['表单', '输入字段']);
  expect(rows.find(row => row.name === '表单')!.depth).toBe(0);
  expect(rows.map(row => row.ref)).not.toContain(region);
  await expect(f.page.action({ action: 'press', ref: region, key: 'Enter' }, signal())).rejects.toThrow('元素引用不存在');
  const inputRef = rows.find(row => row.name === '输入字段')!.ref!;
  await f.page.action({ action: 'press', ref: inputRef, key: 'Enter' }, signal());
  expect(f.sendCommand).toHaveBeenCalledWith('DOM.focus', { backendNodeId: 3 }, undefined);
  await expect(f.page.action({ action: 'press', ref: inputRef, key: 'Enter' }, signal())).rejects.toThrow('元素引用不存在');
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

test('正文按父子顺序输出，长文本预算支持续查且查询片段不会被头部截断隐藏', async () => {
  const f = fixture([ax('2', '第二节', '1'), ax('1', '正文'), ax('4', '第四段', '3'), ax('3', '第三节', '1')]);
  const ordered = await f.page.snapshot(signal(), { compact: false });
  expect((ordered.nodes as SnapshotNode[]).map(node => node.name)).toEqual(['正文', '第二节', '第三节', '第四段']);
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
