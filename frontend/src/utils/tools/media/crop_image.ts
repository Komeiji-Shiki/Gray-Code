/**
 * crop_image 工具 - 前端注册
 *
 * 裁切图片工具的显示配置
 */

import { registerTool } from '../../toolRegistry'
import CropImagePanel from '../../../components/tools/media/crop_image.vue'

/**
 * 单个任务类型
 */
interface CropTask {
  image_path: string
  output_path: string
  x1: number
  y1: number
  x2: number
  y2: number
}

registerTool('crop_image', {
  name: 'crop_image',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '裁切图片',
  icon: 'codicon-selection',
  expandable: true,
  contentComponent: CropImagePanel,
  descriptionFormatter: (args) => {
    const images = args.images as CropTask[] | undefined
    const imagePath = args.image_path as string | undefined
    const x1 = args.x1 as number | undefined
    const y1 = args.y1 as number | undefined
    const x2 = args.x2 as number | undefined
    const y2 = args.y2 as number | undefined
    
    // 批量模式
    if (images && Array.isArray(images) && images.length > 0) {
      if (images.length === 1) {
        const task = images[0]
        const shortInput = task.image_path.length > 20 ? '...' + task.image_path.slice(-20) : task.image_path
        return `${shortInput} (${task.x1},${task.y1})-(${task.x2},${task.y2})`
      }
      // 多任务显示
      return `批量裁切 ${images.length} 张`
    }
    
    // 单张模式
    if (imagePath && x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      const shortInput = imagePath.length > 20 ? '...' + imagePath.slice(-20) : imagePath
      return `${shortInput} (${x1},${y1})-(${x2},${y2})`
    }
    
    return '裁切图片'
  }
})