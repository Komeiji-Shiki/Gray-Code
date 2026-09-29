import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import MarkdownRenderer from '../../components/common/MarkdownRenderer.vue';
import { createWorkspaceAssetController } from '../../components/common/markdown/workspaceAssets';
import { completedRenderCache, fileExistenceCache, imageCache, invalidateWorkspaceAssets, setCachedImage } from '../../components/common/markdown/markdownItCore';
import { sendToExtension } from '../../utils/vscode';
import * as engine from '../../components/common/markdown/markdownItEngine';

vi.mock('../../utils/vscode', () => ({ sendToExtension: vi.fn(), showNotification: vi.fn() }));
const request = vi.mocked(sendToExtension);
let wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => { invalidateWorkspaceAssets(); request.mockReset(); request.mockResolvedValue({ results: {} }); vi.useFakeTimers(); });
afterEach(() => { for (const wrapper of wrappers) wrapper.unmount(); wrappers = []; vi.useRealTimers(); vi.restoreAllMocks(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('工作区切换清空图片、存在性和完成态缓存，迟到的旧工作区检查不再写入', async () => {
  const pending = deferred<{ results: Record<string, boolean> }>(); request.mockReturnValueOnce(pending.promise);
  const controller = createWorkspaceAssetController(ref(document.createElement('div')));
  const check = controller.prevalidateFilePaths('`src/main.ts`');
  expect(request).toHaveBeenCalledWith('checkWorkspaceFilesExist', { paths: ['src/main.ts'] });
  setCachedImage('image.png', 'data:image/png;base64,AAAA'); completedRenderCache.set('a', 'html');
  invalidateWorkspaceAssets(); pending.resolve({ results: { 'src/main.ts': true } }); await check;
  expect(fileExistenceCache.size).toBe(0); expect(imageCache.size).toBe(0); expect(completedRenderCache.size).toBe(0);
});

test('图片读取期间切换工作区，不显示旧图也不继续发出下一批读取', async () => {
  const container = document.createElement('div');
  container.innerHTML = Array.from({ length: 12 }, (_, index) => `<img class="workspace-image" data-path="${btoa(encodeURIComponent(`picture${index}.png`))}">`).join('');
  const pending = deferred<{ success: boolean; data: string }>(); request.mockReturnValue(pending.promise);
  const controller = createWorkspaceAssetController(ref(container));
  const loading = controller.loadWorkspaceImages(); expect(request).toHaveBeenCalledTimes(4);
  invalidateWorkspaceAssets(); pending.resolve({ success: true, data: 'AAAA' }); await loading;
  expect(request).toHaveBeenCalledTimes(4); expect(container.querySelector('[src]')).toBeNull(); expect(imageCache.size).toBe(0);
});

test('内容更新或卸载使旧文件预校验失效，不回填缓存或启动图片后处理', async () => {
  const pending = deferred<{ results: Record<string, boolean> }>(); request.mockReturnValueOnce(pending.promise);
  const wrapper = mount(MarkdownRenderer, { props: { content: '`src/old.ts` ![image](picture.png)' } }); wrappers.push(wrapper);
  await vi.advanceTimersByTimeAsync(0); expect(request).toHaveBeenCalledTimes(1);
  await wrapper.setProps({ content: 'new plain content' }); await vi.advanceTimersByTimeAsync(0);
  pending.resolve({ results: { 'src/old.ts': true } }); await flushPromises();
  expect(fileExistenceCache.has('src/old.ts')).toBe(false); expect(wrapper.text()).toBe('new plain content');
  expect(request.mock.calls.some(([method]) => method === 'readWorkspaceImage')).toBe(false);
  const closing = deferred<{ results: Record<string, boolean> }>(); request.mockReturnValueOnce(closing.promise);
  await wrapper.setProps({ content: '`src/closed.ts`' }); await vi.advanceTimersByTimeAsync(0);
  wrapper.unmount(); wrappers = []; closing.resolve({ results: { 'src/closed.ts': true } }); await flushPromises();
  expect(fileExistenceCache.has('src/closed.ts')).toBe(false);
});

test('相同完成态消息在重新挂载时复用同一份有界缓存', async () => {
  const render = vi.spyOn(engine, 'renderContent');
  const first = mount(MarkdownRenderer, { props: { content: '# Shared completed message' } }); wrappers.push(first);
  await vi.advanceTimersByTimeAsync(0); const count = render.mock.calls.length;
  first.unmount(); wrappers = [];
  const second = mount(MarkdownRenderer, { props: { content: '# Shared completed message' } }); wrappers.push(second);
  await vi.advanceTimersByTimeAsync(0);
  expect(second.get('h1').text()).toBe('Shared completed message'); expect(render).toHaveBeenCalledTimes(count);
});
