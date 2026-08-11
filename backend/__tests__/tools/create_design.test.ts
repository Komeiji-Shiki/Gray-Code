const mockMkdir = jest.fn().mockResolvedValue(undefined)
const mockReadFile = jest.fn().mockRejectedValue({ code: 'FileNotFound' })
const mockWriteFile = jest.fn().mockResolvedValue(undefined)
const mockGetAllWorkspaces = jest.fn()
const mockResolveUriWithInfo = jest.fn()
const mockNormalizeLineEndingsToLF = jest.fn((input: string) => input.replace(/\r\n?/g, '\n'))
const mockSyncProgressFromDesignArtifact = jest.fn().mockResolvedValue([])

jest.mock('vscode', () => ({
  workspace: {
    fs: {
      readFile: mockReadFile,
      writeFile: mockWriteFile
    }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}))

// ensureParentDir 现使用 fs.promises.mkdir（backend/tools/design/pathUtils.ts），
// 将真实 fs 的 mkdir 替换为 mock：避免测试在真实文件系统创建目录，并用于断言父目录创建
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: mockMkdir
    }
  }
})

jest.mock('../../../backend/tools/utils', () => ({
  getAllWorkspaces: (...args: any[]) => mockGetAllWorkspaces(...args),
  resolveUriWithInfo: (...args: any[]) => mockResolveUriWithInfo(...args),
  normalizeLineEndingsToLF: (input: string) => mockNormalizeLineEndingsToLF(input)
}))

jest.mock('../../../backend/tools/progress/autoSync', () => ({
  syncProgressFromDesignArtifact: (...args: any[]) => mockSyncProgressFromDesignArtifact(...args)
}))

import { createCreateDesignTool } from '../../../backend/tools/design/create_design'

describe('create_design tool', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAllWorkspaces.mockReturnValue([{ name: 'workspace' }])
    mockResolveUriWithInfo.mockReturnValue({
      uri: { fsPath: 'D:/workspace/.graycode/design/api-design.md' },
      error: undefined
    })
  })

  test('writes design markdown under .graycode/design and returns requiresUserConfirmation', async () => {
    const tool = createCreateDesignTool()
    const result = await tool.handler({
      title: 'API Design',
      design: '# API Design\r\n\r\n- scope'
    })

    expect(result.success).toBe(true)
    expect(result.requiresUserConfirmation).toBe(true)
    expect(result.data).toEqual({
      path: '.graycode/design/api-design.md',
      content: '# API Design\n\n- scope'
    })

    expect(mockMkdir).toHaveBeenCalledWith('D:/workspace/.graycode/design', { recursive: true })
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockResolveUriWithInfo).toHaveBeenCalledWith('.graycode/design/api-design.md', undefined)
    expect(mockSyncProgressFromDesignArtifact).toHaveBeenCalledWith({
      designPath: '.graycode/design/api-design.md',
      title: 'API Design'
    })

    const writtenBytes = mockWriteFile.mock.calls[0][1] as Uint8Array
    expect(new TextDecoder().decode(writtenBytes)).toBe('# API Design\n\n- scope')
  })

  test('rejects paths outside .graycode/design', async () => {
    const tool = createCreateDesignTool()
    const result = await tool.handler({
      design: '# Invalid',
      path: '.graycode/plans/not-allowed.md'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('.graycode/design/**.md')
    expect(mockResolveUriWithInfo).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
