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
  /** retry/delete/edit 入口需要按消息 id 定位消息下标 */
  messageId?: string
  newContent?: string
  attachments?: Attachment[]
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
}

/** 当前待确认的 dirty 恢复动作（null = 无待确认） */
export const pendingDirtyConfirm = ref<DirtyConfirmPending | null>(null)

export function clearPendingDirtyConfirm(): void {
  pendingDirtyConfirm.value = null
}
