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
 */
const DANGEROUS_GROUP_QUANTIFIER = /\([^()]*(?:[+*]|\|[^()]*|\{[^}]*\})[^()]*\)(?:[+*]|\{[^}]*\})/;

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

    // 危险模式检测在构造前执行：即使引擎能编译，运行时也可能灾难性回溯阻塞扩展宿主
    if (DANGEROUS_GROUP_QUANTIFIER.test(pattern)) {
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
