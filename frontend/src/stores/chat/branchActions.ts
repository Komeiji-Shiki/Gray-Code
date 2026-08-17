/**
 * Chat Store 分支操作（TREE-07 切换后派生状态重建 + TREE-10 候选切换器数据源）
 *
 * 覆盖：
 * - loadBranchGraph / refreshBranchGraph：conversation.getBranchGraph → state.branchGraph
 *   （无图 / 损坏降级统一为 null，只读失败不打断对话）
 * - switchBranchCandidate：conversation.switchBranchCandidate →
 *   重载历史（loadHistory）→ 重建 messageIndexById / toolResponseIndex（loadHistory 内部完成）
 *   → 清理错误条 / 流式残留 → TODO / Build 重置 → 检查点列表刷新（loadCheckpoints）
 *   → 分支图刷新（loadBranchGraph）；失败回滚 UI 状态
 * - deleteBranchCandidate：conversation.deleteBranchCandidate（软删除，仅非活跃候选，
 *   活跃路径不变）→ 刷新分支图
 * - buildCandidateGroupAt：从分支图推导「指定父节点下的候选组」（≥2 候选）
 * - buildCandidateGroupForNode：推导「消息节点所属的候选组」（切换器跟随活跃候选消息，而非父节点）
 *
 * 竞态防护（TREE-13）：
 * - 切换 / 删除前检查 isStreaming / isWaitingForResponse，命中写 BRANCH_BUSY 错误条并拒绝；
 *   后端 BranchHandlers 同样以 BRANCH_BUSY 拒绝变更类分支操作，前端防护为双保险。
 * - isSwitchingBranch 置位期间拒绝并发切换 / 删除（防双击 / 双操作）。
 * - 所有 await 后经 validateSessionIdentity 校验会话归属，防止切换对话后写错状态。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import type { ChatStoreState, BranchGraphData, BranchNodeData } from './types'
import { sendToExtension } from '../../utils/vscode'
import { loadHistory, loadCheckpoints } from './conversationActions'
import { validateSessionIdentity } from './utils'
import { rebuildMessageIndexById } from './state'
import { setPendingDirtyConfirm } from './dirtyConfirmState'

/** 与后端 BranchHandlers.BRANCH_BUSY_STREAMING_MESSAGE 对齐的前端防护文案 */
export const BRANCH_BUSY_MESSAGE = '会话正在流式生成中，请等待完成后再操作'

/** 切换 / 删除失败时的兜底错误码 */
export const BRANCH_SWITCH_ERROR_CODE = 'BRANCH_SWITCH_ERROR'
export const BRANCH_DELETE_ERROR_CODE = 'BRANCH_DELETE_ERROR'
export const BRANCH_RESTORE_ERROR_CODE = 'BRANCH_RESTORE_ERROR'
export const BRANCH_RENAME_ERROR_CODE = 'BRANCH_RENAME_ERROR'

/**
 * BCP-03/04：切换模式（决策 1：默认仅切聊天）。
 * - chat-only：只切换聊天（工作区保持当前状态）；
 * - chat-and-workspace：切换聊天并恢复目标分支绑定的工作区存档。
 */
export type SwitchBranchWorkspaceMode = 'chat-only' | 'chat-and-workspace'

/**
 * BCP-04：是否需要弹「是否连工作区一起恢复」确认框（决策 1 判据，后端富化）。
 * 目标节点执行过写工具（wroteToWorkspace）或绑定了工作区存档（hasWorkspaceState）→ 命中。
 */
export function needsWorkspaceConfirm(node: BranchNodeData | null | undefined): boolean {
  return !!node && (node.wroteToWorkspace === true || node.hasWorkspaceState === true)
}

/** 候选组：同一父节点下（非删除）候选的有序列表 + 当前活跃候选下标 */
export interface BranchCandidateGroup {
  /** 候选组所属父节点 ID */
  parentNodeId: string | null
  /** 按 createdAt 升序的候选列表（过滤已删除） */
  candidates: BranchNodeData[]
  /** 当前活跃候选在 candidates 中的下标（不在组内为 -1） */
  activeIndex: number
}



