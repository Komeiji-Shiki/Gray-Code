import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import AppSource from '../../App.vue?raw'
import SettingsPanelSource from '../../components/settings/SettingsPanel.vue?raw'
import ToolItemSource from '../../components/message/toolMessage/ToolItem.vue?raw'
import ViteConfigSource from '../../../vite.config.ts?raw'
import { resolveWebviewAssetFileName } from '../../build/webviewAssetNaming'

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(directory)) {
    const fullPath = path.join(directory, name)
    if (statSync(fullPath).isDirectory()) files.push(...collectTypeScriptFiles(fullPath))
    else if (name.endsWith('.ts')) files.push(fullPath)
  }
  return files
}

describe('frontend visual and async architecture contracts', () => {
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
