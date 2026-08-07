/**
 * L-3 回归测试：SEARCH_INDEX 锚点与设置组件 data-search-anchor 的一致性。
 *
 * 背景：设置搜索的 90+ 个锚点是人工维护的（SEARCH_INDEX 条目 anchor + 各组件模板里的
 * data-search-anchor 属性）。组件重构删除/重命名锚点时，跳转会静默退化到节标题定位，
 * 用户察觉不到。本测试做源码级一致性校验：SEARCH_INDEX 中每个带 anchor 的条目，
 * 其目标选择器必须在某个设置组件中存在。
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const SETTINGS_DIR = path.resolve(process.cwd(), 'src/components/settings')

/** 读取 settings 目录下所有 .vue 文件内容（含 SettingsPanel.vue 本身） */
function readSettingsComponentSources(): { fileName: string; source: string }[] {
  const entries = readdirSync(SETTINGS_DIR).filter(line => line.endsWith('.vue'))
  return entries.map(fileName => ({
    fileName,
    source: readFileSync(path.join(SETTINGS_DIR, fileName), 'utf8')
  }))
}

describe('L-3: 设置搜索 SEARCH_INDEX 锚点一致性', () => {
  const sources = readSettingsComponentSources()

  it('SEARCH_INDEX 中每个带 anchor 的条目，目标锚点都存在（跨组件反重构漂移）', () => {
    const panelSource = sources.find(s => s.fileName === 'SettingsPanel.vue')?.source ?? ''
    // 从 SettingsPanel.vue 提取 SEARCH_INDEX 条目中所有 anchor 选择器
    // 形如：anchor: '[data-search-anchor="api-url"]'
    const indexedAnchors = Array.from(
      panelSource.matchAll(/anchor:\s*'\[data-search-anchor="([^"]+)"\]'/g),
      m => m[1]
    )
    expect(indexedAnchors.length).toBeGreaterThan(50)

    // 收集全部组件里出现的 data-search-anchor 值
    const allAnchors = new Set<string>()
    for (const { source } of sources) {
      for (const match of source.matchAll(/data-search-anchor="([^"]+)"/g)) {
        allAnchors.add(match[1])
      }
    }
    expect(allAnchors.size).toBeGreaterThan(50)

    const missing = indexedAnchors.filter(anchor => !allAnchors.has(anchor))
    expect(missing).toEqual([])
  })

  it('组件中每个 data-search-anchor 都有对应 SEARCH_INDEX 条目（反向防漏：新增锚点必须收录进搜索索引）', () => {
    const panelSource = sources.find(s => s.fileName === 'SettingsPanel.vue')?.source ?? ''
    const indexedAnchors = new Set(
      Array.from(
        panelSource.matchAll(/anchor:\s*'\[data-search-anchor="([^"]+)"\]'/g),
        m => m[1]
      )
    )

    const allAnchors: string[] = []
    for (const { source } of sources) {
      for (const match of source.matchAll(/data-search-anchor="([^"]+)"/g)) {
        allAnchors.push(match[1])
      }
    }

    const unindexed = [...new Set(allAnchors)].filter(anchor => !indexedAnchors.has(anchor))
    expect(unindexed).toEqual([])
  })

  it('锚点值不重复（同一选择器只应在索引中出现一次）', () => {
    const panelSource = sources.find(s => s.fileName === 'SettingsPanel.vue')?.source ?? ''
    const indexedAnchors = Array.from(
      panelSource.matchAll(/anchor:\s*'\[data-search-anchor="([^"]+)"\]'/g),
      m => m[1]
    )
    const seen = new Set<string>()
    const duplicates = indexedAnchors.filter(anchor => {
      if (seen.has(anchor)) return true
      seen.add(anchor)
      return false
    })
    expect(duplicates).toEqual([])
  })
})
