const mockCreateDirectory = jest.fn().mockResolvedValue(undefined)
const mockReadFile = jest.fn()
const mockWriteFile = jest.fn().mockResolvedValue(undefined)
const mockGetAllWorkspaces = jest.fn()
const mockResolveUriWithInfo = jest.fn()
const mockNormalizeLineEndingsToLF = jest.fn((input: string) => input.replace(/\r\n?/g, '\n'))
const mockSyncProgressFromDesignArtifact = jest.fn().mockResolvedValue([])

jest.mock('vscode', () => ({
  workspace: {
    fs: {
      createDirectory: mockCreateDirectory,
      readFile: mockReadFile,
      writeFile: mockWriteFile
    }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}))

jest.mock('../../../backend/tools/utils', () => ({
  getAllWorkspaces: (...args: any[]) => mockGetAllWorkspaces(...args),
  resolveUriWithInfo: (...args: any[]) => mockResolveUriWithInfo(...args),
  normalizeLineEndingsToLF: (input: string) => mockNormalizeLineEndingsToLF(input)
}))

jest.mock('../../../backend/tools/progress/autoSync', () => ({
  syncProgressFromDesignArtifact: (...args: any[]) => mockSyncProgressFromDesignArtifact(...args)
}))

import { createUpdateDesignTool } from '../../../backend/tools/design/update_design'

describe('update_design tool', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAllWorkspaces.mockReturnValue([{ name: 'workspace' }])
    mockResolveUriWithInfo.mockReturnValue({
      uri: { fsPath: 'D:/workspace/.graycode/design/api-design.md' },
      error: undefined
    })
    mockReadFile.mockResolvedValue(new TextEncoder().encode('# Existing Design'))
  })

  it('rewrites an existing design document and returns requiresUserConfirmation', async () => {
    const tool = createUpdateDesignTool()
    const result = await tool.handler({
      path: '.graycode/design/api-design.md',
      design: '# Revised Design\r\n\r\n- scope',
      changeSummary: '补充边界说明'
    })

    expect(result.success).toBe(true)
    expect(result.requiresUserConfirmation).toBe(true)
    expect(result.data).toEqual({
      path: '.graycode/design/api-design.md',
      content: '# Revised Design\n\n- scope',
      changeSummary: '补充边界说明'
    })
    expect(mockReadFile).toHaveBeenCalledWith({ fsPath: 'D:/workspace/.graycode/design/api-design.md' })
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockSyncProgressFromDesignArtifact).toHaveBeenCalledWith({
      designPath: '.graycode/design/api-design.md',
      title: undefined
    })
  })

  it('rejects update_design when the target design file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('File not found'))

    const tool = createUpdateDesignTool()
    const result = await tool.handler({
      path: '.graycode/design/api-design.md',
      design: '# Revised Design'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('File not found')
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('rejects paths outside .graycode/design', async () => {
    const tool = createUpdateDesignTool()
    const result = await tool.handler({
      path: '.graycode/plans/not-allowed.md',
      design: '# Invalid'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('.graycode/design/**.md')
    expect(mockResolveUriWithInfo).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
