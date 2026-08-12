/**
 * 图像生成工具 - 使用第三方模型生成图片
 *
 * 支持调用 Gemini Image 等模型生成图片
 * 支持单张生成和批量生成两种模式
 * 返回图片和文字解释作为工具响应
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolResult, MultimodalData, ToolContext } from '../types';
import { resolveFileToolPathWithInfo, getAllWorkspaces, calculateAspectRatio } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { saveImage, parseImageDimensionsFromBase64, createFetchSignal } from './imageUtils';
import { createProxyFetch } from '../../modules/channel/proxyFetch';
import { TaskManager, type TaskEvent } from '../taskManager';
import { withLinkedAbort } from '../abortLink';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { buildGenerateImageDescriptions } from '../localization/dynamicDescriptions';

/** 图像生成任务类型常量 */
const TASK_TYPE_IMAGE_GEN = 'image_generation';

/**
 * 默认生成模型（与 settings 默认值 toolsTypes.ts 保持一致）。
 * 此前调用侧默认 'gemini-3-pro-image-preview'、返回侧默认 'gemini-2.5-flash-preview-05-20'，
 * 两个默认值不一致会让返回的 model 字段与真实调用模型不符，统一为同一常量。
 */
const DEFAULT_IMAGE_MODEL = 'gemini-3-pro-image-preview';

/**
 * Gemini API 请求超时（毫秒）：网络挂起时不会无限期等待。
 * 修改原因：generate_image 的 fetch 只有取消信号、无超时保护。
 */
const GEMINI_API_REQUEST_TIMEOUT_MS = 120_000;

/**
 * 图像生成输出事件类型（保持向后兼容）
 */
export interface ImageGenOutputEvent {
    toolId: string;
    type: 'start' | 'progress' | 'complete' | 'cancelled' | 'error';
    data?: {
        message?: string;
        progress?: number;
        totalTasks?: number;
        completedTasks?: number;
    };
    error?: string;
}

/**
 * 订阅图像生成输出（使用 TaskManager）
 * @param listener 监听器函数
 * @returns 取消订阅函数
 */
export function onImageGenOutput(listener: (event: ImageGenOutputEvent) => void): () => void {
    // 将 TaskEvent 转换为 ImageGenOutputEvent
    return TaskManager.onTaskEventByType(TASK_TYPE_IMAGE_GEN, (taskEvent: TaskEvent) => {
        const imageGenEvent: ImageGenOutputEvent = {
            toolId: taskEvent.taskId,
            type: taskEvent.type as ImageGenOutputEvent['type'],
            data: taskEvent.data as ImageGenOutputEvent['data'],
            error: taskEvent.error
        };
        listener(imageGenEvent);
    });
}

/**
 * 生成唯一工具调用 ID（使用 TaskManager）
 */
export function generateToolId(): string {
    return TaskManager.generateTaskId('tool');
}

/**
 * 取消图像生成任务（使用 TaskManager）
 * @param toolId 工具调用 ID
 * @returns 取消结果
 */
export function cancelImageGeneration(toolId: string): {
    success: boolean;
    error?: string;
} {
    return TaskManager.cancelTask(toolId);
}

/**
 * 获取所有活跃的图像生成任务（使用 TaskManager）
 */
export function getActiveImageTasks(): Array<{
    toolId: string;
    startTime: number;
}> {
    return TaskManager.getTasksByType(TASK_TYPE_IMAGE_GEN).map(task => ({
        toolId: task.id,
        startTime: task.startTime
    }));
}

/**
 * 支持的宽高比
 */
const SUPPORTED_ASPECT_RATIOS = [
    '1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'
] as const;

type AspectRatio = typeof SUPPORTED_ASPECT_RATIOS[number];

/**
 * 支持的图片尺寸
 */
const SUPPORTED_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
type ImageSize = typeof SUPPORTED_IMAGE_SIZES[number];

/**
 * 单个图像生成任务
 */
