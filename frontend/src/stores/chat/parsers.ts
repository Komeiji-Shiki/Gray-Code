/**
 * Chat Store 解析器
 * 
 * 包含工具调用解析和 Content 到 Message 的转换
 */

import type { Message, Content, Attachment, ToolUsage } from '../../types'
import { generateId } from '../../utils/format'
// WP15: 统一 functionCall merge 纯函数入口。
// 为什么从独立模块导入：parsers.ts 的 normalizeFunctionCallParts 此前自己定义了
// normalizeNonEmptyString、hasNonEmptyArgs、mergeFunctionCallSnapshot、parseFinalArgs 等。
// 怎么改：复用 utils/functionCallMerge.ts 中的统一版本，本文件仅保留快照特有的 getFunctionCallSnapshotKey 和 mergeFunctionCallSnapshot。
// 目的：快照去重路径（contentToMessage / contentToMessageEnhanced）与流式增量路径使用一致的合并键。
//
// WP15 条件 1 修复：新增导入 mergeFunctionCallIdentity 和 tryParseArgs。
// 为什么：parseFinalArgs 与 tryParseArgs 重复，身份字段合并 4 行与 mergeFunctionCall 重复。
// 怎么改：mergeFunctionCallIdentity 替代内联的身份填充，tryParseArgs + finalArgs 判定替代 parseFinalArgs。
// 目的：消除 parser.ts 与 functionCallMerge.ts 之间的子逻辑重复，G1 前收敛。
import {
  normalizeNonEmptyString,
  hasNonEmptyArgs,
  mergeFunctionCallIdentity,
  tryParseArgs
} from '../../utils/functionCallMerge'

/**
 * 从 MIME 类型获取附件类型
 */
export function getAttachmentTypeFromMime(mimeType: string): 'image' | 'video' | 'audio' | 'document' | 'code' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.includes('javascript') || mimeType.includes('json') ||
      mimeType.includes('xml') || mimeType.includes('html') ||
      mimeType.includes('css') || mimeType.includes('typescript')) return 'code'
  return 'document'
}

/**
 * 从 MIME 类型获取文件扩展名
 */
export function getExtensionFromMime(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mp3': '.mp3',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json'
  }
  return mimeToExt[mimeType] || ''
}

/**
 * 检查 Content 是否只包含 functionResponse（工具执行结果）
 */
export function isOnlyFunctionResponse(content: Content): boolean {
  // M1：后端消息可能缺 parts 字段（旧后端/异常数据），零容错会抛 TypeError 导致整个历史加载崩溃
  const parts = Array.isArray(content.parts) ? content.parts : []
  return parts.length > 0 && parts.every(p => p.functionResponse !== undefined)
}

type FunctionCallPart = NonNullable<Content['parts'][number]['functionCall']> & {
  itemId?: string
  finalArgs?: boolean
}

// WP15 条件 1：parseFinalArgs 已移除。
// 为什么：parseFinalArgs 与 utils/functionCallMerge.ts 的 tryParseArgs 功能完全重叠（安全 JSON.parse +
// 判定 finalArgs），仅在 finalArgs 判定位置不同（tryParseArgs 由调用方自己判断 finalArgs）。
// 怎么改：用 tryParseArgs(incoming.partialArgs) + incoming.finalArgs === true 替代 parseFinalArgs(incoming)。
// 目的：消除 parsers.ts 与 functionCallMerge.ts 之间的子逻辑重复，G1 前收敛。

function getFunctionCallSnapshotKey(part: FunctionCallPart, ordinal: number): string {
  const itemId = normalizeNonEmptyString(part.itemId)
  if (itemId) return `item:${itemId}`

  const id = normalizeNonEmptyString(part.id)
  if (id) return `id:${id}`

  // 为什么 index 使用 typeof number：OpenAI Responses 的 output_index 可以是 0，不能用 truthy 判断。
  // 怎么改：在快照层把 index=0 当成有效合并键。
  // 目的：防止“参数 0”占位工具在 contentSnapshot 转 Message 时被保留下来。
  if (typeof part.index === 'number') return `index:${part.index}`

  return `ordinal:${ordinal}`
}

