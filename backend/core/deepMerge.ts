/**
 * 深度合并工具（模块化重构第六批收敛）。
 *
 * 语义基准：backend/modules/config/configs/base.ts 的 deepMerge 原实现迁入本文件，
 * 逻辑一字未改（数组/原始值直接覆盖、纯对象递归合并、跳过原型链污染键）。
 * base.ts 保留导出面（re-export），ConfigManager 等既有消费方不受影响。
 *
 * 本文件是仓库三套深合并的「参数化基准」实现。三者的关系与语义差异统一在此说明，
 * 避免差异只散落在各调用点注释里导致维护漂移：
 *
 * 1. core/deepMerge.ts 的 deepMerge(target, source, options?)（本文件）
 *    覆盖方向：source 为主、target 兜底——遍历 source 的键递归合并，target 独有键保留。
 *    用 options 参数化三类差异点：
 *    - nullMode:      source 为 null 时 'keep'（默认，返回 target）| 'write'（显式返回 null）。
 *    - undefinedMode: source 某键为 undefined 时 'keep'（默认，保留 target 值）
 *                     | 'skip'（跳过该键，不创建 own 属性）。
 *    - conflictMode:  target 非纯对象而 source 为纯对象时
 *                     'copy-source'（默认，置 target 为 {} 后按 source 递归构建副本）
 *                     | 'reuse-source'（直接返回 source 引用，不复制）。
 *
 * 2. SettingsCore.deepMergeToolsConfig(base, override)
 *    本文件 deepMerge 的薄封装，传入
 *    { nullMode: 'write', conflictMode: 'reuse-source', undefinedMode: 'skip' }。
 *    与历史上的本地递归实现逐字节等价（数组/原始值覆盖、null 显式写入、undefined 跳过、
 *    纯对象递归、类型冲突复用源引用、原型污染键防护），仅额外获得循环引用防护。
 *
 * 3. SettingsCore.deepMergeConfig(defaultConfig, storedConfig)（保留在 SettingsCore.ts，不合并）
 *    方向与本实现相反：default 为主、stored 补齐——遍历 default 的键，stored 值 undefined 时
 *    保留 default 值；stored 独有键浅赋值（不递归）。且「加载恢复」语义与 1/2 的「覆盖更新」
 *    语义不同：stored 为 undefined 返回 defaultConfig 本身、stored 为 null 返回 null、
 *    default 为纯对象而 stored 非纯对象时整体返回 defaultConfig 兜底（容忍损坏的存储数据）。
 *    强行合一需要再引入「合并方向 / 冲突兜底 / 独有键是否递归」等多组正交开关，
 *    复杂度与误用风险高于保留一段短小、注释齐全的本地实现，故刻意不合并。
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
 * deepMerge 的参数化选项。全部可选，缺省值与历史默认行为一致。
 */
export interface DeepMergeOptions {
    /**
     * source 为 null 时的行为：
     * - 'keep'（默认）：返回 target（保留目标值）；
     * - 'write'：显式返回 null（写入 null，清空字段）。
     * 注：source 为 undefined 时始终返回 target（保留目标值），不受本选项影响；
     * 键级「显式 undefined 跳过」由 undefinedMode 控制。
     */
    nullMode?: 'keep' | 'write';
    /**
     * source 某键值为 undefined 时的键级行为：
     * - 'keep'（默认）：保留 target 值（与 source 整体为 undefined 时一致，返回 target 值）；
     * - 'skip'：跳过该键，不写入结果——不创建 own 属性（与 SettingsCore.deepMergeToolsConfig
     *   历史实现的「value === undefined → continue」逐字节等价）。
     */
    undefinedMode?: 'keep' | 'skip';
    /**
     * 类型冲突（target 非纯对象而 source 为纯对象）时的行为：
     * - 'copy-source'（默认）：将 target 置为 {} 后按 source 逐键递归构建源副本；
     * - 'reuse-source'：直接返回 source 引用（不复本）。
     */
    conflictMode?: 'copy-source' | 'reuse-source';
}

