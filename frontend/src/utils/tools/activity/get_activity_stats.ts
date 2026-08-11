/**
 * get_activity_stats 工具注册
 *
 * 让 AI 查看用户的 IDE 使用时间统计，前端用可视化卡片展示
 * （总览 + 每日/每月条形图 + 24 小时作息热力图）。
 */

import { registerTool } from '../../toolRegistry'
import { getToolDisplayName } from '../../toolLocalization'
import ActivityStatsResult from '../../../components/tools/activity/ActivityStatsResult.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

registerTool('get_activity_stats', {
  name: 'get_activity_stats',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('get_activity_stats'),
  icon: 'codicon-graph-line',

  descriptionFormatter: (args) => {
    const range = args?.range
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return range ? `Stats: ${range}` : getToolMetaDescription('get_activity_stats') ?? 'Activity stats'
  },

  // 使用自定义组件显示内容
  contentComponent: ActivityStatsResult
})
