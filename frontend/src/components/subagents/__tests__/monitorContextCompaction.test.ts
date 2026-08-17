import { describe, expect, test } from 'vitest'
import type { SubAgentContextCompactionRecord } from '@shared/subAgentContextCompaction'
import type { Message } from '../../../types'
import {
  buildContextCompactionTimeline,
  latestContextBoundaryCompaction,
  latestContextCompaction,
  upsertContextCompactionRecord
} from '../monitorContextCompaction'

function record(overrides: Partial<SubAgentContextCompactionRecord> = {}): SubAgentContextCompactionRecord {
  return {
    id: 'c1',
    sequence: 1,
    attempt: 1,
    status: 'completed',
    strategy: 'summary',
    startedAt: 1,
    completedAt: 2,
    estimatedTokensBefore: 216000,
    thresholdTokens: 200000,
    estimatedTokensAfter: 7400,
    summarizedMessageCount: 5,
    sourceStartIndex: 1,
    sourceEndIndex: 6,
    boundaryContentIndex: 6,
    ...overrides
  }
}

function message(index: number): Message {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'model',
    content: `message-${index}`,
    parts: [{ text: `message-${index}` }],
    backendIndex: index
  } as Message
}

describe('SubAgent Monitor context compaction projection', () => {
  test('同 ID 的 provider 实报 token 更新原记录，不产生重复卡片', () => {
    const first = record({ status: 'completed' })
    const records = upsertContextCompactionRecord([], first)
    const updated = upsertContextCompactionRecord(records, record({ providerPromptTokensAfter: 7369 }))

    expect(updated).toHaveLength(1)
    expect(updated[0].providerPromptTokensAfter).toBe(7369)
    expect(latestContextCompaction(updated)?.id).toBe('c1')
  })

  test('只在真实 transcript 边界前插入标记', () => {
    const boundary = latestContextBoundaryCompaction([record()])
    const timeline = buildContextCompactionTimeline(
      [message(5), message(6), message(7)],
      boundary,
      5,
      8
    )

    expect(timeline.map(entry => entry.kind)).toEqual(['message', 'compaction', 'message', 'message'])
    expect(timeline[1]).toMatchObject({ kind: 'compaction', record: { boundaryContentIndex: 6 } })
  })

  test('边界不在当前分页窗口时不在顶部伪造位置', () => {
    const timeline = buildContextCompactionTimeline(
      [message(20), message(21)],
      record({ boundaryContentIndex: 6 }),
      20,
      22
    )

    expect(timeline.every(entry => entry.kind === 'message')).toBe(true)
  })
});
