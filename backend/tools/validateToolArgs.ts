/**
 * 工具参数 JSON Schema 校验。
 *
 * 将 JSON Schema 校验错误转为模型可理解的自然语言描述，作为工具调用的错误结果
 * 返回给模型，让模型自行修正参数后重试。
 *
 * 为什么需要：
 * - 没有此校验时，参数错误会在工具 handler 内部抛出程序异常，模型无法理解
 * - 有了此校验，模型能看到 "The required parameter `files` is missing" 这样的描述
 *
 * 与 normalizeToolArgs 的分工：
 * - normalizeToolArgs 负责"能纠正的纠正"（类型容错、别名提升、未知参数剥离+警告）
 * - validateToolArgs 只对纠正后仍然无法执行的问题报错：
 *   1. 必需字段缺失（required 中列出但未提供），含嵌套结构（如 `files[0].line`）
 *   2. 字段类型不匹配（schema 定义为 number 但收到了 string 等），含嵌套结构
 *   3. enum 值不在允许列表中（报错时附上全部可选值）
 *
 * 校验失败时会在错误末尾附带从 schema 生成的紧凑参数签名（Expected parameters），
 * 让模型无需再猜一轮就能看到正确的参数形状。
 */

import type { PropertySchema, ToolParameterSchema } from './coerceToolArgs';

/** 单次校验最多报告的问题条数，避免大批量数组元素错误撑爆错误消息 */
const MAX_REPORTED_ISSUES = 10;

/** 参数签名中嵌套 object 的最大内联展开深度 */
const MAX_SIGNATURE_DEPTH = 3;

/** 嵌套结构递归校验的最大深度（防御异常深的 schema/参数） */
const MAX_VALIDATION_DEPTH = 6;

/**
 * 校验工具参数是否符合 JSON Schema。
 *
 * @param toolName 工具名称（用于错误消息）
 * @param args 工具参数（应已经过 normalizeToolArgs 处理）
 * @param schema 工具的 JSON Schema
 * @returns 校验通过返回 null，否则返回模型可理解的错误描述（含参数签名）
 */
export function validateToolArgs(
    toolName: string,
    args: Record<string, any>,
    schema: ToolParameterSchema | undefined
): string | null {
    if (!schema?.properties) {
        return null;
    }

    // args 为 null/字符串/数字/数组等非对象值时，validateObjectValue 中 `key in obj`
    // 会对原始类型抛 TypeError，导致整个工具批次崩溃。先在此守卫，把非 JSON 对象
    // 参数转成可读错误返回，让模型自行修正。
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return `${toolName} failed: parameters must be a JSON object, got ${args === null ? 'null' : typeof args}`;
    }

    const issues: string[] = [];
    validateObjectValue(args, schema.properties, schema.required, '', issues, 0);

    if (issues.length === 0) {
        return null;
    }

    const reported = issues.slice(0, MAX_REPORTED_ISSUES);
    if (issues.length > reported.length) {
        reported.push(`...and ${issues.length - reported.length} more similar issues`);
    }

    // 附带参数签名：模型收到"缺了什么/错了什么"的同时直接看到正确的参数形状，
    // 避免"知道错了但还要再猜一轮参数结构"的额外迭代
    const noun = issues.length > 1 ? 'issues' : 'issue';
    return `${toolName} failed due to the following ${noun}:\n`
        + `${reported.join('\n')}\n\n`
        + `Expected parameters for \`${toolName}\`:\n${formatSchemaSignature(schema)}`;
}

/**
 * 校验一个对象值的 required 字段和各已声明属性（递归入口）。
 *
 * @param path 当前对象在参数树中的路径；顶层为空字符串
 */
function validateObjectValue(
    obj: Record<string, any>,
    properties: Record<string, PropertySchema>,
    required: string[] | undefined,
    path: string,
    issues: string[],
    depth: number
): void {
    if (required) {
        for (const key of required) {
            if (!(key in obj) || obj[key] === undefined) {
                issues.push(`The required parameter \`${joinPath(path, key)}\` is missing`);
            }
        }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
        const value = obj[key];
        // null 视为"未提供"跳过类型检查（与 required 检查行为保持一致的宽松策略）
        if (!(key in obj) || value === undefined || value === null) {
            continue;
        }
        validateValue(value, propSchema, joinPath(path, key), issues, depth);
    }
}