interface ImageTask {
    /** 图片生成的自然语言提示词 */
    prompt: string;
    /** 参考图片路径数组 */
    reference_images?: string[];
    /** 图片宽高比 */
    aspect_ratio?: AspectRatio;
    /** 图片分辨率 */
    image_size?: ImageSize;
    /** 输出文件路径 */
    output_path: string;
}

/**
 * 图像生成工具配置（从 context.config 获取）
 */
interface GenerateImageConfig {
    /** API URL */
    url?: string;
    /** API Key */
    apiKey?: string;
    /** 模型名称 */
    model?: string;
    /** 是否启用宽高比参数 */
    enableAspectRatio?: boolean;
    /** 默认宽高比（启用时生效） */
    defaultAspectRatio?: string;
    /** 是否启用图片尺寸参数 */
    enableImageSize?: boolean;
    /** 默认图片尺寸（启用时生效） */
    defaultImageSize?: string;
    /** 单次调用允许的最大任务数（批量模式） */
    maxBatchTasks?: number;
    /** 单个任务的最大图片数 */
    maxImagesPerTask?: number;
    /** 代理 URL */
    proxyUrl?: string;
    /** 取消信号 */
    abortSignal?: AbortSignal;
    /** 是否将图片返回给 AI */
    returnImageToAI?: boolean;
}

/**
 * 工具参数配置（传递给 createGenerateImageTool）
 */
interface ToolParamsConfig {
    /** 是否启用宽高比参数 */
    enableAspectRatio: boolean;
    /** 强制宽高比（如果设置，AI 不能更改） */
    forcedAspectRatio?: string;
    /** 是否启用图片尺寸参数 */
    enableImageSize: boolean;
    /** 强制图片尺寸（如果设置，AI 不能更改） */
    forcedImageSize?: string;
}

/**
 * 单个任务的生成结果
 */
interface TaskResult {
    /** 任务索引 */
    index: number;
    /** 是否成功 */
    success: boolean;
    /** 错误信息 */
    error?: string;
    /** 保存的文件路径 */
    paths?: string[];
    /** 生成的图片数量 */
    count?: number;
    /** 图片尺寸信息 */
    dimensions?: Array<{ width: number; height: number; aspectRatio: string }>;
    /** 模型描述文本 */
    description?: string;
    /** 多模态数据 */
    multimodal?: MultimodalData[];
    /** 是否被用户取消 */
    cancelled?: boolean;
}

/**
 * Gemini Image API 响应
 */
interface GeminiImageResponse {
    candidates?: Array<{
        content?: {
            parts?: Array<{
                text?: string;
                inlineData?: {
                    mimeType: string;
                    data: string;
                };
            }>;
        };
    }>;
    error?: {
        code: number;
        message: string;
    };
}

/**
 * 读取参考图片
 */
async function readReferenceImage(imgPath: string, context?: ToolContext): Promise<{ data: string; mimeType: string } | null> {
    const { uri, isOutsideWorkspace } = resolveFileToolPathWithInfo(imgPath);
    if (!uri) {
        return null;
    }

    // 工作区外读取：按 read 策略审批（deny 拒绝 / ask 需确认 / allow 放行）
    if (isOutsideWorkspace) {
        const readAccessError = ensureOutsideWorkspaceAccessApproved('read_file', { path: imgPath }, context, 'generate_image');
        if (readAccessError) {
            return null;
        }
    }

    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const ext = path.extname(imgPath).toLowerCase();
        let mimeType = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') {
            mimeType = 'image/jpeg';
        } else if (ext === '.webp') {
            mimeType = 'image/webp';
        }

        return {
            data: Buffer.from(content).toString('base64'),
            mimeType
        };
    } catch (error) {
        return null;
    }
}

/**
 * 调用 Gemini Image API 生成图片
 */
