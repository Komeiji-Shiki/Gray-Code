import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import SummarizeSettings from '../SummarizeSettings.vue';
import { desktopSettingsDraft, discardDesktopSettings, markDesktopSettingsDirty, saveDesktopSettings, trackPreferenceRequest } from '../../../platform/settingsDraft';
import { setLanguage } from '../../../i18n';
import type { HostTransport } from '../../../utils/hostTransport';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/utils/vscode', () => ({ sendToExtension: send }));
const originalHost = window.__GRAYCODE_HOST;
let wrapper: VueWrapper | undefined;
let saved: Record<string, unknown>, staged: Record<string, unknown>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  setLanguage('zh-CN');
  window.__GRAYCODE_HOST = { kind: 'web' } as HostTransport;
  saved = { method: 'summary', summarizePrompt: '已保存的手动提示词', autoSummarizePrompt: '已保存的自动提示词', useSeparateModel: false };
  staged = { ...saved };
  send.mockReset().mockImplementation(async (type, data) => {
    if (type === 'getSummarizeConfig' || type === 'getDefaultSummarizeConfig') return { ...staged };
    if (type === 'config.listConfigs') return [];
    if (type === 'updateSummarizeConfig') staged = { ...data.config };
    if (type === 'ui.settings.save') saved = { ...staged };
    if (type === 'ui.settings.discard') staged = { ...saved };
    return {};
  });
  await trackPreferenceRequest('ui.settings.begin', {}, Promise.resolve({ dirty: false }));
});
afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined; await flushPromises();
  await trackPreferenceRequest('ui.settings.end', {}, Promise.resolve({}));
  window.__GRAYCODE_HOST = originalHost; setLanguage('auto'); vi.useRealTimers();
});
async function render() {
  // 重建行为与 SettingsPanel 的统一撤销一致。
  wrapper = mount(defineComponent({ setup: () => () => h('div', { onInputCapture: markDesktopSettingsDirty }, [
    h(SummarizeSettings, { key: desktopSettingsDraft.generation }),
  ]) }), { global: { stubs: { CustomSelect: true, CustomCheckbox: true } } });
  await flushPromises();
  return wrapper;
}
test('输入后立即保存全部，先提交最新提示词，再保存统一草稿', async () => {
  const view = await render();
  await view.findAll('textarea')[0].setValue('尚未等待 400 毫秒的新内容');
  expect(send.mock.calls.some(([type]) => type === 'updateSummarizeConfig')).toBe(false);
  await saveDesktopSettings();
  expect(saved.summarizePrompt).toBe('尚未等待 400 毫秒的新内容');
  expect(send.mock.calls.filter(([type]) => type === 'updateSummarizeConfig')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(send.mock.calls.filter(([type]) => type === 'updateSummarizeConfig')).toHaveLength(1);
  expect(send.mock.calls.some(([type]) => type === 'config.listConfigs')).toBe(false);
});
test('撤销全部取消延迟保存，重建页面后旧输入不会重新写入草稿', async () => {
  const view = await render();
  await view.findAll('textarea')[0].setValue('需要丢弃的输入');
  await discardDesktopSettings(); await flushPromises();
  await vi.advanceTimersByTimeAsync(500);
  expect(view.findAll('textarea')[0].element.value).toBe('已保存的手动提示词');
  expect(staged.summarizePrompt).toBe(saved.summarizePrompt);
  expect(send.mock.calls.some(([type]) => type === 'updateSummarizeConfig')).toBe(false);
});
test('旧扩展离开总结设置时仍提交尚未触发的输入', async () => {
  window.__GRAYCODE_HOST = undefined;
  const view = await render();
  await view.findAll('textarea')[0].setValue('扩展最后一次输入');
  view.unmount(); wrapper = undefined; await flushPromises();
  expect(staged.summarizePrompt).toBe('扩展最后一次输入');
});