function mergeFunctionCallSnapshot(target: FunctionCallPart, incoming: FunctionCallPart): void {
  // WP15 条件 1：身份字段合并委托给统一函数，消除与 mergeFunctionCall 的 4 行重复。
  mergeFunctionCallIdentity(target, incoming)

  // WP15 条件 1：args/partialArgs 保留快照特有语义（替换而不是 spread 合并、更长片段胜出而不是追加拼接），
  // 这是快照路径与增量路径的合理语义差异，不做强行混同。
  const parsedFinalArgs = incoming.finalArgs === true ? tryParseArgs(incoming.partialArgs) : null
  if (parsedFinalArgs) {
    target.args = parsedFinalArgs
    delete target.partialArgs
    return
  }

  if (hasNonEmptyArgs(incoming.args)) {
    // 为什么快照路径用直接替换而不是 spread 合并：后端 contentSnapshot 已经是累积完成的完整状态，
    // 不涉及流式过程中先 partialArgs 后补字段的场景，直接替换是正确的最小操作。
    target.args = incoming.args
    delete target.partialArgs
    return
  }

  if (typeof incoming.partialArgs === 'string') {
    // 为什么这里不盲目追加：后端快照已经是累积状态，前端只负责选择最新、更完整的片段。
    // 怎么改：用更长的 partialArgs 替换较短的旧片段。
    // 目的：避免快照二次拼接参数，保持 UI 预览和后端累加器一致。
    if (typeof target.partialArgs !== 'string' || incoming.partialArgs.length >= target.partialArgs.length) {
      target.partialArgs = incoming.partialArgs
    }
  }
}

function normalizeFunctionCallParts(parts: Content['parts']): Content['parts'] {
  const normalized: Content['parts'] = []
  const callIndexByKey = new Map<string, number>()
  let functionCallOrdinal = 0

  for (const part of parts) {
    if (!part.functionCall) {
      normalized.push(part)
      continue
    }

    const functionCall = part.functionCall as FunctionCallPart
    const key = getFunctionCallSnapshotKey(functionCall, functionCallOrdinal)
    functionCallOrdinal += 1

    const existingIndex = callIndexByKey.get(key)
    if (existingIndex !== undefined) {
      const existing = normalized[existingIndex].functionCall as FunctionCallPart
      mergeFunctionCallSnapshot(existing, functionCall)
      continue
    }

    const clonedPart = {
      ...part,
      functionCall: { ...functionCall }
    }
    // WP15 条件 1：用 tryParseArgs + finalArgs 判定替代已删除的 parseFinalArgs。
    const clonedFc = clonedPart.functionCall as FunctionCallPart
    const parsedFinalArgs = clonedFc.finalArgs === true ? tryParseArgs(clonedFc.partialArgs) : null
    if (parsedFinalArgs) {
      clonedPart.functionCall.args = parsedFinalArgs
      delete (clonedPart.functionCall as FunctionCallPart).partialArgs
    }

    callIndexByKey.set(key, normalized.length)
    normalized.push(clonedPart)
  }

  return normalized
}

function extractToolUsages(parts: Content['parts']): ToolUsage[] {
  const toolUsages: ToolUsage[] = []

  for (const part of parts) {
    if (!part.functionCall) continue

    const functionCall = part.functionCall as FunctionCallPart
    const partialArgs = functionCall.partialArgs
    toolUsages.push({
      id: functionCall.id || generateId(),
      name: functionCall.name,
      args: functionCall.args,
      // 为什么把 itemId/index 带到 ToolUsage：MessageItem 和 ToolMessage 都可能从不同投影读取工具状态。
      // 怎么改：让 tools 数组与 parts 数组共享同一流式合并键。
      // 目的：快照覆盖时能替换占位工具，而不是把最后一个 MCP 工具显示两次。
      itemId: functionCall.itemId,
      index: functionCall.index,
      partialArgs,
      status: typeof partialArgs === 'string' ? 'streaming' : 'queued'
    })
  }

  return toolUsages
}

