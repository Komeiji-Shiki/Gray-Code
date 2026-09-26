import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import ContentPreview from '../../../../apps/client/src/components/ContentPreview.vue';

const mocks = vi.hoisted(() => ({ call: vi.fn(), report: vi.fn(), notify: undefined as ((event: any) => void) | undefined, state: { contentPreviewOpen: false } }));
vi.mock('../../../../apps/client/src/api', () => ({ call: mocks.call, subscribe: (listener: typeof mocks.notify) => { mocks.notify = listener; return () => { mocks.notify = undefined; }; } }));
vi.mock('../../../../apps/client/src/state', () => ({ state: mocks.state, report: mocks.report }));
let wrapper: ReturnType<typeof mount> | undefined;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const preview = (id: string, ids = [id]) => ({ id, title: id, content: id, group: { index: 0, items: ids.map(id => ({ id, title: id })) } });
beforeEach(() => {
  mocks.call.mockReset(); mocks.report.mockReset(); pending.clear(); mocks.state.contentPreviewOpen = false;
  mocks.call.mockImplementation(async (_method, params) => params.type === 'preview.get'
    ? new Promise((resolve, reject) => { pending.set(params.data.id, { resolve, reject }); }) : {});
  wrapper = mount(ContentPreview);
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; });
const show = (id: string) => mocks.notify?.({ type: 'workspace.preview', previewId: id });
const closed = () => mocks.call.mock.calls.filter(([_method, params]) => params.type === 'preview.close').map(([_method, params]) => params.data.id);

test('被替换的迟到预览释放整个图片组，保留当前显示的预览', async () => {
  show('old'); show('current'); pending.get('current')!.resolve(preview('current')); await flushPromises();
  pending.get('old')!.resolve(preview('old', ['old', 'old-2'])); await flushPromises();
  expect(closed()).toEqual(['old', 'old-2']);
  expect(wrapper!.get('[role="dialog"]').attributes('aria-label')).toBe('current');
});

test('关闭组件后迟到的预览释放资源，迟到失败不再弹出错误', async () => {
  show('late'); wrapper!.unmount(); wrapper = undefined;
  pending.get('late')!.resolve(preview('late', ['late', 'late-2'])); await flushPromises();
  expect(closed()).toEqual(['late', 'late-2']); expect(mocks.state.contentPreviewOpen).toBe(false);
  wrapper = mount(ContentPreview); show('failed'); wrapper.unmount(); wrapper = undefined;
  pending.get('failed')!.reject(new Error('expired')); await flushPromises();
  expect(mocks.report).not.toHaveBeenCalled();
});
