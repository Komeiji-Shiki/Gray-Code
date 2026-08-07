/**
 * soundEventController - VSCode 窗口焦点感知音效播放测试
 *
 * 覆盖 handleSoundEvent 的可见性/窗口焦点分级：
 * - 文档隐藏（窗口最小化/切走）→ 聚合不播，恢复可见时补播一次
 * - VSCode 窗口聚焦（用户看得见界面，事件结果已可见）→ 不播
 * - VSCode 窗口失焦（切到其他应用）→ 播放提醒
 * - 焦点状态由扩展侧 windowFocusChanged 命令经 setVscodeWindowFocused 更新
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock soundCues：避免真实 AudioContext，只验证「播放是否被触发」
vi.mock('../../services/soundCues', () => ({
  unlockAudio: vi.fn().mockResolvedValue({ success: true }),
  playCue: vi.fn().mockResolvedValue(true)
}))

import {
  handleSoundEvent,
  flushHiddenSoundEvent,
  registerVisibilityChangeHooks,
  resetSoundEventControllerForTests,
  setVscodeWindowFocused
} from '../../services/soundEventController'
import { unlockAudio, playCue } from '../../services/soundCues'
import type { SoundCue } from '../../services/soundCues'

const mockedPlayCue = vi.mocked(playCue)
const mockedUnlockAudio = vi.mocked(unlockAudio)

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
}

function makeEvent(cue: SoundCue = 'taskComplete', createdAt: number = Date.now()) {
  return { cue, source: 'taskEvent' as const, createdAt }
}

describe('soundEventController 窗口焦点感知', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSoundEventControllerForTests()
    setDocumentHidden(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetSoundEventControllerForTests()
  })

  it('默认状态（未收到 windowFocusChanged）视为窗口聚焦 → 不播', async () => {
    await handleSoundEvent(makeEvent())
    expect(mockedPlayCue).not.toHaveBeenCalled()
  })

  it('VSCode 窗口聚焦（setVscodeWindowFocused(true)）→ 不播（用户正看着界面）', async () => {
    setVscodeWindowFocused(true)
    await handleSoundEvent(makeEvent())
    expect(mockedPlayCue).not.toHaveBeenCalled()
  })

  it('VSCode 窗口失焦（setVscodeWindowFocused(false)）→ 播放提醒', async () => {
    setVscodeWindowFocused(false)
    await handleSoundEvent(makeEvent())

    expect(mockedUnlockAudio).toHaveBeenCalled()
    expect(mockedPlayCue).toHaveBeenCalledWith('taskComplete', expect.any(Object))
  })

  it('窗口失焦后重新聚焦：聚焦期间事件不播', async () => {
    setVscodeWindowFocused(false)
    await handleSoundEvent(makeEvent())
    expect(mockedPlayCue).toHaveBeenCalledTimes(1)

    // 用户回到 VSCode（聚焦）→ 之后的事件不再播放
    setVscodeWindowFocused(true)
    await handleSoundEvent(makeEvent())
    expect(mockedPlayCue).toHaveBeenCalledTimes(1)
  })

  it('文档隐藏 → 聚合不播放，恢复可见时补播一次（无论焦点状态，用户刚回到窗口）', async () => {
    setVscodeWindowFocused(true)
    setDocumentHidden(true)
    await handleSoundEvent(makeEvent())
    expect(mockedPlayCue).not.toHaveBeenCalled()

    setDocumentHidden(false)
    await flushHiddenSoundEvent()
    expect(mockedPlayCue).toHaveBeenCalledTimes(1)
  })

  it('visibilitychange 恢复可见时补播聚合事件（hooks 集成）', async () => {
    const cleanup = registerVisibilityChangeHooks()

    // 隐藏期间收到事件 → 聚合
    setDocumentHidden(true)
    await handleSoundEvent(makeEvent())
    expect(mockedPlayCue).not.toHaveBeenCalled()

    // 恢复可见 → visibilitychange 触发补播
    setDocumentHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(mockedPlayCue).toHaveBeenCalledTimes(1))

    cleanup()
  })

  it('事件过期（超过 3 秒）不播放也不聚合', async () => {
    const stale = Date.now() - 4000
    await handleSoundEvent(makeEvent('taskComplete', stale))
    expect(mockedPlayCue).not.toHaveBeenCalled()
  })
})
