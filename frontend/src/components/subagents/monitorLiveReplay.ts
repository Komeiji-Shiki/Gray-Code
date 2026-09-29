import type { Ref } from 'vue'
import type { SubAgentRunEvent, SubAgentRunContentWindow, SubAgentRunManifest } from './monitorTypes'
import { applyStreamChunkToContents } from '@/stores/agentRun/contentDelta'
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
    if (!event.runId || !hasRenderableMonitorLiveDelta(event)) return contentWindow
    const eventRevision = getMonitorLiveDeltaRevision(event)
    const windowRevision = typeof contentWindow.contentRevision === 'number' ? contentWindow.contentRevision : 0
    if (eventRevision < windowRevision) return contentWindow

    const freshness = {
      contentCount: manifest?.contentCount ?? contentWindow.totalCount,
      contentRevision: eventRevision,
      eventSequence: getMonitorLiveDeltaSequence(event) ?? manifest?.eventSequence ?? contentWindow.eventSequence
    }
    if (!isRunWindowTailAuthoritative(contentWindow, freshness)) return undefined

    // 修改原因：后端不再为每个 SubAgent llm_delta 附带完整 snapshot，否则大输出会造成 postMessage 与事件数组 O(n²) 膨胀。
    // 修改方式：当事件仍携带轻量可渲染 delta 且窗口已确认是同 revision 尾部时，Monitor 前端用共享 Content[] delta reducer 本地更新已加载 run。
    // 修改目的：兼容旧协议实时输出，同时新瘦身协议不会把大正文塞进 event。
    const timestamp = event.timestamp || Date.now()
    const nextContents = applyStreamChunkToContents(contentWindow.contents || [], event.payload, timestamp, contentWindow.startIndex || 0)
    const sequence = getMonitorLiveDeltaSequence(event)
    return {
      ...contentWindow,
      contents: nextContents,
      floorIndices: appendMonitorFloorIndices(contentWindow, nextContents),
      endIndex: Math.max(contentWindow.endIndex, contentWindow.startIndex + nextContents.length),
      totalCount: Math.max(contentWindow.totalCount, contentWindow.startIndex + nextContents.length),
      contentRevision: eventRevision,
      eventSequence: Math.max(contentWindow.eventSequence || 0, sequence ?? manifest?.eventSequence ?? 0)
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

    let workingWindow = currentWindow
    const stillBlocked: MonitorLiveDeltaEvent[] = []
    for (const event of replayable) {
      const nextWindow = applyLiveDeltaToWindow(event, workingWindow, {
        contentCount: workingWindow.totalCount,
        eventSequence: getMonitorLiveDeltaSequence(event) ?? workingWindow.eventSequence
      })
      if (!nextWindow) {
        stillBlocked.push(event)
        continue
      }
      workingWindow = nextWindow
    }

    windowsByRunId.value = {
      ...windowsByRunId.value,
      [runId]: workingWindow
    }
    setLiveDeltaBuffer(runId, [...stillBlocked, ...remaining])
  }


  return { bufferLiveDeltaEvent, clearSupersededLiveDeltaBuffer, applyLiveDeltaToWindow, replayBufferedLiveDeltas }
}
