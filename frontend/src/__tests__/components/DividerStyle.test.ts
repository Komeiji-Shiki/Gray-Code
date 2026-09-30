import { readdirSync, readFileSync } from 'node:fs'
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

  // 设置页各节之间、表单行之间有标题与间距，不再画线；数据表格的行线保留（已随分割线 token 变淡）。
  test.each([
    ['ChannelSettings.css', '.config-form'], ['ClawdSettings.vue', '.clawd-settings'],
    ['DebugAdapterSettings.vue', '.debug-adapter-settings'], ['DebugAdapterSettings.vue', '.debug-service-list'],
    ['DependencySettings.vue', '.panel-content'], ['TokenCountSettings.vue', '.panel-content'],
    ['DesktopEditorSettings.vue', '.editor-registration'], ['ExternalAgentSettings.vue', '.external-agents'],
    ['discord/BotConversationFields.vue', '.bot-conversation-fields'], ['discord/discordSettings.css', '.discord-note'],
    ['ModelManager.vue', '.filter-input-container'], ['panel/DesktopUpdateSettings.vue', '.update-overview'],
    ['panel/UsageSummaryCard.vue', '.usage-summary-footer'], ['PlatformAppearanceSettings.vue', '.appearance-row'],
    ['PlatformDevelopmentSettings.vue', '.service-list'], ['PlatformDevelopmentSettings.vue', '.service-row'],
    ['PlatformIntegrationSettings.vue', '.integration-entry'], ['PlatformMigrationSettings.vue', '.migration-settings'],
    ['PlatformModeSettings.vue', '.mode-settings'], ['PlatformModeSettings.vue', '.mode-profile'],
    ['PlatformRemoteSettings.vue', '.remote-status'], ['PlatformRemoteSettings.vue', '.remote-field'],
    ['PlatformReviewSettings.vue', '.review-settings'], ['PlatformWorkspaceSettings.vue', '.workspace-entry'],
    ['prompt/ModulesReference.vue', '.modules-reference'], ['prompt/ToolPolicySection.vue', '.tool-item'],
    ['subAgentsSettings/SubAgentGlobalConfigSection.vue', '.global-config'],
    ['subAgentsSettings/SubAgentToolsSection.vue', '.category-header'],
  ])('设置 %s %s 不画分割线', (file, subject) => {
    expect(sideBorders(read(path.join('frontend/src/components/settings', file)), subject)).toEqual([])
  })
})

describe('控件描边', () => {
  // 分割线 token 几乎透明；输入框、下拉与按钮落在填充卡片上时要靠不透明的控件描边保持轮廓。
  test('输入框、下拉、文本框与按钮不使用分割线 token 描边', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (!/__tests__|dist|node_modules|pets/.test(entry.name)) walk(full) }
        else if (/\.(vue|css)$/.test(entry.name)) files.push(full)
      }
    }
    walk(path.join(repoRoot, 'frontend/src')); walk(path.join(repoRoot, 'apps/client/src'))
    const control = /(^|[\s>+~,])(input|select|textarea|button)(\[[^\]]*\])?$|\.[\w-]*(input|select|textarea|field|btn|button|trigger)(?<!fields)$/i
    const offenders: string[] = []
    for (const file of files) for (const match of readFileSync(file, 'utf8').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1].split(',').map(part => part.trim().replace(/::?[\w-]+(\([^)]*\))?/g, ''))
      if (selectors.every(part => control.test(part)) && /border(-color)?\s*:\s*(1px solid )?var\(--gc-border-subtle\)/.test(match[2]))
        offenders.push(`${path.relative(repoRoot, file)}: ${match[1].trim().split('\n').pop()}`)
    }
    expect(offenders).toEqual([])
  })
})