/**
 * 活跃路径 ID 链（TREE-11 分支树面板数据源）：从 root 沿 activeChildId 走到活跃尾。
 * 镜像后端 BranchGraph.activePath 的语义（前端只读展示，不做抛错）：
 * - 无图 / 空图 / 无 root → []；
 * - 尾不可达 / 链上节点缺失 / 环 → 保守返回已走部分（后端下发前已校验，此处仅防御）。
 */
export function buildActivePathIds(graph: BranchGraphData | null): string[] {
  if (!graph || !graph.nodes || graph.rootNodeId === null) return []

  const path: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = graph.rootNodeId
  while (cursor !== null) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const nodeId: string = cursor
    const current: BranchNodeData | undefined = graph.nodes[nodeId]
    if (!current) break
    path.push(nodeId)
    if (nodeId === graph.activeTailNodeId) break
    cursor = current.activeChildId ?? null
  }
  return path
}

/**
 * 从分支图推导「指定父节点下的候选组」（DeepSeek 风格消息内联切换器数据源，TREE-10）。
 *
 * 语义：候选 = 该父节点的全部非删除子节点（决策 4：单 parentId 索引），按 createdAt 升序；
 * activeIndex = 活跃路径（root → activeChildId → 尾）中经过该父节点的那个子候选。
 * 返回 null：无图 / 父节点 ID 非法 / 候选不足 2 个（无分支点，切换器无意义）/
 * 活跃候选不在组内（数据不一致，防御性隐藏）。
 */
export function buildCandidateGroupAt(
  graph: BranchGraphData | null,
  parentNodeId: string
): BranchCandidateGroup | null {
  if (!graph || !graph.nodes || !parentNodeId) return null

  const candidates = Object.values(graph.nodes)
    .filter(node => node && !node.deleted && node.parentId === parentNodeId)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

  // 切换器只在有 ≥2 个候选的分支点显示（重 roll / 编辑过才出现切换入口）
  if (candidates.length < 2) return null

  // 活跃下标：活跃路径上经过该父节点的子候选（父节点在活跃路径上时必恰好命中一个）
  const activeSet = new Set(buildActivePathIds(graph))
  const activeIndex = candidates.findIndex(candidate => activeSet.has(candidate.id))
  if (activeIndex < 0) return null

  return {
    parentNodeId,
    candidates,
    activeIndex
  }
}

/**
 * 从分支图推导「消息节点所属的候选组」（BranchSwitcherBar 挂载语义，TREE-10）。
 *
 * 语义：切换器跟随当前活跃的候选消息显示——用户在哪条消息上重 roll / 编辑过分支，
 * 切换器就在那条消息（重试后生成的新回答）旁，而不是挂在候选组的父节点上。
 * 例如 user:1 → ai:2 → ai:3，重试 3 后候选组 {3, 3'} 挂在 2 下，切换器显示在
 * 活跃候选 3'（即 3 的位置）上，而非 2 上。
 *
 * 给定消息节点 nodeId：
 * - 若其父节点下有 ≥2 个非删除候选（候选组存在）；
 * - 且 nodeId 是该组当前活跃成员（活跃路径经过它，主历史 UI 上可见的消息）；
 * 则返回该组；否则返回 null（无图 / 节点缺失或软删 / 根节点 / 单候选 / 非活跃成员）。
 *
 * 非活跃成员不返回：旧候选不在主历史 UI 上（sidecar），不会渲染切换器；
 * 活跃路径切换后图刷新，切换器自动跟随新的活跃候选。
 */
export function buildCandidateGroupForNode(
  graph: BranchGraphData | null,
  nodeId: string
): BranchCandidateGroup | null {
  if (!graph?.nodes || !nodeId) return null
  const node = graph.nodes[nodeId]
  if (!node || node.deleted || node.parentId === null) return null

  const group = buildCandidateGroupAt(graph, node.parentId)
  if (!group || group.activeIndex < 0) return null

  const active = group.candidates[group.activeIndex]
  return active && active.id === nodeId ? group : null
}

