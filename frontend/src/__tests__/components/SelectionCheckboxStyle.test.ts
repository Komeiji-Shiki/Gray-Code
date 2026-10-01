import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (file: string) => readFileSync(path.resolve(process.cwd(), '..', file), 'utf8')
const rules = (source: string, selector: string) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(match => match[1].split(',').some(part => part.trim() === selector))
  .map(match => match[2]).join(';')

describe('侧栏选中标记', () => {
  test.each([
    ['frontend/src/components/settings/panel/SettingsSidebar.vue', '.settings-tab.active'],
    ['apps/client/src/components/navigation/ConversationNavigationRow.vue', '.navigation-row.active'],
    ['apps/client/src/components/navigation/conversationSidebar.css', '.navigation-draft.active'],
    ['apps/client/src/components/navigation/conversationSidebar.css', '.navigation-bottom button[aria-pressed=true]'],
  ])('%s %s 的竖线独立于圆角背景', (file, selector) => {
    const source = read(file)
    expect(rules(source, selector)).not.toMatch(/box-shadow:/)
    const marker = rules(source, `${selector}::before`)
    expect(marker).toMatch(/position:\s*absolute/)
    expect(marker).toMatch(/inset:\s*0 auto 0 0/)
    expect(marker).toMatch(/width:\s*2px/)
    expect(marker).toMatch(/border-radius:\s*0/)
    expect(marker).toMatch(/pointer-events:\s*none/)
    expect(marker).toMatch(/background:\s*var\(--gc-accent\)/)
  })
})

describe('复选框勾的位置', () => {
  test('公共几何规则按外框中心定位，并固定勾的内容尺寸', () => {
    const marker = rules(read('frontend/src/styles/primitives.css'), ':where(.custom-checkbox .checkmark)::after')
    expect(marker).toMatch(/left:\s*50%/)
    expect(marker).toMatch(/top:\s*50%/)
    expect(marker).toMatch(/width:\s*4px/)
    expect(marker).toMatch(/height:\s*8px/)
    expect(marker).toMatch(/box-sizing:\s*content-box/)
    expect(marker).toMatch(/transform:\s*translate\(-50%, -60%\) rotate\(45deg\)/)
  })

  test.each([
    'common/CustomCheckbox.vue', 'settings/channelSettings/ChannelBasicSettings.vue',
    'settings/channels/OpenAIOptions.vue', 'settings/channels/OpenAIResponsesOptions.vue',
    'settings/channels/AnthropicOptions.vue', 'settings/channels/GeminiOptions.vue',
    'settings/channels/ToolOptionsSettings.vue',
  ])('%s 不覆盖共享的勾位置，保留选中与配色规则', file => {
    const source = read(`frontend/src/components/${file}`)
    const marker = rules(source, '.custom-checkbox .checkmark::after')
    expect(marker).not.toMatch(/(^|;)\s*(left|top|width|height|transform|box-sizing)\s*:/)
    expect(marker).toMatch(/border:\s*solid var\(--gc-text-on-(primary|accent)\)/)
    expect(rules(source, '.custom-checkbox input:checked ~ .checkmark::after')).toMatch(/display:\s*block/)
  })
})
