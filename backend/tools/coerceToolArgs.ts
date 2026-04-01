/**
 * 工具参数预处理。
 *
 * 兜底策略：
 *
 * 1. boolean 容错：模型输出 "true"/"false" 字符串时，静默转为 true/false
 *    - 仅处理精确匹配 "true" 和 "false"，其他值（如 "yes"、"1"）不转换

 *
 * 2. number 容错：模型输出 "30"、"-5"、"3.14" 等数字字符串时，静默转为数字
 *    - 仅处理匹配 /^-?\d+(\.\d+)?$/ 的字符串，且 Number.isFinite 为 true

 *
 * 3. array 容错：模型把数组参数输出为 JSON 字符串时，尝试 JSON.parse
 *    - 仅在解析结果本身就是数组时才替换
 *
 * 所有转换仅处理顶层参数，不做递归。
 */

export interface ToolParameterSchema {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
}

export interface PropertySchema {
    type: string;
    items?: PropertySchema;
    properties?: Record<string, PropertySchema>;
    required?: string[];
    [key: string]: any;
}

/**
 * 对顶层参数做类型容错转换。
 *
 * 处理三种常见的模型输出错误：
 * - boolean 参数收到 "true"/"false" 字符串
 * - number 参数收到数字字符串
 * - array 参数收到 JSON 字符串
 *
 * 为什么要做这个：模型（尤其是较小的模型）经常在 JSON 输出中给布尔值和数字加引号，
 * 比如输出 {"recursive": "true"} 而非 {"recursive": true}。如果不做容错，
 * 工具内部要么静默得到错误类型，要么直接报错，用户体验差。
 */
export function coerceToolArgs(
    args: Record<string, any>,
    schema: ToolParameterSchema | undefined
): Record<string, any> {
    if (args == null || typeof args !== 'object' || !schema?.properties) {
        return args;
    }

    const result: Record<string, any> = { ...args };
    let modified = false;

    for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (!(key in result)) {
            continue;
        }

        const rawValue = result[key];
        const schemaType = propSchema?.type;

        // boolean 容错："true" → true, "false" → false
        // 仅处理精确的 "true"/"false" 字符串
        if (schemaType === 'boolean' && typeof rawValue === 'string') {
            if (rawValue === 'true') {
                result[key] = true;
                modified = true;
            } else if (rawValue === 'false') {
                result[key] = false;
                modified = true;
            }
            continue;
        }

        // number / integer 容错："30" → 30, "-5" → -5, "3.14" → 3.14
        // 仅处理合法十进制数字字符串
        if ((schemaType === 'number' || schemaType === 'integer') && typeof rawValue === 'string') {
            if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
                const n = Number(rawValue);
                if (Number.isFinite(n)) {
                    result[key] = n;
                    modified = true;
                }
            }
            continue;
        }

        // array 容错：JSON 字符串 → 数组（仅当解析结果是数组时替换）
        if (schemaType === 'array' && typeof rawValue === 'string' && !Array.isArray(rawValue)) {
            const parsed = tryParseJson(rawValue);
            if (Array.isArray(parsed)) {
                result[key] = parsed;
                modified = true;
            }
            continue;
        }
    }

    return modified ? result : args;
}

/**
 * 校验 array 参数是否已经是数组。
 *
 * 设计目标：
 * - 先经过 coerceToolArgs 做一次字符串转数组尝试
 * - 如果对应参数仍然不是数组，则直接返回工具结果错误
 */
export function getToolArgsArrayValidationError(
    toolName: string,
    args: Record<string, any>,
    schema: ToolParameterSchema | undefined
): string | null {
    if (args == null || typeof args !== 'object' || !schema?.properties) {
        return null;
    }

    for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (!(key in args) || propSchema?.type !== 'array') {
            continue;
        }

        const value = args[key];
        if (Array.isArray(value)) {
            continue;
        }

        if (typeof value === 'string') {
            return `Tool "${toolName}" expects parameter "${key}" to be an array. The model returned a string, but it could not be parsed into a JSON array.`;
        }

        return `Tool "${toolName}" expects parameter "${key}" to be an array.`;
    }

    return null;
}

function tryParseJson(str: string): unknown {
    try {
        return JSON.parse(str);
    } catch {
        return undefined;
    }
}
