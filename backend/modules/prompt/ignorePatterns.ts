/**
 * GrayCode - Prompt 忽略模式匹配
 *
 * gitignore 式忽略模式正则缓存与路径匹配。
 * 从 PromptManager.ts 抽离（纯重构，行为不变）。
 */

import { globPatternToRegExp } from './glob'

// ========== 忽略模式正则缓存（matchGlobPattern 每文件×每模式重复 new RegExp 的修复） ==========
// 模块级缓存：key=原始模式，flags 固定为 'i'（与旧实现一致，注意大小写/标志一致性）；
// 大工作区下每条消息可省去大量重复编译。
const ignorePatternRegexCache = new Map<string, RegExp>()
let ignorePatternRegexCompileCount = 0
let ignorePatternRegexHitCount = 0

/** 获取忽略模式正则缓存的统计（供测试断言编译次数） */
export function getGlobIgnoreRegexCacheStats(): { compiles: number; hits: number; size: number } {
    return { compiles: ignorePatternRegexCompileCount, hits: ignorePatternRegexHitCount, size: ignorePatternRegexCache.size }
}

/**
 * 简单的 glob 模式匹配
 */
export function matchGlobPattern(path: string, pattern: string): boolean {
    // 通配符展开语义见 glob.ts（gitignore 式：**/ 零段可选，* 不跨目录段）；
    // 先整体转义正则元字符（含 . [ ( + ? 等），避免用户配置含这些字符时 new RegExp 抛 SyntaxError。
    // 正则源由 pattern 确定性推导、flags 固定为 'i'，可按 pattern 缓存编译结果，避免重复编译。
    let regex = ignorePatternRegexCache.get(pattern)
    if (!regex) {
        const regexPattern = globPatternToRegExp(pattern)
        regex = new RegExp(`^${regexPattern}$|/${regexPattern}$|^${regexPattern}/|/${regexPattern}/`, 'i')
        ignorePatternRegexCompileCount++
        if (ignorePatternRegexCache.size >= 512) {
            ignorePatternRegexCache.clear()
        }
        ignorePatternRegexCache.set(pattern, regex)
    } else {
        ignorePatternRegexHitCount++
    }
    return regex.test(path.replace(/\\/g, '/'))
}

/**
 * 检查路径是否应该被忽略
 */
export function shouldIgnorePath(relativePath: string, ignorePatterns: string[]): boolean {
    for (const pattern of ignorePatterns) {
        if (matchGlobPattern(relativePath, pattern)) {
            return true
        }
    }
    return false
}
