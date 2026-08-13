/**
 * GrayCode - Prompt 模板占位符
 *
 * 系统提示词模板占位符（{{$KEY}}）的注册表与单次扫描替换。
 * 从 PromptManager.ts 抽离（纯重构，行为不变）。
 */

export const DYNAMIC_PROMPT_PLACEHOLDERS = new Set([
    'TODO_LIST',
    'WORKSPACE_FILES',
    'OPEN_TABS',
    'ACTIVE_EDITOR',
    'DIAGNOSTICS',
    'PINNED_FILES',
    'SKILLS'
])

// ========== 模板占位符替换（单次扫描 + 回调查表） ==========
// 三处替换（generateFromTemplate / generateDynamicFromTemplate / renderPromptTemplateContent）
// 原先各自 for 循环逐键 new RegExp + replace，为 O(占位符数 × 模板长度) 的重复全串扫描；
// 合并为单个交替正则单次扫描，正则源模块级预编译（键集合固定为全部已知占位符）。
// 替换器用函数式 () => value 而非字符串替换值：JS replace 的替换字符串中
// $&/$`/$'/$$/$n 是特殊序列，值含这些字符（工作区路径/shell 脚本/自定义记忆提示词等）
// 会被静默改写（04 批 MEDIUM），函数式替换器天然规避。
export const PROMPT_PLACEHOLDER_KEYS = [
    'ENVIRONMENT',
    'CONTEXT_BADGE_FORMAT',
    'TODO_LIST',
    'WORKSPACE_FILES',
    'OPEN_TABS',
    'ACTIVE_EDITOR',
    'DIAGNOSTICS',
    'PINNED_FILES',
    'SKILLS',
    'MEMORY',
    'TOOLS',
    'MCP_TOOLS'
] as const

/** 预编译的占位符交替正则：匹配 {{$KEY}}（KEY ∈ PROMPT_PLACEHOLDER_KEYS，均为 [A-Z_]+，无正则元字符） */
export const PROMPT_PLACEHOLDER_REGEX = new RegExp(
    `\\{\\{\\$(?:${PROMPT_PLACEHOLDER_KEYS.join('|')})\\}\\}`,
    'g'
)

/**
 * 用查表替换模板中的 {{$KEY}} 占位符（单次交替正则扫描，见模块级 PROMPT_PLACEHOLDER_REGEX）。
 * 函数式替换器 () => value 天然规避 JS replace 替换字符串的 $&/$`/$'/$$/$n 特殊序列展开
 * （值可能来自工作区路径/固定文件内容/用户记忆提示词等不可信内容）。
 * 查表未命中的占位符保持原样（与旧逐键替换行为一致）。
 */
export function replacePromptPlaceholders(template: string, modules: Record<string, string>): string {
    return template.replace(PROMPT_PLACEHOLDER_REGEX, (placeholder) => {
        const key = placeholder.slice(3, -2) // 去掉 '{{$' 前缀与 '}}' 后缀
        const value = modules[key]
        return typeof value === 'string' ? value : placeholder
    })
}

/** 提取模板引用的全部 {{$KEY}} 键（按出现顺序去重，用于差分/按需构建） */
export function getReferencedPromptPlaceholders(template: string): Set<string> {
    const keys = new Set<string>()
    const regex = /\{\{\$([A-Z_]+)\}\}/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(template)) !== null) {
        keys.add(match[1])
    }
    return keys
}
