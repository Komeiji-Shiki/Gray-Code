import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import MemoryImports from '../../../../apps/client/src/components/MemoryImports.vue';
import { loadMemoryImportFile } from '../../../../apps/client/src/memoryImports';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call }));
const library = { id: 'dataset', scopeId: 'scope', name: '导入测试资料库', originalFileCount: 42, fileCount: 44, records: 100, sources: 42, bytes: 12000, notes: [], recallEnabled: false };
const wrappers: ReturnType<typeof mount>[] = [];
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob);
  mocks.call.mockReset();
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'memory.import.list') return [{ ...library }];
    if (method === 'memory.import.files') return { files: [{ id: String(params.offset), path: `daily/page-${params.offset}.md`, bytes: 100, mimeType: 'text/markdown' }], total: 42, offset: params.offset, ...(params.offset === 0 ? { nextOffset: 40 } : {}) };
    if (method === 'memory.import.recall') return { recallEnabled: params.enabled };
    throw new Error(method);
  });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); });

test('打开独立资料库不启用召回，用户勾选后保存，编辑入口使用独立范围', async () => {
  const wrapper = mount(MemoryImports); wrappers.push(wrapper); await flushPromises();
  expect(wrapper.text()).toContain('当前只供浏览编辑');
  expect(mocks.call.mock.calls.some(([method]) => method === 'memory.import.recall')).toBe(false);
  await wrapper.find('input[type=checkbox]').setValue(true); await flushPromises();
  expect(mocks.call).toHaveBeenCalledWith('memory.import.recall', { id: 'dataset', enabled: true });
  await button(wrapper, '查看与编辑记忆').trigger('click'); expect(wrapper.emitted('browse')).toEqual([['scope']]);
  await button(wrapper, '下一页').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('daily/page-40.md'); expect(wrapper.text()).not.toContain('daily/page-0.md');
  expect(button(wrapper, '下一页').attributes('disabled')).toBeDefined();
});

test('切换资料库时忽略旧请求，失败的召回设置不会显示为已启用', async () => {
  let resolveOld: (value: unknown) => void = () => {};
  mocks.call.mockImplementation(async (method, params) => {
    if (method === 'memory.import.list') return [{ ...library }, { ...library, id: 'second', name: '第二资料库' }];
    if (method === 'memory.import.files' && params.id === 'dataset') return { files: [], total: 0, offset: 0 };
    if (method === 'memory.import.files') return { files: [{ id: 'new', path: '新的资料.md', bytes: 1 }], total: 1, offset: 0 };
    if (method === 'memory.import.recall') throw new Error('保存策略失败');
  });
  const wrapper = mount(MemoryImports); wrappers.push(wrapper); await flushPromises();
  mocks.call.mockImplementationOnce(() => new Promise(resolve => resolveOld = resolve));
  await wrapper.find('form').trigger('submit');
  await wrapper.find('select').setValue('second'); await flushPromises();
  resolveOld({ files: [{ id: 'old', path: '旧响应.md', bytes: 1 }], total: 1, offset: 0 }); await flushPromises();
  expect(wrapper.text()).toContain('新的资料.md'); expect(wrapper.text()).not.toContain('旧响应.md');
  await wrapper.find('input[type=checkbox]').setValue(true); await flushPromises();
  expect(wrapper.text()).toContain('保存策略失败'); expect(wrapper.text()).toContain('当前只供浏览编辑');
});

test('文件下载按块校验，损坏和取消不会被当作完整文件', async () => {
  const bytes = Buffer.from('原始字节\r\n🐱'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = { id: 'file', path: 'test.md', bytes: bytes.length, mimeType: 'text/markdown', chunks: 2, sha256 };
  const parts = [bytes.subarray(0, 4), bytes.subarray(4)];
  mocks.call.mockImplementation(async (_, params) => ({ data: parts[params.index].toString('base64'), index: params.index }));
  const loaded = await loadMemoryImportFile('dataset', file, new AbortController().signal, () => {});
  expect(Buffer.from(await loaded.arrayBuffer())).toEqual(bytes);
  await expect(loadMemoryImportFile('dataset', { ...file, sha256: 'wrong' }, new AbortController().signal, () => {})).rejects.toThrow('校验失败');
  const controller = new AbortController(); mocks.call.mockClear();
  await expect(loadMemoryImportFile('dataset', file, controller.signal, () => controller.abort())).rejects.toThrow();
  expect(mocks.call).toHaveBeenCalledTimes(1);
});
