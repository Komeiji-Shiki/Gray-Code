/**
 * GrayCode - 深度相等比较工具
 *
 * 仅比较可序列化数据（配置对象/数组/原始值），不做类型收窄、不处理函数等非常规值。
 * 原为 SettingsCore.deepEqual（private static）与 VSCodeSettingsStorage.deepEqual
 * 两份逐字相同实现：统一下沉到 core，供设置保存 diff（VSCodeSettingsStorage.save）
 * 与 system_prompt 变更判定（SettingsCore.notifySystemPromptChangeIfNeeded）共用，
 * 避免维护漂移。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    // 数组经 Object.keys 按索引递归比较，语义与逐元素顺序比较一致
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    return aKeys.every(key =>
        deepEqual(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key]
        )
    );
}
