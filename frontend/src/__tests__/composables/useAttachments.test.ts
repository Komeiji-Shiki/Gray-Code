/**
 * useAttachments - 视频缩略图 Promise 永不 settle 回归测试
 *
 * 问题背景：createVideoThumbnail 无超时、无 onloadedmetadata 兜底，
 * video.duration 为 NaN 时 currentTime 设 NaN 后 onseeked 永不触发，
 * addAttachments 永远停在 uploading=true（输入区被禁用）。
 *
 * 修复：整体超时（10s）、onerror/onabort 分支、settle 兜底；
 * duration 非法（NaN/Infinity/<=0）时放弃截帧；img 加载补 onerror。
 */
import { describe, expect, vi, beforeEach, afterEach } from 'vitest'
import { useAttachments } from '../../composables/useAttachments'

vi.mock('../../composables/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, currentLanguage: { value: 'zh-CN' } })
}))

vi.mock('../../utils/vscode', () => ({
  showNotification: vi.fn().mockResolvedValue(undefined)
}))

// FileReader mock：微任务完成读取，避免依赖真实 FileReader 的异步行为
class MockFileReader {
  result = 'data:video/mp4;base64,TESTDATA'
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(): void {
    queueMicrotask(() => this.onload?.())
  }
}

interface VideoStub {
  preload: string
  muted: boolean
  src: string
  duration: number
  currentTime: number
  videoWidth: number
  videoHeight: number
  onloadedmetadata: (() => void) | null
  onseeked: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
}

let videoStub: VideoStub

function installDomMocks(): void {
  videoStub = {
    preload: '',
    muted: false,
    src: '',
    duration: NaN,
    currentTime: 0,
    videoWidth: 320,
    videoHeight: 180,
    onloadedmetadata: null,
    onseeked: null,
    onerror: null,
    onabort: null
  }

  const ctxStub = {
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(200 * 200 * 4).fill(200) })
  }
  const canvasStub = {
    width: 0,
    height: 0,
    getContext: () => ctxStub,
    toDataURL: () => 'data:image/jpeg;base64,MOCK'
  }

  const originalCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
    if (tagName === 'video') return videoStub as any
    if (tagName === 'canvas') return canvasStub as any
    return originalCreateElement(tagName)
  }) as any)

  URL.createObjectURL = (() => 'blob:mock') as any
  URL.revokeObjectURL = (() => {}) as any
}

function videoFile(): File {
  return new File([new Uint8Array(8)], 'clip.mp4', { type: 'video/mp4' })
}

describe('useAttachments 视频缩略图', () => {
  let attachments: ReturnType<typeof useAttachments>

  beforeEach(() => {
    vi.useRealTimers()
    vi.stubGlobal('FileReader', MockFileReader)
    installDomMocks()
    // 静默预期内的缩略图失败日志（失败路径由 try/catch 正常消化）
    vi.spyOn(console, 'error').mockImplementation(() => {})
    attachments = useAttachments()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('duration 为 NaN 时不再挂起：附件正常添加、uploading 复位', async () => {
    videoStub.duration = NaN
    const promise = attachments.addAttachments([videoFile()])
    // 模拟浏览器触发 onloadedmetadata（duration 非法 → 放弃截帧）
    videoStub.onloadedmetadata!()
    const results = await promise

    expect(results).toHaveLength(1)
    expect(results[0].thumbnail).toBeUndefined()
    expect(attachments.uploading.value).toBe(false)
    expect(attachments.attachments.value).toHaveLength(1)
  })

  test('duration 为 Infinity/0 时同样放弃截帧不挂起', async () => {
    for (const badDuration of [Infinity, 0]) {
      videoStub.duration = badDuration
      const promise = attachments.addAttachments([videoFile()])
      videoStub.onloadedmetadata!()
      const results = await promise
      expect(results).toHaveLength(1)
      expect(results[0].thumbnail).toBeUndefined()
      expect(attachments.uploading.value).toBe(false)
      attachments.attachments.value = []
    }
  })

  test('视频加载失败（onerror）不挂起', async () => {
    videoStub.duration = 10
    const promise = attachments.addAttachments([videoFile()])
    videoStub.onerror!()
    const results = await promise

    expect(results).toHaveLength(1)
    expect(results[0].thumbnail).toBeUndefined()
    expect(attachments.uploading.value).toBe(false)
  })

  test('10 秒超时兜底：无任何事件时 Promise 仍然 settle', async () => {
    vi.useFakeTimers()
    const promise = attachments.addAttachments([videoFile()])
    // 不触发任何视频事件，仅推进时间触发整体超时
    await vi.advanceTimersByTimeAsync(10000)
    const results = await promise

    expect(results).toHaveLength(1)
    expect(attachments.uploading.value).toBe(false)
  })

  test('正常路径：loadedmetadata + seeked 生成缩略图', async () => {
    videoStub.duration = 10
    const promise = attachments.addAttachments([videoFile()])
    videoStub.onloadedmetadata!()
    videoStub.onseeked!()
    const results = await promise

    expect(results).toHaveLength(1)
    expect(results[0].thumbnail).toBe('data:image/jpeg;base64,MOCK')
    expect(attachments.uploading.value).toBe(false)
  })
})
