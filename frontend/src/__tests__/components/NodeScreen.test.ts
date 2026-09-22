import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { NodePeerSummary } from '../../../../packages/contracts/src/nodes';
import NodeScreen from '../../../../apps/client/src/components/NodeScreen.vue';
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call, subscribe: () => () => {} }));
const peer: NodePeerSummary = { id: 'peer', nodeId: 'node', name: '验收设备', direction: 'outgoing', state: 'online', createdAt: 1,
  capabilities: { nodeId: 'node', name: '验收设备', platform: 'win32', protocol: 1, account: { id: 'owner', displayName: '主人', role: 'owner' },
    workspaces: [], agents: [], tasks: true, computer: true, screenshot: true } };
const target = { id: 'window', title: '合成窗口', processId: 123, bounds: { x: 0, y: 0, width: 640, height: 480 }, dpi: 96 };
const frame = () => ({ id: 'frame', capturedAt: Date.now(), window: target, elements: [], truncated: false,
  screenshot: { data: 'ZmFrZQ==', mimeType: 'image/png', width: 640, height: 480 } });
let active = false;
const wrappers: ReturnType<typeof mount>[] = [];
const methods = (method: string) => call.mock.calls.filter(([, params]) => params.method === method);
const button = (wrapper: ReturnType<typeof mount>, text: string) => wrapper.findAll('button').find(item => item.text() === text)!;
async function defaultCall(_method: string, params: { method: string }) {
  if (params.method === 'computer.windows') return { windows: [target], displays: [] };
  if (params.method === 'computer.acquire') active = true;
  if (params.method === 'computer.release') active = false;
  if (params.method === 'computer.status' || params.method === 'computer.acquire' || params.method === 'computer.release') return { active };
  if (params.method === 'computer.observe') return frame();
  return { status: 'completed' };
}
async function open() {
  const wrapper = mount(NodeScreen, { props: { peer, visible: true } }); wrappers.push(wrapper);
  await flushPromises(); await wrapper.get('select[aria-label="远端观看目标"]').setValue('window:window'); await flushPromises();
  return wrapper;
}
beforeEach(() => {
  active = false; call.mockReset().mockImplementation(defaultCall);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks(); vi.useRealTimers(); });

test('隐藏期间迟到取得的远端控制权会再次释放', async () => {
  const wrapper = await open(); let finish!: (value: object) => void;
  call.mockImplementation((method, params) => params.method === 'computer.acquire' ? new Promise(resolve => { finish = resolve; }) : defaultCall(method, params));
  call.mockClear();
  await button(wrapper, '取得控制权').trigger('click'); await flushPromises();
  await wrapper.setProps({ visible: false }); await flushPromises();
  expect(methods('computer.release')).toHaveLength(1);
  active = true; finish({ active: true }); await flushPromises();
  expect(methods('computer.release')).toHaveLength(2); expect(active).toBe(false);
  expect(methods('computer.observe')).toHaveLength(0); expect(methods('computer.action')).toHaveLength(0);
});
test('等候新鲜窗口身份时隐藏面板，不再派发切换窗口动作', async () => {
  const wrapper = await open(); await button(wrapper, '取得控制权').trigger('click'); await flushPromises();
  let finish!: (value: object) => void;
  call.mockImplementation((method, params) => params.method === 'computer.observe' ? new Promise(resolve => { finish = resolve; }) : defaultCall(method, params));
  await button(wrapper, '切换到此窗口').trigger('click'); await flushPromises();
  await wrapper.setProps({ visible: false }); finish(frame()); await flushPromises();
  expect(methods('computer.action')).toHaveLength(0);
});
test('动作与后续状态刷新同时失败，仍展示动作原始错误', async () => {
  const wrapper = await open(); await button(wrapper, '取得控制权').trigger('click'); await flushPromises();
  call.mockImplementation((method, params) => {
    if (params.method === 'computer.action') return Promise.reject(new Error('动作被远端拒绝'));
    if (params.method === 'computer.status') return Promise.reject(new Error('后续网络故障'));
    return defaultCall(method, params);
  });
  await button(wrapper, 'Enter').trigger('click'); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe('动作被远端拒绝');
  expect(wrapper.find('img').exists()).toBe(false); expect(methods('computer.action')).toHaveLength(1);
});
test('动作成功但截图失败时保留回执，不再次派发动作', async () => {
  const wrapper = await open(); await button(wrapper, '取得控制权').trigger('click'); await flushPromises();
  call.mockImplementation((method, params) => params.method === 'computer.observe' ? Promise.reject(new Error('截图失败')) : defaultCall(method, params));
  await button(wrapper, 'Enter').trigger('click'); await flushPromises();
  expect(wrapper.get('[role="status"]').text()).toBe('操作已执行。');
  expect(wrapper.get('[role="alert"]').text()).toContain('操作已执行，但刷新画面失败');
  expect(wrapper.find('img').exists()).toBe(false); expect(methods('computer.action')).toHaveLength(1);
});
test('连续观看在隐藏后停止采集', async () => {
  const wrapper = await open(); await wrapper.get('input[aria-label="连续观看远端画面"]').setValue(true);
  call.mockClear(); await vi.advanceTimersByTimeAsync(1000); await flushPromises();
  expect(methods('computer.observe')).toHaveLength(1);
  await wrapper.setProps({ visible: false }); await flushPromises();
  await vi.advanceTimersByTimeAsync(4000); expect(methods('computer.observe')).toHaveLength(1);
});
