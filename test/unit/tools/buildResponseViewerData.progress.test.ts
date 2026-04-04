import { buildResponseViewerData } from '../../../frontend/src/components/message/responseViewer/buildResponseViewerData'
import type { Message, ToolUsage } from '../../../frontend/src/types'

describe('buildResponseViewerData progress integration', () => {
  function createAssistantMessage(overrides: Partial<Message> = {}): Message {
    return {
      id: 'assistant-message',
      role: 'assistant',
      content: '',
      timestamp: 1710000000000,
      parts: [],
      tools: [],
      ...overrides
    }
  }

  it('builds progress card data from direct tool results', () => {
    const tool: ToolUsage = {
      id: 'progress-tool-1',
      name: 'record_progress_milestone',
      status: 'success',
      args: {
        title: '完成后端基础层',
        summary: '已完成 schema 与工具骨架。'
      },
      result: {
        success: true,
        data: {
          path: '.limcode/progress.md',
          progressSnapshot: {
            formatVersion: 1,
            kind: 'limcode.progress',
            path: '.limcode/progress.md',
            projectId: 'workspace',
            projectName: 'Workspace',
            status: 'active',
            phase: 'implementation',
            currentFocus: '实现 Progress 工具',
            currentProgress: '1/1 个里程碑已完成；最新：PG1',
            latestConclusion: '后端基础层已经完成。',
            currentBlocker: null,
            nextAction: '开始接入前端摘要卡片。',
            updatedAt: '2026-04-03T12:00:00.000Z',
            activeArtifacts: {
              plan: '.limcode/plans/project-progress-document-tools-and-summary-card.plan.md'
            },
            stats: {
              milestonesTotal: 1,
              milestonesCompleted: 1,
              todosTotal: 4,
              todosCompleted: 1,
              todosInProgress: 2,
              todosCancelled: 0,
              activeRisks: 0
            },
            latestMilestone: {
              id: 'PG1',
              title: '完成后端基础层',
              status: 'completed',
              recordedAt: '2026-04-03T12:00:00.000Z'
            }
          }
        }
      }
    }

    const viewerData = buildResponseViewerData(createAssistantMessage({ tools: [tool] }))
    const progressTool = viewerData.common.tools[0]

    expect(progressTool.resultSource).toBe('tool')
    expect(progressTool.progressCardData).toMatchObject({
      path: '.limcode/progress.md',
      title: 'Workspace',
      phase: 'implementation',
      currentProgress: '1/1 个里程碑已完成；最新：PG1',
      latestMilestoneId: 'PG1',
      sourceTool: 'record_progress_milestone'
    })
    expect(progressTool.progressFallbackContent).toContain('已完成 schema 与工具骨架。')
  })

  it('builds progress validation card data from hidden function response messages', () => {
    const assistantMessage = createAssistantMessage({
      id: 'assistant-message-2',
      tools: [{
        id: 'progress-tool-2',
        name: 'validate_progress_document',
        args: {
          path: '.limcode/progress.md'
        }
      }]
    })

    const hiddenFunctionResponseMessage: Message = {
      id: 'function-response-message',
      role: 'tool',
      content: '',
      timestamp: 1710000000500,
      backendIndex: 18,
      isFunctionResponse: true,
      parts: [{
        functionResponse: {
          id: 'progress-tool-2',
          name: 'validate_progress_document',
          response: {
            success: true,
            data: {
              path: '.limcode/progress.md',
              progressValidation: {
                isValid: true,
                formatVersion: 1,
                issueCount: 0,
                errorCount: 0,
                warningCount: 0,
                issues: []
              },
              progressSnapshot: {
                formatVersion: 1,
                kind: 'limcode.progress',
                path: '.limcode/progress.md',
                projectId: 'workspace',
                projectName: 'Workspace',
                status: 'active',
                phase: 'plan',
                currentProgress: '尚无里程碑记录',
                updatedAt: '2026-04-03T12:30:00.000Z',
                activeArtifacts: {},
                stats: {
                  milestonesTotal: 0,
                  milestonesCompleted: 0,
                  todosTotal: 0,
                  todosCompleted: 0,
                  todosInProgress: 0,
                  todosCancelled: 0,
                  activeRisks: 0
                }
              }
            }
          }
        }
      }]
    }

    const viewerData = buildResponseViewerData(assistantMessage, {
      allMessages: [assistantMessage, hiddenFunctionResponseMessage]
    })
    const progressTool = viewerData.common.tools[0]

    expect(progressTool.resultSource).toBe('hiddenFunctionResponse')
    expect(progressTool.sourceBackendIndex).toBe(18)
    expect(progressTool.progressCardData).toMatchObject({
      path: '.limcode/progress.md',
      status: 'active',
      phase: 'plan',
      isValid: true,
      issueCount: 0,
      sourceTool: 'validate_progress_document'
    })
  })
})
