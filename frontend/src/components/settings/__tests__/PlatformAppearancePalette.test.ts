import { flushPromises, mount } from '@vue/test-utils'
import { expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../../../utils/vscode', () => ({ sendToExtension: calls.send }))
vi.mock('../../../platform/settingsDraft', () => ({ useDesktopSettingsDraft: vi.fn() }))
vi.mock('../../../i18n', async importOriginal => ({ ...await importOriginal<typeof import('../../../i18n')>(), useI18n: () => ({ t: (key: string) => key }) }))
import PlatformAppearanceSettings from '../PlatformAppearanceSettings.vue'

const appearance = { theme: 'dark', colors: {}, uiFont: 'inherit', textFont: 'inherit', codeFont: 'monospace', fontSize: 14, codeFontSize: 13,
  lineHeight: 1.6, density: 'comfortable', backgroundImage: '', backgroundOpacity: 0, customCss: '' }

test('选择深色配色后保存 darkPalette，并用色卡预览三套配色', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  calls.send.mockImplementation(async (method: string) => method === 'platform.settings.get' ? { appearance: structuredClone(appearance) } : method === 'desktop.fonts' ? [] : undefined)
  const wrapper = mount(PlatformAppearanceSettings, { global: { stubs: { BackgroundGallery: true, MarkdownRenderer: true } } })
  await flushPromises()
  const options = wrapper.findAll('.palette-option')
  expect(options).toHaveLength(3)
  expect(options[0].attributes('aria-checked')).toBe('true')
  await options[1].trigger('click')
  await flushPromises()
  const update = calls.send.mock.calls.find(([method]) => method === 'platform.settings.update')
  expect(update?.[1].settings.appearance.darkPalette).toBe('graphite')
  expect(wrapper.findAll('.palette-option')[1].attributes('aria-checked')).toBe('true')
})
