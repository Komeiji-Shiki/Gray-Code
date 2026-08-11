const mockCreateDirectory = jest.fn().mockResolvedValue(undefined)
const mockStat = jest.fn().mockRejectedValue({ code: 'FileNotFound' })
const mockWriteFile = jest.fn().mockResolvedValue(undefined)
const mockGetAllWorkspaces = jest.fn()
const mockResolveUriWithInfo = jest.fn()
const mockSyncProgressFromReviewArtifact = jest.fn().mockResolvedValue([])

jest.mock('vscode', () => ({
  workspace: {
    fs: {
      createDirectory: mockCreateDirectory,
      stat: mockStat,
      writeFile: mockWriteFile
    }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}))

jest.mock('../../../backend/tools/utils', () => ({
  getAllWorkspaces: (...args: any[]) => mockGetAllWorkspaces(...args),
  resolveUriWithInfo: (...args: any[]) => mockResolveUriWithInfo(...args)
}))

jest.mock('../../../backend/tools/progress/autoSync', () => ({
  syncProgressFromReviewArtifact: (...args: any[]) => mockSyncProgressFromReviewArtifact(...args)
}))

import { createCreateReviewTool } from '../../../backend/tools/review/create_review'

describe('create_review tool', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAllWorkspaces.mockReturnValue([{ name: 'workspace' }])
    mockResolveUriWithInfo.mockReturnValue({
      uri: { fsPath: 'D:/workspace/.graycode/review/workspace-review.md' },
      error: undefined
    })
  })

  test('writes a V4 review markdown document and returns snapshot-driven summary fields', async () => {
    const tool = createCreateReviewTool()
    const setCustomMetadata = jest.fn().mockResolvedValue(undefined)
    const result = await tool.handler({
      title: 'Workspace Review',
      overview: 'Review the current workspace end-to-end',
      review: 'Initial review scope'
    }, {
      conversationId: 'conversation-1',
      conversationStore: {
        getCustomMetadata: jest.fn().mockResolvedValue(null),
        setCustomMetadata
      }
    } as any)

    expect(result.success).toBe(true)
    expect(result.requiresUserConfirmation).toBeUndefined()
    expect(result.data.path).toBe('.graycode/review/workspace-review.md')
    expect(result.data.content).toContain('# Workspace Review')
    expect(result.data.content).toContain('## 评审快照')
    expect(result.data.content).toContain('```json')
    expect(result.data.content).toContain('"formatVersion": 4')
    expect(result.data.reviewSnapshot.formatVersion).toBe(4)
    expect(result.data.reviewSnapshot.render.locale).toBe('zh-CN')
    expect(result.data.reviewValidation.detectedFormat).toBe('v4')
    expect(result.data.reviewDelta).toMatchObject({ type: 'created' })
    expect(result.data.title).toBe('Workspace Review')
    expect(result.data.status).toBe('in_progress')
    expect(result.data.totalMilestones).toBe(0)
    expect(result.data.totalFindings).toBe(0)

    expect(setCustomMetadata).toHaveBeenCalledWith(
      'conversation-1',
      'reviewSession',
      expect.objectContaining({
        reviewPath: '.graycode/review/workspace-review.md',
        status: 'in_progress'
      })
    )
    expect(mockCreateDirectory).toHaveBeenCalledWith({
      fsPath: 'D:/workspace/.graycode/review'
    })
    expect(mockResolveUriWithInfo).toHaveBeenCalledWith('.graycode/review/workspace-review.md')
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockSyncProgressFromReviewArtifact).toHaveBeenCalledWith({
      reviewPath: '.graycode/review/workspace-review.md',
      title: 'Workspace Review',
      eventMessage: '同步审查文档：.graycode/review/workspace-review.md'
    })
  })

  test('rejects create_review when the conversation already has an active review session', async () => {
    const tool = createCreateReviewTool()
    const result = await tool.handler({
      review: '# Review'
    }, {
      conversationId: 'conversation-1',
      conversationStore: {
        getCustomMetadata: jest.fn().mockResolvedValue({
          reviewRunId: 'review-1',
          reviewPath: '.graycode/review/existing.md',
          status: 'in_progress',
          createdAt: '2026-03-17T00:00:00.000Z',
          finalizedAt: null
        }),
        setCustomMetadata: jest.fn()
      }
    } as any)

    expect(result.success).toBe(false)
    expect(result.error).toContain('active review session already exists')
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  test('rejects paths outside .graycode/review', async () => {
    const tool = createCreateReviewTool()
    const result = await tool.handler({
      review: '# Invalid',
      path: '.graycode/plans/not-allowed.md'
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('.graycode/review/**.md')
    expect(mockResolveUriWithInfo).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})