async function callGeminiImageApi(
    prompt: string,
    referenceImages: Array<{ data: string; mimeType: string }>,
    aspectRatio: string | undefined,
    imageSize: string | undefined,
    config: GenerateImageConfig,
    abortSignal?: AbortSignal
): Promise<GeminiImageResponse> {
    const apiKey = config.apiKey;
    if (!apiKey) {
        throw new Error('API Key not configured. Please configure generate_image tool in settings.');
    }

    const model = config.model || DEFAULT_IMAGE_MODEL;
    const baseUrl = config.url || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;

    // 构建 parts
    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];

    // 添加文本提示
    parts.push({ text: prompt });

    // 添加参考图片
    if (referenceImages && referenceImages.length > 0) {
        for (const img of referenceImages) {
            parts.push({
                inline_data: {
                    mime_type: img.mimeType,
                    data: img.data
                }
            });
        }
    }

    // 构建请求体
    const requestBody: Record<string, unknown> = {
        contents: [{
            role: 'user',
            parts
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
        }
    };

    // 配置图片选项
    // 只有当参数有值时才传入 imageConfig
    if (aspectRatio || imageSize) {
        const imageConfig: Record<string, string> = {};
        if (aspectRatio) {
            imageConfig.aspectRatio = aspectRatio;
        }
        if (imageSize) {
            imageConfig.imageSize = imageSize;
        }
        if (Object.keys(imageConfig).length > 0) {
            (requestBody.generationConfig as Record<string, unknown>).imageConfig = imageConfig;
        }
    }

    // 检查是否已取消
    if (abortSignal?.aborted) {
        throw new Error('Request cancelled');
    }

    // 创建 fetch 函数（支持代理）
    const fetchFn = createProxyFetch(config.proxyUrl);

    // 发送请求（传递取消信号 + 超时保护：网络挂起时不会无限期等待）
    const { signal: fetchSignal, cleanup: cleanupFetchSignal } = createFetchSignal(abortSignal, GEMINI_API_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchFn(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: fetchSignal
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API request failed: ${response.status} ${errorText}`);
        }

        return await response.json() as GeminiImageResponse;
    } finally {
        cleanupFetchSignal();
    }
}

/**
 * 从响应中提取图片和文本
 */
function extractFromResponse(response: GeminiImageResponse): {
    images: Array<{ data: string; mimeType: string; dimensions?: { width: number; height: number } }>;
    texts: string[];
} {
    const images: Array<{ data: string; mimeType: string; dimensions?: { width: number; height: number } }> = [];
    const texts: string[] = [];

    if (response.candidates) {
        for (const candidate of response.candidates) {
            if (candidate.content?.parts) {
                for (const part of candidate.content.parts) {
                    if (part.inlineData) {
                        const dimensions = parseImageDimensionsFromBase64(part.inlineData.data, part.inlineData.mimeType);
                        images.push({
                            data: part.inlineData.data,
                            mimeType: part.inlineData.mimeType,
                            dimensions: dimensions || undefined
                        });
                    }
                    if (part.text) {
                        texts.push(part.text);
                    }
                }
            }
        }
    }

    return { images, texts };
}

/**
 * 获取文件扩展名
 */
/**
 * 根据 Buffer 嗅探图片真实后缀名，如果嗅探失败则回退到 mimeType
 */
function detectExtension(buffer: Buffer, mimeType?: string): string {
    // 嗅探 Magic Number
    if (buffer.length > 4) {
        // JPEG: FF D8
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) return '.jpg';
        // PNG: 89 50 4E 47
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return '.png';
        // GIF: 47 49 46 (GIF87a 或 GIF89a)
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif';
        // WebP: RIFF .... WEBP
        if (buffer.length >= 12 && 
            buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && 
            buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
            return '.webp';
        }
    }

    // 回退到基于 MIME 类型的映射
    const mimeToExt: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'image/x-icon': '.ico',
        'image/heic': '.heic',
        'image/heif': '.heif'
    };
    
    return (mimeType ? mimeToExt[mimeType] : null) || '.png';
}

/**
 * 执行单个图像生成任务
 */
async function executeImageTask(
    task: ImageTask,
    index: number,
    config: GenerateImageConfig,
    maxImagesPerTask: number,
    abortSignal?: AbortSignal,
    context?: ToolContext
): Promise<TaskResult> {
    const { prompt, reference_images, aspect_ratio, image_size, output_path } = task;

    // 验证参数
    if (!prompt) {
        return { index, success: false, error: 'Task ' + (index + 1) + ': prompt is required' };
    }

    if (!output_path) {
        return { index, success: false, error: 'Task ' + (index + 1) + ': output_path is required' };
    }

    if (aspect_ratio && !SUPPORTED_ASPECT_RATIOS.includes(aspect_ratio as AspectRatio)) {
        return {
            index,
            success: false,
            error: `Task ${index + 1}: Invalid aspect_ratio. Supported: ${SUPPORTED_ASPECT_RATIOS.join(', ')}`
        };
    }

    if (image_size && !SUPPORTED_IMAGE_SIZES.includes(image_size as ImageSize)) {
        return {
            index,
            success: false,
            error: `Task ${index + 1}: Invalid image_size. Supported: ${SUPPORTED_IMAGE_SIZES.join(', ')}`
        };
    }

    if (reference_images && reference_images.length > 14) {
        return {
            index,
            success: false,
            error: `Task ${index + 1}: Maximum 14 reference images allowed`
        };
    }

    try {
        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled image generation`, cancelled: true };
        }
        
        // 读取参考图片
        const referenceImages: Array<{ data: string; mimeType: string }> = [];
        if (reference_images && reference_images.length > 0) {
            for (const imgPath of reference_images) {
                // 检查是否已取消
                if (abortSignal?.aborted) {
                    return { index, success: false, error: `Task ${index + 1}: User cancelled image generation`, cancelled: true };
                }
                const img = await readReferenceImage(imgPath, context);
                if (!img) {
                    return {
                        index,
                        success: false,
                        error: `Task ${index + 1}: Cannot read reference image: ${imgPath}`
                    };
                }
                referenceImages.push(img);
            }
        }

        // 决定最终的参数值
        // 规则：
        // - 如果启用参数且有强制值（defaultXxx 非空），使用强制值
        // - 如果启用参数且无强制值，使用 AI 传入的值
        // - 如果禁用参数，不传
        let finalAspectRatio: string | undefined;
        if (config.enableAspectRatio) {
            // 如果有设定的默认值，强制使用（AI 不能覆盖）
            // 如果没有默认值，使用 AI 传入的值
            finalAspectRatio = config.defaultAspectRatio || aspect_ratio;
        }
        
        let finalImageSize: string | undefined;
        if (config.enableImageSize) {
            // 如果有设定的默认值，强制使用
            // 如果没有默认值，使用 AI 传入的值
            finalImageSize = config.defaultImageSize || image_size;
        }

        // 调用 API 生成图片（传递取消信号）
        const response = await callGeminiImageApi(
            prompt,
            referenceImages,
            finalAspectRatio,
            finalImageSize,
            config,
            abortSignal
        );

        if (response.error) {
            return {
                index,
                success: false,
                error: `Task ${index + 1}: API error - ${response.error.message}`
            };
        }

        // 提取图片和文本
        const { images, texts } = extractFromResponse(response);
        
        if (images.length === 0) {
            return {
                index,
                success: false,
                error: `Task ${index + 1}: No images generated. Content may have been filtered or an error occurred.`
            };
        }

        // 保存图片（限制数量）
        const savedPaths: string[] = [];
        const multimodal: MultimodalData[] = [];
        const allDimensions: Array<{ width: number; height: number; aspectRatio: string }> = [];
        const limitedImages = images.slice(0, maxImagesPerTask);

        for (let i = 0; i < limitedImages.length; i++) {
            const img = limitedImages[i];
            const buffer = Buffer.from(img.data, 'base64');
            const ext = detectExtension(buffer, img.mimeType);
            
            // 确定输出路径
            let finalOutputPath: string;
            if (i === 0) {
                const currentExt = path.extname(output_path).toLowerCase();
                const targetExt = ext.toLowerCase();
                
                // 定义同义后缀组，防止不必要的更正
                const areSynonyms = (ext1: string, ext2: string) => {
                    const jpegExts = ['.jpg', '.jpeg', '.jfif'];
                    return jpegExts.includes(ext1) && jpegExts.includes(ext2);
                };

                if (currentExt !== targetExt && !areSynonyms(currentExt, targetExt)) {
                    // 仅在后缀名完全不匹配且不是同义词时更正
                    const dirName = path.dirname(output_path);
                    const currentExtName = path.extname(output_path);
                    const baseNameWithoutExt = path.basename(output_path, currentExtName);
                    
                    const newFileName = baseNameWithoutExt + targetExt;
                    finalOutputPath = dirName === '.' ? newFileName : path.join(dirName, newFileName);
                } else {
                    finalOutputPath = output_path;
                }
            } else {
                const baseName = output_path.replace(/\.[^.]+$/, '');
                finalOutputPath = `${baseName}_${i}${ext}`;
            }

            // 保存图片
            await saveImage(buffer, finalOutputPath, context, 'generate_image');
            savedPaths.push(finalOutputPath);

            // 收集尺寸信息
            if (img.dimensions) {
                allDimensions.push({
                    width: img.dimensions.width,
                    height: img.dimensions.height,
                    aspectRatio: calculateAspectRatio(img.dimensions.width, img.dimensions.height)
                });
            }

            // 添加到多模态返回
            multimodal.push({
                mimeType: img.mimeType,
                data: img.data,
                name: path.basename(finalOutputPath)
            });
        }

        // 组合文本说明
        const textDescription = texts.length > 0
            ? texts.join('\n')
            : `Task ${index + 1}: Successfully generated ${images.length} images`;

        return {
            index,
            success: true,
            paths: savedPaths,
            count: images.length,
            dimensions: allDimensions.length > 0 ? allDimensions : undefined,
            description: textDescription,
            multimodal
        };
    } catch (error) {
        // 检查是否是取消导致的错误
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : '';
        
        // 修改原因：超时保护（createFetchSignal 的 timeout abort）会让 fetch 以 AbortError
        // （"The operation was aborted"）拒绝，仅凭 errorName/message 会把请求超时误判为用户取消。
        // 修改方式：以用户 abortSignal 是否真的 aborted 为准（超时只中止内部 fetchSignal，
        // 不会中止调用方的 abortSignal）；AbortError/消息检查仅作无信号时的后备。
        const isCancelled = abortSignal?.aborted === true ||
            (errorName === 'AbortError' && !abortSignal) ||
            errorMessage.includes('cancelled') ||
            errorMessage.includes('canceled') ||
            errorMessage.includes('Request cancelled');
        
        return {
            index,
            success: false,
            error: isCancelled
                ? `Task ${index + 1}: User cancelled image generation`
                : `Task ${index + 1}: ${errorMessage}`,
            cancelled: isCancelled
        };
    }
}

