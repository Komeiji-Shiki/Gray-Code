import { describe, test, expect, vi, afterEach } from 'vitest'
import { useAttachments } from '../../composables/useAttachments'

const savePastedImageToWorkspace = vi.hoisted(() => vi.fn())

vi.mock('../../composables/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../../utils/vscode', () => ({ showNotification: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../services/context', () => ({ savePastedImageToWorkspace }))

class ImageReader {
  result = 'data:image/png;base64,aW1n'
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  onabort: null | (() => void) = null
  readAsDataURL() { queueMicrotask(() => this.onload?.()) }
}

function imageFile() {
  return new File(['image'], 'image.png', { type: 'image/png' })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  savePastedImageToWorkspace.mockReset()
})

function stubBrowserImageTools() {
  class ImageStub {
    width = 10
    height = 10
    naturalWidth = 10
    naturalHeight = 10
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  }
  vi.stubGlobal('FileReader', ImageReader)
  vi.stubGlobal('Image', ImageStub)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as any)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,dGh1bWI=')
}

describe('粘贴图片写入工作区', () => {
  test('保存成功后附件记录工作区相对路径', async () => {
    stubBrowserImageTools()
    savePastedImageToWorkspace.mockResolvedValue('.graycode/attachments/pasted-1.png')

    const attachment = await useAttachments().addAttachment(imageFile(), [], {
      savePastedImages: true,
      conversationId: 'conv-a'
    })

    expect(savePastedImageToWorkspace).toHaveBeenCalledWith(
      { name: 'image.png', mimeType: 'image/png', data: 'aW1n' },
      'conv-a'
    )
    expect(attachment?.metadata).toMatchObject({
      sourcePath: '.graycode/attachments/pasted-1.png',
      pastedToWorkspace: true
    })
  })

  test('没有工作区时图片仍按附件发送，不记录路径', async () => {
    stubBrowserImageTools()
    savePastedImageToWorkspace.mockResolvedValue(null)

    const attachment = await useAttachments().addAttachment(imageFile(), [], { savePastedImages: true })

    expect(attachment).not.toBeNull()
    expect(attachment?.metadata?.pastedToWorkspace).toBeUndefined()
    expect(attachment?.metadata?.sourcePath).toBeUndefined()
  })

  test('普通选文件不触发工作区写入', async () => {
    stubBrowserImageTools()
    savePastedImageToWorkspace.mockResolvedValue('.graycode/attachments/pasted-1.png')

    await useAttachments().addAttachment(imageFile())

    expect(savePastedImageToWorkspace).not.toHaveBeenCalled()
  })
})
