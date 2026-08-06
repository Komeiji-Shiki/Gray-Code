import { describe, expect, it } from 'vitest'
import type { BranchGraphData, BranchNodeData } from '../../../stores/chat/types'
import {
  buildFullBranchRows,
  buildNavigationBranchRows,
  buildTrackGraphRows,
  type BranchTrackGraph,
  type BranchTrackNodeRow
} from '../branchTreeLayout'

function node(id: string, parentId: string | null, overrides: Partial<BranchNodeData> = {}): BranchNodeData {
  return { id, parentId, role: 'model', createdAt: Number(id.replace(/\D/g, '')) || 0, ...overrides }
}

function linearGraph(length: number): BranchGraphData {
  const nodes: Record<string, BranchNodeData> = {}
  for (let index = 0; index < length; index++) {
    const id = `n${index}`
    const nextId = index < length - 1 ? `n${index + 1}` : undefined
    nodes[id] = node(id, index === 0 ? null : `n${index - 1}`, {
      role: index % 2 === 0 ? 'user' : 'model',
      activeChildId: nextId,
      parts: [{ text: `消息 ${index}` }]
    })
  }
  return { version: 1, rootNodeId: 'n0', activeTailNodeId: `n${length - 1}`, nodes }
}

describe('branchTreeLayout', () => {
  it('完整模式的线性长对话始终使用同一轨道', () => {
    const rows = buildFullBranchRows(linearGraph(20))

    expect(rows).toHaveLength(20)
    expect(new Set(rows.map(row => row.lane))).toEqual(new Set([0]))
  })

  it('只有兄弟候选才分配额外轨道，候选后续沿用自己的轨道', () => {
    const graph: BranchGraphData = {
      version: 1,
      rootNodeId: 'u1',
      activeTailNodeId: 'u3',
      nodes: {
        u1: node('u1', null, { role: 'user', activeChildId: 'a1' }),
        a1: node('a1', 'u1', { activeChildId: 'u2' }),
        u2: node('u2', 'a1', { role: 'user', activeChildId: 'u3' }),
        u3: node('u3', 'u2'),
        a2: node('a2', 'u1', { activeChildId: 'u4' }),
        u4: node('u4', 'a2', { role: 'user' })
      }
    }

    const laneById = new Map(buildFullBranchRows(graph).map(row => [row.id, row.lane]))
    expect(laneById.get('u1')).toBe(0)
    expect(laneById.get('a1')).toBe(0)
    expect(laneById.get('u2')).toBe(0)
    expect(laneById.get('u3')).toBe(0)
    expect(laneById.get('a2')).toBe(1)
    expect(laneById.get('u4')).toBe(1)
  })

  it('导航模式折叠线性中段但保留根节点和当前尾节点', () => {
    const rows = buildNavigationBranchRows(linearGraph(8))

    expect(rows.map(row => row.type)).toEqual(['node', 'collapsed', 'node'])
    expect(rows[0].id).toBe('n0')
    expect(rows[1]).toMatchObject({ type: 'collapsed', count: 6, lane: 0, active: true })
    expect(rows[2].id).toBe('n7')
  })

  it('导航模式保留分支点、候选根、命名节点和软删节点', () => {
    const graph: BranchGraphData = {
      version: 1,
      rootNodeId: 'root',
      activeTailNodeId: 'tail',
      nodes: {
        root: node('root', null, { role: 'user', activeChildId: 'active' }),
        active: node('active', 'root', { activeChildId: 'middle' }),
        middle: node('middle', 'active', { activeChildId: 'tail' }),
        tail: node('tail', 'middle'),
        named: node('named', 'root', { label: '保留的候选' }),
        deleted: node('deleted', 'root', { deleted: true })
      }
    }

    const rows = buildNavigationBranchRows(graph)
    const nodeIds = rows.filter(row => row.type === 'node').map(row => row.id)
    expect(nodeIds).toEqual(['root', 'active', 'tail', 'deleted', 'named'])
    expect(rows.some(row => row.type === 'collapsed' && row.count === 1)).toBe(true)
  })
})

