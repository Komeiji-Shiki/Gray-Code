import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const repoRoot = path.resolve(process.cwd(), '..')
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8')

/** 找出选择器以 subject 结尾的规则里声明的单边分割线。 */
function sideBorders(source: string, subject: string): string[] {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const selector = new RegExp(`(^|[\\s,}>])${escaped}$`)
  const found: string[] = []
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(part => part.trim())
    if (!selectors.some(part => selector.test(part))) continue
    found.push(...match[2].split(';').map(part => part.trim()).filter(part => /^border-(top|bottom|left|right)\s*:/.test(part)))
  }
  return found
}

describe('结构分割线', () => {
  // 外壳色与内容底色本身有明暗差，标题、工具条与内容之间靠留白分隔，不再画线。
  test.each([
    ['apps/client/src/styles/base.css', '.titlebar'],
    ['apps/client/src/styles/base.css', '.statusbar'],
    ['apps/client/src/styles/base.css', '.panel-heading'],
    ['apps/client/src/styles/workbench.css', '.diff-toolbar'],
    ['apps/client/src/components/navigation/conversationSidebar.css', '.conversation-sidebar'],
    ['apps/client/src/components/navigation/conversationSidebar.css', '.navigation-search'],
    ['apps/client/src/components/navigation/conversationSidebar.css', '.navigation-bottom'],
    ['apps/client/src/components/RunInspector.vue', '.run-status-strip'],
    ['apps/client/src/components/WorkbenchTabs.vue', '.workbench-tabbar'],
    ['apps/client/src/components/Workbench.vue', '.file-toolbar'],
    ['apps/client/src/components/CodeEditor.vue', '.editor-status'],
    ['apps/client/src/components/GitPanel.vue', '.git-heading'],
    ['apps/client/src/components/SearchPanel.vue', '.search-form'],
    ['apps/client/src/components/SearchPanel.vue', 'header'],
    ['apps/client/src/components/OutlinePanel.vue', 'header'],
    ['frontend/src/App.vue', '.conversation-heading'],
    ['frontend/src/components/settings/SettingsPanel.vue', '.settings-header'],
    ['frontend/src/components/settings/PlatformSettingsFooter.vue', '.platform-settings-footer'],
    ['frontend/src/components/settings/panel/SettingsSidebar.vue', '.settings-sidebar'],
  ])('%s %s 不画分割线', (file, subject) => {
    expect(sideBorders(read(file), subject)).toEqual([])
  })
})
