/**
 * GrayCode - 模型工具声明本地化应用器
 *
 * 无副作用：克隆工具声明和递归参数 schema，在克隆对象上替换说明，返回新对象。
 * 不修改 ToolRegistry 中的声明，也不修改动态工厂返回后被其他调用方持有的对象。
 *
 * 只覆盖 description 字段，不改变：工具名、参数键、type、required、enum、
 * default、strict、readOnly、依赖和别名。
 */

import type { ToolDeclaration } from '../types';
import type { ToolDescriptionLocalization } from './types';

/**
 * 深度克隆 JSON 安全对象（工具声明参数 schema 不含函数/循环引用）。
 */
function deepClone<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(item => deepClone(item)) as unknown as T;
    }
    if (value && typeof value === 'object') {
        const cloned: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            cloned[key] = deepClone(item);
        }
        return cloned as unknown as T;
    }
    return value;
}

/**
 * 在参数 schema 的 properties 上按稳定路径设置 description。
 *
 * 路径格式示例：
 * - path                      → properties.path.description
 * - files                     → properties.files.description
 * - files[].path              → properties.files.items.properties.path.description
 * - hunks[].oldContent        → properties.hunks.items.properties.oldContent.description
 * - structuredFindings[].evidence[].path
 *
 * 定位失败时静默跳过（找不到翻译项时保留原说明，不删除信息）。
 */
function setDescriptionAtPath(
    properties: Record<string, any>,
    pathKey: string,
    description: string
): boolean {
    const segments = pathKey.split('.');
    let node: Record<string, any> | undefined = { properties };

    for (let i = 0; i < segments.length; i++) {
        if (!node) {
            return false;
        }
        const segment = segments[i];
        const isArrayTraversal = segment.endsWith('[]');
        const name = isArrayTraversal ? segment.slice(0, -2) : segment;

        const prop = node.properties?.[name] ?? node[name];
        if (!prop || typeof prop !== 'object') {
            return false;
        }

        if (i === segments.length - 1) {
            prop.description = description;
            return true;
        }

        node = isArrayTraversal ? (prop.items ?? prop) : prop;
    }
    return false;
}

/**
 * 应用本地化。
 *
 * - 未配置本地化项时返回原声明（未做任何修改，零拷贝）；
 * - 配置了本地化项时返回克隆后的新声明，原声明与动态工厂产物不被修改；
 * - 找不到某个翻译路径时保留原说明。
 */
export function localizeToolDeclaration(
    declaration: ToolDeclaration,
    localization: ToolDescriptionLocalization | undefined
): ToolDeclaration {
    if (!localization) {
        return declaration;
    }

    const cloned: ToolDeclaration = {
        ...declaration,
        description: localization.description ?? declaration.description,
        parameters: {
            ...declaration.parameters,
            properties: deepClone(declaration.parameters.properties)
        }
    };

    if (localization.parameters) {
        for (const [pathKey, text] of Object.entries(localization.parameters)) {
            setDescriptionAtPath(cloned.parameters.properties, pathKey, text);
        }
    }

    return cloned;
}
