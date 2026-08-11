/**
 * generate_image 工具 - 前端注册
 *
 * 图像生成工具的显示配置
 * 支持单张和批量生成两种模式
 */

import { registerTool } from '../../toolRegistry'
import GenerateImagePanel from '../../../components/tools/media/generate_image.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

/**
 * 单个任务类型
 */
interface ImageTask {
  prompt: string
  reference_images?: string[]
  aspect_ratio?: string
  image_size?: string
  output_path: string
}

registerTool('generate_image', {
  name: 'generate_image',
  // TODO(i18n): label/descriptionFormatter 仍为硬编码中文，后续接入 getToolDisplayName / t() 统一本地化
  label: '生成图像',
  icon: 'codicon-file-media',
  expandable: true,
  contentComponent: GenerateImagePanel,
  descriptionFormatter: (args) => {
    const images = args.images as ImageTask[] | undefined
    const prompt = args.prompt as string | undefined
    const outputPath = args.output_path as string | undefined
    
    // 批量模式
    if (images && Array.isArray(images) && images.length > 0) {
      if (images.length === 1) {
        const task = images[0]
        const shortPrompt = task.prompt.length > 30 ? task.prompt.slice(0, 30) + '...' : task.prompt
        return `${shortPrompt} → ${task.output_path}`
      }
      // 多任务显示
      const firstPrompt = images[0].prompt
      const shortPrompt = firstPrompt.length > 20 ? firstPrompt.slice(0, 20) + '...' : firstPrompt
      return `批量生成 ${images.length} 张: ${shortPrompt} 等`
    }
    
    // 单张模式
    if (prompt) {
      const shortPrompt = prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt
      return outputPath ? `${shortPrompt} → ${outputPath}` : shortPrompt
    }
    
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return getToolMetaDescription('generate_image') ?? '图像生成'
  }
})