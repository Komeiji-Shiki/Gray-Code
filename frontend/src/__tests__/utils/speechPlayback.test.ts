import { afterEach, describe, expect, test, vi } from 'vitest'
import { playClip } from '../../utils/speechPlayback'

class FakeAudio {
  static created: FakeAudio[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  paused = false
  constructor(readonly src: string) { FakeAudio.created.push(this) }
  play() { return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute() {}
}

const clip = { text: '你好', mimeType: 'audio/mpeg', base64: 'YQ==' }

afterEach(() => { vi.unstubAllGlobals(); FakeAudio.created.length = 0 })

describe('单段音频播放', () => {
  test('播放结束时完成，中止时暂停并以 AbortError 结束', async () => {
    vi.stubGlobal('Audio', FakeAudio)
    const finished = playClip(clip, new AbortController().signal)
    expect(FakeAudio.created[0].src).toBe('data:audio/mpeg;base64,YQ==')
    FakeAudio.created[0].onended!()
    await expect(finished).resolves.toBeUndefined()

    const controller = new AbortController()
    const stopped = playClip(clip, controller.signal)
    controller.abort()
    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeAudio.created[1].paused).toBe(true)
    expect(FakeAudio.created[1].onended).toBeNull()
  })

  test('播放出错时拒绝，已中止的信号不再创建音频', async () => {
    vi.stubGlobal('Audio', FakeAudio)
    const failing = playClip(clip, new AbortController().signal)
    FakeAudio.created[0].onerror!()
    await expect(failing).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    await expect(playClip(clip, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeAudio.created).toHaveLength(1)
  })
})
