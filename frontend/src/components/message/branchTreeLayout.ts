import type { BranchGraphData, BranchNodeData } from '../../stores/chat/types'
import { buildActivePathIds, buildChildrenIndex } from '../../stores/chat/branchActions'

export type BranchTreeViewMode = 'navigation' | 'full'

export interface BranchTreeNodeRow {
  type: 'node'
  id: string
  node: BranchNodeData
  /**
   * 可视轨道编号。线性父子沿用同一轨道，只有兄弟候选才分配新轨道。
   */
  lane: number
  active: boolean
  current: boolean
  candidateCount: number
  isCandidateRoot: boolean
}

export interface BranchTreeCollapsedRow {
  type: 'collapsed'
  id: string
  lane: number
  count: number
  active: boolean
}

export type BranchTreeDisplayRow = BranchTreeNodeRow | BranchTreeCollapsedRow

function isVisibleNavigationNode(
  row: BranchTreeNodeRow,
  graph: BranchGraphData,
  childCountByParent: ReadonlyMap<string, number>
): boolean {
  if (row.node.id === graph.rootNodeId || row.current || row.candidateCount >= 2 || row.isCandidateRoot) {
    return true
  }

  return row.node.deleted === true || Boolean(row.node.label?.trim()) || (childCountByParent.get(row.node.id) ?? 0) === 0
}

/**
 * 构建完整消息轨道。
 *
 * 与目录树的 depth 不同，lane 不会随着每条消息递增：父节点只有一个候选时，子节点继续使用
 * 父轨道；父节点有多个候选时，当前候选留在原轨道，其余候选才向右分配轨道。
 */
export function buildFullBranchRows(graph: BranchGraphData | null): BranchTreeNodeRow[] {
  if (!graph?.nodes || graph.rootNodeId === null || !graph.nodes[graph.rootNodeId]) return []

  const activePath = new Set(buildActivePathIds(graph))
  const childrenIndex = buildChildrenIndex(graph)
  const rows: BranchTreeNodeRow[] = []

  const walk = (nodeId: string, lane: number, isCandidateRoot: boolean): void => {
    const node = graph.nodes[nodeId]
    if (!node) return

    const children = childrenIndex.get(nodeId) ?? []
    const liveChildren = children.filter(child => !child.deleted)
    rows.push({
      type: 'node',
      id: node.id,
      node,
      lane,
      active: activePath.has(node.id),
      current: graph.activeTailNodeId === node.id,
      candidateCount: liveChildren.length,
      isCandidateRoot
    })

    if (children.length === 0) return

    const preferredChildId = node.activeChildId && children.some(child => child.id === node.activeChildId)
      ? node.activeChildId
      : children.find(child => !child.deleted)?.id ?? children[0].id
    let alternateOffset = 1

    for (const child of children) {
      const childLane = child.id === preferredChildId ? lane : lane + alternateOffset++
      walk(child.id, childLane, children.length >= 2)
    }
  }

  walk(graph.rootNodeId, 0, false)
  return rows
}

/**
 * 构建默认的分支导航：只保留真正影响分支管理的节点，连续普通消息合并为摘要行。
 */
export function buildNavigationBranchRows(graph: BranchGraphData | null): BranchTreeDisplayRow[] {
  if (!graph) return []

  const fullRows = buildFullBranchRows(graph)
  const childrenIndex = buildChildrenIndex(graph)
  const childCountByParent = new Map<string, number>()
  for (const [parentId, children] of childrenIndex) {
    childCountByParent.set(parentId, children.length)
  }

  const rows: BranchTreeDisplayRow[] = []
  let pending: BranchTreeNodeRow[] = []
  let collapsedSequence = 0

  const flushPending = (): void => {
    if (pending.length === 0) return
    rows.push({
      type: 'collapsed',
      id: `collapsed-${collapsedSequence++}`,
      lane: pending[0].lane,
      count: pending.length,
      active: pending.every(row => row.active)
    })
    pending = []
  }

  for (const row of fullRows) {
    if (isVisibleNavigationNode(row, graph, childCountByParent)) {
      flushPending()
      rows.push(row)
      continue
    }

    const previous = pending[pending.length - 1]
    if (previous && (previous.lane !== row.lane || previous.active !== row.active)) {
      flushPending()
    }
    pending.push(row)
  }
  flushPending()

  return rows
}

export function buildBranchTreeRows(
  graph: BranchGraphData | null,
  mode: BranchTreeViewMode
): BranchTreeDisplayRow[] {
  return mode === 'full' ? buildFullBranchRows(graph) : buildNavigationBranchRows(graph)
}
