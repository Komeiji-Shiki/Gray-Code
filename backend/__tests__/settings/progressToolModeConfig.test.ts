import { SettingsManager, type SettingsStorage } from '../../../backend/modules/settings/SettingsManager'
import {
  ASK_PROMPT_MODE,
  DESIGN_PROMPT_MODE,
  PLAN_PROMPT_MODE,
  REVIEW_PROMPT_MODE,
} from '../../../backend/modules/settings/types'

class MemorySettingsStorage implements SettingsStorage {
  constructor(private readonly loaded: any = null) {}

  async load() {
    return this.loaded
  }

  async save() {
    return undefined
  }
}

const PROGRESS_TOOLS = ['create_progress', 'update_progress', 'record_progress_milestone', 'validate_progress_document']

describe('progress tool mode config', () => {
  it('adds progress tools to design, plan, and review modes but not ask mode', () => {
    expect(DESIGN_PROMPT_MODE.toolPolicy).toEqual(expect.arrayContaining(PROGRESS_TOOLS))
    expect(PLAN_PROMPT_MODE.toolPolicy).toEqual(expect.arrayContaining(PROGRESS_TOOLS))
    expect(REVIEW_PROMPT_MODE.toolPolicy).toEqual(expect.arrayContaining(PROGRESS_TOOLS))

    for (const toolName of PROGRESS_TOOLS) {
      expect(ASK_PROMPT_MODE.toolPolicy).not.toContain(toolName)
    }
  })

  it('SettingsManager synchronizes built-in mode toolPolicy updates for progress tools', async () => {
    const storage = new MemorySettingsStorage({
      toolsConfig: {
        system_prompt: {
          currentModeId: 'code',
          modes: {
            code: { id: 'code', name: 'Code', icon: 'code', template: 'code', dynamicTemplateEnabled: true, dynamicTemplate: '' },
            design: {
              ...DESIGN_PROMPT_MODE,
              toolPolicy: ['read_file']
            },
            plan: {
              ...PLAN_PROMPT_MODE,
              toolPolicy: ['read_file']
            },
            ask: {
              ...ASK_PROMPT_MODE,
              toolPolicy: ['read_file', 'create_progress']
            },
            review: {
              ...REVIEW_PROMPT_MODE,
              toolPolicy: ['read_file']
            }
          }
        }
      }
    })

    const manager = new SettingsManager(storage)
    await manager.initialize()

    const config = manager.getSystemPromptConfig()
    expect(config.modes.design.toolPolicy).toEqual(DESIGN_PROMPT_MODE.toolPolicy)
    expect(config.modes.plan.toolPolicy).toEqual(PLAN_PROMPT_MODE.toolPolicy)
    expect(config.modes.review.toolPolicy).toEqual(REVIEW_PROMPT_MODE.toolPolicy)
    expect(config.modes.ask.toolPolicy).toEqual(ASK_PROMPT_MODE.toolPolicy)
  })
})