/**
 * BR-01 窗口 id 对齐（TREE-10 回归）：编辑用户消息（branch 模式）后，后端主历史中该消息
 * 已被替换为新编辑候选节点（editCandidate 新建的节点 id），而本地窗口仍保留旧候选 id——
 * 导致 buildCandidateGroupForNode 把该消息判定为「候选组非活跃成员」返回 null，
 * BranchSwitcherBar 不显示（切走再切回触发 loadHistory 重载后才恢复）。
 *
 * 本函数在分支图刷新成功后执行：窗口内凡是「候选组中的非活跃成员」的用户消息，
 * 且候选组存在、窗口中没有活跃候选 id 的消息时，把该消息 id 对齐为活跃候选 id
 * （BR-01 原则：窗口 id 与后端主历史 Content.id 必须一致）。
 * 只处理 role='user'：assistant 占位消息 id 由 complete/cancelled 终结替换，不在此列。
 * 幂等：对齐后消息已位于活跃路径，再次执行不会重复替换。
 */
export function alignWindowUserMessageIdsToGraph(
  state: ChatStoreState,
  graph: BranchGraphData | null
): void {
  if (!graph?.nodes) return
  const messages = state.allMessages.value
  if (messages.length === 0) return

  const activeIds = new Set(buildActivePathIds(graph))
  const seenIds = new Set(messages.map(m => m.id))
  let changed = false

  const aligned = messages.map((msg) => {
    if (msg.role !== 'user' || activeIds.has(msg.id)) return msg
    const node = graph.nodes[msg.id]
    if (!node || node.deleted || node.parentId === null) return msg
    const group = buildCandidateGroupAt(graph, node.parentId)
    if (!group || group.activeIndex < 0) return msg
    const activeId = group.candidates[group.activeIndex].id
    if (activeId === msg.id || seenIds.has(activeId)) return msg
    seenIds.add(activeId)
    changed = true
    return { ...msg, id: activeId }
  })

  if (changed) {
    state.allMessages.value = aligned
    rebuildMessageIndexById(state)
  }
}

/**
 * 子节点索引（TREE-11 分支树面板数据源）：Map<parentId, 子节点列表>。
 * 镜像后端 BranchGraph.childrenIndex：按 createdAt 升序（同毫秒按 id 字典序），
 * 软删节点也包含在内（由展示方按需灰显）。
 */
export function buildChildrenIndex(
  graph: BranchGraphData | null
): Map<string, BranchNodeData[]> {
  const index = new Map<string, BranchNodeData[]>()
  if (!graph?.nodes) return index

  for (const node of Object.values(graph.nodes)) {
    if (!node || node.parentId === null) continue
    const list = index.get(node.parentId)
    if (list) {
      list.push(node)
    } else {
      index.set(node.parentId, [node])
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) => {
      const ca = a.createdAt ?? 0
      const cb = b.createdAt ?? 0
      if (ca !== cb) return ca - cb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }
  return index
}

/**
 * 读取当前对话的分支图（TREE-10）。
 * - 无图（线性模式）→ null；
 * - 损坏（errorCode: BRANCH_STORAGE_CORRUPT）→ null + warn（读取侧降级，不抛错）；
 * - 只读失败（IPC 异常）→ 保留旧值，不打断对话。
 */
export async function loadBranchGraph(state: ChatStoreState): Promise<BranchGraphData | null> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) {
    state.branchGraph.value = null
    return null
  }

  state.branchGraphLoading.value = true
  try {
    const result = await sendToExtension<{
      graph?: BranchGraphData | null
      errorCode?: string
      errorMessage?: string
    }>(MESSAGE_NAMES['conversation.getBranchGraph'], { conversationId })

    if (!validateSessionIdentity(state, conversationId)) return state.branchGraph.value

    if (result?.graph) {
      state.branchGraph.value = result.graph
      // BR-01 对齐（TREE-10 回归）：编辑用户消息后窗口 id 落后于图活跃候选，
      // 刷新图时把窗口内非活跃候选成员的用户消息 id 对齐为活跃候选，
      // BranchSwitcherBar 才能在保存后立即显示「‹ 2/2 ›」切换器。
      alignWindowUserMessageIdsToGraph(state, result.graph)
    } else {
      if (result?.errorCode) {
        console.warn('[branchActions] branch graph unavailable:', result.errorCode, result.errorMessage ?? '')
      }
      state.branchGraph.value = null
    }
    return state.branchGraph.value
  } catch (err) {
    console.warn('[branchActions] Failed to load branch graph:', err)
    return state.branchGraph.value
  } finally {
    // 无条件复位：await 期间会话可能已切换，条件复位会让 branchGraphLoading 卡 true
    // （加载指示器永久旋转），与 isSwitchingBranch 的无条件复位同款
    state.branchGraphLoading.value = false
  }
}

