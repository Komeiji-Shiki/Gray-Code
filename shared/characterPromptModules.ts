/** 角色资料只能通过预设引用；宿主负责提供本回合已经捕获的内容。 */
export const CHARACTER_PROMPT_MODULES = [
  { id: 'WORLDBOOK_DEPTH', name: '按历史深度插入世界书', description: '单独作为一条预设条目使用，按世界书自己的深度和角色插入。OpenAI 保留 system 角色，Gemini 与 Anthropic 转为 user 并保留位置。' },
  { id: 'CHARACTER', name: '角色设定', description: '角色描述、性格与场景。' },
  { id: 'CHARACTER_DESCRIPTION', name: '角色描述', description: '角色卡的 description 字段。' },
  { id: 'CHARACTER_PERSONALITY', name: '角色性格', description: '角色卡的 personality 字段。' },
  { id: 'CHARACTER_SCENARIO', name: '角色场景', description: '角色卡的 scenario 字段。' },
  { id: 'CHARACTER_EXAMPLES', name: '示例对话', description: '角色卡的 mes_example 字段，保留原文。' },
  { id: 'CHARACTER_SYSTEM', name: '角色系统提示词', description: '角色卡自带的 system_prompt。' },
  { id: 'CHARACTER_POST_HISTORY', name: '角色历史后提示词', description: '角色卡自带的 post_history_instructions。' },
  { id: 'USER_PERSONA', name: '用户角色设定', description: '当前角色会话填写的用户设定。' },
  { id: 'WORLDBOOK_BEFORE_CHARACTER', name: '角色前世界书', description: '本回合激活且位置为角色定义前的世界书条目。' },
  { id: 'WORLDBOOK_AFTER_CHARACTER', name: '角色后世界书', description: '本回合激活且位置为角色定义后的世界书条目。' },
  { id: 'WORLDBOOK_BEFORE_EXAMPLES', name: '示例前世界书', description: '本回合激活且位置为示例前的世界书条目。' },
  { id: 'WORLDBOOK_AFTER_EXAMPLES', name: '示例后世界书', description: '本回合激活且位置为示例后的世界书条目。' },
  { id: 'WORLDBOOK_BEFORE_NOTE', name: '作者注前世界书', description: '本回合激活且位置为作者注前的世界书条目。' },
  { id: 'WORLDBOOK_AFTER_NOTE', name: '作者注后世界书', description: '本回合激活且位置为作者注后的世界书条目。' },
] as const;

/** 用户主动创建的入门预设，不改写已有预设或工具范围。 */
export function createCharacterStarterPreset(id: string) {
  const sections = [
    ['role-system', '角色提示词', 'system', '根据角色设定与已有对话继续交流。\n{{$CHARACTER_SYSTEM}}'],
    ['world-before', '角色前世界书', 'system', '{{$WORLDBOOK_BEFORE_CHARACTER}}'],
    ['character', '角色设定', 'system', '{{$CHARACTER}}'],
    ['world-after', '角色后世界书', 'system', '{{$WORLDBOOK_AFTER_CHARACTER}}'],
    ['persona', '用户角色', 'system', '{{$USER_PERSONA}}'],
    ['examples-before', '示例前世界书', 'user', '{{$WORLDBOOK_BEFORE_EXAMPLES}}'],
    ['examples', '示例对话', 'user', '{{$CHARACTER_EXAMPLES}}'],
    ['examples-after', '示例后世界书', 'user', '{{$WORLDBOOK_AFTER_EXAMPLES}}'],
    ['note-before', '作者注前世界书', 'user', '{{$WORLDBOOK_BEFORE_NOTE}}'],
    ['note-after', '作者注后世界书', 'user', '{{$WORLDBOOK_AFTER_NOTE}}'],
    ['chat-history', '聊天历史', 'user', ''],
    ['post-history', '历史后提示词', 'user', '{{$CHARACTER_POST_HISTORY}}'],
    ['world-depth', '深度世界书', 'user', '{{$WORLDBOOK_DEPTH}}'],
  ];
  return { id, name: '基础角色对话', template: '', promptAssemblyMode: 'entries' as const, dynamicTemplateEnabled: false,
    dynamicTemplate: '', dynamicContextStrategy: 'preserve' as const,
    promptEntries: sections.map(([key, name, role, content], order) => ({ id: key, name, role: role as 'system' | 'user' | 'assistant', content, order,
      enabled: true, type: key === 'chat-history' ? 'chat_history' as const : 'prompt' as const })) };
}