/**
 * 校验单个值：类型 → enum → 递归进入 array items / object properties。
 * 类型不匹配时立即返回，不再对错误类型的值做深层检查（避免产生误导性的连锁错误）。
 */
function validateValue(
    value: any,
    schema: PropertySchema | undefined,
    path: string,
    issues: string[],
    depth: number
): void {
    if (!schema || depth > MAX_VALIDATION_DEPTH) {
        return;
    }

    const expectedType = schema.type;
    if (expectedType) {
        const actualType = getJsonType(value);

        // integer 是 number 的子类型，单独处理
        if (expectedType === 'integer') {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                issues.push(
                    `The parameter \`${path}\` type is expected as \`integer\` but provided as \`${actualType}\``
                );
                return;
            }
        } else if (expectedType === 'array' && actualType === 'string') {
            // array 参数收到字符串时给出更具体的指引：
            // coerceToolArgs 已经尝试过把 JSON 字符串解析为数组，走到这里说明解析失败
            issues.push(
                `The parameter \`${path}\` is expected as \`array\` but a string was provided ` +
                `and it could not be parsed into a JSON array. Provide a real JSON array instead of a quoted string`
            );
            return;
        } else if (expectedType !== actualType) {
            issues.push(
                `The parameter \`${path}\` type is expected as \`${expectedType}\` but provided as \`${actualType}\``
            );
            return;
        }
    }

    // enum：类型正确但值不在允许列表中。附上全部可选值，模型一轮即可修正
    if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
        issues.push(
            `The parameter \`${path}\` must be one of ${schema.enum.map(formatEnumValue).join(' | ')}, ` +
            `but \`${String(value)}\` was provided`
        );
        return;
    }

    // 递归进入数组元素
    if (expectedType === 'array' && Array.isArray(value) && schema.items) {
        for (let i = 0; i < value.length; i++) {
            const item = value[i];
            if (item === undefined || item === null) {
                continue;
            }
            validateValue(item, schema.items, `${path}[${i}]`, issues, depth + 1);
        }
        return;
    }

    // 递归进入嵌套对象的已声明属性
    if (expectedType === 'object' && schema.properties && isPlainObject(value)) {
        validateObjectValue(value, schema.properties, schema.required, path, issues, depth + 1);
    }
}

/**
 * 从 schema 生成紧凑的参数签名，随校验错误一起回传给模型。
 *
 * 输出示例：
 * - path: string (required)
 * - hunks: Array<{ oldContent: string; newContent: string; startLine?: number }> (required)
 * - updateMode: "revision" | "progress_sync" (optional)
 */
function formatSchemaSignature(schema: ToolParameterSchema): string {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties)
        .map(([name, prop]) => {
            const requirement = required.has(name) ? 'required' : 'optional';
            return `- ${name}: ${formatTypeExpression(prop, 0)} (${requirement})`;
        })
        .join('\n');
}

/**
 * 把单个属性 schema 转成 TypeScript 风格的类型表达式。
 * 嵌套 object 内联展开（超过深度上限时降级为 object），enum 展开为字面量联合。
 */
function formatTypeExpression(schema: PropertySchema | undefined, depth: number): string {
    if (!schema) {
        return 'any';
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum.map(formatEnumValue).join(' | ');
    }

    const type = schema.type;
    if (type === 'array') {
        return `Array<${formatTypeExpression(schema.items, depth + 1)}>`;
    }
    if (type === 'object' && schema.properties) {
        if (depth >= MAX_SIGNATURE_DEPTH) {
            return 'object';
        }
        const required = new Set(schema.required ?? []);
        const inner = Object.entries(schema.properties)
            .map(([key, prop]) => `${key}${required.has(key) ? '' : '?'}: ${formatTypeExpression(prop, depth + 1)}`)
            .join('; ');
        return `{ ${inner} }`;
    }
    return type || 'any';
}

function formatEnumValue(value: unknown): string {
    return typeof value === 'string' ? `"${value}"` : String(value);
}

function joinPath(parent: string, key: string): string {
    return parent ? `${parent}.${key}` : key;
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 获取值的 JSON Schema 类型名称。
 */
function getJsonType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}
