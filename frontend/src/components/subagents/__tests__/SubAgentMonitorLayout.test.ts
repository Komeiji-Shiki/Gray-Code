import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const monitor = readFileSync(resolve(__dirname, '../SubAgentMonitor.css'), 'utf8')
const theme = readFileSync(resolve(__dirname, '../../../platform/theme.css'), 'utf8')

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  expect(start, `找不到样式规则 ${selector}`).toBeGreaterThanOrEqual(0)
  return source.slice(start, source.indexOf('}', start) + 1)
}

// jsdom 不计算 Grid 轨道高度；保留布局约束守卫，实际裁切与滚动用 Chromium 验证。
describe('SubAgent Monitor 多运行列表布局', () => {
  test('桌面列表按卡片内容确定行高，超过上限时滚动而不是压缩文字', () => {
    const tabs = rule(theme, '.platform-host body .run-tabs')
    expect(tabs).toMatch(/grid-auto-rows:\s*max-content\s*;/)
    expect(tabs).toMatch(/align-content:\s*start\s*;/)
    expect(tabs).toMatch(/overflow:\s*auto\s*;/)
  })

  test('窄面板允许列宽小于常规卡片宽度，不制造横向溢出', () => {
    expect(rule(theme, '.platform-host body .run-tabs'))
      .toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(170px,\s*100%\),\s*1fr\)\)\s*;/)
  })

  test('列表与标题不参与纵向压缩，短窗口仍给消息区保留高度', () => {
    expect(rule(monitor, '.monitor-header')).toMatch(/flex-shrink:\s*0\s*;/)
    expect(rule(monitor, '.run-tabs')).toMatch(/flex:\s*0\s+0\s+auto\s*;/)
    expect(rule(monitor, '.run-tabs')).toMatch(/max-height:\s*min\(172px,\s*30vh\)\s*;/)
    expect(rule(theme, '.platform-host body .run-tabs')).toMatch(/max-height:\s*min\(180px,\s*30vh\)\s*;/)
    expect(rule(monitor, '.message-scroll')).toMatch(/min-height:\s*0\s*;/)
  })

  test('卡片两行标签不被 flex 压扁，长名称仍只做横向省略', () => {
    const labels = rule(monitor, '.run-name,\n.run-meta')
    expect(labels).toMatch(/flex-shrink:\s*0\s*;/)
    expect(labels).toMatch(/text-overflow:\s*ellipsis\s*;/)
    expect(labels).toMatch(/white-space:\s*nowrap\s*;/)
  })
})
