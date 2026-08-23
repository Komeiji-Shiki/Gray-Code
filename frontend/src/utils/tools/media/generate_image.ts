/**
 * generate_image 工具 - 前端注册
 *
 * 图像生成工具的显示配置
 * 支持单张和批量生成两种模式
 */

import { lazyToolComponent, registerTool } from '../../toolRegistry'
import { getToolMetaDescription } from '../toolMetaLookup'
import { getToolDisplayName } from '../../toolLocalization'
import { t } from '../../../i18n'

const GenerateImagePanel = lazyToolComponent(() => import('../../../components/tools/media/generate_image.vue'))

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
  // 本地化：渲染时按当前语言取显示名（复用 toolLocalization 通道）
  labelFormatter: () => getToolDisplayName('generate_image'),
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
      return t('utils.tools.batchGenerateCount', { count: images.length, prompt: shortPrompt })
    }
    
    // 单张模式
    if (prompt) {
      const shortPrompt = prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt
      return outputPath ? `${shortPrompt} → ${outputPath}` : shortPrompt
    }
    
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退本地化显示名
    return getToolMetaDescription('generate_image') ?? getToolDisplayName('generate_image')
  }
})