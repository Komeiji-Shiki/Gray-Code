/**
 * 工具参数预处理（规范化）。
 *
 * 设计原则：能纠正的就纠正（附带警告告知模型），纠正不了的才交给
 * validateToolArgs 报错。目标是减少"模型因为无害的参数瑕疵浪费一整轮迭代"。
 *
 * 规范化流程（normalizeToolArgs）：
 *
 * 1. 参数改名别名（paramAliases，来自 ToolDeclaration）：
 *    仅适用于与规范参数语义完全等价的纯改名（如 read_file 的 maxLine → endLine）。
 *    当规范参数缺失且别名出现时自动改名并生成警告。
 *
 * 2. 单数别名提升：模型经常把数组参数写成单数形式，
 *    如 {"path": "a.txt"} 而非 {"paths": ["a.txt"]}。
 *    当 schema 声明了数组参数（规则复数 `xxxs` 或 `xxies`）、args 中缺失该参数
 *    但出现了对应单数形式时，自动提升为数组并生成警告。
 *    单数名本身是该工具合法参数时绝不处理。
 *
 * 3. 类型容错（递归，覆盖嵌套结构）：
 *    - boolean："true"/"false"（大小写不敏感，兼容 Python 风格 "True"）→ 布尔值
 *    - number/integer："30"、"-5"、"3.14" 等数字字符串 → 数字
 *    - array：JSON 字符串 → 数组（仅当解析结果确实是数组），并继续递归处理元素
 *    - object：JSON 字符串 → 对象（仅当解析结果是普通对象，覆盖双重编码场景），
 *      并按 properties 递归处理已声明的属性
 *
 * 4. 未知参数剥离：schema 中未声明的顶层参数直接移除并生成警告，
 *    而不是让整个调用失败。工具声明的兼容透传参数（compatParams）除外：
 *    它们不向模型宣传但会被保留，由 handler 自行解释语义。
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

export interface NormalizeToolArgsOptions {
    /** 纯改名别名：alias → canonical（来自 ToolDeclaration.paramAliases） */
    paramAliases?: Record<string, string>;
    /** 兼容透传参数：不剥离、由 handler 解释语义（来自 ToolDeclaration.compatParams） */
    compatParams?: string[];
}

export interface NormalizeToolArgsResult {
    args: Record<string, any>;
    warnings: string[];
}

/**
 * 工具参数规范化统一入口。
 *
 * 按顺序执行：参数改名别名 → 单数别名提升 → 递归类型容错 → 未知参数剥离。
 * 所有自动纠正都会生成一条警告，最终应随工具结果回传给模型，
 * 帮助模型在后续调用中自行修正。
 */
export function normalizeToolArgs(
    toolName: string,
    args: Record<string, any>,
    schema: ToolParameterSchema | undefined,
    options?: NormalizeToolArgsOptions
): NormalizeToolArgsResult {
    if (args == null || typeof args !== 'object' || Array.isArray(args) || !schema?.properties) {
        return { args, warnings: [] };
    }

    const warnings: string[] = [];

    let currentArgs = applyParamAliases(args, schema, options?.paramAliases, warnings);
    currentArgs = promoteSingularArrayAliases(currentArgs, schema, warnings);
    currentArgs = coerceToolArgs(currentArgs, schema);
    currentArgs = stripUnknownParams(toolName, currentArgs, schema, options?.compatParams, warnings);

    return { args: currentArgs, warnings };
}

/**
 * 对参数做递归类型容错转换。
 *
 * 为什么要做这个：模型（尤其是较小的模型）经常在 JSON 输出中给布尔值和数字
 * 加引号，比如输出 {"recursive": "true"} 而非 {"recursive": true}；嵌套结构里
 * 同样会犯（如 files[].line 输出 "5"）。如果不做容错，工具内部要么静默得到
 * 错误类型，要么直接报错，白白浪费一轮迭代。
 *
 * 未修改任何值时返回原始对象引用（便于调用方做同一性判断）。
 */
export function coerceToolArgs(
    args: Record<string, any>,
    schema: ToolParameterSchema | undefined
): Record<string, any> {
    if (args == null || typeof args !== 'object' || !schema?.properties) {
        return args;
    }

    const { value, modified } = coerceObjectBySchema(args, schema.properties);
    return modified ? value : args;
}