/**
 * BR-01：读取后端透传的稳定节点 id（content.id）。
 *
 * 旧后端/旧消息无 id 时返回 undefined，调用方回退 generateId。
 */
function getContentNodeId(content: Content): string | undefined {
  return typeof content.id === 'string' && content.id.length > 0 ? content.id : undefined
}

/**
 * 将 Content 转换为 Message
 */
export function contentToMessage(content: Content, id?: string): Message {
  // M1：后端消息可能缺 parts 字段，按空数组容错，避免 normalizeFunctionCallParts 抛 TypeError
  const sourceParts = Array.isArray(content.parts) ? content.parts : []
  const normalizedParts = normalizeFunctionCallParts(sourceParts)
  const textParts = normalizedParts.filter(p => p.text && !p.thought)
  const text = textParts.map(p => p.text).join('')
  
  // 提取工具调用信息
  const toolUsages = extractToolUsages(normalizedParts)
  
  // 确定消息角色：有工具调用时角色仍为 assistant
  const role = content.role === 'model' ? 'assistant' : 'user'
  
  const msg: Message = {
    // BR-01：优先透传后端稳定节点 id（content.id），不再每次加载重新生成；
    // 无 id（旧后端/流式占位）时回退生成，保持向后兼容。
    id: id || getContentNodeId(content) || generateId(),
    // BR-01：透传父节点 id（首条消息为 null）——前端据此判断根节点，
    // 编辑根节点时自动降级为「原地保存」（根节点无父节点可挂编辑候选）
    parentId: content.parentId,
    role,
    content: text,
    timestamp: Date.now(),
    parts: normalizedParts,
    tools: toolUsages.length > 0 ? toolUsages : undefined,
    source: content.source,
    // 总结消息标记（通常由 contentToMessageEnhanced 处理，这里保持一致）
    isSummary: content.isSummary,
    isAutoSummary: content.isAutoSummary,
    isSummarized: content.isSummarized,
    summaryTokenStats: content.summaryTokenStats,
    metadata: {
      // 存储模型版本（仅 model 消息有值）
      modelVersion: content.modelVersion,
      // 存储完整的 usageMetadata（仅 model 消息有值）
      usageMetadata: content.usageMetadata,
      // 计时信息（从后端获取）
      thinkingDuration: content.thinkingDuration,
      responseDuration: content.responseDuration,
      streamDuration: content.streamDuration,
      firstChunkTime: content.firstChunkTime,
      ttft: content.ttft,
      chunkCount: content.chunkCount,
      // 保留向后兼容
      thoughtsTokenCount: content.usageMetadata?.thoughtsTokenCount ?? content.thoughtsTokenCount,
      candidatesTokenCount: content.usageMetadata?.candidatesTokenCount ?? content.candidatesTokenCount
    }
  }
  if (typeof content.index === 'number') {
    msg.backendIndex = content.index
  }
  return msg
}

/**
 * 将 Content 转换为 Message（增强版）
 *
 * 现在不再预先匹配工具响应，而是在显示时通过 getToolResponseMessage 获取
 * 同时会从 inlineData 中提取附件信息
 */
