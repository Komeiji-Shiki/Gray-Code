import type { Ref } from 'vue'
import type { SubAgentRunEvent, SubAgentRunContentWindow, SubAgentRunManifest } from './monitorTypes'
import { applyStreamUpdatesToContents } from '@/stores/agentRun/contentDelta'
import { appendMonitorFloorIndices } from './monitorMessages'
import { isRunWindowTailAuthoritative } from './monitorWindowState'
import { DEFAULT_MONITOR_LIVE_DELTA_BUFFER_LIMIT, enqueueMonitorLiveDelta, getMonitorLiveDeltaRevision, getMonitorLiveDeltaSequence, hasRenderableMonitorLiveDelta, selectReplayableMonitorLiveDeltas, type MonitorLiveDeltaEvent } from './monitorLiveDeltaBuffer'

/** 每个监视器独立持有实时片段；仅向版本和窗口尾部都匹配的任务回放。 */
export function createMonitorLiveReplay(windowsByRunId: Ref<Record<string, SubAgentRunContentWindow>>) {
  const liveDeltaBuffersByRunId = new Map<string, MonitorLiveDeltaEvent[]>()
  function setLiveDeltaBuffer(runId: string, buffer: MonitorLiveDeltaEvent[]) {
    // 修改原因：缓冲区是 Map，Vue 不需要追踪它；但必须集中删除空数组，避免长期打开 Monitor 后残留空 run key。
    // 修改方式：空缓冲直接 delete，非空缓冲替换为新数组引用。
    // 修改目的：让有界缓冲的生命周期清晰，避免后台 run 持续占用内存。
    if (buffer.length === 0) {
      liveDeltaBuffersByRunId.delete(runId)
    } else {
      liveDeltaBuffersByRunId.set(runId, buffer)
    }
  }

  function bufferLiveDeltaEvent(event: SubAgentRunEvent) {
    if (!event.runId || !hasRenderableMonitorLiveDelta(event)) return
    const current = liveDeltaBuffersByRunId.get(event.runId)
    setLiveDeltaBuffer(
      event.runId,
      enqueueMonitorLiveDelta(current, event, DEFAULT_MONITOR_LIVE_DELTA_BUFFER_LIMIT)
    )
  }

  function clearSupersededLiveDeltaBuffer(runId: string, revision: number | undefined) {
    const current = liveDeltaBuffersByRunId.get(runId)
    if (!current || typeof revision !== 'number') return
    // 修改原因：content_snapshot 表示后端 transcript 已进入更新 revision，旧 revision 的 live delta 已被权威窗口取代。
    // 修改方式：低于新 revision 的缓冲 delta 提前淘汰，等于或高于 revision 的 delta 继续等待匹配窗口。
    // 修改目的：流结束或工具结果写入后，不让旧实时片段重新追加到新窗口。
    setLiveDeltaBuffer(runId, current.filter(event => getMonitorLiveDeltaRevision(event) >= revision))
  }

  type MonitorLiveDeltaFreshness = Pick<SubAgentRunManifest, 'contentCount' | 'eventSequence'>

  function applyLiveDeltaToWindow(
    event: MonitorLiveDeltaEvent,
    contentWindow: SubAgentRunContentWindow,
    manifest?: MonitorLiveDeltaFreshness
  ): SubAgentRunContentWindow | undefined {
    const result = applyLiveDeltaBatch([event], contentWindow, manifest)
    return result.blocked.length ? undefined : result.window
  }

  function applyLiveDeltaBatch<T extends MonitorLiveDeltaEvent>(
    events: readonly T[],
    contentWindow: SubAgentRunContentWindow,
    manifest?: MonitorLiveDeltaFreshness
  ): { window: SubAgentRunContentWindow; blocked: T[] } {
    const windowRevision = typeof contentWindow.contentRevision === 'number' ? contentWindow.contentRevision : 0
    const accepted: T[] = []
    const blocked: T[] = []
    for (const event of events) {
      if (!event.runId || !hasRenderableMonitorLiveDelta(event)) continue
      const revision = getMonitorLiveDeltaRevision(event)
      if (revision < windowRevision) continue
      if (!isRunWindowTailAuthoritative(contentWindow, {
        contentCount: manifest?.contentCount ?? contentWindow.totalCount,
        contentRevision: revision,
      })) blocked.push(event)
      else accepted.push(event)
    }
    if (!accepted.length) return { window: contentWindow, blocked }

    // 同一版本的片段合批后只复制一次尾消息，顺序、参数最终快照和 usage 仍逐事件应用。
    const nextContents = applyStreamUpdatesToContents(contentWindow.contents, accepted.map(event => ({
      chunk: event.payload, timestamp: event.timestamp || Date.now(),
    })), contentWindow.startIndex)
    const sequence = accepted.reduce((latest, event) => Math.max(latest,
      getMonitorLiveDeltaSequence(event) ?? manifest?.eventSequence ?? 0), contentWindow.eventSequence || 0)
    return {
      blocked,
      window: {
        ...contentWindow,
        contents: nextContents,
        floorIndices: appendMonitorFloorIndices(contentWindow, nextContents),
        endIndex: Math.max(contentWindow.endIndex, contentWindow.startIndex + nextContents.length),
        totalCount: Math.max(contentWindow.totalCount, contentWindow.startIndex + nextContents.length),
        contentRevision: windowRevision,
        eventSequence: sequence,
      },
    }
  }

  function replayBufferedLiveDeltas(runId: string) {
    const currentWindow = windowsByRunId.value[runId]
    const currentBuffer = liveDeltaBuffersByRunId.get(runId)
    if (!currentWindow || !currentBuffer?.length) return

    const { replayable, remaining } = selectReplayableMonitorLiveDeltas(currentBuffer, currentWindow)
    if (replayable.length === 0) {
      setLiveDeltaBuffer(runId, remaining)
      return
    }

    const result = applyLiveDeltaBatch(replayable, currentWindow, { contentCount: currentWindow.totalCount })

    windowsByRunId.value = {
      ...windowsByRunId.value,
      [runId]: result.window
    }
    setLiveDeltaBuffer(runId, [...result.blocked, ...remaining])
  }


  return { bufferLiveDeltaEvent, clearSupersededLiveDeltaBuffer, applyLiveDeltaToWindow, applyLiveDeltaBatch, replayBufferedLiveDeltas }
}
