/**
 * SettingsPanel 拆分（T12 批次，纯重构，行为零变化）共享类型。
 *
 * SettingsPanel.vue 与拆出的 panel/ 子组件共用这些接口；独立 .ts 模块
 * （非 .vue 具名导出），供 .ts / .vue 双向安全引用。
 */
import type { SettingsTab } from '@/stores/settingsStore'

export interface TabItem {
  id: SettingsTab
  label: string
  icon: string
}

export interface SearchIndexEntry {
  /** 稳定唯一键（结果列表 key） */
  key: string
  /** 目标页签 */
  tab: SettingsTab
  /** 结果行显示标签（i18n key） */
  labelKey: string
  /** 搜索关键词（中/英/日混合，小写包含匹配） */
  keywords: string[]
  /** 目标元素选择器（相对 .settings-section）；缺省定位到节标题 h4 */
  anchor?: string
}
