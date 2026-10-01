import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const bar = readFileSync(path.resolve(process.cwd(), 'src/components/input/InputSelectorBar.vue'), 'utf8')
const area = readFileSync(path.resolve(process.cwd(), 'src/components/input/InputArea.vue'), 'utf8')
const tps = readFileSync(path.resolve(process.cwd(), 'src/components/input/TpsBar.vue'), 'utf8')

test('选择器排成一行紧凑胶囊，不再按整宽栅格分两排', () => {
  expect(bar).toMatch(/\.selector-bar\s*\{[^}]*display:\s*flex/)
  expect(bar).not.toMatch(/grid-template-columns/)
  expect(bar).toMatch(/:deep\(\.model-trigger\)[^{]*\{[^}]*width:\s*auto/)
})

test('输入区使用卡片底色与淡描边', () => {
  expect(area).toMatch(/\.input-area\s*\{[^}]*background:\s*var\(--gc-surface-raised\)[^}]*border:\s*1px solid var\(--gc-border-subtle\)/)
})

test('思考强度选择器与模式、渠道、模型使用同一胶囊样式', () => {
  const reasoning = readFileSync(path.resolve(process.cwd(), 'src/components/input/ReasoningSelector.vue'), 'utf8')
  expect(bar).toMatch(/:deep\(\.select-trigger\)\s*\{[^}]*height:\s*24px[^}]*border:\s*0[^}]*background:\s*var\(--gc-surface-hover\)/)
  expect(bar).toMatch(/:deep\(\.select-trigger:hover\)/)
  expect(reasoning).not.toMatch(/:deep\(\.select-trigger\)/)
  // CustomSelect 的 compact 规则优先级高于胶囊规则，基础 min-height 也会把胶囊撑高。
  expect(reasoning).not.toMatch(/<CustomSelect[^>]*\scompact[\s>]/)
  expect(bar).toMatch(/:deep\(\.select-trigger\)\s*\{[^}]*min-height:\s*0/)
})

test('下拉选择器箭头统一使用 chevron 图标', () => {
  for (const file of ['src/components/common/CustomSelect.vue', 'src/components/input/ChannelSelector.vue', 'src/components/input/ModelSelector.vue']) {
    const source = readFileSync(path.resolve(process.cwd(), file), 'utf8')
    expect(source, file).not.toContain('▼')
    expect(source, file).toMatch(/codicon-chevron-down[^"]*select-arrow|select-arrow[^"]*codicon-chevron-down/)
  }
})

test('TPS 条空闲时隐藏但保留占位', () => {
  expect(tps).toMatch(/\.tps-bar\.is-idle\s*\{[^}]*visibility:\s*hidden/)
})
