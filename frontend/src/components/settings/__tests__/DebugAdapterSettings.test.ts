import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import DebugAdapterSettings from '../DebugAdapterSettings.vue';
const calls = vi.hoisted(() => ({ send: vi.fn(), dirty: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: calls.send }));
vi.mock('@/platform/settingsDraft', () => ({ markDesktopSettingsDirty: calls.dirty }));
beforeEach(() => {
  vi.clearAllMocks(); calls.send.mockResolvedValue([
    { id: 'node', name: 'Node.js / TypeScript', source: 'bundled', available: true },
    { id: 'python', name: 'Python · debugpy', source: 'system', available: false, configurationTemplate: { id: 'python', name: 'Python · debugpy', command: 'python', args: ['-m', 'debugpy.adapter'], transport: 'stdio' } },
  ]);
});
test('调试器检测不会覆盖解释器草稿，TCP 连接与空参数可以继续编辑', async () => {
  const Host = defineComponent({ components: { DebugAdapterSettings }, setup: () => ({ adapters: ref<any[]>([]) }), template: '<DebugAdapterSettings v-model="adapters" :disabled="false" />' });
  const wrapper = mount(Host); await flushPromises();
  try {
    expect(wrapper.text()).toContain('内置可用'); expect(wrapper.text()).toContain('需要安装');
    await wrapper.findAll('button').find(value => value.text() === '设置调试器路径')!.trigger('click'); await flushPromises();
    await wrapper.get('[aria-label="调试适配器程序"]').setValue('D:/项目/.venv/Scripts/python.exe');
    await wrapper.findAll('button').find(value => value.text() === '添加启动参数')!.trigger('click');
    await wrapper.findAll('button').find(value => value.text() === '重新检测调试器')!.trigger('click'); await flushPromises();
    expect((wrapper.vm as any).adapters[0]).toMatchObject({ command: 'D:/项目/.venv/Scripts/python.exe', args: ['-m', 'debugpy.adapter', ''] });
    await wrapper.get('.custom-debug-adapter select').setValue('tcp');
    await wrapper.get('[aria-label="调试适配器程序"]').setValue(''); await wrapper.get('input[type=number]').setValue(5678);
    expect((wrapper.vm as any).adapters[0]).toMatchObject({ transport: 'tcp', command: '', port: 5678 });
    expect(calls.dirty).toHaveBeenCalled();
  } finally { wrapper.unmount(); }
});
