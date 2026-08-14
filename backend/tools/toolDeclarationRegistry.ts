/**
 * 工具声明工厂注册表（组合根反向注册）
 *
 * 依赖方向：modules 层不允许依赖 tools 层工具工厂的运行时实现（模块化重构遗留第 5 项）。
 * ToolDeclarationResolver 过去直接 import createReadFileTool / createGenerateImageTool 等工厂，
 * 现在改为：工厂由组合根（backend/bootstrap）注册到本注册表，resolver 按工具名反向获取。
 *
 * 已注册工具（组合根 backend/bootstrap/index.ts 的 initTools）：
 * - 动态能力工具：read_file、generate_image、remove_background、crop_image、resize_image、rotate_image；
 * - 模型工具声明国际化（半动态工具 + 声明工厂）：write_file、list_files、delete_file、create_directory、
 *   insert_code、delete_code、apply_diff、search_in_files、find_files、get_symbols、goto_definition、
 *   find_references、execute_command、history_search、read_skill、subagents、agent_send_message。
 *   后一批工厂忽略 args，描述按进程级实际语言生成（zh-CN → 中文，en/ja → 英文），
 *   动态信息（工作区列表、shell 列表、技能列表、代理列表、MAX_HOP_DEPTH、截断行数等）
 *   在工厂内保持运行时插值；语言切换后 resolver 按需重建声明。
 *
 * 语义约束：
 * - 工厂必须是「懒创建」：每次调用都重新构建动态工具（read_file 多模态描述、图片工具参数
 *   随解析选项/设置变化），不要改成单例缓存；
 * - getToolDeclarationFactory 取不到时返回 undefined，调用方保持既有回退行为（跳过动态替换）。
 */

import type { Tool } from './types';

/**
 * 动态工具声明的构造参数（按工具名取用相关字段）：
 * - read_file：multimodalEnabled / channelType / toolMode；
 * - generate_image：maxBatchTasks / maxImagesPerTask / paramsConfig；
 * - remove_background / crop_image / resize_image / rotate_image：maxBatchTasks。
 */
export interface ToolDeclarationFactoryArgs {
    /** read_file：是否启用多模态（决定描述中是否包含图片/PDF 支持说明） */
    multimodalEnabled?: boolean;
    /** read_file：渠道类型（openai 的 function_call 模式不支持多模态） */
    channelType?: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
    /** read_file：工具模式 */
    toolMode?: 'function_call' | 'xml' | 'json';
    /** 图片工具：单次调用允许的最大任务数 */
    maxBatchTasks?: number;
    /** crop_image：是否使用归一化坐标（0-1000）；false 表示像素坐标，与运行时 handler 同源 */
    useNormalizedCoordinates?: boolean;
    /** generate_image：单个任务的最大图片数 */
    maxImagesPerTask?: number;
    /** generate_image：宽高比/图片尺寸参数配置（与 createGenerateImageTool 的 paramsConfig 同构） */
    paramsConfig?: {
        /** 是否启用宽高比参数 */
        enableAspectRatio: boolean;
        /** 强制宽高比（设定后 AI 不能更改） */
        forcedAspectRatio?: string;
        /** 是否启用图片尺寸参数 */
        enableImageSize: boolean;
        /** 强制图片尺寸（设定后 AI 不能更改） */
        forcedImageSize?: string;
    };
}

/** 动态工具声明工厂：输入解析上下文，返回带声明的完整工具（懒创建，每次调用重新构建） */
export type ToolDeclarationFactory = (args: ToolDeclarationFactoryArgs) => Tool;

const toolDeclarationFactories = new Map<string, ToolDeclarationFactory>();

/**
 * 注册工具声明工厂（组合根调用）。同名重复注册为覆盖式，天然幂等（重试初始化安全）。
 */
export function registerToolDeclarationFactory(name: string, factory: ToolDeclarationFactory): void {
    toolDeclarationFactories.set(name, factory);
}

/**
 * 按工具名获取工厂；未注册时返回 undefined（调用方保持既有行为：跳过动态声明替换）。
 */
export function getToolDeclarationFactory(name: string): ToolDeclarationFactory | undefined {
    return toolDeclarationFactories.get(name);
}

/**
 * 清空全部注册（测试隔离用；生产代码无需调用）。
 */
export function clearToolDeclarationFactories(): void {
    toolDeclarationFactories.clear();
}

// —— 动态声明自检（发现 15）——

/** 对象自身是否含 getter/setter 属性（含不可枚举属性） */
function hasAccessorProperties(obj: object): boolean {
    for (const key of Object.getOwnPropertyNames(obj)) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (descriptor?.get || descriptor?.set) {
            return true;
        }
    }
    return false;
}

/**
 * 判定工具声明是否「动态」：tool.declaration 本身是 getter，
 * 或声明对象上有 getter 字段（如 history_search 的 description getter）。
 * 动态声明的工具必须有对应工厂，否则 resolver 会静默回退静态声明。
 */
function isDynamicDeclarationTool(tool: Tool): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(tool, 'declaration');
    if (descriptor?.get) {
        return true;
    }
    const declaration = tool.declaration;
    if (declaration && typeof declaration === 'object') {
        return hasAccessorProperties(declaration);
    }
    return false;
}

/**
 * 只读自检：收集「声明含 getter 但未注册声明工厂」的工具名。
 * 供组合根（assertToolDeclarationFactories）与测试调用，
 * 防止注释清单与 registerToolDeclarationFactory 实际注册漂移。
 */
export function collectMissingToolDeclarationFactories(tools: Iterable<Tool>): string[] {
    const missing: string[] = [];
    for (const tool of tools) {
        if (!isDynamicDeclarationTool(tool)) {
            continue;
        }
        const name = tool.declaration?.name;
        if (name && !toolDeclarationFactories.has(name)) {
            missing.push(name);
        }
    }
    return missing;
}

/**
 * 断言所有动态声明工具都已注册声明工厂；缺失时抛错。
 * 组合根在 registerAllTools + 工厂注册完成后调用（测试可传自定义工具集）。
 */
export function assertToolDeclarationFactories(tools: Iterable<Tool>): void {
    const missing = collectMissingToolDeclarationFactories(tools);
    if (missing.length > 0) {
        throw new Error(
            `Tool declaration factories are missing for dynamic tools: ${missing.join(', ')}. ` +
            'Register them in the composition root (backend/bootstrap initTools) to keep the dynamic declaration list in sync.'
        );
    }
}
