import { ref, watch } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useChatStore } from '@/stores'

type ChannelType = 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic'

/**
 * PromptSettings「Token 计数」区块的领域逻辑（S7 批次拆分，纯重构，行为零变化）。
 *
 * @param getTemplate 读取当前静态模板文本（对应原 config.template）
 */
export function usePromptTokenCount(getTemplate: () => string) {
  const chatStore = useChatStore()

  // Token 计数状态
  const staticTokenCount = ref<number | null>(null)
  const dynamicTokenCount = ref<number | null>(null)
  const isCountingTokens = ref(false)
  const tokenCountError = ref('')
  const selectedChannel = ref<ChannelType>('gemini')

  // 可用的渠道选项
  const channelOptions: { value: ChannelType; label: string }[] = [
    { value: 'gemini', label: 'Gemini' },
    { value: 'gemini-interactions', label: 'Gemini Interactions' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' }
  ]

  // token 计数请求序号：丢弃过期响应，避免慢响应覆盖新结果（如切换渠道后旧响应迟到）
  let tokenCountRequestSeq = 0

  // 计算 token 数量（分别计算静态模板和动态上下文）
  async function countTokens() {
    const seq = ++tokenCountRequestSeq

    if (!getTemplate()) {
      staticTokenCount.value = null
      dynamicTokenCount.value = null
      isCountingTokens.value = false
      return
    }

    isCountingTokens.value = true
    tokenCountError.value = ''

    try {
      const result = await sendToExtension<{
        success: boolean
        staticTokens?: number
        dynamicTokens?: number
        error?: string
      }>(MESSAGE_NAMES.countSystemPromptTokens, {
        staticText: getTemplate(),
        channelType: selectedChannel.value,
        conversationId: chatStore.currentConversationId
      })

      // 过期响应直接丢弃
      if (seq !== tokenCountRequestSeq) return

      if (result?.success) {
        staticTokenCount.value = result.staticTokens ?? null
        dynamicTokenCount.value = result.dynamicTokens ?? null
      } else {
        staticTokenCount.value = null
        dynamicTokenCount.value = null
        tokenCountError.value = result?.error || 'Token count failed'
      }
    } catch (error: any) {
      // 过期响应直接丢弃
      if (seq !== tokenCountRequestSeq) return
      console.error('Failed to count tokens:', error)
      staticTokenCount.value = null
      dynamicTokenCount.value = null
      tokenCountError.value = error.message || 'Token count failed'
    } finally {
      if (seq === tokenCountRequestSeq) isCountingTokens.value = false
    }
  }

  // 格式化 token 数量显示
  function formatTokenCount(count: number): string {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`
    }
    return count.toString()
  }

  // 监听渠道变化，重新计算 token
  watch(selectedChannel, () => {
    countTokens()
  })

  return {
    staticTokenCount,
    dynamicTokenCount,
    isCountingTokens,
    tokenCountError,
    selectedChannel,
    channelOptions,
    countTokens,
    formatTokenCount
  }
}
