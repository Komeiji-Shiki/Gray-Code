import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { defineComponent, nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  listeners: [] as ((message: any) => void)[],
  settings: { speech: { enabled: true, autoPlay: true } } as Record<string, any>,
  synthesis: [] as { text: string; resolve: () => void; reject: (error: Error) => void }[],
  played: [] as string[],
  finishPlayback: [] as (() => void)[],
}))

vi.mock('@/utils/vscode', () => ({
  onMessageFromExtension: (listener: (message: any) => void) => {
    mocks.listeners.push(listener)
    return () => { mocks.listeners.splice(mocks.listeners.indexOf(listener), 1) }
  },
  sendToExtension: vi.fn((type: string, data: Record<string, any>) => {
    if (type === 'platform.settings.get') return Promise.resolve(structuredClone(mocks.settings))
    return new Promise((resolve, reject) => {
      mocks.synthesis.push({ text: data.text, reject,
        resolve: () => resolve({ provider: 'fish', clips: [{ text: data.text, mimeType: 'audio/mpeg', base64: 'YQ==' }] }) })
    })
  }),
}))

vi.mock('@/utils/speechPlayback', () => ({
  playClip: vi.fn((clip: { text: string }, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    mocks.played.push(clip.text)
    mocks.finishPlayback.push(resolve)
    signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true })
  })),
}))

import { speak, speechEnabled, speechPlaying, stopSpeech, useSpeechAutoPlay, useSpeechSettingsSync } from '../../composables/useSpeechPlayback'

const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }
const emit = (message: any) => { for (const listener of [...mocks.listeners]) listener(message) }

beforeEach(() => {
  mocks.synthesis.length = 0
  mocks.played.length = 0
  mocks.finishPlayback.length = 0
  mocks.settings = { speech: { enabled: true, autoPlay: true } }
})
afterEach(() => stopSpeech())

describe('朗读播放', () => {
  test('合成过程中停止，合成返回后不会再出声', async () => {
    const reading = speak('第一句。', 'stop-during-synthesis')
    expect(speechPlaying.value).toBe(true)
    stopSpeech()
    expect(speechPlaying.value).toBe(false)
    mocks.synthesis[0].resolve()
    await reading
    expect(mocks.played).toEqual([])
  })

  test('播放当前段的同时合成下一段', async () => {
    const first = `${'甲'.repeat(1000)}。`
    const second = `${'乙'.repeat(1000)}。`
    const reading = speak(first + second, 'pipeline')
    expect(mocks.synthesis.map(item => item.text)).toEqual([first])
    mocks.synthesis[0].resolve()
    await flush()
    expect(mocks.played).toEqual([first])
    expect(mocks.synthesis.map(item => item.text)).toEqual([first, second])
    mocks.finishPlayback[0]()
    mocks.synthesis[1].resolve()
    await flush()
    expect(mocks.played).toEqual([first, second])
    mocks.finishPlayback[1]()
    await reading
    expect(speechPlaying.value).toBe(false)
  })

  test('开始新的朗读会中止上一轮，旧的合成结果被丢弃', async () => {
    const old = speak('旧的回复。', 'old')
    const current = speak('新的回复。', 'new')
    mocks.synthesis[0].resolve()
    await old
    mocks.synthesis[1].resolve()
    await flush()
    expect(mocks.played).toEqual(['新的回复。'])
    expect(speechPlaying.value).toBe(true)
    mocks.finishPlayback[0]()
    await current
    expect(speechPlaying.value).toBe(false)
  })

  test('合成失败交给调用方，停止后的失败不再上报', async () => {
    const failing = speak('会失败。', 'failing')
    mocks.synthesis[0].reject(new Error('quota'))
    await expect(failing).rejects.toThrow('quota')
    const stopped = speak('停止后失败。', 'stopped')
    stopSpeech()
    mocks.synthesis[1].reject(new Error('late'))
    await expect(stopped).resolves.toBeUndefined()
  })
})

describe('朗读设置与自动朗读', () => {
  function mountWith(store: { currentConversationId: string | null; allMessages: any[] }, report = vi.fn()) {
    return mount(defineComponent({
      setup() { useSpeechSettingsSync(); useSpeechAutoPlay(store, report); return () => null },
    }))
  }

  test('设置保存后重新读取开关', async () => {
    mocks.settings = { speech: { enabled: false } }
    const wrapper = mountWith(reactive({ currentConversationId: null, allMessages: [] }))
    await flush()
    expect(speechEnabled.value).toBe(false)
    mocks.settings = { speech: { enabled: true, autoPlay: true } }
    emit({ type: 'settingsChanged' })
    await flush()
    expect(speechEnabled.value).toBe(true)
    wrapper.unmount()
  })

  test('只在当前会话整轮完成时朗读最后一条回复，同一条只读一次', async () => {
    const store = reactive({ currentConversationId: 'current', allMessages: [
      { id: 'user', role: 'user', content: '问题' },
      { id: 'reply-1', role: 'assistant', content: '**完成**了。' },
    ] as any[] })
    const wrapper = mountWith(store)
    await flush()
    emit({ type: 'streamChunk', data: { type: 'toolIteration', conversationId: 'current' } })
    emit({ type: 'streamChunk', data: { type: 'complete', conversationId: 'other' } })
    await nextTick()
    expect(mocks.synthesis).toEqual([])
    emit({ type: 'streamChunkBatch', data: [{ type: 'delta', conversationId: 'current' }, { type: 'complete', conversationId: 'current' }] })
    await nextTick()
    expect(mocks.synthesis.map(item => item.text)).toEqual(['完成了。'])
    emit({ type: 'streamChunk', data: { type: 'complete', conversationId: 'current' } })
    await nextTick()
    expect(mocks.synthesis).toHaveLength(1)
    wrapper.unmount()
    expect(mocks.listeners).toEqual([])
  })
})