/** 刷新当前对话的分支图（loadBranchGraph 的别名，供 UI 手动刷新 / 后续批次接线） */
export function refreshBranchGraph(state: ChatStoreState): Promise<BranchGraphData | null> {
  return loadBranchGraph(state)
}

/** 分支变更前置检查：流式中拒绝（BRANCH_BUSY，双保险） */
function rejectIfStreaming(state: ChatStoreState): boolean {
  if (state.isStreaming.value || state.isWaitingForResponse.value) {
    state.error.value = { code: 'BRANCH_BUSY', message: BRANCH_BUSY_MESSAGE }
    return true
  }
  return false
}

/** 切换前的 UI 快照（失败回滚用） */
interface BranchSwitchSnapshot {
  allMessages: ChatStoreState['allMessages']['value']
  windowStartIndex: number
  totalMessages: number
  checkpoints: ChatStoreState['checkpoints']['value']
  toolResponseCache: ChatStoreState['toolResponseCache']['value']
  branchGraph: ChatStoreState['branchGraph']['value']
  activeBuild: ChatStoreState['activeBuild']['value']
}

function captureSwitchSnapshot(state: ChatStoreState): BranchSwitchSnapshot {
  return {
    allMessages: [...state.allMessages.value],
    windowStartIndex: state.windowStartIndex.value,
    totalMessages: state.totalMessages.value,
    checkpoints: [...state.checkpoints.value],
    toolResponseCache: new Map(state.toolResponseCache.value),
    branchGraph: state.branchGraph.value,
    activeBuild: state.activeBuild.value
  }
}

function restoreSwitchSnapshot(state: ChatStoreState, snapshot: BranchSwitchSnapshot): void {
  state.allMessages.value = snapshot.allMessages
  rebuildMessageIndexById(state)
  state.windowStartIndex.value = snapshot.windowStartIndex
  state.totalMessages.value = snapshot.totalMessages
  state.checkpoints.value = snapshot.checkpoints
  state.toolResponseCache.value = snapshot.toolResponseCache
  state.branchGraph.value = snapshot.branchGraph
  state.activeBuild.value = snapshot.activeBuild
}

/**
 * 切换候选（TREE-07 前端主链路 + BCP-03/04/05 工作区联动）。
 *
 * @param options.mode 切换模式（缺省 'chat-only'，决策 1）；
 *   'chat-and-workspace' 时后端先恢复目标分支工作区存档再切换。
 * @param options.confirmedDiscardDirty BCP-05（决策 11）：用户在未保存文件确认框中确认后传 true。
 *
 * BCP-05：chat-and-workspace 模式下后端检测到未保存（dirty）文件且未确认时返回
 * { success: false, dirtyFiles }——本函数在 pendingDirtyConfirm 中登记待确认动作
 * （DirtyFilesConfirm.vue 据此弹确认框），不写错误条；确认后以
 * confirmedDiscardDirty=true 重新调用。
 *
 * 成功后按顺序：
 * 1. 清理错误条 / 流式残留（streamingMessageId / activeStreamId / _lastCancelledStreamId /
 *    _failedStreamMessageId / isStreaming / isWaitingForResponse / retryStatus）；
 * 2. TODO / Build 重置（取舍见研究报告 tree07-10-frontend.md）：
 *    - toolResponseCache 清空 → todoSnapshot 基于新窗口重放为「待定」；
 *    - activeBuild 置空（不再把旧路径的 Build 会话挂在新活跃路径上）；
 * 3. loadHistory 重载历史（内部重建 messageIndexById / toolResponseIndex；后端 TREE-06
 *    落地后返回新活跃路径，当前未重写主历史时返回原历史，窗口语义保持一致）；
 * 4. loadCheckpoints 刷新检查点列表（messageIndex 按新活跃路径重映射）；
 * 5. loadBranchGraph 刷新分支图（切换器数据源）。
 *
 * 失败时回滚 UI 快照（窗口 / 索引 / 检查点 / 工具缓存 / 分支图 / Build），仅写错误条。
 *
 * @returns 是否成功（BRANCH_BUSY / 无会话 / 参数非法 / dirty 拦截也返回 false）
 */
