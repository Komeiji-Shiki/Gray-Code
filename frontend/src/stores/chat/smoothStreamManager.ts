/**
 * 平滑流式输出的实例管理（模块级单例）。
 *
 * 每条流式消息一个 SmoothStreamer 实例（Map<messageId, entry>），
 * 多标签页 / subagent 并发流互不干扰。partKey 表达"当前正在输出的段落身份"
 * （thought/text + part 索引），段落切换（thought → 正文、工具调用后新正文）时
 * 先放完上一段积压再重置蓄水池，新段落从空开始平滑打出。
 *
 * 真实内容（message.parts / content）由 streamChunkHandlers 照旧累加；
 * 本模块只负责驱动"显示层"文本的节奏。TPS 等指标吃真实 chunk，不经此层。
 */

import {
  SmoothStreamer,
  SMOOTH_PRESETS,
  type SmoothMode,
  type SmoothStreamerOptions
} from '../../utils/smoothStream'

interface SmoothEntry {
  streamer: SmoothStreamer
  partKey: string
  mode: SmoothMode
}

const entries = new Map<string, SmoothEntry>()

function buildOptions(mode: SmoothMode): SmoothStreamerOptions {
  const preset = mode === 'off' ? undefined : SMOOTH_PRESETS[mode]
  return preset ? { lookahead: preset.lookahead } : {}
}

/**
 * 推送一段流式增量文本到平滑蓄水池。
 *
 * @param messageId 流式消息 ID（每条消息一个实例）
 * @param partKey   当前段落身份；变化时先放完上一段积压再重置
 * @param text      本次 chunk 的增量文本（非累计值）
 * @param mode      平滑档位（'off' 时调用方不应进入本函数）
 * @param onCommit  显示层文本更新回调（由调用方写入 store.smoothTexts）
 */
export function pushSmoothText(
  messageId: string,
  partKey: string,
  text: string,
  mode: SmoothMode,
  onCommit: (displayText: string) => void
): void {
  let entry = entries.get(messageId)
  if (!entry || entry.mode !== mode) {
    if (entry) {
      entry.streamer.flush()
      entry.streamer.dispose()
      entries.delete(messageId)
    }
    entry = {
      streamer: new SmoothStreamer(onCommit, buildOptions(mode)),
      partKey,
      mode
    }
    entries.set(messageId, entry)
  }

  if (entry.partKey !== partKey) {
    entry.streamer.switchPart()
    entry.partKey = partKey
  }
  entry.streamer.push(text)
}

/**
 * 终结清理：先放完积压（不丢尾巴），再销毁实例。
 * 调用方随后应从 store.smoothTexts 删除该消息的显示文本（切回真实 content）。
 */
export function finishSmoothStream(messageId: string): void {
  const entry = entries.get(messageId)
  if (!entry) return
  entry.streamer.flush()
  entry.streamer.dispose()
  entries.delete(messageId)
}

/** 全量清理（会话切换/应用销毁等兜底） */
export function disposeAllSmoothStreams(): void {
  for (const entry of entries.values()) {
    entry.streamer.dispose()
  }
  entries.clear()
}

/** 当前是否有该消息的活跃平滑实例（供测试/诊断） */
export function hasSmoothStream(messageId: string): boolean {
  return entries.has(messageId)
}
