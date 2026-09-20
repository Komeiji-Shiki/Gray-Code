import { EventEmitter } from 'node:events';
import { BrowserPage } from '../../../apps/desktop/src/browser/page';
import { compactSnapshot, type SnapshotNode } from '../../../apps/desktop/src/browser/snapshot';

const signal = () => new AbortController().signal;
const ax = (id: string, name: string, parentId?: string) => ({ nodeId: id, parentId, backendDOMNodeId: Number(id), role: { value: 'button' }, name: { value: name } });

function fixture(nodes: ReturnType<typeof ax>[]) {
  let attached = false;
  const sendCommand = jest.fn(async (method: string, params?: any, sessionId?: string): Promise<any> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame', url: 'https://fixture.test/' } } };
    if (method === 'Accessibility.getFullAXTree') return { nodes };
    return {};
  });
  const debug = Object.assign(new EventEmitter(), { sendCommand, isAttached: () => attached, attach: () => { attached = true; } });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debug, isDestroyed: () => false, isDevToolsOpened: () => false,
    getURL: () => 'https://fixture.test/', getTitle: () => '验收网页', capturePage: jest.fn(),
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
  expect(rows.map(row => row.name)).toEqual(['输入字段', '表单']);
  expect(rows.find(row => row.name === '表单')!.depth).toBe(0);
  expect(rows.map(row => row.ref)).not.toContain(region);
  await expect(f.page.action({ action: 'press', ref: region, key: 'Enter' }, signal())).rejects.toThrow('元素引用不存在');
  const inputRef = rows[0].ref!;
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

test('截图保持比例并报告实际尺寸，小图片不放大', async () => {
  const f = fixture([]);
  const small = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 720 }), toPNG: () => Buffer.from('fixture'), resize: jest.fn() };
  const large = { ...small, getSize: () => ({ width: 3840, height: 2160 }), resize: jest.fn(() => small) };
  f.contents.capturePage.mockResolvedValueOnce(large).mockResolvedValueOnce(small);
  expect(await f.page.screenshot(signal())).toMatchObject({ width: 1280, height: 720, mimeType: 'image/png' });
  expect(large.resize).toHaveBeenCalledWith({ width: 1280, height: 720, quality: 'best' });
  await f.page.screenshot(signal(), 2560); expect(small.resize).not.toHaveBeenCalled();
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
