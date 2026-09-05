import { describe, test, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { useAttachments } from '../../composables/useAttachments'
import type { Attachment } from '../../types'

vi.mock('../../composables/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/vscode', () => ({ showNotification: vi.fn().mockResolvedValue(undefined) }))

const readers: DeferredReader[] = []
class DeferredReader {
  result = 'data:text/plain;base64,ZmFrZQ=='
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  constructor() { readers.push(this) }
  readAsDataURL() {}
}
function file(name: string) { return new File(['fixture'], name, { type: 'text/plain' }) }
afterEach(() => { vi.unstubAllGlobals(); readers.length = 0 })

describe('attachment upload ownership', () => {
  test('image metadata records original dimensions rather than thumbnail dimensions', async () => {
    class ImageReader extends DeferredReader {
      result = 'data:image/png;base64,aW1hZ2U='
      readAsDataURL() { queueMicrotask(() => this.onload?.()) }
    }
    class OriginalImage {
      width = 1200
      height = 600
      naturalWidth = 1200
      naturalHeight = 600
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    }
    vi.stubGlobal('FileReader', ImageReader)
    vi.stubGlobal('Image', OriginalImage)
    const drawImage = vi.fn()
    const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as any)
    const dataUrl = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,dGh1bWI=')
    try {
      const attachment = await useAttachments().addAttachment(new File(['image'], 'image.png', { type: 'image/png' }))
      expect(attachment?.metadata).toEqual({ width: 1200, height: 600 })
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 100)
    } finally {
      canvasContext.mockRestore()
      dataUrl.mockRestore()
    }
  })
  test('clear discards pending attachment and stops the rest of its batch', async () => {
    vi.stubGlobal('FileReader', DeferredReader)
    const api = useAttachments()
    const adding = api.addAttachments([file('a.txt'), file('b.txt')])
    api.clearAttachments()
    readers[0].onload!()
    expect(await adding).toEqual([])
    expect(api.attachments.value).toEqual([])
    expect(readers).toHaveLength(1)
    expect(api.uploading.value).toBe(false)
  })

  test('all files in a pending batch stay with the originating draft across tab switches', async () => {
    vi.stubGlobal('FileReader', DeferredReader)
    const target = ref<Attachment[]>([])
    const originalDraft = target.value
    const api = useAttachments(target)
    const adding = api.addAttachments([file('a.txt'), file('b.txt')])
    target.value = []
    readers[0].onload!()
    // Allow the batch to start reading its second file.
    await vi.waitFor(() => expect(readers).toHaveLength(2))
    readers[1].onload!()
    await adding
    expect(target.value).toEqual([])
    expect(originalDraft.map(x => x.name)).toEqual(['a.txt', 'b.txt'])
    target.value = originalDraft
    expect(api.attachmentCount.value).toBe(2)
  })

  test('concurrent batches remain uploading until both finish', async () => {
    vi.stubGlobal('FileReader', DeferredReader)
    const api = useAttachments()
    const first = api.addAttachments([file('a.txt')])
    const second = api.addAttachments([file('b.txt')])
    readers[0].onload!()
    await first
    expect(api.uploading.value).toBe(true)
    readers[1].onload!()
    await second
    expect(api.uploading.value).toBe(false)
    expect(api.uploadProgress.value).toBe(0)
    expect(api.attachments.value).toHaveLength(2)
  })
})
