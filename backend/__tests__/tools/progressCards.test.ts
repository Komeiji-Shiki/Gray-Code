import {
  extractProgressCardData,
  formatProgressToolFallbackContent
} from '../../../frontend/src/utils/progressCards'
import { setLanguage } from '../../../frontend/src/i18n'

// 进度卡文案走 i18n：固定英文，断言不依赖进程/环境默认语言
setLanguage('en')

describe('progressCards utility', () => {
  beforeEach(() => {
    setLanguage('en')
  })

  test('extracts create_progress card data from progressSnapshot first', () => {
    const card = extractProgressCardData(
      'create_progress',
      { projectName: 'Workspace' },
      {
        success: true,
        data: {
          path: '.graycode/progress.md',
          progressSnapshot: {
            formatVersion: 1,
            kind: 'limcode.progress',
            path: '.graycode/progress.md',
            projectId: 'workspace',
            projectName: 'Workspace',
            status: 'active',
            phase: 'plan',
            currentFocus: '整理范围',
            currentProgress: '尚无里程碑记录',
            latestConclusion: '准备开始实现。',
            currentBlocker: null,
            nextAction: '开始实现后端。',
            updatedAt: '2026-04-03T12:00:00.000Z',
            activeArtifacts: {
              plan: '.graycode/plans/project-progress-document-tools-and-summary-card.plan.md'
            },
            stats: {
              milestonesTotal: 0,
              milestonesCompleted: 0,
              todosTotal: 2,
              todosCompleted: 0,
              todosInProgress: 1,
              todosCancelled: 0,
              activeRisks: 1
            }
          }
        }
      }
    )

    expect(card).toMatchObject({
      path: '.graycode/progress.md',
      title: 'Workspace',
      projectId: 'workspace',
      projectName: 'Workspace',
      status: 'active',
      phase: 'plan',
      currentFocus: '整理范围',
      currentProgress: '尚无里程碑记录',
      latestConclusion: '准备开始实现。',
      nextAction: '开始实现后端。',
      milestonesTotal: 0,
      todosTotal: 2,
      todosInProgress: 1,
      activeRisks: 1,
      activePlanPath: '.graycode/plans/project-progress-document-tools-and-summary-card.plan.md',
      sourceTool: 'create_progress'
    })
  })

  test('extracts record_progress_milestone card data from milestone snapshot', () => {
    const card = extractProgressCardData(
      'record_progress_milestone',
      { title: '完成后端基础层' },
      {
        success: true,
        data: {
          path: '.graycode/progress.md',
          progressSnapshot: {
            formatVersion: 1,
            kind: 'limcode.progress',
            path: '.graycode/progress.md',
            projectId: 'workspace',
            projectName: 'Workspace',
            status: 'active',
            phase: 'implementation',
            currentFocus: '实现 Progress 工具',
            currentProgress: '1/1 个里程碑已完成；最新：PG1',
            latestConclusion: '后端基础层已经完成。',
            nextAction: '开始接入前端摘要卡片。',
            updatedAt: '2026-04-03T12:10:00.000Z',
            activeArtifacts: {
              review: '.graycode/review/project-progress-review.md'
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
              recordedAt: '2026-04-03T12:10:00.000Z'
            }
          },
          progressDelta: {
            type: 'milestone_recorded',
            milestoneId: 'PG1'
          }
        }
      }
    )

    expect(card).toMatchObject({
      path: '.graycode/progress.md',
      status: 'active',
      phase: 'implementation',
      currentProgress: '1/1 个里程碑已完成；最新：PG1',
      latestConclusion: '后端基础层已经完成。',
      nextAction: '开始接入前端摘要卡片。',
      milestonesTotal: 1,
      milestonesCompleted: 1,
      latestMilestoneId: 'PG1',
      latestMilestoneTitle: '完成后端基础层',
      latestMilestoneStatus: 'completed',
      activeReviewPath: '.graycode/review/project-progress-review.md',
      sourceTool: 'record_progress_milestone'
    })
    expect(card?.latestConclusionPreview).toContain('后端基础层已经完成。')
  })

  test('extracts validate_progress_document card data from validation summary', () => {
    const card = extractProgressCardData(
      'validate_progress_document',
      { path: '.graycode/progress.md' },
      {
        success: true,
        data: {
          path: '.graycode/progress.md',
          progressValidation: {
            isValid: false,
            formatVersion: 1,
            issueCount: 1,
            errorCount: 1,
            warningCount: 0,
            issues: [
              { severity: 'error', code: 'progress_document_invalid', message: 'Progress document metadata block is missing or empty' }
            ]
          },
          progressSnapshot: {
            formatVersion: 1,
            kind: 'limcode.progress',
            path: '.graycode/progress.md',
            projectId: 'workspace',
            projectName: 'Workspace',
            status: 'blocked',
            phase: 'plan',
            currentProgress: '尚无里程碑记录',
            updatedAt: '2026-04-03T12:20:00.000Z',
            activeArtifacts: {},
            stats: { milestonesTotal: 0, milestonesCompleted: 0, todosTotal: 0, todosCompleted: 0, todosInProgress: 0, todosCancelled: 0, activeRisks: 0 }
          }
        }
      }
    )

    expect(card).toMatchObject({
      path: '.graycode/progress.md',
      status: 'blocked',
      phase: 'plan',
      isValid: false,
      issueCount: 1,
      errorCount: 1,
      sourceTool: 'validate_progress_document'
    })
    expect(card?.issues).toEqual([
      expect.objectContaining({ code: 'progress_document_invalid', severity: 'error' })
    ])
  })

  test('formats progress fallback content from snapshot or args', () => {
    expect(formatProgressToolFallbackContent(
      'update_progress',
      {},
      {
        data: {
          progressSnapshot: {
            currentFocus: '实现前端卡片',
            currentProgress: '1/2 个里程碑已完成；最新：PG1',
            latestConclusion: '后端已完成。',
            nextAction: '继续实现前端。'
          }
        }
      }
    )).toContain('实现前端卡片')

    expect(formatProgressToolFallbackContent(
      'record_progress_milestone',
      { summary: '完成后端基础层。' }
    )).toBe('完成后端基础层。')

    expect(formatProgressToolFallbackContent(
      'validate_progress_document',
      {},
      {
        data: {
          progressValidation: {
            isValid: true,
            issueCount: 0,
            errorCount: 0,
            warningCount: 0,
          }
        }
      }
    )).toContain('Valid: true')
  })
})
