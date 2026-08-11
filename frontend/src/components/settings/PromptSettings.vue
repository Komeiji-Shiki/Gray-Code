<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { useSettingsStore, useChatStore } from '@/stores'
import { InputDialog, ConfirmDialog, type SelectOption } from '../common'
import { copyToClipboard } from '@/utils/format'
import { MESSAGE_NAMES } from '@shared/protocol'
import PromptEntriesEditor from './PromptEntriesEditor.vue'
import ModeSelectorBar from './prompt/ModeSelectorBar.vue'
import AssemblyModeSelector from './prompt/AssemblyModeSelector.vue'
import DynamicStrategyBlock from './prompt/DynamicStrategyBlock.vue'
import StaticTemplateSection from './prompt/StaticTemplateSection.vue'
import DynamicTemplateSection from './prompt/DynamicTemplateSection.vue'
import ModulesReference from './prompt/ModulesReference.vue'
import ToolPolicySection from './prompt/ToolPolicySection.vue'
import TokenCountSection from './prompt/TokenCountSection.vue'
import ImportModesDialog from './prompt/ImportModesDialog.vue'
import type {
  PromptModule,
  DynamicContextStrategy,
  PromptAssemblyMode,
  PromptEntry,
  ToolInfo,
  ToolPolicyMode
} from './prompt/types'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()

// 渠道类型
type ChannelType = 'gemini' | 'openai' | 'anthropic'

// 提示词模式
interface PromptMode {
  id: string
  name: string
  icon?: string
  template: string
  promptAssemblyMode?: PromptAssemblyMode
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  dynamicContextStrategy?: DynamicContextStrategy
  promptEntries?: PromptEntry[]
  toolPolicy?: string[]
}

// 系统提示词配置（支持多模式）
interface SystemPromptConfig {
  currentModeId: string
  modes: Record<string, PromptMode>
  template: string
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  dynamicContextStrategy: DynamicContextStrategy
  customPrefix: string
  customSuffix: string
}

// 静态变量（放入系统提示词，可被 API provider 缓存）
const STATIC_PROMPT_MODULES: PromptModule[] = [
  {
    id: 'ENVIRONMENT',
    name: '环境信息',
    description: '包含工作区路径、操作系统、时区和用户语言（静态内容，可缓存）',
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
    name: '工具定义',
    description: '根据渠道配置生成 XML 或 Function Call 格式的工具定义（此变量由系统自动填充）',
    example: `====

TOOLS

You have access to these tools:

## read_file
Description: Read file content
...`
  },
  {
    id: 'CONTEXT_BADGE_FORMAT',
    name: '上下文徽章结构',
    description: '解释 <lim-context ...>...</lim-context> 的字段含义，明确哪里是标题、哪里是正文，以及 binary 徽章不应按文本解析',
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
    name: 'MCP 工具',
    description: '来自 MCP 服务器的额外工具定义（此变量由系统自动填充）',
    example: `====

MCP TOOLS

Additional tools from MCP servers:
...`,
    requiresConfig: 'MCP 设置中需要配置并连接服务器'
  },
  {
    id: 'MEMORY',
    name: '记忆系统',
    description: '永久记忆系统（OptMem）的使用说明，告诉 AI 如何跨会话记录和回忆信息。可在 设置 → 记忆 中自定义内容。',
    example: `====

MEMORY

Your memory is OptMem, a permanent memory system that survives every session.

### At startup: activating memory (mandatory)
Run memory_wake before any other tool call...

### While working: register memories (mandatory)
Call memory_note whenever you learn something new...`,
    requiresConfig: '设置 → 记忆 中可自定义此提示词'
  }
]

// 动态变量（作为上下文消息临时插入，不存储到历史记录）
const DYNAMIC_CONTEXT_MODULES: PromptModule[] = [
  {
    id: 'TODO_LIST',
    name: 'TODO 列表',
    description: '显示当前会话的 TODO 列表（来自 todo_write / todo_update / create_plan 持久化的 todoList 元数据）',
    example: `====

TODO LIST

Total: 3 | pending: 1 | in_progress: 1 | completed: 1 | cancelled: 0
- [in_progress] 实现 {{$TODO_LIST}} 注入  \`#inject-todo\`
- [pending] 增量更新 todo_update  \`#todo-update\`
- [completed] 精简 todo_write 工具响应  \`#slim-result\``
  },
  {
    id: 'WORKSPACE_FILES',
    name: '工作区文件树',
    description: '列出工作区中的文件和目录结构，受上下文感知设置中的深度和忽略模式影响',
    example: `====

WORKSPACE FILES

The following is a list of files in the current workspace:

src/
  main.ts
  utils/
    helper.ts`,
    requiresConfig: '上下文感知 > 发送工作区文件树'
  },
  {
    id: 'OPEN_TABS',
    name: '打开的标签页',
    description: '列出当前在编辑器中打开的文件标签页',
    example: `====

OPEN TABS

Currently open files in editor:
  - src/main.ts
  - src/utils/helper.ts`,
    requiresConfig: '上下文感知 > 发送打开的标签页'
  },
  {
    id: 'ACTIVE_EDITOR',
    name: '活动编辑器',
    description: '显示当前正在编辑的文件路径',
    example: `====

ACTIVE EDITOR

Currently active file: src/main.ts`,
    requiresConfig: '上下文感知 > 发送当前活动编辑器'
  },
  {
    id: 'DIAGNOSTICS',
    name: '诊断信息',
    description: '显示工作区的错误、警告等诊断信息，帮助 AI 修复代码问题',
    example: `====

DIAGNOSTICS

The following diagnostics were found in the workspace:

src/main.ts:
  Line 10: [Error] Cannot find name 'foo'. (ts)
  Line 15: [Warning] 'bar' is defined but never used. (ts)`,
    requiresConfig: '上下文感知 > 启用诊断信息'
  },
  {
    id: 'PINNED_FILES',
    name: '固定文件内容',
    description: '显示用户固定的文件的完整内容',
    example: `====

PINNED FILES CONTENT

The following are pinned files...

--- README.md ---
# Project Title
...`,
    requiresConfig: '需要在输入框旁的固定文件按钮中添加文件'
  },
  {
    id: 'SKILLS',
    name: 'Skills 内容',
    description: '显示当前启用的 Skills 的内容。Skills 是用户自定义的知识模块，AI 可以通过 toggle_skills 工具动态启用/禁用。',
    example: `====

ACTIVE SKILLS

The following skills are currently active...

## pymatgen

# Pymatgen - Python Materials Genomics
...`,
    requiresConfig: 'AI 通过 toggle_skills 工具启用 skills'
  }
]

// 静态变量 ID 集合
const staticModuleIds = new Set(STATIC_PROMPT_MODULES.map(m => m.id))

// 动态变量 ID 集合
const dynamicModuleIds = new Set(DYNAMIC_CONTEXT_MODULES.map(m => m.id))

