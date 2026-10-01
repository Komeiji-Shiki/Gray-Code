import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import AppSource from '../../App.vue?raw'
import SettingsPanelSource from '../../components/settings/SettingsPanel.vue?raw'
import ToolItemSource from '../../components/message/toolMessage/ToolItem.vue?raw'
import ViteConfigSource from '../../../vite.config.ts?raw'
import { resolveWebviewAssetFileName } from '../../build/webviewAssetNaming'
import { resolveAppearancePalette } from '../../../../shared/appearance'
import { semanticTokens } from '../../../../shared/appearanceTokens'

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name)
    if (statSync(fullPath).isDirectory()) files.push(...collectTypeScriptFiles(fullPath))
    else if (name.endsWith('.ts')) files.push(fullPath)
  }
  return files
}

const repoRoot = path.resolve(process.cwd(), '..')
// 只有 token 定义与启动默认值文件可以出现 --vscode-*；其余组件只引用 --gc-*。
const TOKEN_SOURCES = new Set(['frontend/src/styles/tokens.css', 'frontend/src/platform/theme.css'].map(file => path.join(repoRoot, file)))
function collectSources(directory: string, extensions = ['.vue', '.css', '.ts']): string[] {
  const files: string[] = []
  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name)
    if (/__tests__|__generated__|node_modules|[\\/]i18n[\\/]langs/.test(fullPath)) continue
    if (statSync(fullPath).isDirectory()) files.push(...collectSources(fullPath, extensions))
    else if (extensions.some(extension => name.endsWith(extension)) && !/\.test\.ts$/.test(name)) files.push(fullPath)
  }
  return files
}
function offenders(roots: string[], pattern: RegExp, allow: Set<string>) {
  return roots.flatMap(root => collectSources(root)).filter(file => !allow.has(file))
    .flatMap(file => [...readFileSync(file, 'utf8').matchAll(pattern)].map(match => `${path.relative(repoRoot, file)}: ${match[0]}`))
}

