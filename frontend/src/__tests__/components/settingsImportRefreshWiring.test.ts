/**
 * 设置导入后的刷新接线契约
 *
 * 背景：导入渠道/MCP/设置写入的是后端数据，webview 侧视图是挂载时拉取的快照，
 * 缺任何一处订阅或缓存失效，用户就得重启插件才能看到刚导入的配置。
 *
 * 这里锁两件事：
 * 1. 接线完整性——后端三条刷新命令各自的消费方都在（App.vue 全局失效渠道缓存 +
 *    渠道页/MCP 页/设置面板订阅）。App.vue 无法在单测里整体挂载（依赖全部 store 与
 *    异步页面），沿用项目既有的 ?raw 源码断言风格（见 FrontendSystem.test.ts）。
 * 2. 失效机制本身——缓存被置 null 后 preloadChannelConfigs 必须真的重新发请求，
 *    否则第 1 条里的全局失效只是空转。
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import AppSource from '../../App.vue?raw'
import ChannelSettingsSource from '../../components/settings/ChannelSettings.vue?raw'
import McpSettingsSource from '../../components/settings/McpSettings.vue?raw'
import SettingsPanelSource from '../../components/settings/SettingsPanel.vue?raw'

vi.mock('@/services/config', () => ({
  listConfigIds: vi.fn(),
  getConfig: vi.fn()
}))

import { listConfigIds, getConfig } from '@/services/config'
import {
  preloadChannelConfigs,
  getChannelConfigsCache,
  setChannelConfigsCache,
  resetChannelConfigsCache
} from '@/services/channelConfigCache'

const mockListConfigIds = listConfigIds as unknown as ReturnType<typeof vi.fn>
const mockGetConfig = getConfig as unknown as ReturnType<typeof vi.fn>

describe('设置导入刷新命令的前端接线', () => {
  test('App.vue 常驻处理 channels.configChanged 批量变更并失效渠道预加载缓存', () => {
    // 渠道设置页此刻可能未挂载（用户在其它页签）：必须由常驻根组件失效模块级缓存
    expect(AppSource).toContain("PUSH_MESSAGE_NAMES['channels.configChanged']")
    expect(AppSource).toMatch(/if\s*\(!message\.data\?\.configId\)\s*\{\s*setChannelConfigsCache\(null\)/)
  })

  test('渠道设置页订阅 channels.configChanged 并重拉列表', () => {
    expect(ChannelSettingsSource).toMatch(
      /onExtensionCommand\(\s*PUSH_MESSAGE_NAMES\['channels\.configChanged'\]/
    )
    expect(ChannelSettingsSource).toContain('async function reloadFromExternalChange')
    // 自身单次编辑（带 configId）已就地刷新，不得重复跑全量请求
    expect(ChannelSettingsSource).toContain('if (data?.configId) return')
  })

  test('MCP 设置页订阅 mcp.configChanged 并重拉服务器列表', () => {
    expect(McpSettingsSource).toContain("PUSH_MESSAGE_NAMES['mcp.configChanged']")
    expect(McpSettingsSource).toMatch(
      /onExtensionCommand\(PUSH_MESSAGE_NAMES\['mcp\.configChanged'\], \(\) => \{\s*void loadServers\(\)/
    )
  })

  test('设置面板订阅 settings.imported 并重新加载设置值', () => {
    expect(SettingsPanelSource).toContain("PUSH_MESSAGE_NAMES['settings.imported']")
    expect(SettingsPanelSource).toMatch(
      /onExtensionCommand\(PUSH_MESSAGE_NAMES\['settings\.imported'\], \(\) => \{\s*void loadSettings\(\)/
    )
  })

  test('三处订阅均在卸载时取消（不残留全局推送监听）', () => {
    for (const source of [ChannelSettingsSource, McpSettingsSource, SettingsPanelSource]) {
      expect(source).toContain('onUnmounted(')
    }
    expect(ChannelSettingsSource).toContain('unsubscribeConfigChanged()')
    expect(McpSettingsSource).toContain('unsubscribeMcpChanged()')
    expect(SettingsPanelSource).toContain('unsubscribeSettingsImported()')
  })
})

describe('渠道预加载缓存的失效语义（刷新接线的依赖机制）', () => {
  beforeEach(() => {
    resetChannelConfigsCache()
    vi.resetAllMocks()
    mockListConfigIds.mockResolvedValue(['cfg-1'])
    mockGetConfig.mockImplementation((id: string) => Promise.resolve({ id, name: id }))
  })

  test('缓存失效后再次 preload 会重新发请求，不复用陈旧列表', async () => {
    await preloadChannelConfigs()
    expect(getChannelConfigsCache()?.map(c => c.id)).toEqual(['cfg-1'])
    expect(mockListConfigIds).toHaveBeenCalledTimes(1)

    // 缓存命中时不发请求
    await preloadChannelConfigs()
    expect(mockListConfigIds).toHaveBeenCalledTimes(1)

    // 导入完成 → 全局失效 → 下次进入渠道页必须读到新数据
    setChannelConfigsCache(null)
    mockListConfigIds.mockResolvedValue(['cfg-1', 'cfg-imported'])
    await preloadChannelConfigs()

    expect(mockListConfigIds).toHaveBeenCalledTimes(2)
    expect(getChannelConfigsCache()?.map(c => c.id)).toEqual(['cfg-1', 'cfg-imported'])
  })
})
