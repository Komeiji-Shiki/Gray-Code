const mockReadFile = jest.fn()
const mockResolveUriWithInfo = jest.fn()
const mockNormalizeLineEndingsToLF = jest.fn((input: string) => input.replace(/\r\n?/g, '\n'))
const mockGetAllWorkspaces = jest.fn()

jest.mock('vscode', () => ({
  workspace: {
    fs: {
      readFile: mockReadFile,
      stat: jest.fn(),
      createDirectory: jest.fn(),
      writeFile: jest.fn()
    }
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: jest.fn((value: string) => ({ fsPath: value }))
  },
  FileType: {
    Directory: 2
  }
}))

jest.mock('../../../backend/tools/utils', () => ({
  getAllWorkspaces: (...args: any[]) => mockGetAllWorkspaces(...args),
  resolveUriWithInfo: (...args: any[]) => mockResolveUriWithInfo(...args),
  normalizeLineEndingsToLF: (input: string) => mockNormalizeLineEndingsToLF(input)
}))

import { buildProgressDocument } from '../../../backend/tools/progress/documentLayout'
import { createValidateProgressDocumentTool } from '../../../backend/tools/progress/validate_progress_document'

describe('validate_progress_document tool', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAllWorkspaces.mockReturnValue([{ name: 'workspace' }])
    mockResolveUriWithInfo.mockReturnValue({
      uri: { fsPath: 'D:/workspace/.limcode/progress.md' },
      error: undefined
    })
  })

  it('returns validation summary and progress snapshot for a valid progress document', async () => {
    const progressDoc = buildProgressDocument({
      projectId: 'workspace',
      projectName: 'Workspace',
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
      status: 'active',
      phase: 'plan',
      currentFocus: '整理实现计划',
      latestConclusion: '准备开始实现。',
      nextAction: '先补后端，再补前端。',
      activeArtifacts: {
        plan: '.limcode/plans/project-progress-document-tools-and-summary-card.plan.md'
      },
      todos: [
        { id: 'progress-01', content: '实现后端基础层', status: 'pending' }
      ],
      milestones: [],
      risks: [],
      log: []
    }).content

    mockReadFile.mockResolvedValue(new TextEncoder().encode(progressDoc))

    const tool = createValidateProgressDocumentTool()
    const result = await tool.handler({
      path: '.limcode/progress.md'
    })

    expect(result.success).toBe(true)
    expect((result.data as any).progressValidation).toMatchObject({
      isValid: true,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
      formatVersion: 1
    })
    expect((result.data as any).progressSnapshot).toMatchObject({
      path: '.limcode/progress.md',
      projectName: 'Workspace',
      status: 'active',
      phase: 'plan'
    })
  })

  it('reports validation failure for an invalid progress document', async () => {
    mockReadFile.mockResolvedValue(new TextEncoder().encode('# invalid progress doc'))

    const tool = createValidateProgressDocumentTool()
    const result = await tool.handler({
      path: '.limcode/progress.md'
    })

    expect(result.success).toBe(true)
    expect((result.data as any).progressValidation).toMatchObject({
      isValid: false,
      issueCount: 1,
      errorCount: 1,
      warningCount: 0
    })
    expect((result.data as any).issues).toEqual([
      expect.objectContaining({ severity: 'error' })
    ])
  })
})
