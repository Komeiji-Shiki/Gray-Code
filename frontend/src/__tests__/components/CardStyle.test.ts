import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const settings = path.resolve(process.cwd(), 'src/components/settings')
const read = (file: string) => readFileSync(path.join(settings, file), 'utf8')
const readFrom = (file: string) => readFileSync(path.resolve(process.cwd(), '..', file), 'utf8')

/** 选择器列表中恰好含 subject（不带伪类或组合）的规则正文。 */
function baseRules(source: string, subject: string): string[] {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const selector = new RegExp(`(^|[\\s,}>])${escaped}$`)
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').map(part => part.trim()).some(part => selector.test(part)))
    .map(match => match[2])
}

// 设置页的列表项与分组用填充面板区分，不再逐个描边；描边留透明，悬停、选中与警告态仍可上色。
const cards: Array<[string, string]> = [
  ['AutoExecSettings.vue', '.settings-intro'], ['AutoExecSettings.vue', '.category-header'], ['AutoExecSettings.vue', '.tool-item'],
  ['checkpoint/CheckpointCleanupPanel.vue', '.conversations-list-wrapper'],
  ['checkpoint/CheckpointMessageSettings.vue', '.tools-table'], ['checkpoint/CheckpointToolSettings.vue', '.tools-table'],
  ['ContextSettings.vue', '.setting-block'], ['ContextSettings.vue', '.preview-block'],
  ['DependencySettings.vue', '.tool-panel'], ['GenerateImageSettings.vue', '.section'],
  ['memorySettings/MemoryConfigSection.vue', '.section'], ['ModelManager.vue', '.model-list-container'],
  ['panel/GeneralSettingsSection.vue', '.info-text'], ['panel/GeneralSettingsSection.vue', '.proxy-settings'],
  ['panel/GeneralSettingsSection.vue', '.storage-settings'], ['panel/UsageSummaryCard.vue', '.usage-summary-card'],
  ['PlatformAppearanceSettings.vue', '.unified-preview'], ['PlatformIntegrationSettings.vue', '.bot-access-settings'],
  ['PlatformWorkspaceSettings.vue', '.workspace-root'], ['prompt/ModeSelectorBar.vue', '.mode-selector-bar'],
  ['prompt/TokenCountSection.vue', '.token-count-section'], ['PromptEntriesEditor.vue', '.entry-card'],
  ['PromptSettings.css', '.template-section'], ['SoundSettings.vue', '.panel-overview'], ['SoundSettings.vue', '.settings-area'],
  ['subAgentsSettings/SubAgentToolsSection.vue', '.tool-item'], ['SubAgentsSettings.vue', '.no-agents'],
  ['SummarizeSettings.vue', '.section'], ['TokenCountSettings.vue', '.settings-intro'], ['TokenCountSettings.vue', '.channel-panel'],
  ['ToolsSettings.vue', '.global-config'], ['ToolsSettings.vue', '.category-header'], ['ToolsSettings.vue', '.tool-item'],
]

