import type { BranchGraphData, BranchNodeData } from '../../stores/chat/types'
import { buildActivePathIds, buildChildrenIndex } from '../../stores/chat/branchActions'

export type BranchTreeViewMode = 'navigation' | 'full'

/** 父节点有 ≥2 个子节点时，挑选继承父轨道的子节点（与活跃路径对齐，兜底首个非软删） */
function pickPreferredChildId(node: BranchNodeData, children: BranchNodeData[]): string {
  return node.activeChildId && children.some(child => child.id === node.activeChildId)
    ? node.activeChildId
    : children.find(child => !child.deleted)?.id ?? children[0].id
}

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

    const preferredChildId = pickPreferredChildId(node, children)
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

// ============ 完整消息图（高级模式，轨道式泳道布局） ============

/** 行内一个轨道单元上的线形状（vline = 上下延续；left/right = 分叉横线） */
export interface BranchTrackLineCell {
  /** 轨道号 */
  lane: number
  /** 竖线：该轨道在当前行上下延续 */
  vline: boolean
  /** 左半横线：分叉线从左侧轨道进入 */
  left: boolean
  /** 右半横线：分叉线向右侧轨道延伸 */
  right: boolean
  /** 该线是否属于活跃路径 */
  active: boolean
}

/** 完整消息图节点行：一行一条消息，节点落在自己的轨道列，其余轨道列绘制经过的线 */
export interface BranchTrackNodeRow {
  kind: 'node'
  id: string
  /** 节点所在轨道 */
  lane: number
  node: BranchNodeData
  active: boolean
  current: boolean
  candidateCount: number
  isCandidateRoot: boolean
  /** 本行经过的线（含节点所在轨道的延续线，渲染时节点标记覆盖其中段） */
  lines: BranchTrackLineCell[]
}

/** 完整消息图折叠行：连续线性段合并为摘要行，轨道延续线保留 */
export interface BranchTrackCollapsedRow {
  kind: 'collapsed'
  id: string
  lane: number
  count: number
  active: boolean
  lines: BranchTrackLineCell[]
}

export type BranchTrackRow = BranchTrackNodeRow | BranchTrackCollapsedRow

export interface BranchTrackGraph {
  rows: BranchTrackRow[]
  /** 轨道列数（轨道号 0..laneCount-1） */
  laneCount: number
}

interface LineShape {
  vline: boolean
  left: boolean
  right: boolean
  active: boolean
}

function buildLinesForRow(byLane: Map<number, LineShape> | undefined): BranchTrackLineCell[] {
  if (!byLane) return []
  const cells: BranchTrackLineCell[] = []
  for (const [lane, shape] of byLane) {
    if (!shape.vline && !shape.left && !shape.right) continue
    cells.push({ lane, vline: shape.vline, left: shape.left, right: shape.right, active: shape.active })
  }
  cells.sort((a, b) => a.lane - b.lane)
  return cells
}

function mergeSegmentLines(rows: BranchTrackNodeRow[]): BranchTrackLineCell[] {
  const merged = new Map<number, LineShape>()
  for (const row of rows) {
    for (const line of row.lines) {
      let shape = merged.get(line.lane)
      if (!shape) {
        shape = { vline: false, left: false, right: false, active: false }
        merged.set(line.lane, shape)
      }
      shape.vline = shape.vline || line.vline
      shape.left = shape.left || line.left
      shape.right = shape.right || line.right
      shape.active = shape.active || line.active
    }
  }
  return buildLinesForRow(merged)
}

/**
 * 构建轨道式完整消息图（高级模式）。
 *
 * 布局规则：
 * - 行序 = BFS 分层（层内按「父节点顺序 × children createdAt 顺序」），每条消息一行；
 * - 轨道列数由「同时存在的候选分支」决定，而不是消息数量：preferred 子节点继承父轨道，
 *   兄弟候选分配空闲轨道（候选分支走完即释放，后续新候选复用），无空闲才向右扩展；
 * - 父子连接绘制为线：同轨延续画竖线，分叉在父轨道伸出横线、中间轨道横穿；
 * - expandAll=false 时，连续的非关键线性段（单子、无分叉线）折叠为摘要行。
 */