// 默认静态系统提示词模板（代码模式）
const CODE_MODE_TEMPLATE = `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

{{$MEMORY}}

====

GUIDELINES

- Use the provided tools to complete tasks. Tools can help you read files, search code, execute commands, and modify files.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- When you need to make changes, use apply_diff for targeted modifications or write_file for creating new files.
- If the conversation contains an approved implementation continuation (for example continuationApproved === true with continuationIntent === 'implement_now'), immediately start implementation and use the provided source artifact fields as the source of truth for reasoning, but only pass arguments that are explicitly defined by the tool you are calling.
- Treat legacy handoff fields such as planExecutionPrompt, planPath, or planContent as the same kind of approved implementation continuation when unified continuation fields are absent.
- Do not say that the plan is ready for review, and do not create another plan unless the user explicitly asks to revise it.
- For complex, multi-step work, use todo_write once to initialize/replace the TODO list, then use todo_update for incremental updates (status/content) as you progress.
- When TODO status changes in a meaningful way during approved implementation, call update_plan with updateMode: 'progress_sync' to sync the latest TODO snapshot back to the approved plan document.
- When calling update_plan with updateMode: 'progress_sync', NEVER pass sourceArtifact or any continuation/source-artifact carry-over fields.
- In progress_sync mode, only send path, todos, updateMode, and optional changeSummary. Do NOT send sourceArtifactType, sourcePath, sourceContent, planPath, planContent, continuationPrompt, planExecutionPrompt, continuationApproved, or continuationIntent.
- sourceArtifact is only valid for create_plan or update_plan with updateMode: 'revision'. sourceArtifactType/sourcePath/sourceContent are continuation fields, not update_plan arguments.
- If a TODO moves into in_progress, completed, or cancelled, sync the plan promptly.
- If the plan itself must change, use update_plan with updateMode: 'revision', then stop and wait for the user to confirm the revised plan.
- For parallelizable investigations (or when you need to explore multiple areas quickly), use subagents to delegate focused sub-tasks.
- If the task is simple and doesn't require tools, just respond directly without calling any tools.
- You can use Mermaid syntax in fenced code blocks (\`\`\`mermaid) to create diagrams and flowcharts when explaining complex concepts.
- Always maintain code readability and maintainability.
- Do not omit any code.`

// 默认静态系统提示词模板（设计模式）
const DESIGN_MODE_TEMPLATE = `You are a professional software architect and design consultant. Your primary role is to help users clarify requirements, design solutions, and plan implementation strategies.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

{{$MEMORY}}

====

GUIDELINES

- Use the provided tools to complete tasks. Tools can help you read files, search code, execute commands, and modify files.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- When you need to make changes, use apply_diff for targeted modifications or write_file for creating new files.
- If the task is simple and doesn't require tools, just respond directly without calling any tools.
- Always maintain code readability and maintainability.
- Do not omit any code.

====

DESIGN MODE BEHAVIOR

**IMPORTANT: You are in DESIGN MODE. Follow these principles:**

1. **Communicate First**: Before making any code changes, discuss the design with the user. Ask clarifying questions about requirements, constraints, and preferences.

2. **Analyze and Plan**: When asked to implement something, first analyze the current codebase structure, identify potential approaches, and present options to the user.

3. **Seek Confirmation**: Always confirm your understanding of the requirements and proposed solution before proceeding with implementation.

4. **Minimal File Modifications**: Only write or modify files when:
   - The user explicitly requests implementation
   - You need to create design documents or diagrams
   - The user confirms they want you to proceed with changes

5. **Focus on Design Artifacts**: Prefer creating or discussing:
   - Architecture diagrams and flowcharts (in markdown/mermaid)
   - API specifications and interfaces
   - Data models and schemas
   - Implementation roadmaps and task breakdowns

6. **Iterative Refinement**: Work with the user to refine the design through multiple rounds of discussion before implementation.

7. **Create or Update Design Docs via Tool**: Use create_design for a new design document and update_design when revising an existing design document under .graycode/design/**.md.

8. **Stop After Writing Design Doc**: After calling create_design or update_design, STOP and wait for the user to review the design and decide whether to generate or update a plan.

9. **Do Not Skip to Plan or Code**: Do not create plan documents or perform implementation work directly in Design mode unless the user explicitly changes the workflow.`

// 默认静态系统提示词模板（计划模式）
const PLAN_MODE_TEMPLATE = `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

{{$MEMORY}}

====

PLAN MODE

**IMPORTANT: You are in PLAN MODE. Follow these principles:**

- Use the provided tools to analyze the codebase and create implementation plans.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- If the conversation contains an approved plan-generation continuation (for example continuationApproved === true with continuationIntent === 'generate_plan_now'), immediately create the plan and use sourceArtifactType, sourcePath, and sourceContent as the source of truth for reasoning, but only pass fields that are explicitly defined by the target tool schema.
- Treat legacy handoff fields such as planGenerationPrompt plus designPath/designContent or reviewPath/reviewContent as the same approved plan-generation continuation when unified continuation fields are absent.
- Once a plan-generation continuation is approved, do not ask for another confirmation and do not restate that the design or review is ready for review.
- When generating a plan from a confirmed design, include a clear section near the top of the plan that references the source design document path.
- When generating a plan from a confirmed review, include a clear section near the top of the plan that references the source review document path and the findings or follow-up items you are implementing.
- When generating a new plan from a confirmed design or review, call create_plan and pass sourceArtifact with the confirmed source type and path.
- Use create_plan to write the plan document in .graycode/plans/**.md.
- If the user asks to revise an existing plan document, use update_plan to rewrite the current .graycode/plans/**.md file instead of creating a second plan document.
- Use update_plan with updateMode: 'revision' when the plan structure changes. Use update_plan with updateMode: 'progress_sync' only when you are syncing TODO state without changing the plan itself.
- When calling update_plan with updateMode: 'progress_sync', NEVER pass sourceArtifact or any continuation/source-artifact carry-over fields.
- In progress_sync mode, only send path, todos, updateMode, and optional changeSummary. Do NOT send sourceArtifactType, sourcePath, sourceContent, planPath, planContent, continuationPrompt, planExecutionPrompt, continuationApproved, or continuationIntent.
- sourceArtifact is only valid for create_plan or update_plan with updateMode: 'revision'. sourceArtifactType/sourcePath/sourceContent are continuation fields, not update_plan arguments.
- **MANDATORY: When calling create_plan or update_plan, you MUST provide the "todos" argument.** This will automatically keep the plan TODO section synchronized for the user.
- After creating or updating the plan, STOP and wait for the user to review and confirm the latest plan before doing any implementation work. The user will click the "Execute Plan" button on the plan card to confirm.
- You can use subagents for focused planning sub-tasks, but stay within the allowed tools and do not modify code.
- Focus on creating detailed implementation plans and task breakdowns.
- Do not modify actual code files directly. Only create plan documents.
- Always maintain code readability and maintainability in your plans.`

