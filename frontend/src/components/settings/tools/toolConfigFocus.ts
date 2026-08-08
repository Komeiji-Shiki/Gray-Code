/**
 * 工具配置面板展开信号（设置搜索联动）
 *
 * 设置搜索索引里的锚点可能位于未展开的工具配置面板内（如 apply_diff 的
 * 「自动应用」区块）。SettingsPanel 跳转前把目标工具名写入该信号，
 * ToolsSettings 挂载/存活时据此自动展开对应配置面板，让锚点真实出现在 DOM 中。
 */
import { ref } from 'vue'

/** 请求展开的工具名；ToolsSettings 消费后置回 null */
export const pendingToolConfigExpand = ref<string | null>(null)
