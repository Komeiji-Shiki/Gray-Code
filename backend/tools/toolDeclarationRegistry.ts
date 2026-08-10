/**
 * 工具声明工厂注册表（组合根反向注册）
 *
 * 依赖方向：modules 层不允许依赖 tools 层工具工厂的运行时实现（模块化重构遗留第 5 项）。
 * ToolDeclarationResolver 过去直接 import createReadFileTool / createGenerateImageTool 等工厂，
 * 现在改为：工厂由组合根（backend/bootstrap）注册到本注册表，resolver 按工具名反向获取。
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
    channelType?: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom';
    /** read_file：工具模式 */
    toolMode?: 'function_call' | 'xml' | 'json';
    /** 图片工具：单次调用允许的最大任务数 */
    maxBatchTasks?: number;
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
