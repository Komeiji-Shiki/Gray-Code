import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const bar = readFileSync(path.resolve(process.cwd(), 'src/components/input/InputSelectorBar.vue'), 'utf8')
const area = readFileSync(path.resolve(process.cwd(), 'src/components/input/InputArea.vue'), 'utf8')
const tps = readFileSync(path.resolve(process.cwd(), 'src/components/input/TpsBar.vue'), 'utf8')

test('选择器排成一行紧凑胶囊，不再按整宽栅格分两排', () => {
  expect(bar).toMatch(/\.selector-bar\s*\{[^}]*display:\s*flex/)
  expect(bar).not.toMatch(/grid-template-columns/)
  expect(bar).toMatch(/:deep\(\.model-trigger\)\s*\{[^}]*width:\s*auto/)
})

test('输入区使用卡片底色与淡描边', () => {
  expect(area).toMatch(/\.input-area\s*\{[^}]*background:\s*var\(--gc-surface-raised\)[^}]*border:\s*1px solid var\(--gc-border-subtle\)/)
})

test('TPS 条空闲时隐藏但保留占位', () => {
  expect(tps).toMatch(/\.tps-bar\.is-idle\s*\{[^}]*visibility:\s*hidden/)
})