describe('buildTrackGraphRows 轨道式完整消息图', () => {
  function nodeRowOf(graph: BranchTrackGraph, id: string): BranchTrackNodeRow {
    const row = graph.rows.find(r => r.kind === 'node' && r.id === id)
    if (!row || row.kind !== 'node') throw new Error(`missing node row: ${id}`)
    return row
  }

  it('线性长对话始终单轨道且无跨轨线', () => {
    const graph = buildTrackGraphRows(linearGraph(20), true)

    expect(graph.laneCount).toBe(1)
    expect(graph.rows).toHaveLength(20)
    expect(graph.rows.every(row => row.kind === 'node' && row.lane === 0)).toBe(true)
  })

  it('兄弟候选各占新轨道，候选结束后轨道释放可复用', () => {
    const graph: BranchGraphData = {
      version: 1,
      rootNodeId: 'root',
      activeTailNodeId: 'a3',
      nodes: {
        root: node('root', null, { role: 'user', activeChildId: 'a' }),
        a: node('a', 'root', { activeChildId: 'a1' }),
        a1: node('a1', 'a', { activeChildId: 'a2' }),
        a2: node('a2', 'a1', { activeChildId: 'a3' }),
        a3: node('a3', 'a2'),
        b: node('b', 'root'),
        c: node('c', 'a2')
      }
    }

    const result = buildTrackGraphRows(graph, true)
    const laneById = new Map(
      result.rows
        .filter((row): row is BranchTrackNodeRow => row.kind === 'node')
        .map(row => [row.id, row.lane])
    )
    expect(laneById.get('root')).toBe(0)
    expect(laneById.get('a')).toBe(0)
    expect(laneById.get('a1')).toBe(0)
    expect(laneById.get('a2')).toBe(0)
    expect(laneById.get('a3')).toBe(0)
    expect(laneById.get('b')).toBe(1)
    // b 是叶子 → 轨道 1 释放 → c 复用轨道 1，而不是新开轨道 2
    expect(laneById.get('c')).toBe(1)
    expect(result.laneCount).toBe(2)
  })

  it('分叉点行绘制跨轨横线，同轨延续绘制竖线', () => {
    const graph: BranchGraphData = {
      version: 1,
      rootNodeId: 'u1',
      activeTailNodeId: 'u3',
      nodes: {
        u1: node('u1', null, { role: 'user', activeChildId: 'a1' }),
        a1: node('a1', 'u1', { activeChildId: 'u2' }),
        u2: node('u2', 'a1', { role: 'user', activeChildId: 'u3' }),
        u3: node('u3', 'u2'),
        a2: node('a2', 'u1', { activeChildId: 'u4' }),
        u4: node('u4', 'a2', { role: 'user' })
      }
    }

    const result = buildTrackGraphRows(graph, true)
    // 行序：u1(0), a1(1), a2(2), u2(3), u4(4), u3(5)；轨道：u1/a1/u2/u3 = 0，a2/u4 = 1
    expect(result.laneCount).toBe(2)
    // 候选行 a2（轨 1）：轨 0 上应有分叉横线 + 主路径竖线（├ 形状）
    const a2Row = nodeRowOf(result, 'a2')
    expect(a2Row.lane).toBe(1)
    expect(a2Row.lines.find(line => line.lane === 0)).toMatchObject({ vline: true, right: true })
    // 主路径行 u2（轨 0）：轨 1 上应有候选分支的延续竖线
    const u2Row = nodeRowOf(result, 'u2')
    expect(u2Row.lines.find(line => line.lane === 1)).toMatchObject({ vline: true })
    // 活跃路径标记：候选分支的延续线非活跃，主路径延续线活跃
    expect(u2Row.lines.find(line => line.lane === 1)?.active).toBe(false)
    expect(u2Row.lines.find(line => line.lane === 0)?.active).toBe(true)
    // a2 行轨 0 的线同时承载主路径竖线（活跃）与分叉横线（非活跃），合并后 active 取并集
    expect(a2Row.lines.find(line => line.lane === 0)?.active).toBe(true)
  })

  it('折叠线性中段，保留根节点与当前尾节点', () => {
    const result = buildTrackGraphRows(linearGraph(8), false)

    expect(result.rows.map(row => row.kind)).toEqual(['node', 'collapsed', 'node'])
    expect(result.rows[0].id).toBe('n0')
    expect(result.rows[1]).toMatchObject({ kind: 'collapsed', count: 6, lane: 0, active: true })
    expect(result.rows[2].id).toBe('n7')
  })

  it('展开完整消息显示全部节点', () => {
    const result = buildTrackGraphRows(linearGraph(8), true)

    expect(result.rows).toHaveLength(8)
    expect(result.rows.every(row => row.kind === 'node')).toBe(true)
  })
})