export function buildTrackGraphRows(graph: BranchGraphData | null, expandAll: boolean): BranchTrackGraph {
  const empty: BranchTrackGraph = { rows: [], laneCount: 0 }
  if (!graph?.nodes || graph.rootNodeId === null || !graph.nodes[graph.rootNodeId]) return empty

  const childrenIndex = buildChildrenIndex(graph)
  const activePath = new Set(buildActivePathIds(graph))

  // 1. BFS 分层
  const layers: BranchNodeData[][] = []
  const seen = new Set<string>([graph.rootNodeId])
  let frontier: BranchNodeData[] = [graph.nodes[graph.rootNodeId]]
  while (frontier.length > 0) {
    layers.push(frontier)
    const next: BranchNodeData[] = []
    for (const parent of frontier) {
      for (const child of childrenIndex.get(parent.id) ?? []) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        next.push(child)
      }
    }
    frontier = next
  }

  // 2. 轨道分配：preferred 继承父轨道，兄弟候选优先复用已释放轨道，无空闲才扩展新轨道
  const laneOfNode = new Map<string, number>()
  const freeLanes: number[] = []
  let maxLane = 0
  laneOfNode.set(graph.rootNodeId, 0)

  for (let depth = 1; depth < layers.length; depth++) {
    const occupied = new Set<number>()
    const takeFreeLane = (): number => {
      for (let i = 0; i < freeLanes.length; i++) {
        if (!occupied.has(freeLanes[i])) {
          const lane = freeLanes[i]
          freeLanes.splice(i, 1)
          return lane
        }
      }
      maxLane += 1
      return maxLane
    }
    for (const parent of layers[depth - 1]) {
      const children = childrenIndex.get(parent.id) ?? []
      if (children.length === 0) continue
      const preferredId = pickPreferredChildId(parent, children)
      const parentLane = laneOfNode.get(parent.id)!
      for (const child of children) {
        const lane = child.id === preferredId && !occupied.has(parentLane) ? parentLane : takeFreeLane()
        laneOfNode.set(child.id, lane)
        occupied.add(lane)
      }
    }
    // 叶子节点走完后释放轨道，供更深层的新候选复用
    for (const node of layers[depth]) {
      const lane = laneOfNode.get(node.id)!
      if ((childrenIndex.get(node.id) ?? []).length === 0 && !freeLanes.includes(lane)) {
        freeLanes.push(lane)
      }
    }
    freeLanes.sort((a, b) => a - b)
  }

  // 3. 行号 = BFS 展平序号；每条父子边把「线」绘制到其跨越的每一行
  const orderedNodes: BranchNodeData[] = []
  const rowIndexOfNode = new Map<string, number>()
  for (const layer of layers) {
    for (const node of layer) {
      rowIndexOfNode.set(node.id, orderedNodes.length)
      orderedNodes.push(node)
    }
  }

  const lineShapesByRow = new Map<number, Map<number, LineShape>>()
  const touch = (row: number, lane: number, active: boolean, mutate: (shape: LineShape) => void): void => {
    let byLane = lineShapesByRow.get(row)
    if (!byLane) {
      byLane = new Map()
      lineShapesByRow.set(row, byLane)
    }
    let shape = byLane.get(lane)
    if (!shape) {
      shape = { vline: false, left: false, right: false, active: false }
      byLane.set(lane, shape)
    }
    shape.active = shape.active || active
    mutate(shape)
  }

  for (const parent of orderedNodes) {
    const children = childrenIndex.get(parent.id) ?? []
    if (children.length === 0) continue
    const parentRow = rowIndexOfNode.get(parent.id)!
    const parentLane = laneOfNode.get(parent.id)!
    for (const child of children) {
      const childRow = rowIndexOfNode.get(child.id)!
      const childLane = laneOfNode.get(child.id)!
      const active = activePath.has(parent.id) && activePath.has(child.id)
      if (childLane === parentLane) {
        // 同轨延续：竖线贯穿父行之后直到子节点行（子节点标记会覆盖行内线）
        for (let row = parentRow + 1; row <= childRow; row++) {
          touch(row, parentLane, active, shape => {
            shape.vline = true
          })
        }
      } else {
        // 分叉：父轨道伸出横线，中间轨道横穿，目标轨道由子节点本身呈现
        const goesRight = childLane > parentLane
        const lo = Math.min(parentLane, childLane)
        const hi = Math.max(parentLane, childLane)
        for (let row = parentRow + 1; row <= childRow; row++) {
          touch(row, parentLane, active, shape => {
            if (goesRight) shape.right = true
            else shape.left = true
          })
          for (let lane = lo + 1; lane < hi; lane++) {
            touch(row, lane, active, shape => {
              shape.left = true
              shape.right = true
            })
          }
        }
      }
    }
  }

  // 4. 组装节点行
  const childCountByParent = new Map<string, number>()
  for (const [parentId, children] of childrenIndex) {
    childCountByParent.set(parentId, children.length)
  }

  const nodeRows: BranchTrackNodeRow[] = []
  for (let index = 0; index < orderedNodes.length; index++) {
    const node = orderedNodes[index]
    const lane = laneOfNode.get(node.id)!
    const children = childrenIndex.get(node.id) ?? []
    const liveChildren = children.filter(child => !child.deleted)
    nodeRows.push({
      kind: 'node',
      id: node.id,
      lane,
      node,
      active: activePath.has(node.id),
      current: graph.activeTailNodeId === node.id,
      candidateCount: liveChildren.length,
      isCandidateRoot: (childCountByParent.get(node.parentId ?? '') ?? 0) >= 2,
      lines: buildLinesForRow(lineShapesByRow.get(index))
    })
  }

  // 5. 折叠线性段（expandAll=false）：非关键节点、恰好单子、行内无分叉/他轨线的连续行合并
  const isCollapsible = (row: BranchTrackNodeRow): boolean => {
    if (row.current || row.isCandidateRoot || row.node.deleted || row.node.id === graph.rootNodeId) return false
    if (row.node.label?.trim()) return false
    const children = childrenIndex.get(row.node.id) ?? []
    if (children.length !== 1 || children[0].deleted) return false
    return row.lines.every(line => line.lane === row.lane && line.vline && !line.left && !line.right)
  }

  const rows: BranchTrackRow[] = []
  if (expandAll) {
    rows.push(...nodeRows)
  } else {
    let index = 0
    let collapsedSequence = 0
    while (index < nodeRows.length) {
      const row = nodeRows[index]
      if (!isCollapsible(row)) {
        rows.push(row)
        index += 1
        continue
      }
      let end = index
      while (end < nodeRows.length && nodeRows[end].lane === row.lane && isCollapsible(nodeRows[end])) {
        end += 1
      }
      const segment = nodeRows.slice(index, end)
      rows.push({
        kind: 'collapsed',
        id: `collapsed-${collapsedSequence++}`,
        lane: row.lane,
        count: segment.length,
        active: segment.every(item => item.active),
        lines: mergeSegmentLines(segment)
      })
      index = end
    }
  }

  return { rows, laneCount: maxLane + 1 }
}