/**
 * 按 properties 定义递归处理对象的每个已声明属性。
 * 未在 schema 中声明的属性保持原样（顶层的剥离由 stripUnknownParams 负责，
 * 嵌套层不做剥离，避免过度激进）。
 */
function coerceObjectBySchema(
    obj: Record<string, any>,
    properties: Record<string, PropertySchema>
): { value: Record<string, any>; modified: boolean } {
    let modified = false;
    const result: Record<string, any> = { ...obj };

    for (const [key, propSchema] of Object.entries(properties)) {
        if (!(key in result)) {
            continue;
        }
        const coerced = coerceValueBySchema(result[key], propSchema);
        if (coerced.modified) {
            result[key] = coerced.value;
            modified = true;
        }
    }

    return { value: modified ? result : obj, modified };
}

/**
 * 按单个属性 schema 递归处理值。
 */
function coerceValueBySchema(
    value: any,
    schema: PropertySchema | undefined
): { value: any; modified: boolean } {
    if (value == null || !schema?.type) {
        return { value, modified: false };
    }

    const schemaType = schema.type;

    // boolean 容错："true"/"false"（大小写不敏感）→ true/false
    if (schemaType === 'boolean' && typeof value === 'string') {
        const lowered = value.toLowerCase();
        if (lowered === 'true') {
            return { value: true, modified: true };
        }
        if (lowered === 'false') {
            return { value: false, modified: true };
        }
        return { value, modified: false };
    }

    // number / integer 容错："30" → 30, "-5" → -5, "+5" → 5, "3.14" → 3.14, "1e3" → 1000
    // 仅处理合法十进制数字字符串（含正负号与科学计数法；用 Number.isFinite 校验最终值）
    if ((schemaType === 'number' || schemaType === 'integer') && typeof value === 'string') {
        if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
            const n = Number(value);
            if (Number.isFinite(n)) {
                return { value: n, modified: true };
            }
        }
        return { value, modified: false };
    }

    // array 容错：JSON 字符串 → 数组（仅当解析结果是数组时替换），
    // 再对数组元素按 items schema 递归处理
    if (schemaType === 'array') {
        let arrayValue = value;
        let modified = false;

        if (typeof arrayValue === 'string') {
            const parsed = tryParseJson(arrayValue);
            if (Array.isArray(parsed)) {
                arrayValue = parsed;
                modified = true;
            } else {
                return { value, modified: false };
            }
        }

        if (Array.isArray(arrayValue) && schema.items) {
            let itemsModified = false;
            const newItems = arrayValue.map((item: any) => {
                const coerced = coerceValueBySchema(item, schema.items);
                if (coerced.modified) {
                    itemsModified = true;
                }
                return coerced.value;
            });
            if (itemsModified) {
                return { value: newItems, modified: true };
            }
        }

        return { value: arrayValue, modified };
    }

    // object 容错：JSON 字符串 → 对象（仅当解析结果是普通对象时替换，
    // 覆盖模型/中转代理把嵌套对象双重编码成字符串的场景），
    // 再按 properties 递归处理已声明属性（不剥离嵌套层的未知属性）
    if (schemaType === 'object') {
        let objectValue = value;
        let parsedFromString = false;

        if (typeof objectValue === 'string') {
            const parsed = tryParseJson(objectValue);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                objectValue = parsed;
                parsedFromString = true;
            } else {
                return { value, modified: false };
            }
        }

        if (schema.properties
            && objectValue !== null && typeof objectValue === 'object' && !Array.isArray(objectValue)) {
            const coerced = coerceObjectBySchema(objectValue as Record<string, any>, schema.properties);
            return { value: coerced.value, modified: parsedFromString || coerced.modified };
        }

        return { value: objectValue, modified: parsedFromString };
    }

    return { value, modified: false };
}

/**
 * 应用工具声明的参数改名别名（alias → canonical）。
 *
 * 仅当规范参数缺失且别名出现时改名；两者都提供时丢弃别名（以规范参数为准）。
 * 别名与 schema 中真实参数同名时视为声明错误，跳过不处理。
 */
