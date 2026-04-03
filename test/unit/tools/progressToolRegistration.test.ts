import { getToolConfig, toolRegistry } from '../../../frontend/src/utils/toolRegistry'

import '../../../frontend/src/utils/tools/progress/create_progress'
import '../../../frontend/src/utils/tools/progress/update_progress'
import '../../../frontend/src/utils/tools/progress/record_progress_milestone'
import '../../../frontend/src/utils/tools/progress/validate_progress_document'

describe('progress tool frontend registration', () => {
  afterAll(() => {
    toolRegistry.unregister('create_progress')
    toolRegistry.unregister('update_progress')
    toolRegistry.unregister('record_progress_milestone')
    toolRegistry.unregister('validate_progress_document')
  })

  it('registers create_progress for frontend display', () => {
    const config = getToolConfig('create_progress')
    expect(config).toBeDefined()
    expect(config?.name).toBe('create_progress')
    expect(config?.descriptionFormatter({ projectName: 'Workspace' })).toBe('Workspace')
  })

  it('registers update_progress for frontend display', () => {
    const config = getToolConfig('update_progress')
    expect(config).toBeDefined()
    expect(config?.name).toBe('update_progress')
    expect(config?.descriptionFormatter({ currentFocus: '实现前端卡片' })).toBe('实现前端卡片')
  })

  it('registers record_progress_milestone for frontend display', () => {
    const config = getToolConfig('record_progress_milestone')
    expect(config).toBeDefined()
    expect(config?.name).toBe('record_progress_milestone')
    expect(config?.descriptionFormatter({ title: '完成后端基础层' })).toBe('完成后端基础层')
  })

  it('registers validate_progress_document for frontend display', () => {
    const config = getToolConfig('validate_progress_document')
    expect(config).toBeDefined()
    expect(config?.name).toBe('validate_progress_document')
    expect(config?.descriptionFormatter({ path: '.limcode/progress.md' })).toBe('.limcode/progress.md')
  })
})