/**
 * 创建图像生成工具（支持动态配置）
 *
 * @param maxBatchTasks 单次调用允许的最大任务数
 * @param maxImagesPerTask 单个任务的最大图片数
 * @param paramsConfig 参数配置
 */
export function createGenerateImageTool(
    maxBatchTasks: number = 5,
    maxImagesPerTask: number = 1,
    paramsConfig?: ToolParamsConfig
): Tool {
    // 默认配置
    const config: ToolParamsConfig = paramsConfig || {
        enableAspectRatio: false,
        enableImageSize: false
    };
    
    // 获取工作区信息
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    // 语言感知说明：根据当前实际界面语言（zh-CN/en/ja）生成模型可见说明。
    // 顶层说明（Limits、宽高比/尺寸参数配置、单张/批量模式、多根尾巴）与
    // 参数说明统一由 localization/dynamicDescriptions 的语言感知生成器负责。
    const lang = resolveLocalizationLanguage(getActualLanguage());
    const descriptions = buildGenerateImageDescriptions({
        lang,
        maxBatchTasks,
        maxImagesPerTask,
        config,
        isMultiRoot,
        workspaceNames: workspaces.map(w => w.name)
    });

    const description = descriptions.description;

    // 构建批量任务的属性定义
    const batchItemProperties: Record<string, unknown> = {
        prompt: {
            type: 'string',
            description: descriptions.batchPrompt
        },
        reference_images: {
            type: 'array',
            description: descriptions.batchReferenceImages,
            items: { type: 'string' }
        },
        output_path: {
            type: 'string',
            description: descriptions.batchOutputPath
        }
    };

    // 仅当启用宽高比且没有强制值时，才包含 aspect_ratio 参数
    if (config.enableAspectRatio && !config.forcedAspectRatio) {
        batchItemProperties.aspect_ratio = {
            type: 'string',
            description: descriptions.batchAspectRatio,
            enum: [...SUPPORTED_ASPECT_RATIOS]
        };
    }
    
    // 仅当启用图片尺寸且没有强制值时，才包含 image_size 参数
    if (config.enableImageSize && !config.forcedImageSize) {
        batchItemProperties.image_size = {
            type: 'string',
            description: descriptions.batchImageSize,
            enum: [...SUPPORTED_IMAGE_SIZES]
        };
    }

    // 构建单张模式的属性定义
    const singleModeProperties: Record<string, unknown> = {
        prompt: {
            type: 'string',
            description: descriptions.singlePrompt
        },
        reference_images: {
            type: 'array',
            description: descriptions.singleReferenceImages,
            items: {
                type: 'string',
                description: descriptions.singleReferenceImageItem
            }
        },
        output_path: {
            type: 'string',
            description: descriptions.singleOutputPath
        }
    };

    // 仅当启用宽高比且没有强制值时，才包含 aspect_ratio 参数
    if (config.enableAspectRatio && !config.forcedAspectRatio) {
        singleModeProperties.aspect_ratio = {
            type: 'string',
            description: descriptions.singleAspectRatio,
            enum: [...SUPPORTED_ASPECT_RATIOS]
        };
    }
    
    // 仅当启用图片尺寸且没有强制值时，才包含 image_size 参数
    if (config.enableImageSize && !config.forcedImageSize) {
        singleModeProperties.image_size = {
            type: 'string',
            description: descriptions.singleImageSize,
            enum: [...SUPPORTED_IMAGE_SIZES]
        };
    }

    return {
        declaration: {
            name: 'generate_image',
            description,
            category: 'media',
            parameters: {
                type: 'object',
                properties: {
                    // 批量生成模式参数
                    images: {
                        type: 'array',
                        description: descriptions.images,
                        items: {
                            type: 'object',
                            properties: batchItemProperties,
                            required: ['prompt', 'output_path']
                        }
                    },
                    // 单张生成模式参数（动态构建）
                    ...singleModeProperties
                }
            }
        },
        handler: withLinkedAbort(async (args, context: ToolContext | undefined, abortController): Promise<ToolResult> => {
            // 从 context 获取配置和工具 ID
            const config = (context?.config || {}) as GenerateImageConfig;
            const toolId = context?.toolId || generateToolId();

            const abortSignal = abortController.signal;

            // 使用 TaskManager 注册任务
            TaskManager.registerTask(toolId, TASK_TYPE_IMAGE_GEN, abortController, {
                prompt: args.prompt,
                outputPath: args.output_path
            });
            
            // 验证配置
            if (!config.apiKey) {
                TaskManager.unregisterTask(toolId, 'error', { error: 'API Key not configured' });
                return {
                    success: false,
                    error: 'API Key not configured. Please configure generate_image tool in settings (Tools Settings -> Image Generation).'
                };
            }

            // 检查使用哪种模式
            const imagesArray = args.images as ImageTask[] | undefined;
            const singlePrompt = args.prompt as string | undefined;
            const singleOutputPath = args.output_path as string | undefined;

            let tasks: ImageTask[] = [];

            if (imagesArray && Array.isArray(imagesArray) && imagesArray.length > 0) {
                // 批量生成模式
                tasks = imagesArray;
            } else if (singlePrompt && singleOutputPath) {
                // 单张生成模式 - 转换为单任务数组
                tasks = [{
                    prompt: singlePrompt,
                    reference_images: args.reference_images as string[] | undefined,
                    aspect_ratio: args.aspect_ratio as AspectRatio | undefined,
                    image_size: args.image_size as ImageSize | undefined,
                    output_path: singleOutputPath
                }];
            } else {
                // 与下方 tasks.length 校验分支保持一致：先注销任务再返回，避免任务管理器残留永久 running 任务
                TaskManager.unregisterTask(toolId, 'error', { error: 'Please use one of the following:\n1. Single mode: Provide prompt and output_path\n2. Batch mode: Provide images array' });
                return {
                    success: false,
                    error: 'Please use one of the following:\n1. Single mode: Provide prompt and output_path\n2. Batch mode: Provide images array'
                };
            }

            // 获取配置限制
            const configMaxBatchTasks = config.maxBatchTasks || 5;
            const configMaxImagesPerTask = config.maxImagesPerTask || 1;

            // 验证任务数量
            if (tasks.length === 0) {
                TaskManager.unregisterTask(toolId, 'error', { error: 'No valid generation tasks' });
                return { success: false, error: 'No valid generation tasks' };
            }

            if (tasks.length > configMaxBatchTasks) {
                TaskManager.unregisterTask(toolId, 'error', { error: `Maximum ${configMaxBatchTasks} generation tasks per call` });
                return { success: false, error: `Maximum ${configMaxBatchTasks} generation tasks per call (current: ${tasks.length})` };
            }

            try {
                // 并发执行所有任务（传递取消信号）
                // 修改原因：同一次调用的多个任务并发写同一 output_path 会互相覆盖（后写者胜出）。
                // 修改方式：进入并发前检测重复输出路径并拒绝。
                const seenOutputPaths = new Set<string>();
                const duplicateOutputTask = tasks.find(task => {
                    if (!task.output_path) return false;
                    if (seenOutputPaths.has(task.output_path)) return true;
                    seenOutputPaths.add(task.output_path);
                    return false;
                });
                if (duplicateOutputTask) {
                    // 与上方早退分支保持一致：先注销任务再返回，避免任务管理器残留永久 running 任务
                    TaskManager.unregisterTask(toolId, 'error', { error: `Duplicate output_path detected: ${duplicateOutputTask.output_path}. Each task must write to a unique output path.` });
                    return { success: false, error: `Duplicate output_path detected: ${duplicateOutputTask.output_path}. Each task must write to a unique output path.` };
                }

                const results = await Promise.all(
                    tasks.map((task, index) => executeImageTask(task, index, config, configMaxImagesPerTask, abortSignal, context))
                );

                // 统计结果
                const successResults = results.filter(r => r.success);
                const failedResults = results.filter(r => !r.success && !r.cancelled);
                const cancelledResults = results.filter(r => r.cancelled);
                
                // 任务完成，使用 TaskManager 注销（若所有任务均被取消，终态为 cancelled）
                const allCancelled = cancelledResults.length === results.length;
                TaskManager.unregisterTask(
                    toolId,
                    allCancelled ? 'cancelled' : 'completed',
                    allCancelled ? undefined : {
                        totalTasks: tasks.length,
                        completedTasks: successResults.length
                    }
                );
                
                // 如果所有任务都被取消，返回用户中断信息
                if (cancelledResults.length === results.length) {
                    return {
                        success: false,
                        error: 'User cancelled the image generation request. Please wait for user\'s next instruction.',
                        cancelled: true
                    };
                }

            // 收集所有多模态数据
            const allMultimodal: MultimodalData[] = [];
            const allPaths: string[] = [];
            const allDimensions: Array<{ width: number; height: number; aspectRatio: string }> = [];
            let totalCount = 0;
            const descriptions: string[] = [];

            for (const result of successResults) {
                if (result.multimodal) {
                    allMultimodal.push(...result.multimodal);
                }
                if (result.paths) {
                    allPaths.push(...result.paths);
                }
                if (result.count) {
                    totalCount += result.count;
                }
                if (result.dimensions) {
                    allDimensions.push(...result.dimensions);
                }
                if (result.description) {
                    descriptions.push(result.description);
                }
            }

            // 生成报告
            const isBatch = tasks.length > 1;
            let message: string;

            if (failedResults.length === 0) {
                // 全部成功
                if (isBatch) {
                    message = `✅ Batch generation completed: ${successResults.length}/${tasks.length} tasks succeeded, ${totalCount} images generated\n\nSaved to:\n${allPaths.map(p => `• ${p}`).join('\n')}`;
                } else {
                    // 单张模式显示尺寸
                    const dimInfo = allDimensions.length > 0
                        ? `\n\nDimensions: ${allDimensions.map(d => `${d.width}×${d.height} (${d.aspectRatio})`).join(', ')}`
                        : '';
                    message = `✅ Successfully generated ${totalCount} images${dimInfo}\n\nSaved to: ${allPaths.join(', ')}`;
                }
            } else if (successResults.length === 0) {
                // 全部失败
                const errors = failedResults.map(r => r.error).join('\n');
                return {
                    success: false,
                    error: isBatch
                        ? `Batch generation failed: All ${tasks.length} tasks failed\n\n${errors}`
                        : failedResults[0].error || 'Generation failed'
                };
            } else {
                // 部分成功
                const errors = failedResults.map(r => r.error).join('\n');
                message = `⚠️ Batch generation partially completed: ${successResults.length}/${tasks.length} succeeded, ${failedResults.length}/${tasks.length} failed\n\n`;
                message += `Saved to:\n${allPaths.map(p => `• ${p}`).join('\n')}\n\n`;
                message += `Failure reasons:\n${errors}`;
            }

            // 如果有部分任务被取消
            const hasCancelled = cancelledResults.length > 0;
            const cancelledNote = hasCancelled
                ? `\n\n⚠️ Note: ${cancelledResults.length} tasks were cancelled by user`
                : '';

                // 根据配置决定是否返回多模态数据给 AI（默认关闭以节省 token）
                const shouldReturnImageToAI = config.returnImageToAI === true;
                
                return {
                    success: true,
                    data: {
                        message: message + cancelledNote,
                        toolId,
                        totalTasks: tasks.length,
                        successCount: successResults.length,
                        failedCount: failedResults.length,
                        cancelledCount: cancelledResults.length,
                        totalImages: totalCount,
                        paths: allPaths,
                        dimensions: allDimensions.length > 0 ? allDimensions : undefined,
                        model: config.model || DEFAULT_IMAGE_MODEL,
                        details: descriptions
                    },
                    multimodal: shouldReturnImageToAI && allMultimodal.length > 0 ? allMultimodal : undefined,
                    cancelled: hasCancelled
                };
            } catch (error) {
                // 检查是否是取消导致的错误
                const errorMessage = error instanceof Error ? error.message : String(error);
                const errorName = error instanceof Error ? error.name : '';
                
                // 修改原因：超时保护（createFetchSignal 的 timeout abort）会让 fetch 以 AbortError
                // （"This operation was aborted"）拒绝，仅凭 errorName/message 会把请求超时误判为用户取消。
                // 修改方式：以用户 abortSignal 是否真的 aborted 为准；AbortError/消息检查仅作无信号时的后备。
                const isCancelled = abortSignal.aborted === true ||
                    (errorName === 'AbortError' && !abortSignal) ||
                    errorMessage.includes('cancelled') ||
                    errorMessage.includes('canceled');
                
                // 使用 TaskManager 注销任务
                TaskManager.unregisterTask(
                    toolId,
                    isCancelled ? 'cancelled' : 'error',
                    isCancelled ? undefined : { error: errorMessage }
                );
                
                if (isCancelled) {
                    return {
                        success: false,
                        error: 'User cancelled the image generation request. Please wait for user\'s next instruction.',
                        cancelled: true
                    };
                }
                
                // 修改原因：非取消错误直接 rethrow，与兄弟工具不一致（应返回错误 ToolResult 而非抛出）。
                // 修改方式：与其余媒体工具一致 return { success: false, error }。
                return {
                    success: false,
                    error: errorMessage
                };
            }
        })
    };
}

/**
 * 注册图像生成工具（默认配置）
 */
export function registerGenerateImage(): Tool {
    return createGenerateImageTool();
}