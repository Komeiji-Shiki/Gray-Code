import type { PromptAssemblyMode, PromptEntry } from './types'

/** 导入、预览、保存共用条目规范化，聊天历史位置只使用传入的正式标识。 */
export function promptEntryHelpers(CHAT_HISTORY_PROMPT_ENTRY_ID: string) {
  function normalizePromptAssemblyMode(value: unknown): PromptAssemblyMode {
    return value === 'entries' ? 'entries' : 'legacy'
  }

  function createChatHistoryPromptEntry(order = 1000): PromptEntry {
    return {
      id: CHAT_HISTORY_PROMPT_ENTRY_ID,
      name: 'Chat History',
      type: 'chat_history',
      enabled: true,
      role: 'user',
      content: '',
      order
    }
  }

  function normalizePromptEntries(entries: PromptEntry[] | undefined, assemblyMode: PromptAssemblyMode): PromptEntry[] {
    const rawEntries = Array.isArray(entries) ? entries : []
    const normalized = rawEntries
      .filter(entry => entry && typeof entry === 'object')
      .map((entry, index) => ({
        id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `entry_${index}`,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `Prompt ${index + 1}`,
        type: entry.type === 'chat_history' || entry.id === CHAT_HISTORY_PROMPT_ENTRY_ID ? 'chat_history' as const : 'prompt' as const,
        enabled: entry.enabled !== false,
        role: entry.role === 'user' || entry.role === 'assistant' || entry.role === 'system' ? entry.role : 'system',
        content: typeof entry.content === 'string' ? entry.content : '',
        fakeThought: typeof entry.fakeThought === 'string' ? entry.fakeThought : '',
        order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : index
      }))

    if (assemblyMode === 'entries') {
      const result: PromptEntry[] = []
      let hasChatHistory = false
      for (const entry of normalized) {
        if (entry.type !== 'chat_history') {
          result.push(entry)
          continue
        }
        if (hasChatHistory) continue
        hasChatHistory = true
        result.push({
          ...createChatHistoryPromptEntry(entry.order),
          name: entry.name.trim() || 'Chat History'
        })
      }
      if (!hasChatHistory) {
        result.push(createChatHistoryPromptEntry(result.length))
      }
      return result
        .sort((a, b) => a.order - b.order)
        .map((entry, index) => ({ ...entry, order: index }))
    }

    return normalized
      .filter(entry => entry.type !== 'chat_history')
      .sort((a, b) => a.order - b.order)
      .map((entry, index) => ({ ...entry, order: index }))
  }

  function clonePromptEntries(entries: PromptEntry[]): PromptEntry[] {
    return entries.map(entry => ({ ...entry }))
  }


  return { normalizePromptAssemblyMode, normalizePromptEntries, clonePromptEntries }
}
