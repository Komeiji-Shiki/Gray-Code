/**
 * resize_image 工具 - 前端注册
 *
 * 缩放图片工具的显示配置
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'
import { t } from '../../../i18n'

const ResizeImagePanel = lazyToolComponent(() => import('../../../components/tools/media/resize_image.vue'))

/**
 * 单个任务类型
 */
interface ResizeTask {
  image_path: string
  output_path: string
  width: number
  height: number
}

registerTool('resize_image', {
  name: 'resize_image',
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('resize_image'),
  icon: 'codicon-arrow-both',
  expandable: true,
  contentComponent: ResizeImagePanel,
  descriptionFormatter: (args) => {
    const images = args.images as ResizeTask[] | undefined
    const imagePath = args.image_path as string | undefined
    const width = args.width as number | undefined
    const height = args.height as number | undefined
    
    // 批量模式
    if (images && Array.isArray(images) && images.length > 0) {
      if (images.length === 1) {
        const task = images[0]
        const shortInput = task.image_path.length > 20 ? '...' + task.image_path.slice(-20) : task.image_path
        return `${shortInput} → ${task.width}x${task.height}`
      }
      // 多任务显示
      return t('utils.tools.batchResizeCount', { count: images.length })
    }
    
    // 单张模式
    if (imagePath && width !== undefined && height !== undefined) {
      const shortInput = imagePath.length > 20 ? '...' + imagePath.slice(-20) : imagePath
      return `${shortInput} → ${width}x${height}`
    }
    
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化显示名
    return getToolMetaDescription('resize_image') ?? getToolDisplayName('resize_image')
  }
})