// 默认静态系统提示词模板（询问模式）
const ASK_MODE_TEMPLATE = `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

====

ASK MODE

**IMPORTANT: You are in ASK MODE. Follow these principles:**

- Use the provided tools to read and analyze the codebase to answer questions.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- You can only read files and search code. You cannot modify files or execute commands.
- Focus on providing accurate answers based on code analysis.
- Always maintain code readability and maintainability in your responses.`

const DEFAULT_TEMPLATE = CODE_MODE_TEMPLATE

// 默认动态上下文模板
const DEFAULT_DYNAMIC_TEMPLATE = `This is the current turn's dynamic context information you can use. It may change between turns. Continue with the previous task if the information is not needed and ignore it.

{{$TODO_LIST}}

{{$WORKSPACE_FILES}}

{{$OPEN_TABS}}

{{$ACTIVE_EDITOR}}

{{$DIAGNOSTICS}}

{{$PINNED_FILES}}

{{$SKILLS}}`

// 默认模式 ID
const DEFAULT_MODE_ID = 'code'
const CHAT_HISTORY_PROMPT_ENTRY_ID = 'chat-history'
const DEFAULT_PROMPT_ASSEMBLY_MODE: PromptAssemblyMode = 'legacy'

// 模式列表
const modes = ref<PromptMode[]>([])
const currentModeId = ref(DEFAULT_MODE_ID)
const selectedModeId = ref(DEFAULT_MODE_ID)  // 当前编辑的模式

// 对话框状态
const showAddModeDialog = ref(false)
const showDuplicateModeDialog = ref(false)
const showImportModeDialog = ref(false)
const showRenameModeDialog = ref(false)
const showDeleteConfirm = ref(false)
const showUnsavedConfirm = ref(false)
const showResetStaticConfirm = ref(false)
const showResetDynamicConfirm = ref(false)
const pendingModeId = ref('')
const duplicatingModeId = ref('')
const duplicatingModeName = ref('')
const renamingModeId = ref('')
const renamingModeName = ref('')
const importPayloadText = ref('')
const importErrorMessage = ref('')

// 模式选项（用于模式下拉选择）
const modeOptions = computed<SelectOption[]>(() => {
  return modes.value.map(m => ({
    value: m.id,
    label: m.name
  }))
})

// 配置状态（当前编辑中的模式配置）
const config = reactive<{
  template: string
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  dynamicContextStrategy: DynamicContextStrategy
}>({
  template: DEFAULT_TEMPLATE,
  dynamicTemplateEnabled: true,
  dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
  dynamicContextStrategy: 'single'
})

// 原始配置（用于检测变化）
const originalConfig = ref<typeof config | null>(null)

// ========== 模式工具策略 ==========

const availableTools = ref<ToolInfo[]>([])
const isLoadingTools = ref(false)
const toolSearchQuery = ref('')

const toolPolicyMode = ref<ToolPolicyMode>('inherit')
const toolPolicy = ref<string[]>([])
const originalToolPolicyMode = ref<ToolPolicyMode>('inherit')
const originalToolPolicy = ref<string[]>([])
const promptEntries = ref<PromptEntry[]>([])
const originalPromptEntries = ref<PromptEntry[]>([])
const promptAssemblyMode = ref<PromptAssemblyMode>(DEFAULT_PROMPT_ASSEMBLY_MODE)
const originalPromptAssemblyMode = ref<PromptAssemblyMode>(DEFAULT_PROMPT_ASSEMBLY_MODE)

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

function normalizePromptEntries(entries: PromptEntry[] | undefined, assemblyMode: PromptAssemblyMode = promptAssemblyMode.value): PromptEntry[] {
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

function clonePromptMode(mode: PromptMode): PromptMode {
  const cloned: PromptMode = {
    ...mode,
    promptAssemblyMode: normalizePromptAssemblyMode(mode.promptAssemblyMode),
    toolPolicy: Array.isArray(mode.toolPolicy) ? [...mode.toolPolicy] : undefined,
    promptEntries: Array.isArray(mode.promptEntries)
      ? clonePromptEntries(mode.promptEntries)
      : undefined
  }
  if (!Array.isArray(mode.toolPolicy)) {
    delete (cloned as any).toolPolicy
  }
  if (!Array.isArray(mode.promptEntries)) {
    delete (cloned as any).promptEntries
  }
  return cloned
}

function createModeId(prefix = 'mode'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function getUniqueModeName(baseName: string): string {
  const trimmed = baseName.trim() || t('components.settings.promptSettings.modes.newModeDefault')
  const used = new Set(modes.value.map(mode => mode.name.trim()))
  if (!used.has(trimmed)) return trimmed

  let index = 2
  let candidate = `${trimmed} ${index}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${trimmed} ${index}`
  }
  return candidate
}

function getDuplicateModeName(mode: PromptMode): string {
  return getUniqueModeName(`${mode.name} ${t('components.settings.promptSettings.modes.copySuffix')}`)
}

function buildEditedModeSnapshot(sourceMode?: PromptMode): PromptMode {
  const fallbackMode: PromptMode = sourceMode || {
    id: selectedModeId.value,
    name: t('components.settings.promptSettings.modes.newModeDefault'),
    icon: 'symbol-method',
    template: DEFAULT_TEMPLATE,
    promptAssemblyMode: DEFAULT_PROMPT_ASSEMBLY_MODE,
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
    dynamicContextStrategy: 'single'
  }

  const snapshot: PromptMode = {
    ...clonePromptMode(fallbackMode),
    template: cleanupEmptyLines(config.template || ''),
    promptAssemblyMode: promptAssemblyMode.value,
    dynamicTemplateEnabled: config.dynamicTemplateEnabled,
    dynamicTemplate: cleanupEmptyLines(config.dynamicTemplate || ''),
    dynamicContextStrategy: config.dynamicContextStrategy,
    promptEntries: normalizePromptEntries(promptEntries.value, promptAssemblyMode.value)
  }

  if (toolPolicyMode.value === 'custom') {
    snapshot.toolPolicy = Array.from(new Set(toolPolicy.value))
  } else {
    delete (snapshot as any).toolPolicy
  }

  if (!snapshot.promptEntries || snapshot.promptEntries.length === 0) {
    delete (snapshot as any).promptEntries
  }

  return snapshot
}

function getModeSnapshotForExport(mode: PromptMode): PromptMode {
  return mode.id === selectedModeId.value
    ? buildEditedModeSnapshot(mode)
    : clonePromptMode(mode)
}

function sanitizeImportedMode(raw: unknown, fallbackName: string): PromptMode {
  if (!raw || typeof raw !== 'object') {
    throw new Error(t('components.settings.promptSettings.modes.importInvalid'))
  }

  const item = raw as Partial<PromptMode> & Record<string, unknown>
  const assemblyMode = normalizePromptAssemblyMode(item.promptAssemblyMode)
  const name = typeof item.name === 'string' && item.name.trim()
    ? item.name.trim()
    : fallbackName

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : createModeId('imported_mode'),
    name,
    icon: typeof item.icon === 'string' && item.icon.trim() ? item.icon.trim() : 'symbol-method',
    template: typeof item.template === 'string' ? item.template : DEFAULT_TEMPLATE,
    promptAssemblyMode: assemblyMode,
    dynamicTemplateEnabled: item.dynamicTemplateEnabled !== false,
    dynamicTemplate: typeof item.dynamicTemplate === 'string' ? item.dynamicTemplate : DEFAULT_DYNAMIC_TEMPLATE,
    dynamicContextStrategy: item.dynamicContextStrategy === 'preserve' ? 'preserve' : 'single',
    promptEntries: normalizePromptEntries(item.promptEntries as PromptEntry[] | undefined, assemblyMode),
    toolPolicy: Array.isArray(item.toolPolicy)
      ? Array.from(new Set(item.toolPolicy.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0).map(tool => tool.trim())))
      : undefined
  }
}