export async function switchBranchCandidate(
  state: ChatStoreState,
  nodeId: string,
  options?: { mode?: SwitchBranchWorkspaceMode; confirmedDiscardDirty?: boolean; confirmedDirtyFiles?: string[] }
): Promise<boolean> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return false
  if (typeof nodeId !== 'string' || !nodeId.trim()) return false
  if (rejectIfStreaming(state)) return false
  if (state.isSwitchingBranch.value) return false

  const mode = options?.mode === 'chat-and-workspace' ? 'chat-and-workspace' : 'chat-only'
  const snapshot = captureSwitchSnapshot(state)
  state.isSwitchingBranch.value = true

  try {
    const result = await sendToExtension<{
      success?: boolean
      dirtyFiles?: string[]
    }>(MESSAGE_NAMES['conversation.switchBranchCandidate'], {
      conversationId,
      nodeId,
      mode,
      ...(options?.confirmedDiscardDirty === true ? { confirmedDiscardDirty: true } : {}),
      ...(options?.confirmedDirtyFiles ? { confirmedDirtyFiles: options.confirmedDirtyFiles } : {})
    })
    if (!validateSessionIdentity(state, conversationId)) return false

    // BCP-05（决策 11）：chat-and-workspace 后端拦截到未保存文件 → 登记待确认动作，
    // 不写错误条（确认框由 DirtyFilesConfirm.vue 弹出），本次切换未执行。
    // （已确认（confirmedDiscardDirty=true）时后端不会返回 dirtyFiles，此处再防御一次）
    if (options?.confirmedDiscardDirty !== true && result?.dirtyFiles && result.dirtyFiles.length > 0) {
      // BCP-05：登记待确认动作并记录发起会话归属（切走该会话时清空，见 dirtyConfirmState）
      setPendingDirtyConfirm(conversationId, {
        kind: 'switch',
        files: result.dirtyFiles,
        switch: { nodeId }
      })
      return false
    }

    // 1) 清理错误条 / 流式残留（切换本身已由后端保证与流式互斥）
    state.error.value = null
    state.streamingMessageId.value = null
    state.activeStreamId.value = null
    state._lastCancelledStreamId.value = null
    state._failedStreamMessageId.value = null
    state.isStreaming.value = false
    state.isWaitingForResponse.value = false
    state.retryStatus.value = null

    // 2) TODO / Build 重置为待定 / 清空
    state.toolResponseCache.value = new Map()
    state.activeBuild.value = null

    // 3) 重载历史（重建 messageIndexById / toolResponseIndex）
    await loadHistory(state)
    // 4) 检查点列表刷新
    await loadCheckpoints(state)
    // 5) 分支图刷新
    await loadBranchGraph(state)
    return true
  } catch (err: any) {
    if (validateSessionIdentity(state, conversationId)) {
      restoreSwitchSnapshot(state, snapshot)
      state.error.value = {
        code: err?.code || BRANCH_SWITCH_ERROR_CODE,
        message: err?.message || 'Failed to switch branch candidate'
      }
    }
    return false
  } finally {
    // 无条件复位：await 期间会话可能已切换（validateSessionIdentity 失败提前 return），
    // 若这里仍按会话归属条件复位，切换器锁会永久卡在 true，后续所有分支操作被拦截。
    state.isSwitchingBranch.value = false
  }
}

/**
 * 软删除分支候选（TREE-09 UI 入口）。
 *
 * 后端拒绝删除活跃路径上的节点（BRANCH_OPERATION_CONFLICT），因此可删除的候选必然是
 * 非活跃候选——活跃路径不变，成功后只需刷新分支图（无需重载历史 / 检查点）。
 */
