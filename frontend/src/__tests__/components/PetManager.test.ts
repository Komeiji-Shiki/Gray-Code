import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PetManager from '../../../../apps/client/src/components/PetManager.vue';
import { setShellLanguage } from '../../../../apps/client/src/i18n';
const { call, collectImport, fileData } = vi.hoisted(() => ({ call: vi.fn(), collectImport: vi.fn(), fileData: vi.fn() }));
vi.mock('../../../../apps/client/src/api', () => ({ call, rpc: call }));
vi.mock('../../../../apps/client/src/pets/importFiles', () => ({
  collectPetImport: collectImport,
  fileBase64: fileData,
  selectedPath: (file: File) => file.webkitRelativePath || file.name,
}));
const resources = ['first', 'second'].map(id => ({ id, name: id, kind: 'sprite', sprite: { version: 2 }, files: [], actions: [], expressions: [] }));
const configuration = { resourceId: 'first', visible: false, surface: 'app', scale: 1, reducedMotion: false, stopped: false, taskAnimations: true, mappings: {} };
const wrappers: ReturnType<typeof mount>[] = [];
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
beforeEach(() => {
  setShellLanguage('zh-CN');
  HTMLDialogElement.prototype.showModal = vi.fn(); call.mockReset();
  collectImport.mockReset().mockResolvedValue({ entry: 'model.model3.json', files: [{ path: 'model.model3.json', data: 'e30=' }] });
  fileData.mockReset().mockResolvedValue('Y29yZQ==');
  call.mockImplementation(async method => method === 'pets.list' ? resources : { configuration: structuredClone(configuration), revision: 1, floatingAvailable: true });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
async function open(props = {}) {
  const wrapper = mount(PetManager, { props, global: { stubs: { PetPlayer: true } } });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}
async function chooseFiles(wrapper: ReturnType<typeof mount>, selector: string, files: File[]) {
  const input = wrapper.get(selector);
  Object.defineProperty(input.element, 'files', { configurable: true, value: files });
  await input.trigger('change');
}

describe('桌宠选择草稿', () => {
  it('未保存的新资源选择在关闭前要求处理', async () => {
    const wrapper = await open(); await wrapper.findAll('.pet-row')[1].trigger('click');
    await button(wrapper, '关闭').trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined(); expect(wrapper.find('footer.confirm').exists()).toBe(true);
  });
  it('跳转屏幕感知也保留未保存确认，确认后进入原目标', async () => {
    const wrapper = await open(); await wrapper.findAll('.pet-row')[1].trigger('click');
    await button(wrapper, '屏幕感知设置').trigger('click'); expect(wrapper.emitted('screenSense')).toBeUndefined();
    await button(wrapper, '放弃更改并继续').trigger('click'); expect(wrapper.emitted('screenSense')).toHaveLength(1);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
  it('放弃更改恢复保存的资源选择，随后可直接关闭', async () => {
    const wrapper = await open(); await wrapper.findAll('.pet-row')[1].trigger('click');
    await button(wrapper, '放弃更改并读取已保存设置').trigger('click'); await flushPromises();
    expect(wrapper.findAll('.pet-row')[0].attributes('aria-pressed')).toBe('true');
    await button(wrapper, '关闭').trigger('click'); expect(wrapper.emitted('close')).toHaveLength(1);
  });
});

describe('陪伴内资源管理与全局显示设置', () => {
  it('嵌入时选择只更新陪伴草稿，保存互动也保留播放器的资源绑定', async () => {
    const wrapper = await open({ embedded: true, selectedResourceId: 'first' });
    expect(wrapper.element.tagName).toBe('SECTION');
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    await wrapper.findAll('.pet-row')[1].trigger('click');
    expect(wrapper.emitted('selectResource')).toEqual([['second']]);
    expect(call.mock.calls.some(([method]) => method === 'pets.configure')).toBe(false);
    await wrapper.get('.display-section input[type="checkbox"]').setValue(true);
    await button(wrapper, '保存互动设置').trigger('click');
    await flushPromises();
    expect(call).toHaveBeenCalledWith('pets.configure', expect.objectContaining({
      configuration: expect.objectContaining({ resourceId: 'first', reducedMotion: true }),
    }));
  });

  it('全局模式只加载 Core 和显示缩放，放弃修改会通知外层恢复干净状态', async () => {
    const wrapper = await open({ embedded: true, section: 'preferences' });
    expect(wrapper.find('.import-buttons').exists()).toBe(false);
    expect(wrapper.find('.pet-row').exists()).toBe(false);
    expect(wrapper.find('.pet-runtime').exists()).toBe(true);
    expect(call.mock.calls.some(([method]) => method === 'pets.list')).toBe(false);
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(1);
    await wrapper.get('input[type="range"]').setValue('1.8');
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([true]);
    await (wrapper.vm as unknown as { discard(): Promise<void> }).discard();
    await flushPromises();
    expect((wrapper.get('input[type="range"]').element as HTMLInputElement).value).toBe('1');
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([false]);
  });
});

describe('Live2D 导入中的 Core 安装', () => {
  it('在同一表单选择 Core，安装完成后才继续导入模型', async () => {
    const runtime = { name: 'live2dcubismcore.min.js', bytes: 4, sha256: 'runtime' };
    const imported = { ...resources[0], id: 'model', name: 'model', kind: 'live2d' };
    let runtimeReady = false;
    let modelImported = false;
    call.mockImplementation(async method => {
      if (method === 'pets.list') return modelImported ? [...resources, imported] : resources;
      if (method === 'pets.runtime.import') runtimeReady = true;
      if (method === 'pets.import') { modelImported = true; return imported; }
      return { configuration: structuredClone(configuration), revision: 1, floatingAvailable: true, runtime: runtimeReady ? runtime : undefined };
    });
    const wrapper = await open({ embedded: true });
    const model = new File(['{}'], 'model.model3.json');
    const core = new File(['Live2DCubismCore'], 'live2dcubismcore.min.js');
    await chooseFiles(wrapper, '.import-buttons input[type="file"]', [model]);
    expect(wrapper.get('.import-form a').attributes('href')).toBe('https://www.live2d.com/download/cubism-sdk/download-web/');
    expect(button(wrapper, '校验并导入').attributes('disabled')).toBeDefined();
    await chooseFiles(wrapper, '.import-runtime input[type="file"]', [core]);
    await wrapper.get('.import-form').trigger('submit');
    await flushPromises();
    const writes = call.mock.calls.filter(([method]) => method === 'pets.runtime.import' || method === 'pets.import');
    expect(writes.map(([method]) => method)).toEqual(['pets.runtime.import', 'pets.import']);
    expect(writes[0][1]).toEqual({ name: core.name, data: 'Y29yZQ==' });
    expect(wrapper.find('.import-form').exists()).toBe(false);
    expect(wrapper.emitted('selectResource')).toEqual([['model']]);
  });

  it('Core 安装失败保留模型表单，并停止模型导入', async () => {
    call.mockImplementation(async method => {
      if (method === 'pets.runtime.import') throw new Error('Core 文件无效');
      if (method === 'pets.list') return resources;
      return { configuration: structuredClone(configuration), revision: 1, floatingAvailable: true };
    });
    const wrapper = await open();
    await chooseFiles(wrapper, '.import-buttons input[type="file"]', [new File(['{}'], 'model.model3.json')]);
    await chooseFiles(wrapper, '.import-runtime input[type="file"]', [new File(['invalid'], 'live2dcubismcore.min.js')]);
    await wrapper.get('.import-form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Core 文件无效');
    expect(wrapper.find('.import-form').exists()).toBe(true);
    expect(call.mock.calls.some(([method]) => method === 'pets.import')).toBe(false);
  });
});
