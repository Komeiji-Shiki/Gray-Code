import { describe, expect, it } from 'vitest'
import type { BranchGraphData, BranchNodeData } from '../../../stores/chat/types'
import {
  buildFullBranchRows,
  buildNavigationBranchRows
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