describe('设置页卡片', () => {
  test.each(cards)('%s %s 是填充卡片', (file, subject) => {
    const body = baseRules(read(file), subject).join(';')
    expect(body).toMatch(/border:\s*1px solid transparent/)
    expect(body).toMatch(/background:\s*var\(--gc-surface-raised\)/)
    expect(body).toMatch(/border-radius:\s*var\(--gc-radius-lg\)/)
    expect(body).not.toMatch(/border:\s*1px solid var\(--gc-border-(subtle|control)\)/)
  })

  test.each([['AppearanceSettings.vue', '.form-group'], ['SoundSettings.vue', '.form-group']])('%s %s 只靠留白分组', (file, subject) => {
    const body = baseRules(read(file), subject).join(';')
    expect(body).not.toMatch(/border:\s*1px solid var\(--gc-border/)
    expect(body).not.toMatch(/background:\s*var\(--gc-surface/)
  })

  test.each([['PromptEntriesEditor.vue', '.chat-history-note'], ['SoundSettings.vue', '.asset-row']])('%s %s 嵌在卡片里用浅填充', (file, subject) => {
    const body = baseRules(read(file), subject).join(';')
    expect(body).not.toMatch(/border:\s*1px solid var\(--gc-border/)
    expect(body).toMatch(/background:\s*var\(--gc-surface-muted\)/)
  })

  test.each([
    ['PlatformDevelopmentSettings.vue', '.service-list', '.service-row'],
    ['DebugAdapterSettings.vue', '.debug-service-list', '.debug-service-list article'],
  ])('%s 服务网格用间距与填充格子代替网格线', (file, list, cell) => {
    const source = read(file)
    expect(baseRules(source, list).join(';')).toMatch(/gap:\s*6px/)
    const body = baseRules(source, cell).join(';')
    expect(body).toMatch(/background:\s*var\(--gc-surface-raised\)/)
    expect(body).toMatch(/border-radius:\s*var\(--gc-radius-lg\)/)
  })
  test('提示词条目分组本身不再是卡片，条目卡片直接排列', () => {
    expect(read('PromptSettings.css')).toMatch(/\.template-section\.entries-section\s*\{[^}]*background:\s*transparent/)
  })
})

describe('设置页其余容器、提示框与状态胶囊', () => {
  test.each([
    ['mcpSettings/McpBrowsePanel.vue', '.mcp-browse-panel'], ['NotificationQuietHours.vue', '.notification-quiet-hours'],
    ['PromptEntriesEditor.vue', '.character-entry-tools'], ['memorySettings/MemoryEntriesSection.vue', '.section'],
    ['../usage/UsageTimeSection.vue', '.usage-time-section'],
  ])('%s %s 是填充卡片', (file, subject) => {
    const body = baseRules(read(file), subject).join(';')
    expect(body).toMatch(/background:\s*var\(--gc-surface-raised\)/)
    expect(body).toMatch(/border-radius:\s*var\(--gc-radius-lg\)/)
    expect(body).not.toMatch(/border:\s*1px solid var\(--gc-border-(subtle|control)\)/)
  })

  // 说明类提示框用强调色淡底区分，不再画左侧色条与描边。
  test.each([
    ['AutoExecSettings.vue', '.settings-tips'], ['ContextSettings.vue', '.pattern-help'],
    ['GenerateImageSettings.vue', '.feature-description'], ['SummarizeSettings.vue', '.feature-description'],
    ['MemorySettings.vue', '.info-box'], ['panel/WorkspaceFeatureLinks.vue', '.workspace-feature-links'],
    ['discord/discordSettings.css', '.discord-notice'],
  ])('%s %s 是淡底提示框', (file, subject) => {
    const body = baseRules(read(file), subject).join(';')
    expect(body).toMatch(/background:\s*var\(--gc-info-bg\)/)
    expect(body).toMatch(/border-radius:\s*var\(--gc-radius-lg\)/)
    expect(body).not.toMatch(/border(-left)?:\s*\d+px solid var\(--gc-(link|quote-border|border-subtle|focus-border|info-border)\)/)
  })

  test.each([
    ['discord/discordSettings.css', '.discord-status'], ['PlatformIntegrationSettings.vue', '.integration-status'],
  ])('%s %s 是圆角状态胶囊', (file, subject) => {
    expect(baseRules(read(file), subject).join(';')).toMatch(/border-radius:\s*var\(--gc-radius-pill\)/)
  })

  test('更新页标识与展开的计数渠道不再是直角或强调色描边', () => {
    expect(baseRules(read('panel/DesktopUpdateSettings.vue'), '.product-mark').join(';')).toMatch(/border-radius:\s*var\(--gc-radius-md\)/)
    expect(read('TokenCountSettings.vue')).not.toMatch(/\.channel-panel\.expanded\s*\{[^}]*border-color:\s*var\(--gc-focus-border\)/)
  })

  test.each([
    'CheckpointSettings.vue', 'ContextSettings.vue', 'panel/GeneralSettingsSection.vue', 'BranchCleanupSettings.vue',
  ])('%s 的 .divider 只留间距', file => {
    const body = baseRules(read(file), '.divider').join(';')
    expect(body).not.toMatch(/background:\s*var\(--gc-(border|surface)/)
  })

  test('工作台添加面板菜单是圆角浮层', () => {
    const body = baseRules(readFrom('apps/client/src/components/WorkbenchTabs.vue'), '.workbench-add-menu').join(';')
    expect(body).toMatch(/border-radius:\s*var\(--gc-radius-lg\)/)
  })
})