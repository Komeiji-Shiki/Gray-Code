/**
 * resize_image 工具 - 前端注册
 *
 * 缩放图片工具的显示配置
 */

import { registerTool } from '../../toolRegistry'
import ResizeImagePanel from '../../../components/tools/media/resize_image.vue'

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
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '缩放图片',
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
      return `批量缩放 ${images.length} 张`
    }
    
    // 单张模式
    if (imagePath && width !== undefined && height !== undefined) {
      const shortInput = imagePath.length > 20 ? '...' + imagePath.slice(-20) : imagePath
      return `${shortInput} → ${width}x${height}`
    }
    
    return '缩放图片'
  }
})