/**
 * get_activity_stats 工具注册
 *
 * 让 AI 查看用户的 IDE 使用时间统计，前端用可视化卡片展示
 * （总览 + 每日/每月条形图 + 24 小时作息热力图）。
 */

import { registerTool } from '../../toolRegistry'
import ActivityStatsResult from '../../../components/tools/activity/ActivityStatsResult.vue'

registerTool('get_activity_stats', {
  name: 'get_activity_stats',
  label: 'Activity Stats',
  icon: 'codicon-graph-line',

  descriptionFormatter: (args) => {
    const range = args?.range
    return range ? `Stats: ${range}` : 'Activity stats'
  },

  // 使用自定义组件显示内容
  contentComponent: ActivityStatsResult
})
