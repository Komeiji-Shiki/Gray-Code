/**
 * useDeferredSave - 防抖提交与异步 flush 语义测试
 *
 * 覆盖：
 * - schedule 防抖：延迟后仅执行最后一次调度
 * - flush 立即触发待提交，返回的 Promise 等待异步提交结束
 * - flush 等待 timer 已触发但仍在执行的异步提交（无需再次 schedule）
 * - 提交执行期间继续 schedule：后续 flush 仍会提交新调度，且同时等待在途提交
 * - timer 触发的提交被拒绝：不产生 unhandled rejection；flush 仍能感知并传播 rejection
 * - flush 传播同步抛错与异步拒绝
 * - cancel 取消尚未触发的提交；isPending 反映待触发状态
 * - flushOnUnmount：true 时卸载触发未提交内容；false 时卸载取消
 */
import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { useDeferredSave, type UseDeferredSaveOptions } from '../../composables/useDeferredSave'

type DeferredSaveApi = ReturnType<typeof useDeferredSave>

/** 在组件内调用 composable（onUnmounted 需要活动组件实例），并暴露其 API */
function mountHost(options: UseDeferredSaveOptions = {}) {
  return mount(defineComponent({
    setup() {
      return useDeferredSave(options)
    },
    template: '<div />'
  }))
}

describe('useDeferredSave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('schedule 防抖：延迟后仅执行最后一次调度', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi
    const commit = vi.fn()

    api.schedule(commit)
    api.schedule(commit)
    api.schedule(commit)

    expect(api.isPending()).toBe(true)
    expect(commit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(api.isPending()).toBe(false)
  })

  test('flush 立即触发待提交，并等待异步提交结束', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi
    let resolveCommit!: () => void
    const commit = vi.fn(() => new Promise<void>(res => { resolveCommit = res }))

    api.schedule(commit)
    let flushed = false
    const flushPromise = api.flush().then(() => { flushed = true })

    // flush 已触发提交（无需等待防抖延迟），但提交尚未结束
    expect(commit).toHaveBeenCalledTimes(1)
    expect(flushed).toBe(false)

    resolveCommit()
    await flushPromise
    expect(flushed).toBe(true)
  })

  test('flush 等待 timer 已触发但仍在执行的异步提交', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi
    let resolveCommit!: () => void
    const commit = vi.fn(() => new Promise<void>(res => { resolveCommit = res }))

    api.schedule(commit)
    await vi.advanceTimersByTimeAsync(100) // timer 触发，提交在途
    expect(commit).toHaveBeenCalledTimes(1)

    let flushed = false
    const flushPromise = api.flush().then(() => { flushed = true })
    expect(flushed).toBe(false)

    resolveCommit()
    await flushPromise
    expect(flushed).toBe(true)
  })

  test('提交执行期间继续 schedule：后续 flush 提交新调度并等待在途提交', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = vi.fn(() => new Promise<void>(res => { resolveFirst = res }))
    const second = vi.fn(() => new Promise<void>(res => { resolveSecond = res }))

    api.schedule(first)
    await vi.advanceTimersByTimeAsync(100) // first 在途
    api.schedule(second)                    // 调度期间继续 schedule

    let flushed = false
    const flushPromise = api.flush().then(() => { flushed = true })
    // 提交串行执行：第二次保存必须等第一次 settle，防止旧值晚完成后覆盖新值。
    expect(second).not.toHaveBeenCalled()
    expect(flushed).toBe(false)

    resolveFirst()
    await Promise.resolve()
    await Promise.resolve()
    expect(second).toHaveBeenCalledTimes(1)
    expect(flushed).toBe(false)

    resolveSecond()
    await flushPromise
    expect(flushed).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
  })

  test('timer 触发的提交被拒绝：不产生 unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const wrapper = mountHost({ delay: 100 })
      const api = wrapper.vm as unknown as DeferredSaveApi

      api.schedule(() => Promise.reject(new Error('boom')))
      await vi.advanceTimersByTimeAsync(100)

      // 排空微任务队列，让 Node 有机会报告 unhandled rejection
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('flush 传播 timer 触发的提交 rejection', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi

    api.schedule(() => Promise.reject(new Error('boom')))
    await vi.advanceTimersByTimeAsync(100)

    await expect(api.flush()).rejects.toThrow('boom')
  })

  test('新的成功提交会取代此前失败结果，不会永久污染后续 flush', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi

    api.schedule(() => Promise.reject(new Error('old failure')))
    await vi.advanceTimersByTimeAsync(100)
    await expect(api.flush()).rejects.toThrow('old failure')

    const latest = vi.fn().mockResolvedValue(undefined)
    api.schedule(latest)
    await expect(api.flush()).resolves.toBeUndefined()
    expect(latest).toHaveBeenCalledTimes(1)
    await expect(api.flush()).resolves.toBeUndefined()
  })

  test('flush 传播同步抛错的提交 rejection', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi

    api.schedule(() => { throw new Error('sync boom') })
    await expect(api.flush()).rejects.toThrow('sync boom')
  })

  test('cancel 取消尚未触发的提交', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi
    const commit = vi.fn()

    api.schedule(commit)
    expect(api.isPending()).toBe(true)
    api.cancel()
    expect(api.isPending()).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(commit).not.toHaveBeenCalled()
  })

  test('无待提交/在途提交时 flush 立即 resolve', async () => {
    const wrapper = mountHost({ delay: 100 })
    const api = wrapper.vm as unknown as DeferredSaveApi
    await expect(api.flush()).resolves.toBeUndefined()
  })

  test('flushOnUnmount=true：卸载时触发尚未提交的内容', () => {
    const wrapper = mountHost({ delay: 100, flushOnUnmount: true })
    const api = wrapper.vm as unknown as DeferredSaveApi
    const commit = vi.fn()

    api.schedule(commit)
    wrapper.unmount()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  test('flushOnUnmount=false：卸载时取消尚未提交的内容', () => {
    const wrapper = mountHost({ delay: 100, flushOnUnmount: false })
    const api = wrapper.vm as unknown as DeferredSaveApi
    const commit = vi.fn()

    api.schedule(commit)
    wrapper.unmount()
    expect(commit).not.toHaveBeenCalled()
  })
})
