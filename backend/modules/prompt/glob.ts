/**
 * glob 模式转正则的公共实现（gitignore 式语义）
 *
 * - `*` 不跨目录段（`[^/]*`）
 * - 仅「独立段」的 `**`（整段为 `**`）跨任意段（`.*`），后紧跟分隔符时零段可选——
 *   模式 `**` + 分隔符 + `x` 匹配根级 `x`，模式 `a` + `/**` + 分隔符 + `b` 匹配 `a/b`
 * - 中缀 `**`（`a**b`、`**x`、`a**`）按普通 `*` 处理，不跨目录段（gitignore 语义）
 *
 * 为什么这里不需要 `[\\/]` 字符类：
 * 调用方在 test 前统一把路径归一化为 `/`（`path.replace(/\\/g, '/')`），
 * 因此模式里的 `/` 在 RegExp 源中就是字面 `/`，无需展开成 `[/\\]` 字符类——
 * 避免「正则源转义 + 字符串转义」叠加出的 4 反斜杠魔法，也消除了
 * 「斜杠替换必须先于星号替换」的顺序耦合（`*` 展开出的 `[^/]*` 不再被污染）。
 */

/** 转义正则元字符（glob 模式转正则前的公共前置步骤） */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把 glob 模式编译为（无锚点的）正则源串。
 *
 * 调用方按自身语义决定锚定方式：
 * - 全路径匹配：`^${src}$`
 * - 忽略模式（路径任意位置命中）：`^${src}$|/${src}$|^${src}/|/${src}/`
 *   （调用方须先 `path.replace(/\\/g, '/')` 归一化路径）
 */
export function globPatternToRegExp(pattern: string): string {
    return escapeRegExp(pattern.replace(/\\/g, '/'))
        .replace(/\\\*\\\*/g, '<<<GLOBSTAR>>>')        // 转义后的 **
        .replace(/\\\*/g, '[^/]*')                     // 转义后的 *
        // 仅「独立段」的 **（段首/段尾或 / 边界）才保留 globstar 语义；
        // 中缀 **（a**b、**x、a**）按普通 * 处理，不跨目录段
        .replace(/(^|\/)<<<GLOBSTAR>>>(?=\/|$)/g, '$1<<<GLOBSTAR_SEG>>>')
        .replace(/<<<GLOBSTAR>>>/g, '[^/]*')
        .replace(/<<<GLOBSTAR_SEG>>>\//g, '(?:.*/)?')  // ** 后跟分隔符：零段可选
        .replace(/<<<GLOBSTAR_SEG>>>/g, '.*')          // 裸 ** 跨任意段
}
