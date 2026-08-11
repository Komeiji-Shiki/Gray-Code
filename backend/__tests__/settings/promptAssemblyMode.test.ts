import { SettingsManager } from '../../../backend/modules/settings/SettingsManager'
import {
  CHAT_HISTORY_PROMPT_ENTRY_ID,
  DEFAULT_SYSTEM_PROMPT_CONFIG,
  type PromptMode
} from '../../../backend/modules/settings/types'
import { createSettingsManager } from '../__fixtures__/settingsFixtures'

function createManager() {
  return createSettingsManager({
    toolsConfig: {
      system_prompt: DEFAULT_SYSTEM_PROMPT_CONFIG
    }
  })
}

describe('prompt assembly mode settings', () => {
  test('adds exactly one chat-history entry when saving entries mode without one', async () => {
    const manager = createManager()
    await manager.initialize()

    const mode: PromptMode = {
      id: 'entry-mode',
      name: 'Entry Mode',
      template: 'legacy template',
      promptAssemblyMode: 'entries',
      dynamicTemplateEnabled: true,
      dynamicTemplate: 'legacy dynamic',
      promptEntries: [
        {
          id: 'system-entry',
          name: 'System Entry',
          type: 'prompt',
          enabled: true,
          role: 'system',
          content: 'system',
          order: 0
        }
      ]
    }

    await manager.savePromptMode(mode)

    const saved = manager.getSystemPromptConfig().modes['entry-mode']
    expect(saved.promptAssemblyMode).toBe('entries')
    expect(saved.promptEntries?.filter(entry => entry.type === 'chat_history')).toHaveLength(1)
    expect(saved.promptEntries?.find(entry => entry.type === 'chat_history')).toMatchObject({
      id: CHAT_HISTORY_PROMPT_ENTRY_ID,
      name: 'Chat History',
      enabled: true,
      role: 'user',
      content: ''
    })
  })

  test('does not force chat-history into legacy mode', async () => {
    const manager = createManager()
    await manager.initialize()

    const mode: PromptMode = {
      id: 'legacy-mode',
      name: 'Legacy Mode',
      template: 'legacy template',
      promptAssemblyMode: 'legacy',
      dynamicTemplateEnabled: true,
      dynamicTemplate: 'legacy dynamic'
    }

    await manager.savePromptMode(mode)

    const saved = manager.getSystemPromptConfig().modes['legacy-mode']
    expect(saved.promptAssemblyMode).toBe('legacy')
    expect(saved.promptEntries).toBeUndefined()
  })

  test('renames a newly saved custom mode without overwriting its config', async () => {
    const manager = createManager()
    await manager.initialize()

    const mode: PromptMode = {
      id: 'mode_1700000000000',
      name: 'New Mode',
      template: 'custom template',
      promptAssemblyMode: 'entries',
      dynamicTemplateEnabled: false,
      dynamicTemplate: 'custom dynamic',
      dynamicContextStrategy: 'preserve',
      toolPolicy: ['read_file'],
      promptEntries: [
        {
          id: 'system-entry',
          name: 'System Entry',
          type: 'prompt',
          enabled: true,
          role: 'system',
          content: 'system',
          order: 0
        }
      ]
    }

    await manager.savePromptMode(mode)
    const renamed = await manager.renamePromptMode(mode.id, 'Renamed Mode')

    expect(renamed).toMatchObject({
      id: mode.id,
      name: 'Renamed Mode',
      template: 'custom template',
      dynamicTemplateEnabled: false,
      dynamicTemplate: 'custom dynamic',
      dynamicContextStrategy: 'preserve',
      toolPolicy: ['read_file']
    })

    const savedModes = manager.getSystemPromptConfig().modes
    expect(savedModes[mode.id]).toBeDefined()
    expect(Object.values(savedModes).filter(saved => saved.id === mode.id)).toHaveLength(1)
    expect(savedModes[mode.id].name).toBe('Renamed Mode')
    expect(savedModes[mode.id].promptEntries?.filter(entry => entry.type === 'chat_history')).toHaveLength(1)
  })
})
