/**
 * SubAgent Monitor 提示音触发规则（纯函数，便于单元测试）。
 *
 * 设计目标：
 * - run 状态迁移只在「非终态 → 终态」时触发一次提示音（completed → taskComplete，failed → taskError）
 * - 重试类事件（retrying / retryFailed）直接映射到警告/错误音
 * - 所有提示音统一走子代理独立开关（role: 'subagent'）
 */

import { handleSoundEvent } from '@/services/soundEventController'
import type { SoundCue } from '@/services/soundCues'

export type MonitorRunStatus = 'queued' | 'running' | 'paused' | 'awaiting_monitor_action' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** 活跃（非终态）run 状态：从这些状态进入终态才播提示音，取消/中断等用户侧终止不播 */
const ACTIVE_RUN_STATUSES: ReadonlySet<MonitorRunStatus> = new Set<MonitorRunStatus>([
  'queued',
  'running',
  'paused',
  'awaiting_monitor_action'
])

/** 状态迁移对应的提示音：completed → 任务完成；failed → 任务失败；其余迁移不播 */
export function getRunStatusTransitionCue(prev: MonitorRunStatus | undefined, next: MonitorRunStatus | undefined): 'taskComplete' | 'taskError' | null {
  if (!prev || !next) return null
  if (prev === next) return null
  if (!ACTIVE_RUN_STATUSES.has(prev)) return null
  if (next === 'completed') return 'taskComplete'
  if (next === 'failed') return 'taskError'
  return null
}

/** 重试类事件对应的提示音：retrying → 警告；retryFailed → 错误；其余事件不播 */
export function getRunRetryEventCue(eventType: string): 'warning' | 'error' | null {
  if (eventType === 'retrying') return 'warning'
  if (eventType === 'retryFailed') return 'error'
  return null
}

/** 播放一条子代理提示音（是否真正出声由音效控制器统一决定：设置开关/窗口焦点/音频解锁） */
export function playMonitorSubagentCue(cue: SoundCue, createdAt?: number): void {
  void handleSoundEvent({
    cue,
    source: 'taskEvent',
    role: 'subagent',
    createdAt: createdAt ?? Date.now()
  })
}
