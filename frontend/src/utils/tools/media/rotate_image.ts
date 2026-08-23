/**
 * rotate_image 工具 - 前端注册
 *
 * 旋转图片工具的显示配置
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'
import { t } from '../../../i18n'

const RotateImagePanel = lazyToolComponent(() => import('../../../components/tools/media/rotate_image.vue'))

/**
 * 单个任务类型
 */
interface RotateTask {
  image_path: string
  output_path: string
  angle: number
  format?: string
}

registerTool('rotate_image', {
  name: 'rotate_image',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('rotate_image'),
  icon: 'codicon-sync',
  expandable: true,
  contentComponent: RotateImagePanel,
  descriptionFormatter: (args) => {
    const images = args.images as RotateTask[] | undefined
    const imagePath = args.image_path as string | undefined
    const angle = args.angle as number | undefined
    
    // 批量模式
    if (images && Array.isArray(images) && images.length > 0) {
      if (images.length === 1) {
        const task = images[0]
        const shortInput = task.image_path.length > 20 ? '...' + task.image_path.slice(-20) : task.image_path
        return `${shortInput} → ${task.angle}°`
      }
      // 多任务显示
      return t('utils.tools.batchRotateCount', { count: images.length })
    }
    
    // 单张模式
    if (imagePath && angle !== undefined) {
      const shortInput = imagePath.length > 20 ? '...' + imagePath.slice(-20) : imagePath
      return `${shortInput} → ${angle}°`
    }
    
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化显示名
    return getToolMetaDescription('rotate_image') ?? getToolDisplayName('rotate_image')
  }
})