function parsePromptModeImportPayload(rawText: string): PromptMode[] {
  const trimmed = rawText.trim()
  if (!trimmed) {
    throw new Error(t('components.settings.promptSettings.modes.importEmpty'))
  }

  const parsed = JSON.parse(trimmed)
  const source = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.modes)
      ? parsed.modes
      : parsed?.mode
        ? [parsed.mode]
        : [parsed]

  const imported = source.map((item: unknown, index: number) =>
    sanitizeImportedMode(item, `${t('components.settings.promptSettings.modes.importedModeDefault')} ${index + 1}`)
  )

  if (imported.length === 0) {
    throw new Error(t('components.settings.promptSettings.modes.importEmpty'))
  }

  return imported
}

function buildPromptModeExportPayload(target: 'current' | 'all'): string {
  const exportedModes = target === 'current'
    ? modes.value
        .filter(mode => mode.id === selectedModeId.value)
        .map(mode => getModeSnapshotForExport(mode))
    : modes.value.map(mode => getModeSnapshotForExport(mode))

  const payload = {
    schema: 'graycode.promptModes.v1',
    exportedAt: new Date().toISOString(),
    modes: exportedModes
  }

  return JSON.stringify(payload, null, 2)
}

async function exportPromptModes(target: 'current' | 'all') {
  const payload = buildPromptModeExportPayload(target)
  const filename = target === 'current'
    ? `graycode-prompt-mode-${selectedModeId.value || 'current'}.json`
    : 'graycode-prompt-modes.json'

  try {
    const result = await sendToExtension<{ success: boolean; cancelled?: boolean }>(MESSAGE_NAMES.exportPromptModes, {
      filename,
      content: payload
    })
    if (!result?.success) return

    const copied = await copyToClipboard(payload)
    showToast(
      copied
        ? t('components.settings.promptSettings.modes.exportSuccess')
        : t('components.settings.promptSettings.modes.exportDownloadOnly'),
      true
    )
  } catch (error) {
    console.error('Failed to export prompt modes:', error)
    showToast(t('components.settings.promptSettings.modes.exportFailed'), false)
  }
}

async function persistImportedModes(importedModes: PromptMode[]) {
  const savedModes: PromptMode[] = []

  for (const importedMode of importedModes) {
    const mode: PromptMode = {
      ...importedMode,
      id: createModeId('imported_mode'),
      name: getUniqueModeName(importedMode.name)
    }
    if (!mode.toolPolicy || mode.toolPolicy.length === 0) {
      delete (mode as any).toolPolicy
    }
    if (!mode.promptEntries || mode.promptEntries.length === 0) {
      delete (mode as any).promptEntries
    }

    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode })
    savedModes.push(mode)
  }

  modes.value = [...modes.value, ...savedModes]
  const lastMode = savedModes[savedModes.length - 1]
  if (lastMode) {
    selectedModeId.value = lastMode.id
    loadModeConfig(lastMode.id)
  }
  settingsStore.refreshPromptModes()
  showToast(t('components.settings.promptSettings.modes.importSuccess', { count: savedModes.length }), true)
}

function isSamePromptEntries(a: PromptEntry[], b: PromptEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    return !!other &&
      entry.id === other.id &&
      entry.name === other.name &&
      (entry.type || 'prompt') === (other.type || 'prompt') &&
      entry.enabled === other.enabled &&
      entry.role === other.role &&
      entry.content === other.content &&
      (entry.fakeThought ?? '') === (other.fakeThought ?? '') &&
      entry.order === other.order
  })
}

function normalizeToolList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return Array.from(new Set(list)).sort()
}

function isSameToolList(a: string[], b: string[]): boolean {
  const na = normalizeToolList(a)
  const nb = normalizeToolList(b)
  if (na.length !== nb.length) return false
  return na.every((v, i) => v === nb[i])
}

const filteredTools = computed(() => {
  const q = toolSearchQuery.value.trim().toLowerCase()
  if (!q) return availableTools.value
  return availableTools.value.filter(t => {
    const name = (t.name || '').toLowerCase()
    const desc = (t.description || '').toLowerCase()
    return name.includes(q) || desc.includes(q)
  })
})

const groupedTools = computed<Record<string, ToolInfo[]>>(() => {
  const grouped: Record<string, ToolInfo[]> = {}
  for (const tool of filteredTools.value) {
    const category = tool.category || '其他'
    if (!grouped[category]) grouped[category] = []
    grouped[category].push(tool)
  }
  for (const category of Object.keys(grouped)) {
    grouped[category].sort((a, b) => a.name.localeCompare(b.name))
  }
  return grouped
})

function getCategoryDisplayName(category: string): string {
  const mapping: Record<string, string> = {
    file: t('components.settings.toolsSettings.categories.file'),
    search: t('components.settings.toolsSettings.categories.search'),
    terminal: t('components.settings.toolsSettings.categories.terminal'),
    lsp: t('components.settings.toolsSettings.categories.lsp'),
    media: t('components.settings.toolsSettings.categories.media'),
    other: t('components.settings.toolsSettings.categories.other'),
    其他: t('components.settings.toolsSettings.categories.other'),
    mcp: 'MCP',
    todo: 'TODO',
    agents: 'Agents',
    skills: 'Skills'
  }
  return mapping[category] || category
}

function isToolSelected(name: string): boolean {
  return toolPolicy.value.includes(name)
}

function toggleTool(name: string, enabled: boolean) {
  if (enabled) {
    if (!toolPolicy.value.includes(name)) {
      toolPolicy.value.push(name)
    }
    return
  }
  toolPolicy.value = toolPolicy.value.filter(t => t !== name)
}

function selectAllTools() {
  toolPolicy.value = availableTools.value.map(t => t.name)
}

