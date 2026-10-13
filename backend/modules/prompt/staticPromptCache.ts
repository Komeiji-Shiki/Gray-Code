/** 只保存不可变文本，不能把某次请求捕获的工作区、编辑器或角色读取函数留到下一轮。 */
export class StaticPromptCache {
    private readonly entries = new Map<string, { value: string; generatedAt: number }>()

    read(key: string, generate: () => string, refresh = false): string {
        const now = Date.now()
        const cached = this.entries.get(key)
        if (!refresh && cached && now - cached.generatedAt < 60000) {
            this.entries.delete(key)
            this.entries.set(key, cached)
            return cached.value
        }
        const value = generate()
        this.entries.delete(key)
        this.entries.set(key, { value, generatedAt: now })
        if (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!)
        return value
    }

    clear(): void {
        this.entries.clear()
    }
}