describe('frontend visual and async architecture contracts', () => {
  test('聊天前端组件只引用 --gc-* 语义 token', () => {
    expect(offenders([path.resolve(process.cwd(), 'src')], /--vscode-[A-Za-z][\w-]*/g, TOKEN_SOURCES)).toEqual([])
  })

  test('外壳组件只引用 --gc-* 语义 token', () => {
    const shellRoot = path.join(repoRoot, 'apps/client/src')
    // 桌宠窗口是独立页面，在 floating.css 中自带一套变量；PetSurface.vue 同时挂在该页面。
    const petWindow = new Set(collectSources(path.join(shellRoot, 'pets')).concat(path.join(shellRoot, 'components/PetSurface.vue')))
    const legacy = /var\(\s*--(background|panel|surface|input|text|muted|disabled|accent|border|hover|selection|selection-text|button|button-hover|button-text|danger|error|success|warning|scrollbar|scrollbar-hover|code-font|ui-font|text-font|font-size|line-height)\s*[,)]/g
    expect(offenders([shellRoot], /--vscode-[A-Za-z][\w-]*/g, petWindow)).toEqual([])
    expect(offenders([shellRoot], legacy, petWindow)).toEqual([])
  })

  test('visual system defines semantic tokens, compatibility aliases and accessible primitives', () => {
    const stylesRoot = path.resolve(process.cwd(), 'src/styles')
    const tokensSource = readFileSync(path.join(stylesRoot, 'tokens.css'), 'utf8')
    const primitivesSource = readFileSync(path.join(stylesRoot, 'primitives.css'), 'utf8')
    for (const token of [
      '--gc-surface-base',
      '--gc-text-muted',
      '--gc-border-subtle',
      '--gc-focus-border',
      '--gc-layer-popover',
      '--gc-control-height-md',
      '--spacing-sm',
      '--radius-md'
    ]) {
      expect(tokensSource).toContain(token)
    }
    expect(tokensSource).toContain('@media (forced-colors: active)')
    expect(primitivesSource).toContain('.gc-button')
    expect(primitivesSource).toContain('.gc-visually-hidden')
    expect(primitivesSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(ToolItemSource).not.toMatch(/#555555|#777777/)
  })

  test('语义 token 覆盖全部角色，圆角不再全局置零', () => {
    const tokens = readFileSync(path.resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
    for (const token of ['--gc-surface-chrome', '--gc-surface-sunken', '--gc-surface-input', '--gc-surface-overlay',
      '--gc-button-primary', '--gc-button-secondary', '--gc-text-on-primary', '--gc-text-on-secondary',
      '--gc-danger-bg', '--gc-warning-border', '--gc-info-bg', '--gc-badge-bg', '--gc-code-bg', '--gc-quote-bg',
      '--gc-git-added', '--gc-chart-orange', '--gc-scrollbar', '--gc-font-code', '--gc-text-placeholder']) {
      expect(tokens).toContain(`${token}:`)
    }
    expect(tokens).toMatch(/--gc-radius-sm:\s*6px/)
    const theme = readFileSync(path.resolve(process.cwd(), 'src/platform/theme.css'), 'utf8')
    expect(theme).not.toMatch(/--gc-radius-(xs|sm|md|lg):\s*0/)
  })

  test('状态描边与不透明的控件描边混色，不随半透明分割线变淡', () => {
    const tokens = readFileSync(path.resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
    for (const role of ['success', 'warning', 'danger', 'info'])
      expect(tokens).toMatch(new RegExp(`--gc-${role}-border: color-mix\\(in srgb, var\\(--gc-${role}\\) 45%, var\\(--gc-border-control\\)\\);`))
  })
  test('两个文档的启动默认值与默认色板一致，避免加载设置前闪色', () => {
    const palette = resolveAppearancePalette('dark')
    const chat = readFileSync(path.resolve(process.cwd(), 'src/platform/theme.css'), 'utf8')
    const shell = readFileSync(path.resolve(process.cwd(), '../apps/client/src/styles/base.css'), 'utf8')
    // Web 登录与工作区加载页在读取设置前显示，启动默认值必须覆盖全部语义 token。
    for (const [key, tokens] of Object.entries(semanticTokens)) for (const token of tokens) {
      expect(chat).toContain(`${token}: ${palette[key]};`)
      expect(shell).toContain(`${token}: ${palette[key]};`)
    }
  })

  test('组件样式不写死色值，部件圆角不写死为 0', () => {
    // 色值只允许出现在 token 定义、两处启动默认值、第三方主题适配与独立的桌宠窗口中。
    const allowed = new Set([
      'frontend/src/styles/tokens.css', 'frontend/src/platform/theme.css', 'apps/client/src/styles/base.css',
      'apps/client/src/components/CodeEditor.vue', 'apps/client/src/pets/floating.css', 'apps/client/src/components/PetSurface.vue',
      'frontend/src/components/common/markdown/MermaidZoomModal.vue', 'frontend/src/components/settings/BackgroundGallery.vue',
    ].map(file => path.join(repoRoot, file)))
    const roots = [path.resolve(process.cwd(), 'src'), path.join(repoRoot, 'apps/client/src')]
    const hex = /(?<![\w&-])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b(?=[\s;,)!}'"])/g
    // .ts 中的十六进制多为画布绘制或第三方主题参数，只检查样式文件。
    expect(offenders(roots, hex, allowed).filter(line => !/\.ts: /.test(line))).toEqual([])
    const zeroRadius = /\.(gc-button|gc-field|gc-badge|tool-item|permission-options button|approval-buttons button)[^{]*\{[^}]*border-radius:\s*0[;}]/g
    expect(offenders(roots, zeroRadius, new Set())).toEqual([])
  })

  test('通用控件：主按钮用主按钮配色、次要按钮用次要底、滑块圆角', () => {
    const primitives = readFileSync(path.resolve(process.cwd(), 'src/styles/primitives.css'), 'utf8')
    expect(primitives).toMatch(/\.gc-button--primary\)\s*\{[^}]*var\(--gc-button-primary\)/)
    expect(primitives).toMatch(/\.gc-button\)\s*\{[^}]*var\(--gc-button-secondary\)/)
    expect(primitives).toContain('.gc-menu-item')
    const scrollbar = readFileSync(path.resolve(process.cwd(), 'src/components/common/CustomScrollbar.css'), 'utf8')
    expect(scrollbar).toMatch(/\.scroll-thumb-v\s*\{[^}]*border-radius:\s*var\(--gc-radius-pill\)/)
    const shell = readFileSync(path.join(repoRoot, 'apps/client/src/styles/base.css'), 'utf8')
    expect(shell).toMatch(/\nbutton\s*\{[^}]*border:\s*1px solid transparent/)
  })

  test('外壳结构使用外壳色，选中项为浅底加左侧强调条', () => {
    const sidebar = readFileSync(path.join(repoRoot, 'apps/client/src/components/navigation/conversationSidebar.css'), 'utf8')
    expect(sidebar).toMatch(/\.conversation-sidebar\{[^}]*background:var\(--gc-surface-chrome\)/)
    expect(sidebar).toMatch(/\.navigation-draft\.active\{[^}]*background:var\(--gc-surface-chrome-hover\)/)
    expect(sidebar).toMatch(/\.navigation-draft\.active::before[^}]*width:2px;[^}]*border-radius:0;[^}]*background:var\(--gc-accent\)/)
    const tabs = readFileSync(path.resolve(process.cwd(), 'src/components/tabs/ConversationTabs.vue'), 'utf8')
    expect(tabs).toMatch(/\.tab-item\.active\s*\{[^}]*background:\s*var\(--gc-surface-base\)/)
    const base = readFileSync(path.join(repoRoot, 'apps/client/src/styles/base.css'), 'utf8')
    expect(base).toMatch(/\n\.titlebar \{[^}]*background: var\(--gc-surface-chrome\)/)
    // 紧凑密度必须改写外壳实际读取的字号 token。
    expect(base).toMatch(/\.application\[data-density="compact"\] \{\s*--gc-font-size-ui: 12px;/)
  })

  test('Vite keeps the Webview entry stylesheet stable without collapsing lazy chunk CSS names', () => {
    expect(ViteConfigSource).toContain('assetFileNames: resolveWebviewAssetFileName')
    expect(resolveWebviewAssetFileName({ name: 'index.css' })).toBe('index.css')
    expect(resolveWebviewAssetFileName({ names: ['index.css'] })).toBe('index.css')
    expect(resolveWebviewAssetFileName({ name: 'MessageList.css' })).toBe('assets/[name]-[hash][extname]')
    expect(resolveWebviewAssetFileName({ names: ['SettingsPanel.css'] })).toBe('assets/[name]-[hash][extname]')
    expect(resolveWebviewAssetFileName({ name: 'file-icons.woff2' })).toBe('assets/[name][extname]')
  })

  test('App and SettingsPanel keep heavy views behind dynamic import boundaries', () => {
    for (const component of ['MessageList', 'SubAgentMonitor', 'HistoryPage', 'UsagePage', 'SettingsPanel']) {
      expect(AppSource).toMatch(new RegExp(`const ${component} = defineAsyncComponent\\(\\(\\) => import\\(`))
    }
    expect(AppSource).not.toMatch(/import\s+SubAgentMonitor\s+from/)
    expect(AppSource).not.toMatch(/import\s+\{\s*MessageList\s*\}/)

    for (const component of [
      'ChannelSettings',
      'ToolsSettings',
      'McpSettings',
      'PromptSettings',
      'SubAgentsSettings',
      'AppearanceSettings',
      'UsageTimeSection'
    ]) {
      expect(SettingsPanelSource).toMatch(new RegExp(`const ${component} = defineAsyncComponent\\(\\(\\) => import\\(`))
    }
  })

  test('tool registration metadata stays synchronous while every detail SFC is lazy', () => {
    const toolsRoot = path.resolve(process.cwd(), 'src/utils/tools')
    const sources = collectTypeScriptFiles(toolsRoot).map(file => readFileSync(file, 'utf8'))
    const combined = sources.join('\n')

    expect(combined).not.toMatch(/import\s+\w+\s+from\s+['"][^'"]*components\/tools\/[^'"]+\.vue['"]/) 
    expect((combined.match(/lazyToolComponent\(\(\) => import\(/g) || []).length).toBeGreaterThanOrEqual(30)
  })
})
