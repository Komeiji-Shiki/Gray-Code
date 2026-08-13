/**
 * GrayCode - Prompt 文本工具
 *
 * 轻量字符串指纹、TODO 列表格式化、文本截断等纯函数。
 * 从 PromptManager.ts 抽离（纯重构，行为不变）。
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type NormalizedTodoItem = { id: string; content: string; status: TodoStatus }

export function isTodoStatus(value: unknown): value is TodoStatus {
    return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled'
}

export function normalizeTodoList(raw: unknown): NormalizedTodoItem[] {
    if (!Array.isArray(raw)) return []
    const out: NormalizedTodoItem[] = []
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const id = (item as any).id
        const content = (item as any).content
        const status = (item as any).status
        if (typeof id !== 'string' || !id.trim()) continue
        if (typeof content !== 'string') continue
        if (!isTodoStatus(status)) continue
        out.push({ id: id.trim(), content, status })
    }
    return out
}

export function truncateText(s: string, maxLen: number): string {
    const t = (s ?? '').replace(/\s+/g, ' ').trim()
    if (t.length <= maxLen) return t
    return t.slice(0, Math.max(0, maxLen - 1)) + '…'
}

/**
 * 轻量字符串指纹（FNV-1a 32 位 + 长度前缀）。
 * 用于把模板文本嵌入系统提示词缓存键：模板可能很长，直接拼原文会让 key 巨大；
 * 长度先筛掉绝大多数差异，哈希兜底区分等长但内容不同的模板。
 */
export function fingerprint(s: string): string {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return `${s.length}:${(h >>> 0).toString(36)}`
}

export function formatTodoListText(raw: unknown): string {
    const todos = normalizeTodoList(raw)
    if (todos.length === 0) return ''

    const order: Record<TodoStatus, number> = {
        in_progress: 0,
        pending: 1,
        completed: 2,
        cancelled: 3
    }
    const sorted = [...todos].sort((a, b) => {
        const oa = order[a.status] ?? 9
        const ob = order[b.status] ?? 9
        if (oa !== ob) return oa - ob
        return a.id.localeCompare(b.id)
    })

    const counts: Record<TodoStatus, number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        cancelled: 0
    }
    for (const t of todos) counts[t.status]++

    const MAX_ITEMS = 50
    const shown = sorted.slice(0, MAX_ITEMS)

    const lines: string[] = []
    lines.push(
        `Total: ${todos.length} | pending: ${counts.pending} | in_progress: ${counts.in_progress} | completed: ${counts.completed} | cancelled: ${counts.cancelled}`
    )
    for (const t of shown) {
        const content = truncateText(t.content, 200)
        lines.push(`- [${t.status}] ${content}  \`#${t.id}\``)
    }
    if (sorted.length > shown.length) {
        lines.push(`... and ${sorted.length - shown.length} more items.`)
    }

    return lines.join('\n')
}
