/**
 * 未保存文件确认（BCP-05 / 决策 11）的共享 UI 状态。
 *
 * 普通恢复（checkpoint.restore 的四个入口：restore / retry / delete / edit）与分支切换恢复
 * （switchBranchCandidate mode=chat-and-workspace）在后端检测到 dirty 文件时，都会把待确认动作
 * 写入本模块；DirtyFilesConfirm.vue 据此渲染确认框，确认后按 kind 分发续作（带
 * confirmedDiscardDirty=true 重试），取消则清空待确认动作（不产生任何副作用）。
 *
 * 独立成纯模块的原因：checkpointActions 与 branchActions 都需要写、DirtyFilesConfirm.vue
 * 需要读——若放在任一 actions 模块内会形成 actions ↔ 组件 的循环导入。
 */
import { ref } from 'vue'
import type { Attachment } from '../../types'

/** 待确认动作的分类：普通恢复 / 分支切换恢复 */
export type DirtyConfirmKind = 'restore' | 'switch'

/** 普通恢复的续作入口参数（与 checkpointActions 四个入口一一对应） */
export interface DirtyRestorePending {
  entry: 'restore' | 'retry' | 'delete' | 'edit'
  checkpointId: string
  /** 恢复确认框中已确认删除快照后新建文件？ */
  deleteUntrackedFiles: boolean
  /** 预览恢复令牌，dirty 确认续作必须沿用同一令牌。 */
  previewId?: string
  /** retry/delete/edit 入口需要按消息 id 定位消息下标 */
  messageId?: string
  newContent?: string
  attachments?: Attachment[]
  /** DeepSeek Vision 图像处理模式（edit 入口随请求透传；undefined = 后端默认拆分） */
  deepSeekVisionTileSplit?: boolean
}

/** 分支切换恢复的续作参数 */
export interface DirtySwitchPending {
  nodeId: string
}

export interface DirtyConfirmPending {
  kind: DirtyConfirmKind
  /** 后端返回的 dirty 文件绝对路径列表 */
  files: string[]
  restore?: DirtyRestorePending
  switch?: DirtySwitchPending
  /**
   * 发起该待确认动作时的会话 ID（BCP-05 归属校验）。
   * 切换会话时按此字段清空；确认/取消时校验归属，避免把续作动作发到错误会话。
   * 旧写入方（未带归属）保持 undefined = 无归属，清空时一视同仁。
   */
  conversationId?: string | null
}

/** 当前待确认的 dirty 恢复动作（null = 无待确认） */
export const pendingDirtyConfirm = ref<DirtyConfirmPending | null>(null)

/**
 * 登记待确认动作并记录发起会话归属。
 *
 * @param conversationId 发起时的会话 ID（可为 null，如新建会话场景）
 * @param pending 待确认动作
 */
export function setPendingDirtyConfirm(
  conversationId: string | null | undefined,
  pending: DirtyConfirmPending
): void {
  pendingDirtyConfirm.value = {
    ...pending,
    conversationId: conversationId ?? null
  }
}

/**
 * 清空待确认动作（带归属校验）。
 *
 * - 不传 conversationId（如 DirtyFilesConfirm.vue 的确认/取消）：无条件清空（旧语义）；
 * - 传入 conversationId 时：仅当待确认动作无归属或归属与当前会话一致才清空——
 *   动作属于其它会话时保留，避免把续作动作误发到新会话。
 */
export function clearPendingDirtyConfirm(conversationId?: string | null): void {
  const pending = pendingDirtyConfirm.value
  if (!pending) return
  if (
    typeof conversationId === 'string' &&
    typeof pending.conversationId === 'string' &&
    pending.conversationId !== conversationId
  ) {
    // 归属不匹配：该确认框属于其它会话，不在本会话清空
    return
  }
  pendingDirtyConfirm.value = null
}