function clearAllTools() {
  toolPolicy.value = []
}

async function loadAvailableTools() {
  isLoadingTools.value = true
  try {
    const [builtin, mcp] = await Promise.all([
      sendToExtension<{ tools: ToolInfo[] }>(MESSAGE_NAMES['tools.getTools'], {}),
      sendToExtension<{ tools: ToolInfo[] }>(MESSAGE_NAMES['tools.getMcpTools'], {})
    ])

    const merged: ToolInfo[] = [
      ...(builtin?.tools || []),
      ...(mcp?.tools || [])
    ]

    const byName = new Map<string, ToolInfo>()
    for (const tool of merged) {
      if (!tool?.name) continue
      if (!byName.has(tool.name)) {
        byName.set(tool.name, tool)
      }
    }

    availableTools.value = Array.from(byName.values()).sort((a, b) => {
      const ca = (a.category || '').localeCompare(b.category || '')
      if (ca !== 0) return ca
      return a.name.localeCompare(b.name)
    })
  } catch (error) {
    console.error('Failed to load tools list for tool policy:', error)
    availableTools.value = []
  } finally {
    isLoadingTools.value = false
  }
}

// 是否有未保存的变化
const hasChanges = computed(() => {
  if (!originalConfig.value) return false
  const basicChanged = config.template !== originalConfig.value.template ||
    config.dynamicTemplateEnabled !== originalConfig.value.dynamicTemplateEnabled ||
    config.dynamicTemplate !== originalConfig.value.dynamicTemplate ||
    config.dynamicContextStrategy !== originalConfig.value.dynamicContextStrategy

  const assemblyChanged = promptAssemblyMode.value !== originalPromptAssemblyMode.value

  const policyChanged =
    toolPolicyMode.value !== originalToolPolicyMode.value ||
    !isSameToolList(toolPolicy.value, originalToolPolicy.value)

  const entriesChanged = !isSamePromptEntries(promptEntries.value, originalPromptEntries.value)

  return basicChanged || assemblyChanged || policyChanged || entriesChanged
})

// 加载状态
const isLoading = ref(true)
const isSaving = ref(false)
const toastVisible = ref(false)
const toastMessage = ref('')
const toastSuccess = ref(true)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(message: string, success: boolean) {
  toastMessage.value = message
  toastSuccess.value = success
  toastVisible.value = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastVisible.value = false }, 2500)
}
const isFirstLoad = ref(true)  // 标记是否首次加载

// Token 计数状态
const staticTokenCount = ref<number | null>(null)
const dynamicTokenCount = ref<number | null>(null)
const isCountingTokens = ref(false)
const tokenCountError = ref('')
const selectedChannel = ref<ChannelType>('gemini')

// 可用的渠道选项
const channelOptions: { value: ChannelType; label: string }[] = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' }
]

// 展开的模块
const collapsedReference = ref(true)
const expandedModule = ref<string | null>(null)

// 加载配置
async function loadConfig() {
  isLoading.value = true
  try {
    const result = await sendToExtension<SystemPromptConfig>(MESSAGE_NAMES.getSystemPromptConfig, {})
    if (result) {
      // 加载模式列表
      modes.value = Object.values(result.modes || {})
      currentModeId.value = result.currentModeId || 'default'

      // 只在首次加载时设置 selectedModeId 为当前使用的模式
      // 切换页签时保持上次编辑的模式
      if (isFirstLoad.value) {
        selectedModeId.value = currentModeId.value
        isFirstLoad.value = false
      }

      // 加载当前编辑模式的配置
      loadModeConfig(selectedModeId.value)
    }
  } catch (error) {
    console.error('Failed to load system prompt config:', error)
  } finally {
    isLoading.value = false
  }
}

// 加载指定模式的配置
function loadModeConfig(modeId: string) {
  const mode = modes.value.find(m => m.id === modeId)
  if (mode) {
    config.template = typeof mode.template === 'string' ? mode.template : DEFAULT_TEMPLATE
    config.dynamicTemplateEnabled = mode.dynamicTemplateEnabled ?? true
    config.dynamicTemplate = typeof mode.dynamicTemplate === 'string' ? mode.dynamicTemplate : DEFAULT_DYNAMIC_TEMPLATE
    config.dynamicContextStrategy = mode.dynamicContextStrategy || 'single'
    originalConfig.value = { ...config }
    promptAssemblyMode.value = normalizePromptAssemblyMode(mode.promptAssemblyMode)
    originalPromptAssemblyMode.value = promptAssemblyMode.value
    promptEntries.value = normalizePromptEntries(mode.promptEntries, promptAssemblyMode.value)
    originalPromptEntries.value = clonePromptEntries(promptEntries.value)

    // 加载模式工具策略
    const policy = mode.toolPolicy
    if (Array.isArray(policy) && policy.length > 0) {
      toolPolicyMode.value = 'custom'
      toolPolicy.value = [...policy]
    } else {
      toolPolicyMode.value = 'inherit'
      toolPolicy.value = []
    }
    toolSearchQuery.value = ''
    originalToolPolicyMode.value = toolPolicyMode.value
    originalToolPolicy.value = [...toolPolicy.value]
  }
}

// 切换编辑的模式
async function handleModeChange(modeId: string) {
  // 如果有未保存的更改，提示用户
  if (hasChanges.value) {
    pendingModeId.value = modeId
    showUnsavedConfirm.value = true
    return
  }
  selectedModeId.value = modeId
  loadModeConfig(modeId)
}

// 确认放弃更改并切换模式
function confirmSwitchMode() {
  selectedModeId.value = pendingModeId.value
  loadModeConfig(pendingModeId.value)
  showUnsavedConfirm.value = false
}