export function contentToMessageEnhanced(content: Content, id?: string): Message {
  // M1：后端消息可能缺 parts 字段，按空数组容错，避免 normalizeFunctionCallParts 抛 TypeError
  const sourceParts = Array.isArray(content.parts) ? content.parts : []
  const normalizedParts = normalizeFunctionCallParts(sourceParts)
  const textParts = normalizedParts.filter(p => p.text && !p.thought)
  const text = textParts.map(p => p.text).join('')
  
  // 提取工具调用信息（不预先匹配响应）
  const toolUsages = extractToolUsages(normalizedParts)
  for (const toolUsage of toolUsages) {
    const part = normalizedParts.find(p => {
      const functionCall = p.functionCall as FunctionCallPart | undefined
      // 为什么 itemId 需要先判断存在：undefined === undefined 会让无 itemId 的普通工具误匹配第一条 functionCall。
      // 怎么改：优先按最终 id 匹配，只有 toolUsage.itemId 存在时才用内部流式键兜底。
      // 目的：保留 rejected 状态同步能力，同时不污染普通工具的状态。
      return functionCall?.id === toolUsage.id || (!!toolUsage.itemId && functionCall?.itemId === toolUsage.itemId)
    })
    if (part?.functionCall?.rejected === true) {
      toolUsage.status = 'error'
    }
  }

  // 提取附件信息（从 inlineData）
  const attachments: Attachment[] = []
  
  for (const part of normalizedParts) {
    // 从 inlineData 提取附件
    if (part.inlineData) {
      const attType = getAttachmentTypeFromMime(part.inlineData.mimeType)
      const ext = getExtensionFromMime(part.inlineData.mimeType)
      
      // 优先使用存储的 id 和 name，否则使用默认值
      const inlineData = part.inlineData as { mimeType: string; data: string; id?: string; name?: string }
      const attId = inlineData.id || generateId()
      const attName = inlineData.name || `attachment${ext || ''}`
      
      // 计算大小（Base64 字符串解码后的大约大小）
      const base64Length = part.inlineData.data.length
      const size = Math.floor(base64Length * 0.75)
      
      // 生成缩略图（对于图片，直接使用 data URL）
      let thumbnail: string | undefined
      if (attType === 'image') {
        thumbnail = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
      }
      
      attachments.push({
        id: attId,
        name: attName,
        type: attType,
        size,
        mimeType: part.inlineData.mimeType,
        data: part.inlineData.data,
        thumbnail
      })
    }
  }
  
  const role = content.role === 'model' ? 'assistant' : 'user'
  // 优先使用后端传递的 isFunctionResponse 标志，否则通过 parts 判断
  // 这样可以正确处理包含多模态附件的函数响应消息
  const isFunctionResponse = content.isFunctionResponse === true || isOnlyFunctionResponse(content)
  
  const msg: Message = {
    // BR-01：优先透传后端稳定节点 id（content.id），不再每次加载重新生成；
    // 无 id（旧后端/流式占位）时回退生成，保持向后兼容。
    id: id || getContentNodeId(content) || generateId(),
    // BR-01：透传父节点 id（首条消息为 null）——前端据此判断根节点，
    // 编辑根节点时自动降级为「原地保存」（根节点无父节点可挂编辑候选）
    parentId: content.parentId,
    role,
    content: text,
    // 使用后端存储的时间戳，如果没有则为 0（前端会判断不显示）
    timestamp: content.timestamp || 0,
    parts: normalizedParts,
    tools: toolUsages.length > 0 ? toolUsages : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    source: content.source,
    isFunctionResponse,  // 标记是否为纯 functionResponse 消息
    isSummary: content.isSummary,  // 标记是否为总结消息
    isAutoSummary: content.isAutoSummary,  // 标记是否为自动触发的总结消息
    isSummarized: content.isSummarized,  // 标记是否已被总结覆盖（逻辑截断）
    summarizedMessageCount: content.summarizedMessageCount,  // 总结消息覆盖的消息数量
    summaryTokenStats: content.summaryTokenStats,
    metadata: {
      modelVersion: content.modelVersion,
      usageMetadata: content.usageMetadata,
      // 从后端加载的思考持续时间
      thinkingDuration: content.thinkingDuration,
      // 从后端加载的计时信息
      responseDuration: content.responseDuration,
      firstChunkTime: content.firstChunkTime,
      streamDuration: content.streamDuration,
      ttft: content.ttft,
      chunkCount: content.chunkCount,
      thoughtsTokenCount: content.usageMetadata?.thoughtsTokenCount ?? content.thoughtsTokenCount,
      candidatesTokenCount: content.usageMetadata?.candidatesTokenCount ?? content.candidatesTokenCount
    }
  }
  if (typeof content.index === 'number') {
    msg.backendIndex = content.index
  }
  return msg
}
