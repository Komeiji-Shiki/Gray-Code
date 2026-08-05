/**
 * 正则 ReDoS 防护共享工具
 *
 * 供 search_in_files / history_search / MemoryManager.recall 共用：
 * - 长度上限：超出直接拒绝，避免超长模式拖垮正则引擎
 * - 危险模式启发式检测：组内存在量词（+ 或 * 或 {n,m} 或 ?）或分支（|）且整个组再被
 *   量词修饰的嵌套量词（如 `(a+)+`、`(a|a)+`、`(a{2,})*`）是经典灾难性回溯来源；
 *   通过分组栈扫描识别嵌套分组绕过（如 `((a+)+)`、`(?=(a+))+`）
 * - 构造异常捕获：非法正则返回可读错误而不是把堆栈抛给调用方
 */

/** 正则源串长度上限（超出直接拒绝，不尝试完整 ReDoS 检测） */
export const MAX_REGEX_SOURCE_LENGTH = 500;

/** 紧跟在 `)` 之后才构成危险形态的量词（含 {n,m} 定界量词，与原启发式行为一致） */
const FOLLOWING_QUANTIFIERS = new Set(['+', '*', '?', '{']);

/**
 * 组体是否含危险内容（量词或分支）。
 *
 * - `+` `*` `{` 一律视为量词；
 * - `|` 视为分支（与旧启发式一致，宁可误杀也不放过）；
 * - `?` 仅当不是 `(?:` / `(?=` / `(?!` / `(?<=` / `(?<!` 的 lookaround 前缀时才视为量词
 *   （`(a?)+` 这类「可选组 + 外层量词」同样是灾难性回溯来源）。
 */
function groupBodyHasDanger(body: string): boolean {
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\\') {
            i++; // 跳过转义字符本身与目标
            continue;
        }
        if (ch === '+' || ch === '*' || ch === '{' || ch === '|') {
            return true;
        }
        if (ch === '?' && i > 0 && body[i - 1] !== '(') {
            return true;
        }
    }
    return false;
}

/**
 * 分组栈扫描：对每个 `)` 检查其后的字符。
 * 若紧跟量词，则回溯匹配的 `(` 并检查组体是否含量词/分支——
 * 嵌套分组（`((a+)+)`）不再被「组内不能有括号」的单层启发式漏掉。
 */
function hasDangerousQuantifiedGroup(pattern: string): boolean {
    const stack: number[] = [];
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            i++; // 跳过转义（\( \) 不算分组，[\]] 等类内转义也不结束类）
            continue;
        }
        if (inClass) {
            if (ch === ']') inClass = false;
            continue;
        }
        if (ch === '[') {
            inClass = true;
            continue;
        }
        if (ch === '(') {
            stack.push(i);
            continue;
        }
        if (ch === ')' && stack.length > 0) {
            const open = stack.pop()!;
            const next = pattern[i + 1];
            if (next !== undefined && FOLLOWING_QUANTIFIERS.has(next)) {
                const body = pattern.slice(open + 1, i);
                if (groupBodyHasDanger(body)) {
                    return true;
                }
            }
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

    // 危险模式检测在构造前执行：即使引擎能编译，运行时也可能灾难性回溯阻塞扩展宿主
    if (hasDangerousQuantifiedGroup(pattern)) {
        return {
            ok: false,
            error: `Dangerous regular expression pattern detected (possible ReDoS): nested quantifiers like "(a+)+", "(a|a)+", "((a+)+)" or "(?=(a+))+" are not allowed. Please simplify the pattern.`
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
