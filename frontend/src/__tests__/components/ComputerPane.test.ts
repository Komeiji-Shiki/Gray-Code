import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ComputerPane from '../../../../apps/client/src/components/ComputerPane.vue';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ rpc, call: rpc, subscribe: () => () => {} }));
const target = { id: '98', title: '测试编辑器', processId: 100, bounds: { x: -1920, y: 0, width: 1000, height: 500 }, dpi: 144 };
const frame = (id = 'frame-1') => ({ id, capturedAt: Date.now(), window: target, elements: [], truncated: false,
  screenshot: { data: 'ZmFrZQ==', mimeType: 'image/jpeg', width: 1000, height: 500 } });
const wrappers: ReturnType<typeof mount>[] = [];
const open = async () => { const wrapper = mount(ComputerPane, { props: { visible: true } }); wrappers.push(wrapper); await flushPromises(); return wrapper; };
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(async (method: string) => {
    if (method === 'computer.status') return { active: false, available: true, screenshotAvailable: true };
    if (method === 'computer.windows') return { windows: [target], displays: [] };
    if (method === 'computer.observe') return frame();
    if (method === 'computer.recent') return [];
    return { status: 'completed' };
  });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('电脑面板的画面操作流程', () => {
  it('选择窗口默认显示截图，控件树仅在进入控件标签时读取', async () => {
    const wrapper = await open();
    await wrapper.find('#computer-window').setValue('98'); await flushPromises();
    expect(rpc).toHaveBeenCalledWith('computer.observe', expect.objectContaining({ windowId: '98', screenshot: true, frameOnly: true, width: 1280 }));
    expect(wrapper.find('img').attributes('src')).toBe('data:image/jpeg;base64,ZmFrZQ==');
    expect(wrapper.find('.computer-controls').exists()).toBe(false);
    await button(wrapper, '控件与输入').trigger('click'); await flushPromises();
    expect(rpc).toHaveBeenLastCalledWith('computer.status');
    expect(rpc).toHaveBeenCalledWith('computer.observe', expect.objectContaining({ frameOnly: false }));
  });

  it('在缩放后的图片上双击，传回图片像素并在操作后释放控制', async () => {
    const wrapper = await open(); await wrapper.find('#computer-window').setValue('98'); await flushPromises();
    await wrapper.find('select[aria-label="截图操作"]').setValue('double');
    const img = wrapper.find('img');
    vi.spyOn(img.element, 'getBoundingClientRect').mockReturnValue({ x: 30, y: 20, width: 500, height: 250 } as DOMRect);
    Object.assign(img.element, { setPointerCapture: vi.fn() });
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { button: 0, clientX: 130, clientY: 70, bubbles: true });
      Object.defineProperty(event, 'pointerId', { value: 1 }); img.element.dispatchEvent(event);
    }
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith('computer.action', expect.objectContaining({ observationId: 'frame-1', action: 'click', coordinateSpace: 'image', x: 200, y: 100, clickCount: 2 }));
    expect(rpc).toHaveBeenCalledWith('computer.release');
    expect(wrapper.text()).toContain('操作已完成');
  });

  it('操作已完成而截图失败时，保留动作成功信息并清除已消费的旧画面', async () => {
    const wrapper = await open(); await wrapper.find('#computer-window').setValue('98'); await flushPromises();
    rpc.mockImplementation(async method => {
      if (method === 'computer.observe') throw new Error('捕获不可用');
      if (method === 'computer.status') return { active: false, screenshotAvailable: true };
      return { status: 'completed' };
    });
    await button(wrapper, '切换到窗口').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('操作已完成，但刷新画面失败');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(rpc.mock.calls.filter(([name]) => name === 'computer.action')).toHaveLength(1);
  });

  it('等待控制权期间关闭面板，不再执行迟到动作', async () => {
    const wrapper = await open(); await wrapper.find('#computer-window').setValue('98'); await flushPromises();
    let acquired!: (value: object) => void;
    rpc.mockImplementation(async method => {
      if (method === 'computer.acquire') return new Promise(resolve => { acquired = resolve; });
      if (method === 'computer.status') return { active: false };
      return {};
    });
    await button(wrapper, '切换到窗口').trigger('click'); await flushPromises();
    await wrapper.setProps({ visible: false }); acquired({}); await flushPromises();
    expect(rpc.mock.calls.some(([name]) => name === 'computer.action')).toBe(false);
    expect(rpc).toHaveBeenCalledWith('computer.release');
  });

  it('快速隐藏再打开，旧截图请求不能阻止重新获取画面', async () => {
    const wrapper = await open(); let resolveFrame!: (value: unknown) => void;
    rpc.mockImplementation(async method => {
      if (method === 'computer.status') return { active: false, screenshotAvailable: true };
      if (method === 'computer.windows') return { windows: [target], displays: [] };
      if (method === 'computer.observe') return new Promise(resolve => { resolveFrame = resolve; });
      return {};
    });
    await wrapper.find('#computer-window').setValue('98'); await flushPromises();
    await wrapper.setProps({ visible: false }); await wrapper.setProps({ visible: true });
    const oldRequest = resolveFrame; oldRequest(frame('old')); await flushPromises();
    expect(resolveFrame).not.toBe(oldRequest); expect(wrapper.find('img').exists()).toBe(false);
    resolveFrame(frame('fresh')); await flushPromises();
    expect(wrapper.find('img').exists()).toBe(true);
  });
});