// 保存配置
async function saveConfig() {
  isSaving.value = true
  try {
    // 工具策略校验：custom 模式必须至少选择一个工具
    if (toolPolicyMode.value === 'custom' && toolPolicy.value.length === 0) {
      showToast(t('components.settings.promptSettings.toolPolicy.emptyCannotSave'), false)
      return
    }

    // 保存前清理多余空行
    const cleanedTemplate = cleanupEmptyLines(config.template)
    const cleanedDynamicTemplate = cleanupEmptyLines(config.dynamicTemplate)

    // 更新当前模式的配置
    const currentMode = modes.value.find(m => m.id === selectedModeId.value)
    const baseMode: PromptMode = currentMode || {
      id: selectedModeId.value,
      name: '默认模式',
      icon: 'symbol-method',
      template: DEFAULT_TEMPLATE,
      promptAssemblyMode: DEFAULT_PROMPT_ASSEMBLY_MODE,
      dynamicTemplateEnabled: true,
      dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
      dynamicContextStrategy: 'single'
    }

    const nextToolPolicy = toolPolicyMode.value === 'custom'
      ? Array.from(new Set(toolPolicy.value))
      : undefined

    const nextPromptEntries = normalizePromptEntries(promptEntries.value, promptAssemblyMode.value)

    const updatedMode: PromptMode = {
      ...baseMode,
      template: cleanedTemplate,
      promptAssemblyMode: promptAssemblyMode.value,
      dynamicTemplateEnabled: config.dynamicTemplateEnabled,
      dynamicTemplate: cleanedDynamicTemplate,
      dynamicContextStrategy: config.dynamicContextStrategy,
      toolPolicy: nextToolPolicy,
      promptEntries: nextPromptEntries.length > 0 ? nextPromptEntries : undefined
    }
    if (toolPolicyMode.value !== 'custom') {
      delete (updatedMode as any).toolPolicy
    }

    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: updatedMode })

    // 更新本地配置为清理后的版本
    config.template = cleanedTemplate
    config.dynamicTemplate = cleanedDynamicTemplate
    config.dynamicContextStrategy = updatedMode.dynamicContextStrategy || 'single'
    originalConfig.value = { ...config }
    originalPromptAssemblyMode.value = promptAssemblyMode.value
    originalToolPolicyMode.value = toolPolicyMode.value
    originalToolPolicy.value = [...toolPolicy.value]
    promptEntries.value = clonePromptEntries(nextPromptEntries)
    originalPromptEntries.value = clonePromptEntries(nextPromptEntries)

    // 更新模式列表中的配置
    const modeIndex = modes.value.findIndex(m => m.id === selectedModeId.value)
    if (modeIndex >= 0) {
      modes.value[modeIndex] = updatedMode
    }

    // 通知 InputArea 刷新模式列表，避免保存动态上下文策略后输入区仍显示旧模式数据
    settingsStore.refreshPromptModes()

    showToast(t('components.settings.promptSettings.saveSuccess'), true)

    // 保存成功后自动更新 token 计数（辅助操作：不阻塞保存成功反馈，
    // token 计数走渠道 API 可能较慢，等待它会让保存响应延迟）
    void countTokens()
  } catch (error) {
    console.error('Failed to save system prompt config:', error)
    showToast(t('components.settings.promptSettings.saveFailed'), false)
  } finally {
    isSaving.value = false
  }
}

// token 计数请求序号：丢弃过期响应，避免慢响应覆盖新结果（如切换渠道后旧响应迟到）
let tokenCountRequestSeq = 0

// 计算 token 数量（分别计算静态模板和动态上下文）
async function countTokens() {
  const seq = ++tokenCountRequestSeq

  if (!config.template) {
    staticTokenCount.value = null
    dynamicTokenCount.value = null
    isCountingTokens.value = false
    return
  }

  isCountingTokens.value = true
  tokenCountError.value = ''

  try {
    const result = await sendToExtension<{
      success: boolean
      staticTokens?: number
      dynamicTokens?: number
      error?: string
    }>(MESSAGE_NAMES.countSystemPromptTokens, {
      staticText: config.template,
      channelType: selectedChannel.value,
      conversationId: chatStore.currentConversationId
    })

    // 过期响应直接丢弃
    if (seq !== tokenCountRequestSeq) return

    if (result?.success) {
      staticTokenCount.value = result.staticTokens ?? null
      dynamicTokenCount.value = result.dynamicTokens ?? null
    } else {
      staticTokenCount.value = null
      dynamicTokenCount.value = null
      tokenCountError.value = result?.error || 'Token count failed'
    }
  } catch (error: any) {
    // 过期响应直接丢弃
    if (seq !== tokenCountRequestSeq) return
    console.error('Failed to count tokens:', error)
    staticTokenCount.value = null
    dynamicTokenCount.value = null
    tokenCountError.value = error.message || 'Token count failed'
  } finally {
    if (seq === tokenCountRequestSeq) isCountingTokens.value = false
  }
}

// 格式化 token 数量显示
function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return count.toString()
}

// 清理文本中的多余空行（将3个或以上连续换行压缩为2个）
function cleanupEmptyLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function handlePromptAssemblyModeChange(mode: PromptAssemblyMode) {
  promptAssemblyMode.value = mode
  if (mode === 'entries') {
    promptEntries.value = normalizePromptEntries(promptEntries.value, 'entries')
  }
}

// 重置静态模板为默认
function resetStaticToDefault() {
  const modeDefaults: Record<string, string> = {
    code: CODE_MODE_TEMPLATE,
    design: DESIGN_MODE_TEMPLATE,
    plan: PLAN_MODE_TEMPLATE,
    ask: ASK_MODE_TEMPLATE
  }

  config.template = modeDefaults[selectedModeId.value] || DEFAULT_TEMPLATE
  showResetStaticConfirm.value = false
}

// 重置动态模板为默认
function resetDynamicToDefault() {
  config.dynamicTemplate = DEFAULT_DYNAMIC_TEMPLATE
  showResetDynamicConfirm.value = false
}

// 插入变量到静态模板
function insertStaticModule(moduleId: string) {
  if (!staticModuleIds.has(moduleId)) {
    console.warn(`Invalid static module ID: ${moduleId}`)
    return
  }
  const placeholder = `{{$${moduleId}}}`
  config.template += placeholder
}

// 插入变量到动态模板
function insertDynamicModule(moduleId: string) {
  if (!dynamicModuleIds.has(moduleId)) {
    console.warn(`Invalid dynamic module ID: ${moduleId}`)
    return
  }
  const placeholder = `{{$${moduleId}}}`
  config.dynamicTemplate += placeholder
}

function convertLegacyTemplatesToEntries() {
  const entries: PromptEntry[] = []
  const cleanedTemplate = cleanupEmptyLines(config.template)
  const cleanedDynamicTemplate = cleanupEmptyLines(config.dynamicTemplate)

  if (cleanedTemplate) {
    entries.push({
      id: 'legacy-system-template',
      name: '系统提示词',
      enabled: true,
      role: 'system',
      content: cleanedTemplate,
      order: 0
    })
  }

  if (cleanedDynamicTemplate) {
    entries.push({
      id: 'legacy-dynamic-context',
      name: '动态上下文',
      enabled: config.dynamicTemplateEnabled,
      role: 'user',
      content: cleanedDynamicTemplate,
      order: 100
    })
  }

  entries.push({
    ...createChatHistoryPromptEntry(50),
    name: 'Chat History'
  })

  promptAssemblyMode.value = 'entries'
  promptEntries.value = normalizePromptEntries(entries, 'entries')
}

// 切换模块展开
function toggleModule(moduleId: string) {
  expandedModule.value = expandedModule.value === moduleId ? null : moduleId
}

// 生成变量ID显示字符串（使用 {{$xxx}} 格式）
function formatModuleId(id: string): string {
  return `\{\{$${id}\}\}`
}

// 打开添加模式对话框
function openAddModeDialog() {
  showAddModeDialog.value = true
}