export async function deleteBranchCandidate(state: ChatStoreState, nodeId: string): Promise<boolean> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return false
  if (typeof nodeId !== 'string' || !nodeId.trim()) return false
  if (rejectIfStreaming(state)) return false
  if (state.isSwitchingBranch.value) return false

  state.isSwitchingBranch.value = true

  try {
    const result = await sendToExtension<{
      success?: boolean
      deleted?: boolean
      clearedParentActiveChild?: boolean
    }>(MESSAGE_NAMES['conversation.deleteBranchCandidate'], { conversationId, nodeId })

    if (!validateSessionIdentity(state, conversationId)) return false

    if (result?.success === false) {
      state.error.value = { code: BRANCH_DELETE_ERROR_CODE, message: 'Failed to delete branch candidate' }
      return false
    }

    await loadBranchGraph(state)
    return true
  } catch (err: any) {
    if (validateSessionIdentity(state, conversationId)) {
      state.error.value = {
        code: err?.code || BRANCH_DELETE_ERROR_CODE,
        message: err?.message || 'Failed to delete branch candidate'
      }
    }
    return false
  } finally {
    // 与 switchBranchCandidate 同款：无条件复位，会话切换后不能让切换器锁永久卡 true
    state.isSwitchingBranch.value = false
  }
}

/**
 * 恢复软删候选（TREE-11 分支树面板入口）。
 * 后端清除节点 / 候选摘要的 deleted / deletedAt（不自动重新激活）；
 * 成功后仅刷新分支图（活跃路径不变，无需重载历史 / 检查点）。
 */
export async function restoreBranchCandidate(state: ChatStoreState, nodeId: string): Promise<boolean> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return false
  if (typeof nodeId !== 'string' || !nodeId.trim()) return false
  if (rejectIfStreaming(state)) return false
  if (state.isSwitchingBranch.value) return false

  state.isSwitchingBranch.value = true

  try {
    const result = await sendToExtension<{ success?: boolean }>(
      MESSAGE_NAMES['conversation.restoreBranchCandidate'],
      { conversationId, nodeId }
    )

    if (!validateSessionIdentity(state, conversationId)) return false

    if (result?.success === false) {
      state.error.value = { code: BRANCH_RESTORE_ERROR_CODE, message: 'Failed to restore branch candidate' }
      return false
    }

    await loadBranchGraph(state)
    return true
  } catch (err: any) {
    if (validateSessionIdentity(state, conversationId)) {
      state.error.value = {
        code: err?.code || BRANCH_RESTORE_ERROR_CODE,
        message: err?.message || 'Failed to restore branch candidate'
      }
    }
    return false
  } finally {
    // 与 switchBranchCandidate 同款：无条件复位，会话切换后不能让切换器锁永久卡 true
    state.isSwitchingBranch.value = false
  }
}

/**
 * 重命名分支候选（TREE-11 分支树面板入口）。
 * 后端只改 label（节点 + 候选摘要同步，不动 contents）；空 label 视为清除标签。
 * 成功后仅刷新分支图。
 */
export async function renameBranchCandidate(
  state: ChatStoreState,
  nodeId: string,
  label: string
): Promise<boolean> {
  const conversationId = state.currentConversationId.value
  if (!conversationId) return false
  if (typeof nodeId !== 'string' || !nodeId.trim()) return false
  if (rejectIfStreaming(state)) return false
  if (state.isSwitchingBranch.value) return false

  const normalizedLabel = typeof label === 'string' ? label.trim() : ''
  state.isSwitchingBranch.value = true

  try {
    const result = await sendToExtension<{ success?: boolean }>(
      MESSAGE_NAMES['conversation.renameBranchCandidate'],
      { conversationId, nodeId, label: normalizedLabel }
    )

    if (!validateSessionIdentity(state, conversationId)) return false

    if (result?.success === false) {
      state.error.value = { code: BRANCH_RENAME_ERROR_CODE, message: 'Failed to rename branch candidate' }
      return false
    }

    await loadBranchGraph(state)
    return true
  } catch (err: any) {
    if (validateSessionIdentity(state, conversationId)) {
      state.error.value = {
        code: err?.code || BRANCH_RENAME_ERROR_CODE,
        message: err?.message || 'Failed to rename branch candidate'
      }
    }
    return false
  } finally {
    // 与 switchBranchCandidate 同款：无条件复位，会话切换后不能让切换器锁永久卡 true
    state.isSwitchingBranch.value = false
  }
}
