/**
 * 深度合并工具（模块化重构第六批收敛）。
 *
 * 语义基准：backend/modules/config/configs/base.ts 的 deepMerge 原实现迁入本文件，
 * 逻辑一字未改（数组/原始值直接覆盖、纯对象递归合并、跳过原型链污染键）。
 * base.ts 保留导出面（re-export），ConfigManager 等既有消费方不受影响。
 *
 * 注意：与 backend/modules/settings/SettingsCore.ts 的 deepMergeToolsConfig 语义存在差异，
 * 刻意不强制合一：
 * - 覆盖值为 null/undefined 时，本实现保留目标值；deepMergeToolsConfig 显式写入该值；
 * - 类型冲突（目标非纯对象、源为纯对象）时，本实现生成源对象的副本，
 *   deepMergeToolsConfig 直接复用源引用。
 * SettingsCore 调用方（updateSettings / getToolsConfigEntry / CheckpointSettingsService）
 * 依赖前者行为，保留其本地实现（见 SettingsCore.ts 注释）。
 */

/**
 * 合并键黑名单：__proto__/constructor/prototype 键在 Object.entries 中会出现，
 * `result['__proto__'] = value` 会触发原型 setter 替换合并结果的原型链（原型污染）。
 */
const UNSAFE_MERGE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** 键是否可安全参与合并（排除原型链污染键 __proto__/constructor/prototype） */
export function isSafeMergeKey(key: string): boolean {
    return !UNSAFE_MERGE_KEYS.has(key);
}

/**
 * 深度合并两个对象
 *
 * @param target 目标对象
 * @param source 源对象
 * @returns 合并后的对象
 */
export function deepMerge(target: any, source: any): any {
    return deepMergeInternal(target, source, new WeakSet());
}

/**
 * 深度合并内部实现：带循环引用检测（访问路径 WeakSet）。
 *
 * source/target 直接或间接自引用（如 merged.self = merged）时，无保护的递归会
 * 无限下钻直至栈溢出。路径检测只标记「当前递归链上」的对象，回溯时移除——
 * 兄弟分支共享同一对象（DAG）不会被误判为循环，行为与旧实现一致。
 */
function deepMergeInternal(target: any, source: any, seen: WeakSet<object>): any {
    if (source === null || source === undefined) {
        return target;
    }
    
    // 数组与原始值直接覆盖（与 SettingsCore.deepMergeToolsConfig 的数组/原始值语义一致）：
    // 旧实现目标数组与源数组拼接（[...target, ...sourceItems]），自定义设置/导入
    // 无法清空数组字段；改为覆盖后只有纯对象递归合并，其余一律以 source 为准。
    if (Array.isArray(source) || typeof source !== 'object') {
        return source;
    }
    
    // 目标为数组或非对象而源为纯对象：类型冲突，以源为准（覆盖语义）
    if (Array.isArray(target) || typeof target !== 'object' || target === null) {
        target = {};
    }

    // 循环引用：source 或 target 已在本轮递归路径上，返回当前 target 引用停止合并，
    // 保留既有结构，避免无限递归栈溢出。
    if (seen.has(source) || seen.has(target)) {
        return target;
    }
    seen.add(source);
    seen.add(target);
    
    const result = { ...target };
    
    for (const key of Object.keys(source)) {
        // 跳过原型链污染键（__proto__/constructor/prototype）
        if (!isSafeMergeKey(key)) {
            continue;
        }
        // 递归合并所有子节点
        result[key] = deepMergeInternal(result[key], source[key], seen);
    }

    // 回溯：兄弟分支共享同一对象（DAG）不被误判为循环
    seen.delete(source);
    seen.delete(target);
    
    return result;
}