// 确认添加新模式
async function confirmAddMode(name: string) {
  const id = createModeId()
  const newMode: PromptMode = {
    id,
    name: getUniqueModeName(name),
    icon: 'symbol-method',
    template: DEFAULT_TEMPLATE,
    promptAssemblyMode: DEFAULT_PROMPT_ASSEMBLY_MODE,
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
    dynamicContextStrategy: 'single'
  }

  try {
    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: newMode })
    modes.value.push(newMode)
    selectedModeId.value = id
    loadModeConfig(id)
    // 通知 InputArea 刷新模式列表
    settingsStore.refreshPromptModes()
  } catch (error) {
    console.error('Failed to add mode:', error)
  }
}

function openDuplicateModeDialog() {
  const source = modes.value.find(m => m.id === selectedModeId.value)
  if (!source) return
  duplicatingModeId.value = source.id
  duplicatingModeName.value = getDuplicateModeName(source)
  showDuplicateModeDialog.value = true
}

async function confirmDuplicateMode(name: string) {
  const source = modes.value.find(m => m.id === duplicatingModeId.value)
  const normalizedName = name.trim()
  if (!source || !normalizedName) return

  const baseSnapshot = source.id === selectedModeId.value
    ? buildEditedModeSnapshot(source)
    : clonePromptMode(source)

  const duplicatedMode: PromptMode = {
    ...baseSnapshot,
    id: createModeId('mode_copy'),
    name: getUniqueModeName(normalizedName),
    promptEntries: Array.isArray(baseSnapshot.promptEntries)
      ? clonePromptEntries(baseSnapshot.promptEntries).map(entry => ({ ...entry }))
      : undefined,
    toolPolicy: Array.isArray(baseSnapshot.toolPolicy) ? [...baseSnapshot.toolPolicy] : undefined
  }
  if (!duplicatedMode.toolPolicy || duplicatedMode.toolPolicy.length === 0) {
    delete (duplicatedMode as any).toolPolicy
  }
  if (!duplicatedMode.promptEntries || duplicatedMode.promptEntries.length === 0) {
    delete (duplicatedMode as any).promptEntries
  }

  try {
    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: duplicatedMode })
    modes.value.push(duplicatedMode)
    selectedModeId.value = duplicatedMode.id
    loadModeConfig(duplicatedMode.id)
    settingsStore.refreshPromptModes()
    showToast(t('components.settings.promptSettings.modes.duplicateSuccess'), true)
  } catch (error) {
    console.error('Failed to duplicate mode:', error)
    showToast(t('components.settings.promptSettings.modes.duplicateFailed'), false)
  }
}

function openImportModeDialog() {
  importPayloadText.value = ''
  importErrorMessage.value = ''
  showImportModeDialog.value = true
}

async function confirmImportModes() {
  importErrorMessage.value = ''
  try {
    const importedModes = parsePromptModeImportPayload(importPayloadText.value)
    await persistImportedModes(importedModes)
    showImportModeDialog.value = false
  } catch (error: any) {
    console.error('Failed to import prompt modes:', error)
    importErrorMessage.value = error?.message || t('components.settings.promptSettings.modes.importFailed')
  }
}

async function handleImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return

  try {
    importPayloadText.value = await file.text()
    importErrorMessage.value = ''
  } catch (error: any) {
    importErrorMessage.value = error?.message || t('components.settings.promptSettings.modes.importFailed')
  } finally {
    if (input) input.value = ''
  }
}

// 打开重命名模式对话框
function openRenameModeDialog(modeId: string) {
  const mode = modes.value.find(m => m.id === modeId)
  if (!mode) return

  renamingModeId.value = modeId
  renamingModeName.value = mode.name
  showRenameModeDialog.value = true
}

// 确认重命名模式
async function confirmRenameMode(newName: string) {
  const mode = modes.value.find(m => m.id === renamingModeId.value)
  const normalizedName = newName.trim()
  if (!mode || !normalizedName || normalizedName === mode.name) return

  try {
    const result = await sendToExtension<{ mode?: PromptMode }>(MESSAGE_NAMES.renamePromptMode, {
      modeId: renamingModeId.value,
      name: normalizedName
    })
    const updatedMode: PromptMode = result?.mode || { ...mode, name: normalizedName }
    const index = modes.value.findIndex(m => m.id === renamingModeId.value)
    if (index >= 0) {
      modes.value[index] = updatedMode
    }
    renamingModeName.value = updatedMode.name
    // 通知 InputArea 刷新模式列表
    settingsStore.refreshPromptModes()
  } catch (error) {
    console.error('Failed to rename mode:', error)
  }
}

// 打开删除确认对话框
function openDeleteConfirm() {
  // 至少保留一个模式
  if (modes.value.length <= 1) return
  showDeleteConfirm.value = true
}

// 确认删除模式
async function confirmDeleteMode() {
  const modeId = selectedModeId.value
  // 至少保留一个模式
  if (modes.value.length <= 1) return

  try {
    await sendToExtension(MESSAGE_NAMES.deletePromptMode, { modeId })
    modes.value = modes.value.filter(m => m.id !== modeId)
    // 切换到第一个可用的模式
    const firstMode = modes.value[0]
    if (firstMode) {
      selectedModeId.value = firstMode.id
      loadModeConfig(firstMode.id)
    }
    // 通知 InputArea 刷新模式列表
    settingsStore.refreshPromptModes()
  } catch (error) {
    console.error('Failed to delete mode:', error)
  }
}

// 初始化
onMounted(async () => {
  await loadConfig()
  await loadAvailableTools()
  // 加载配置后自动计算 token 数量
  await countTokens()
})

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
})

// 监听渠道变化，重新计算 token
watch(selectedChannel, () => {
  countTokens()
})
</script>

