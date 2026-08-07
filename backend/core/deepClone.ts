/**
 * GrayCode - 通用深拷贝工具
 *
 * 优先使用 structuredClone（Node 17+/Electron 内置，保留 undefined、Date、
 * Map、Set 等非 JSON 类型，且性能优于 JSON 往返）；遇到不可结构化克隆的值
 * （如函数、Symbol、DOM 节点）时回退到 JSON.parse(JSON.stringify(...))，
 * 保持与旧深拷贝行为一致。
 *
 * 用法：
 * ```ts
 * import { deepClone } from '../../core/deepClone';
 *
 * const copy = deepClone(original);
 * ```
 */

export function deepClone<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}