/** 合并 options 与默认值，产出完整选项（避免深层每次判断 undefined）。 */
function resolveOptions(options?: DeepMergeOptions): Required<DeepMergeOptions> {
    return {
        nullMode: options?.nullMode ?? 'keep',
        undefinedMode: options?.undefinedMode ?? 'keep',
        conflictMode: options?.conflictMode ?? 'copy-source'
    };
}

/**
 * 深度合并两个对象
 *
 * @param target 目标对象
 * @param source 源对象
 * @param options 可选参数（nullMode / undefinedMode / conflictMode），缺省行为与历史一致
 * @returns 合并后的对象
 */
export function deepMerge(target: any, source: any, options?: DeepMergeOptions): any {
    return deepMergeInternal(target, source, new WeakSet(), resolveOptions(options));
}

/**
 * 深度合并内部实现：带循环引用检测（访问路径 WeakSet）。
 *
 * source/target 直接或间接自引用（如 merged.self = merged）时，无保护的递归会
 * 无限下钻直至栈溢出。路径检测只标记「当前递归链上」的对象，回溯时移除——
 * 兄弟分支共享同一对象（DAG）不会被误判为循环，行为与旧实现一致。
 */
function deepMergeInternal(
    target: any,
    source: any,
    seen: WeakSet<object>,
    opts: Required<DeepMergeOptions>
): any {
    if (source === null) {
        // nullMode 'write'：显式写入 null（清空字段）；'keep'（默认）：保留目标值
        return opts.nullMode === 'write' ? null : target;
    }
    if (source === undefined) {
        return target;
    }

    // 数组与原始值直接覆盖：
    // 旧实现目标数组与源数组拼接（[...target, ...sourceItems]），自定义设置/导入
    // 无法清空数组字段；改为覆盖后只有纯对象递归合并，其余一律以 source 为准。
    if (Array.isArray(source) || typeof source !== 'object') {
        return source;
    }

    // 目标为数组或非对象而源为纯对象：类型冲突。
    // conflictMode 'reuse-source'：直接复用源引用（SettingsCore.deepMergeToolsConfig 历史语义）；
    // 'copy-source'（默认）：置 target 为 {} 后按源副本递归构建。
    if (Array.isArray(target) || typeof target !== 'object' || target === null) {
        if (opts.conflictMode === 'reuse-source') {
            return source;
        }
        target = {};
    }

    // 循环引用兜底：target 已在本轮递归路径上（target 自引用）时返回当前 target 引用停止合并；
    // source 循环（直接/间接自引用）已由调用点（见下方循环内 seen.has(sourceValue) 分支）
    // 提前拦截，不会走到这里；保留该检查作为纵深防御，避免无限递归栈溢出。
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
        const sourceValue = source[key];
        // undefinedMode 'skip'：显式 undefined 跳过该键、不创建 own 属性
        // （与 SettingsCore.deepMergeToolsConfig 历史实现逐字节等价）。
        if (sourceValue === undefined && opts.undefinedMode === 'skip') {
            continue;
        }
        // 循环引用：sourceValue 已在本轮递归链上（source 直接/间接自引用，如 merged.self = merged）。
        // 直接递归会把该键替换成 undefined/{}（result[key] 尚未赋值时目标值为 undefined），
        // 与上方「保留既有结构」注释不符；这里保留目标旧值，目标没有该键时保留源引用本身，
        // 不再下钻——既避免栈溢出，也不破坏自引用结构。兄弟分支共享同一对象（DAG）不受影响：
        // 回溯时 seen 已移除，互不误判。
        if (seen.has(sourceValue)) {
            result[key] = result[key] !== undefined ? result[key] : sourceValue;
            continue;
        }
        // 递归合并所有子节点
        result[key] = deepMergeInternal(result[key], sourceValue, seen, opts);
    }

    // 回溯：兄弟分支共享同一对象（DAG）不被误判为循环
    seen.delete(source);
    seen.delete(target);

    return result;
}
