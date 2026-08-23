/**
 * remove_background 工具 - 前端注册
 *
 * 抠图工具的显示配置
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'
import { t } from '../../../i18n'

const RemoveBackgroundPanel = lazyToolComponent(() => import('../../../components/tools/media/remove_background.vue'))

/**
 * 单个任务类型
 */
interface RemoveTask {
  image_path: string
  output_path: string
  subject_description?: string
  mask_path?: string
}

registerTool('remove_background', {
  name: 'remove_background',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('remove_background'),
  icon: 'codicon-wand',
  expandable: true,
  contentComponent: RemoveBackgroundPanel,
  descriptionFormatter: (args) => {
    const images = args.images as RemoveTask[] | undefined
    const imagePath = args.image_path as string | undefined
    const outputPath = args.output_path as string | undefined
    
    // 批量模式
    if (images && Array.isArray(images) && images.length > 0) {
      if (images.length === 1) {
        const task = images[0]
        const shortInput = task.image_path.length > 20 ? '...' + task.image_path.slice(-20) : task.image_path
        return `${shortInput} → ${task.output_path}`
      }
      // 多任务显示
      return t('utils.tools.batchRemoveBackgroundCount', { count: images.length })
    }
    
    // 单张模式
    if (imagePath && outputPath) {
      const shortInput = imagePath.length > 25 ? '...' + imagePath.slice(-25) : imagePath
      const shortOutput = outputPath.length > 25 ? '...' + outputPath.slice(-25) : outputPath
      return `${shortInput} → ${shortOutput}`
    }
    
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化显示名
    return getToolMetaDescription('remove_background') ?? getToolDisplayName('remove_background')
  }
})