<template>
  <div class="prompt-settings">
    <!-- 加载中 -->
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.settings.promptSettings.loading') }}</span>
    </div>

    <template v-else>
      <!-- 模式选择栏 -->
      <ModeSelectorBar
        :selected-mode-id="selectedModeId"
        :mode-options="modeOptions"
        :is-saving="isSaving"
        :can-delete="modes.length > 1"
        @update:model-value="handleModeChange"
        @save="saveConfig"
        @add="openAddModeDialog"
        @duplicate="openDuplicateModeDialog"
        @export-current="exportPromptModes('current')"
        @import="openImportModeDialog"
        @rename="openRenameModeDialog(selectedModeId)"
        @delete="openDeleteConfirm()"
      />

      <!-- 提示词组装方式 -->
      <AssemblyModeSelector
        :model-value="promptAssemblyMode"
        @update:model-value="handlePromptAssemblyModeChange"
      />

      <template v-if="promptAssemblyMode === 'entries'">
        <!-- 预设提示词条目编辑区 -->
        <div class="template-section entries-section" data-search-anchor="prompt-entries">
          <div class="section-header">
            <label class="section-label">
              <i class="codicon codicon-list-tree"></i>
              预设提示词条目
              <span class="section-badge entries-badge">role / drag</span>
            </label>
          </div>
          <p class="section-description">
            按顺序编辑多条提示词。system 条目会合并进系统提示词，user / assistant 条目会作为本次请求的临时上下文插入；Chat History 条目表示真实聊天历史插入点。
          </p>
          <PromptEntriesEditor
            v-model="promptEntries"
            :static-modules="STATIC_PROMPT_MODULES"
            :dynamic-modules="DYNAMIC_CONTEXT_MODULES"
            @convert-legacy="convertLegacyTemplatesToEntries"
          />
        </div>

        <!-- 动态上下文保留策略（预设条目模式） -->
        <div class="template-section dynamic-strategy-section" data-search-anchor="prompt-dynamic-strategy">
          <div class="section-header">
            <label class="section-label">
              <i class="codicon codicon-history"></i>
              {{ t('components.settings.promptSettings.dynamicSection.strategyTitle') }}
            </label>
          </div>

          <DynamicStrategyBlock
            :model-value="config.dynamicContextStrategy"
            :format-module-id="formatModuleId"
            @update:model-value="config.dynamicContextStrategy = $event"
          />
        </div>
      </template>

      <template v-else>
        <!-- 静态系统提示词编辑区 -->
        <StaticTemplateSection v-model="config.template" @reset="showResetStaticConfirm = true" />

        <!-- 动态上下文模板编辑区 -->
        <DynamicTemplateSection
          v-model="config.dynamicTemplate"
          v-model:enabled="config.dynamicTemplateEnabled"
          v-model:strategy="config.dynamicContextStrategy"
          :format-module-id="formatModuleId"
          @reset="showResetDynamicConfirm = true"
        />
      </template>

      <!-- 可用变量参考（可收缩，默认收起） -->
      <ModulesReference
        v-model:collapsed="collapsedReference"
        :expanded-module="expandedModule"
        :static-modules="STATIC_PROMPT_MODULES"
        :dynamic-modules="DYNAMIC_CONTEXT_MODULES"
        :format-module-id="formatModuleId"
        @toggle-module="toggleModule"
        @insert-static="insertStaticModule"
        @insert-dynamic="insertDynamicModule"
      />
      <!-- 模式工具策略 -->
      <ToolPolicySection
        v-model="toolPolicyMode"
        v-model:search-query="toolSearchQuery"
        :is-loading-tools="isLoadingTools"
        :available-tools="availableTools"
        :grouped-tools="groupedTools"
        :get-category-display-name="getCategoryDisplayName"
        :is-tool-selected="isToolSelected"
        :tool-policy="toolPolicy"
        @select-all="selectAllTools"
        @clear="clearAllTools"
        @toggle-tool="toggleTool"
      />

      <!-- Token 计数 -->
      <TokenCountSection
        v-model:selected-channel="selectedChannel"
        :is-counting-tokens="isCountingTokens"
        :static-token-count="staticTokenCount"
        :dynamic-token-count="dynamicTokenCount"
        :token-count-error="tokenCountError"
        :channel-options="channelOptions"
        :format-token-count="formatTokenCount"
        @refresh="countTokens"
      />
    </template>

    <!-- 保存浮窗提示 -->
    <Transition name="toast-fade">
      <div
        v-if="toastVisible"
        class="save-toast"
        :class="{ success: toastSuccess }"
        :role="toastSuccess ? 'status' : 'alert'"
        :aria-live="toastSuccess ? 'polite' : 'assertive'"
        aria-atomic="true"
      >
        <i :class="['codicon', toastSuccess ? 'codicon-check' : 'codicon-error']" aria-hidden="true"></i>
        {{ toastMessage }}
      </div>
    </Transition>

    <!-- 添加模式对话框 -->
    <InputDialog
      v-model="showAddModeDialog"
      :title="t('components.settings.promptSettings.modes.add')"
      :placeholder="t('components.settings.promptSettings.modes.newModeDefault')"
      :default-value="t('components.settings.promptSettings.modes.newModeDefault')"
      @confirm="confirmAddMode"
    />

    <!-- 复制模式对话框 -->
    <InputDialog
      v-model="showDuplicateModeDialog"
      :title="t('components.settings.promptSettings.modes.duplicate')"
      :placeholder="duplicatingModeName"
      :default-value="duplicatingModeName"
      @confirm="confirmDuplicateMode"
    />

    <!-- 导入模式对话框 -->
    <ImportModesDialog
      v-if="showImportModeDialog"
      :payload-text="importPayloadText"
      :error-message="importErrorMessage"
      @update:payload-text="importPayloadText = $event"
      @update:error-message="importErrorMessage = $event"
      @close="showImportModeDialog = false"
      @confirm="confirmImportModes"
      @export-all="exportPromptModes('all')"
      @file-change="handleImportFileChange"
    />

    <!-- 重命名模式对话框 -->
    <InputDialog
      v-model="showRenameModeDialog"
      :title="t('components.settings.promptSettings.modes.rename')"
      :placeholder="renamingModeName"
      :default-value="renamingModeName"
      @confirm="confirmRenameMode"
    />

    <!-- 删除确认对话框 -->
    <ConfirmDialog
      v-model="showDeleteConfirm"
      :title="t('components.settings.promptSettings.modes.delete')"
      :message="t('components.settings.promptSettings.modes.confirmDelete')"
      :is-danger="true"
      @confirm="confirmDeleteMode"
    />

    <!-- 未保存更改确认对话框 -->
    <ConfirmDialog
      v-model="showUnsavedConfirm"
      :title="t('components.common.confirmDialog.title')"
      :message="t('components.settings.promptSettings.modes.unsavedChanges')"
      @confirm="confirmSwitchMode"
    />

    <!-- 重置静态模板确认对话框 -->
    <ConfirmDialog
      v-model="showResetStaticConfirm"
      :title="t('components.settings.promptSettings.templateSection.title')"
      :message="t('components.common.confirmDialog.message')"
      @confirm="resetStaticToDefault"
    />

    <!-- 重置动态模板确认对话框 -->
    <ConfirmDialog
      v-model="showResetDynamicConfirm"
      :title="t('components.settings.promptSettings.dynamicSection.title')"
      :message="t('components.common.confirmDialog.message')"
      @confirm="resetDynamicToDefault"
    />
  </div>
</template>

<style scoped>
.prompt-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--vscode-descriptionForeground);
}

/* 保存浮窗提示 */
.save-toast {
  position: fixed;
  top: 48px;
  right: 24px;
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 12px;
  border-radius: 4px;
  background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
  color: var(--vscode-notifications-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}

.save-toast.success .codicon {
  color: var(--vscode-terminal-ansiGreen);
}

.save-toast:not(.success) .codicon {
  color: var(--vscode-errorForeground);
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.template-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.section-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 500;
}

.section-badge.entries-badge {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.entries-section {
  border-color: var(--vscode-focusBorder);
}

</style>
