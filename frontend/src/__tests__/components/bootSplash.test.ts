/**
 * bootSplash 一致性测试：首帧静态启动画面（electron-app/renderer/boot-splash.html，
 * 由 patch-dist.mjs 注入 index.html）与 Splash.vue 是双份维护的同一套动画——
 * 路径数据（d=）、SMIL 时长、CSS 时间轴常量、文案必须严格一致，
 * 否则「boot 播放 → Vue 负延迟续播」的无缝接管会出现跳变。
 *
 * 覆盖：
 * - 两处 SVG 路径 d= 完全一致（fills + draw 路径）
 * - SMIL dur（笔尖光点）一致
 * - Splash.vue 全部动画时长/延迟常量都在 boot 样式中存在（负延迟接管前提）
 * - 标题/副标题文案一致
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const repoRoot = path.resolve(process.cwd(), '..')
const bootHtmlPath = path.join(repoRoot, 'electron-app', 'renderer', 'boot-splash.html')
const splashVuePath = path.join(process.cwd(), 'src', 'components', 'Splash.vue')

const bootHtml = fs.readFileSync(bootHtmlPath, 'utf-8')
const splashVue = fs.readFileSync(splashVuePath, 'utf-8')

function extractDValues(content: string): string[] {
  return [...content.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1])
}

function extractDurValues(content: string): string[] {
  return [...content.matchAll(/\bdur="([^"]+)"/g)].map((m) => m[1])
}

/** 只取 <style> 块内的 CSS 时间 token（排除注释/文案里的数字，避免误报） */
function extractStyleBlocks(content: string): string {
  return [...content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function extractCssTimeTokens(content: string): Set<string> {
  return new Set([...content.matchAll(/\b\d+(?:\.\d+)?s\b/g)].map((m) => m[0]))
}

describe('bootSplash 与 Splash.vue 一致性', () => {
  it('SVG 路径数据（d=）完全一致', () => {
    const bootD = extractDValues(bootHtml).sort()
    const vueD = extractDValues(splashVue).sort()
    expect(bootD).toEqual(vueD)
  })

  it('SMIL 笔尖光点时长（dur）一致', () => {
    expect(extractDurValues(bootHtml).sort()).toEqual(extractDurValues(splashVue).sort())
  })

  it('Splash.vue 的全部动画时间常量都存在于 boot 样式（负延迟接管前提）', () => {
    const bootTokens = extractCssTimeTokens(extractStyleBlocks(bootHtml))
    const vueTokens = extractCssTimeTokens(extractStyleBlocks(splashVue))
    expect(vueTokens.size).toBeGreaterThan(0)
    for (const token of vueTokens) {
      expect(bootTokens.has(token), `boot-splash.html 缺少时间常量 ${token}`).toBe(true)
    }
  })

  it('标题与副标题文案一致', () => {
    const bootText = bootHtml.replace(/<style>[\s\S]*?<\/style>/g, '')
    const vueText = splashVue
    for (const text of ['Gray', 'Code', 'AI', 'CODING', 'ASSISTANT']) {
      expect(bootText.includes(text)).toBe(true)
      expect(vueText.includes(text)).toBe(true)
    }
  })
})
