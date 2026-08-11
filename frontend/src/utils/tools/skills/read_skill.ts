/**
 * read_skill 工具注册
 * 
 * 替代原有的 toggle_skills 工具。
 * AI 通过 read_skill 按需读取 Skill 内容，不再使用拼接注入。
 */

import { registerTool } from '../../toolRegistry'
import ReadSkillComponent from '../../../components/tools/skills/read_skill.vue'
import { getToolMetaDescription } from '../toolMetaLookup'

// 注册 read_skill 工具
registerTool('read_skill', {
  name: 'read_skill',
  label: 'Read Skill',
  icon: 'codicon-book',
  
  // 描述生成器 - 显示加载的 skill 名称
  descriptionFormatter: (args) => {
    const name = args?.name
    // TODO(meta): 兜底描述改从后端声明取（单一来源）；toolMeta 缺失时回退硬编码
    return name ? `Load: ${name}` : getToolMetaDescription('read_skill') ?? 'Read skill'
  },
  
  // 使用自定义组件显示内容
  contentComponent: ReadSkillComponent
})

// 兼容旧的 toggle_skills 工具调用（历史对话中可能存在）
registerTool('toggle_skills', {
  name: 'toggle_skills',
  label: 'Toggle Skills (Legacy)',
  icon: 'codicon-lightbulb',
  
  descriptionFormatter: (args) => {
    const entries = Object.entries(args).filter(([_, v]) => typeof v === 'boolean')
    const enabling = entries.filter(([_, v]) => v === true).map(([k]) => k)
    const disabling = entries.filter(([_, v]) => v === false).map(([k]) => k)
    
    const parts: string[] = []
    if (enabling.length > 0) {
      parts.push(`Enable: ${enabling.join(', ')}`)
    }
    if (disabling.length > 0) {
      parts.push(`Disable: ${disabling.join(', ')}`)
    }
    
    return parts.length > 0 ? parts.join(' | ') : getToolMetaDescription('toggle_skills') ?? 'Toggle skills'
  }
})
