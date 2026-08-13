/**
 * 工具参数 JSON Schema 的共享类型子集。
 *
 * 工具声明（types.ts 的 ToolDeclaration.parameters）、参数规范化
 * （coerceToolArgs）与参数校验（validateToolArgs）三处共用同一份 schema 类型，
 * 避免声明侧用 `Record<string, any>`、校验侧用 `[key: string]: any` 导致的
 * 「声明-实现无编译期契约」问题（审查发现 02#05）。
 *
 * 说明：JSON Schema 允许任意注解关键字（如 description/enum/default/example 等），
 * 因此保留 `[key: string]: unknown` 索引签名；但把值从 `any` 收紧为 `unknown`，
 * 让误读注解字段（如把 `minimum` 当字符串用）必须显式收窄后才能通过编译。
 */

export interface PropertySchema {
    /** 属性的 JSON Schema 类型（string/number/integer/boolean/array/object） */
    type: string;
    /** 人类可读的参数说明 */
    description?: string;
    /** 可选值列表（string/number 等标量） */
    enum?: unknown[];
    /** array 类型的元素 schema */
    items?: PropertySchema;
    /** object 类型的子属性 schema */
    properties?: Record<string, PropertySchema>;
    /** object 类型的必填子属性名 */
    required?: string[];
    /** number/integer 的最小值 */
    minimum?: number;
    /** number/integer 的最大值 */
    maximum?: number;
    /** 默认值 */
    default?: unknown;
    /** 示例值（仅用于提示词生成） */
    example?: unknown;
    /** 其它 JSON Schema 注解关键字（additionalProperties 等） */
    [key: string]: unknown;
}

/**
 * 工具参数根 schema（Gemini Function Calling 格式的 parameters 字段）。
 */
export interface ToolParameterSchema {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
}