function applyParamAliases(
    args: Record<string, any>,
    schema: ToolParameterSchema,
    aliases: Record<string, string> | undefined,
    warnings: string[]
): Record<string, any> {
    if (!aliases) {
        return args;
    }

    let result: Record<string, any> | null = null;

    for (const [alias, canonical] of Object.entries(aliases)) {
        if (alias in schema.properties || !(canonical in schema.properties)) {
            continue;
        }
        if (!(alias in args) || args[alias] === undefined) {
            continue;
        }

        if (result === null) {
            result = { ...args };
        }

        if (canonical in args && args[canonical] !== undefined) {
            delete result[alias];
            warnings.push(
                `Ignored parameter \`${alias}\` because \`${canonical}\` was also provided.`
            );
            continue;
        }

        result[canonical] = result[alias];
        delete result[alias];
        warnings.push(
            `Parameter \`${alias}\` was automatically interpreted as \`${canonical}\`. ` +
            `Please use \`${canonical}\` directly next time.`
        );
    }

    return result ?? args;
}

/**
 * 单数别名提升。
 *
 * 模型高频错误：schema 要求 paths（数组）却输出了 path（字符串）。
 * 与其在每个工具描述里用大写 IMPORTANT 呼吁，不如在这里通用纠正：
 * - 仅当 schema 中的数组参数缺失、且 args 中存在其单数形式时触发
 * - 支持规则复数 `xxxs` → `xxx` 和 `xxies` → `xxy`（如 queries → query）
 * - 单数名本身是该工具的合法参数时绝不处理（避免语义冲突，
 *   如 search_in_files 的 path 和 pattern 都是真实参数）
 * - 值已是数组时仅改名，否则包装成单元素数组
 */
function promoteSingularArrayAliases(
    args: Record<string, any>,
    schema: ToolParameterSchema,
    warnings: string[]
): Record<string, any> {
    let result: Record<string, any> | null = null;

    for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (propSchema?.type !== 'array') {
            continue;
        }
        if (key in args && args[key] !== undefined) {
            continue;
        }

        for (const singular of singularCandidatesOf(key)) {
            if (singular.length === 0 || singular in schema.properties) {
                continue;
            }
            if (!(singular in args) || args[singular] === undefined) {
                continue;
            }

            const rawValue = args[singular];
            const promoted = Array.isArray(rawValue) ? rawValue : [rawValue];

            if (result === null) {
                result = { ...args };
            }
            delete result[singular];
            result[key] = promoted;
            warnings.push(
                `Parameter \`${singular}\` was automatically interpreted as \`${key}\` (array). ` +
                `Please use \`${key}\` with an array value directly next time.`
            );
            break;
        }
    }

    return result ?? args;
}

/**
 * 生成复数参数名的单数候选，按优先级排列。
 * `ies` 结尾优先按 y 变形（queries → query），否则按去掉尾部 s 处理（paths → path）。
 */
function singularCandidatesOf(key: string): string[] {
    const candidates: string[] = [];
    if (key.length > 3 && key.endsWith('ies')) {
        candidates.push(key.slice(0, -3) + 'y');
    }
    if (key.length > 1 && key.endsWith('s')) {
        candidates.push(key.slice(0, -1));
    }
    return candidates;
}

/**
 * 剥离 schema 中未声明的顶层参数。
 *
 * 未知参数不再导致整个调用失败，而是移除后附加警告，
 * 让工具继续执行、让模型从警告中学习正确的参数名。
 *
 * 工具声明的兼容透传参数（compatParams）不剥离：它们不在 schema 中向模型宣传，
 * 但语义由 handler 专门处理（如 read_file 的 line/maxLines/limit）；
 * 仍会附加一条温和提示，引导模型使用 schema 中声明的参数。
 */
function stripUnknownParams(
    toolName: string,
    args: Record<string, any>,
    schema: ToolParameterSchema,
    compatParams: string[] | undefined,
    warnings: string[]
): Record<string, any> {
    const compatSet = compatParams && compatParams.length > 0 ? new Set(compatParams) : null;
    let result: Record<string, any> | null = null;

    for (const key of Object.keys(args)) {
        if (key in schema.properties) {
            continue;
        }
        if (compatSet?.has(key)) {
            warnings.push(
                `Parameter \`${key}\` was accepted for backward compatibility. ` +
                `Prefer the parameters declared in the \`${toolName}\` tool schema.`
            );
            continue;
        }
        if (result === null) {
            result = { ...args };
        }
        delete result[key];
        warnings.push(
            `Ignored unexpected parameter \`${key}\` (not defined in the \`${toolName}\` tool schema).`
        );
    }

    return result ?? args;
}

function tryParseJson(str: string): unknown {
    try {
        return JSON.parse(str);
    } catch {
        return undefined;
    }
}
