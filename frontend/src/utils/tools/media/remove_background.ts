/**
 * remove_background 工具 - 前端注册
 *
 * 抠图工具的显示配置
 */

import { registerTool } from '../../toolRegistry'
import RemoveBackgroundPanel from '../../../components/tools/media/remove_background.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

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
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '抠图',
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
      return `批量抠图 ${images.length} 张`
    }
    
    // 单张模式
    if (imagePath && outputPath) {
      const shortInput = imagePath.length > 25 ? '...' + imagePath.slice(-25) : imagePath
      const shortOutput = outputPath.length > 25 ? '...' + outputPath.slice(-25) : outputPath
      return `${shortInput} → ${shortOutput}`
    }
    
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return getToolMetaDescription('remove_background') ?? '移除图片背景'
  }
})