/**
 * 正则 ReDoS 防护共享工具
 *
 * 供 search_in_files / history_search / MemoryManager.recall 共用：
 * - 长度上限：超出直接拒绝，避免超长模式拖垮正则引擎
 * - 危险模式启发式检测：组内存在量词（+ 或 * 或 {n,m}）或分支（|）且整个组再被量词
 *   修饰的嵌套量词（如 `(a+)+`、`(a|a)+`、`(a{2,})*`）是经典灾难性回溯来源
 * - 构造异常捕获：非法正则返回可读错误而不是把堆栈抛给调用方
 */

/** 正则源串长度上限（超出直接拒绝，不尝试完整 ReDoS 检测） */
export const MAX_REGEX_SOURCE_LENGTH = 500;

/**
 * 危险模式启发式：
 * `\(` 开头组 → 组内出现量词/分支/范围量词 → `\)` 后紧跟量词。
 * 单组字面量加量词（如 `(abc)+`、`(foo)*`）不拦截，避免误伤常见合法正则。
 * 组内量词包含 `?`（`(a?)+` 与 `(a+)+` 同属灾难性回溯家族；`(abc)?` 因组内无量词不命中）。
 */
const DANGEROUS_GROUP_QUANTIFIER = /\([^()]*(?:[+*?]|\|[^()]*|\{[^}]*\})[^()]*\)(?:[+*]|\{[^}]*\})/;

/**
 * 扫描式嵌套量词检测——弥补 DANGEROUS_GROUP_QUANTIFIER 的 `[^()]*` 盲区：
 * 外层分组的 `[^()]*` 无法跨过内层括号，`((a+)+)+`、`((a|a)+)+` 等经典灾难性回溯
 * 模式检测不到，而这类模式 500 字符内即可构造，作用在不受信任文件内容上会卡死扩展宿主。
 *
 * 规则：逐字符跟踪括号深度，某层内出现过「被量词修饰的闭组」时给父层打标记；
 * 外层闭组自身再被量词修饰且组内存在带量词的子组 → 命中。
 * 转义括号、字符类内的括号不计。
 */
export function hasNestedQuantifiedGroups(pattern: string): boolean {
    let depth = 0;
    // 每层深度「该层内是否已出现带量词的闭组」（开组时重置，闭组时弹给父层）
    const hasQuantifiedChild = new Map<number, boolean>();
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            i += 1; // 跳过转义字符（含 \( \) \{ 等）
            continue;
        }
        if (inClass) {
            if (ch === ']') {
                inClass = false;
            }
            continue;
        }
        if (ch === '[') {
            inClass = true;
            continue;
        }
        if (ch === '(') {
            depth += 1;
            hasQuantifiedChild.set(depth, false);
            continue;
        }
        if (ch === ')') {
            const innerQuantified = hasQuantifiedChild.get(depth) === true;
            hasQuantifiedChild.delete(depth);
            depth = Math.max(0, depth - 1);
            const rest = pattern.slice(i + 1);
            // 尾部量词含 `?`（可选）：`(a+)?` 与 `(a+)` 一样会放大组内量词的歧义，
            // 单独出现（innerQuantified=false）不构成灾难性回溯（`(abc)?` 安全）。
            const quantified = rest.startsWith('*')
                || rest.startsWith('+')
                || rest.startsWith('?')
                || (rest.startsWith('{') && /^\{\d+(?:,\d*)?\}/.test(rest));
            if (innerQuantified && quantified) {
                return true; // 外层量词套内层带量词的组
            }
            if (innerQuantified || quantified) {
                // 本组内出现带量词子组（或本组被量词修饰）→ 对父层标记
                hasQuantifiedChild.set(depth, true);
            }
            continue;
        }
    }
    return false;
}

/**
 * 校验并构造正则（带 ReDoS 护栏）。
 *
 * @param pattern 正则源串（不包含修饰符）
 * @param flags   正则修饰符（如 'gi'）；不传则不使用修饰符
 */
export function validateRegexPattern(
    pattern: string,
    flags?: string
): { ok: true; regex: RegExp } | { ok: false; error: string } {
    if (pattern.length > MAX_REGEX_SOURCE_LENGTH) {
        return {
            ok: false,
            error: `Regular expression too long (${pattern.length} characters, maximum ${MAX_REGEX_SOURCE_LENGTH}). Please simplify the pattern.`
        };
    }

    // 危险模式检测在构造前执行：即使引擎能编译，运行时也可能灾难性回溯阻塞扩展宿主。
    // 两层检测互补：正则启发式覆盖平铺组内量词/分支（(a+)+、(a|a)+），
    // 扫描式覆盖嵌套分组（((a+)+)+ 等 `[^()]*` 无法跨过的形态）。
    if (DANGEROUS_GROUP_QUANTIFIER.test(pattern) || hasNestedQuantifiedGroups(pattern)) {
        return {
            ok: false,
            error: `Dangerous regular expression pattern detected (possible ReDoS): nested quantifiers like "(a+)+", "(a|a)+" or "(a{2,})*" are not allowed. Please simplify the pattern.`
        };
    }

    try {
        const regex = new RegExp(pattern, flags);
        return { ok: true, regex };
    } catch (e) {
        return {
            ok: false,
            error: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`
        };
    }
}
