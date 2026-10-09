import { CHARACTER_PROMPT_MODULES } from '@shared/characterPromptModules'
import { computed } from 'vue'
import { useI18n } from '@/i18n'
import type { PromptModule, PromptAssemblyMode } from '@/components/settings/prompt/types'
import {
  CODE_MODE_TEMPLATE,
  DESIGN_MODE_TEMPLATE,
  PLAN_MODE_TEMPLATE,
  ASK_MODE_TEMPLATE,
  REVIEW_MODE_TEMPLATE,
  DEFAULT_DYNAMIC_CONTEXT_TEMPLATE
} from '@shared/defaultPromptTemplates'

/**
 * PromptSettings 的默认模板与模块目录。
 *
 * 模块 name/description 跟随界面语言；各模式的默认模板与后端共用 shared 中的同一份文本，
 * “恢复默认”与新建配置拿到的内容始终一致。
 */
export function usePromptModeDefaults() {
  const { t } = useI18n()

  // 静态变量（放入系统提示词，可被 API provider 缓存）
  // 模块 name/description/requiresConfig 元数据取自语言包（随界面语言切换）；
  // example 为变量内容预览（英文示例），保持原文不变。
  const STATIC_PROMPT_MODULES = computed<PromptModule[]>(() => [
    {
      id: 'ENVIRONMENT',
      name: t('components.settings.promptSettings.modules.ENVIRONMENT.name'),
      description: t('components.settings.promptSettings.modules.ENVIRONMENT.description'),
      example: `====

ENVIRONMENT

Current Workspace: /path/to/project
Operating System: Windows 11
Timezone: Asia/Shanghai
User Language: zh-CN
Please respond using the user's language by default.`
    },
    {
      id: 'TOOLS',
      name: t('components.settings.promptSettings.modules.TOOLS.name'),
      description: t('components.settings.promptSettings.modules.TOOLS.description'),
      example: `====

TOOLS

You have access to these tools:

## read_file
Description: Read file content
...`
    },
    {
      id: 'CONTEXT_BADGE_FORMAT',
      name: t('components.settings.promptSettings.modules.CONTEXT_BADGE_FORMAT.name'),
      description: t('components.settings.promptSettings.modules.CONTEXT_BADGE_FORMAT.description'),
      example: `====

CONTEXT BADGE FORMAT

<lim-context type="file" path="example-report.pdf" binary="true" title="example-report.pdf (示例)">

</lim-context>

- title 属性是徽章标题
- 标签体（开闭标签之间）才是正文
- binary="true" 时正文为空，不应按文本解析`
    },
    {
      id: 'MCP_TOOLS',
      name: t('components.settings.promptSettings.modules.MCP_TOOLS.name'),
      description: t('components.settings.promptSettings.modules.MCP_TOOLS.description'),
      example: `====

MCP TOOLS

Additional tools from MCP servers:
...`,
      requiresConfig: t('components.settings.promptSettings.modules.MCP_TOOLS.requiresConfig')
    },
    {
      id: 'MEMORY',
      name: t('components.settings.promptSettings.modules.MEMORY.name'),
      description: t('components.settings.promptSettings.modules.MEMORY.description'),
      example: `====

MEMORY

Engineering log memory

memory_wake loads project conventions and lessons saved in earlier sessions...`,
      requiresConfig: t('components.settings.promptSettings.modules.MEMORY.requiresConfig')
    }
  ])

  // 动态变量（作为上下文消息临时插入，不存储到历史记录）
  const DYNAMIC_CONTEXT_MODULES = computed<PromptModule[]>(() => [
    ...CHARACTER_PROMPT_MODULES.map(module => ({ ...module, example: '由当前角色会话生成' })),
    {
      id: 'TODO_LIST',
      name: t('components.settings.promptSettings.modules.TODO_LIST.name'),
      description: t('components.settings.promptSettings.modules.TODO_LIST.description'),
      example: `====

TODO LIST

Total: 3 | pending: 1 | in_progress: 1 | completed: 1 | cancelled: 0
- [in_progress] 实现 {{$TODO_LIST}} 注入  \`#inject-todo\`
- [pending] 增量更新 todo_update  \`#todo-update\`
- [completed] 精简 todo_write 工具响应  \`#slim-result\``
    },
    {
      id: 'WORKSPACE_FILES',
      name: t('components.settings.promptSettings.modules.WORKSPACE_FILES.name'),
      description: t('components.settings.promptSettings.modules.WORKSPACE_FILES.description'),
      example: `====

WORKSPACE FILES

The following is a list of files in the current workspace:

src/
  main.ts
  utils/
    helper.ts`,
      requiresConfig: t('components.settings.promptSettings.modules.WORKSPACE_FILES.requiresConfig')
    },
    {
      id: 'OPEN_TABS',
      name: t('components.settings.promptSettings.modules.OPEN_TABS.name'),
      description: t('components.settings.promptSettings.modules.OPEN_TABS.description'),
      example: `====

OPEN TABS

Currently open files in editor:
  - src/main.ts
  - src/utils/helper.ts`,
      requiresConfig: t('components.settings.promptSettings.modules.OPEN_TABS.requiresConfig')
    },
    {
      id: 'ACTIVE_EDITOR',
      name: t('components.settings.promptSettings.modules.ACTIVE_EDITOR.name'),
      description: t('components.settings.promptSettings.modules.ACTIVE_EDITOR.description'),
      example: `====

ACTIVE EDITOR

Currently active file: src/main.ts`,
      requiresConfig: t('components.settings.promptSettings.modules.ACTIVE_EDITOR.requiresConfig')
    },
    {
      id: 'DIAGNOSTICS',
      name: t('components.settings.promptSettings.modules.DIAGNOSTICS.name'),
      description: t('components.settings.promptSettings.modules.DIAGNOSTICS.description'),
      example: `====

DIAGNOSTICS

The following diagnostics were found in the workspace:

src/main.ts:
  Line 10: [Error] Cannot find name 'foo'. (ts)
  Line 15: [Warning] 'bar' is defined but never used. (ts)`,
      requiresConfig: t('components.settings.promptSettings.modules.DIAGNOSTICS.requiresConfig')
    },
    {
      id: 'PINNED_FILES',
      name: t('components.settings.promptSettings.modules.PINNED_FILES.name'),
      description: t('components.settings.promptSettings.modules.PINNED_FILES.description'),
      example: `====

PINNED FILES CONTENT

The following are pinned files...

--- README.md ---
# Project Title
...`,
      requiresConfig: t('components.settings.promptSettings.modules.PINNED_FILES.requiresConfig')
    },
    {
      id: 'SKILLS',
      name: t('components.settings.promptSettings.modules.SKILLS.name'),
      description: t('components.settings.promptSettings.modules.SKILLS.description'),
      example: `====

ACTIVE SKILLS

The following skills are currently active...

## pymatgen

# Pymatgen - Python Materials Genomics
...`,
      requiresConfig: t('components.settings.promptSettings.modules.SKILLS.requiresConfig')
    }
  ])

  // 静态变量 ID 集合（模块 ID 恒定，不随语言变化）
  const staticModuleIds = new Set(STATIC_PROMPT_MODULES.value.map(module => module.id))

  // 动态变量 ID 集合
  const dynamicModuleIds = new Set(DYNAMIC_CONTEXT_MODULES.value.map(module => module.id))

  const DEFAULT_TEMPLATE = CODE_MODE_TEMPLATE

  // 与后端默认值共享同一来源，保证“恢复默认”和新建配置行为一致。
  const DEFAULT_DYNAMIC_TEMPLATE = DEFAULT_DYNAMIC_CONTEXT_TEMPLATE

  // 默认模式 ID
  const DEFAULT_MODE_ID = 'code'
  const CHAT_HISTORY_PROMPT_ENTRY_ID = 'chat-history'
  const DEFAULT_PROMPT_ASSEMBLY_MODE: PromptAssemblyMode = 'legacy'

  // 清理文本中的多余空行（将3个或以上连续换行压缩为2个）
  function cleanupEmptyLines(text: string): string {
    return text.replace(/\n{3,}/g, '\n\n').trim()
  }

  return {
    STATIC_PROMPT_MODULES,
    DYNAMIC_CONTEXT_MODULES,
    staticModuleIds,
    dynamicModuleIds,
    CODE_MODE_TEMPLATE,
    DESIGN_MODE_TEMPLATE,
    PLAN_MODE_TEMPLATE,
    ASK_MODE_TEMPLATE,
    REVIEW_MODE_TEMPLATE,
    DEFAULT_TEMPLATE,
    DEFAULT_DYNAMIC_TEMPLATE,
    DEFAULT_MODE_ID,
    CHAT_HISTORY_PROMPT_ENTRY_ID,
    DEFAULT_PROMPT_ASSEMBLY_MODE,
    cleanupEmptyLines
  }
}
