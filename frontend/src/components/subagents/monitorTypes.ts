import type { Content } from '@/types'
import type { MonitorRunStatus as RunStatus } from './monitorSoundCues'
import type { SubAgentRunContentWindowState } from './monitorWindowState'

export interface SubAgentRunEvent {
  runId: string
  agentName?: string
  type: string
  timestamp: number
  toolId?: string
  toolName?: string
  eventSequence?: number
  contentRevision?: number
  payload?: any
}

export interface SubAgentRunManifest {
  runId: string
  agentName?: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  conversationId?: string
  contentCount: number
  eventCount: number
  contentRevision?: number
  eventSequence?: number
  preview?: string
  lastMessageRole?: Content['role']
  canRetry?: boolean
  legacy?: boolean
  continuedFromRunId?: string
  streamingContentIndex?: number | null
}

export type SubAgentRunContentWindow = SubAgentRunContentWindowState

export interface SubAgentRunSnapshot {
  runId: string
  agentName?: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  contents: Content[]
  events: SubAgentRunEvent[]
  streamingContentIndex?: number | null
  conversationId?: string
  contentRevision?: number
  eventSequence?: number
}
