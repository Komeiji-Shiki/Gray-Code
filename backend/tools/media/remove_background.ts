/**
 * 抠图工具 - 移除图片背景
 *
 * 工作流程：
 * 1. 读取原图
 * 2. 调用 Gemini Image API 生成遮罩图（黑色=主体，白色=背景）
 * 3. 缩放遮罩图对齐原图尺寸
 * 4. 应用遮罩：保留黑色区域，白色区域设为透明
 * 5. 保存为透明 PNG
 *
 * 支持单张和批量两种模式
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolResult, MultimodalData, ToolContext } from '../types';
import { resolveUri, getAllWorkspaces, calculateAspectRatio } from '../utils';
import { createProxyFetch } from '../../modules/channel/proxyFetch';
import { TaskManager, type TaskEvent } from '../taskManager';
import { getSharp } from '../../modules/dependencies';

/** 抠图任务类型常量 */
const TASK_TYPE_REMOVE_BG = 'remove_background';

/**
 * 抠图输出事件类型
 */
export interface RemoveBgOutputEvent {
    toolId: string;
    type: 'start' | 'progress' | 'complete' | 'cancelled' | 'error';
    data?: {
        message?: string;
        step?: 'reading' | 'generating_mask' | 'processing' | 'saving';
        currentTask?: number;
        totalTasks?: number;
    };
    error?: string;
}

/**
 * 订阅抠图输出
 */
export function onRemoveBgOutput(listener: (event: RemoveBgOutputEvent) => void): () => void {
    return TaskManager.onTaskEventByType(TASK_TYPE_REMOVE_BG, (taskEvent: TaskEvent) => {
        const event: RemoveBgOutputEvent = {
            toolId: taskEvent.taskId,
            type: taskEvent.type as RemoveBgOutputEvent['type'],
            data: taskEvent.data as RemoveBgOutputEvent['data'],
            error: taskEvent.error
        };
        listener(event);
    });
}

/**
 * 取消抠图任务
 */
export function cancelRemoveBackground(toolId: string): { success: boolean; error?: string } {
    return TaskManager.cancelTask(toolId);
}

/**
 * 抠图工具配置（复用生图配置）
 */
interface RemoveBackgroundConfig {
    url?: string;
    apiKey?: string;
    model?: string;
    proxyUrl?: string;
    maxBatchTasks?: number;
    /** 是否将图片返回给 AI */
    returnImageToAI?: boolean;
}

/**
 * 单个抠图任务
 */
interface RemoveTask {
    /** 原始图片路径 */
    image_path: string;
    /** 输出文件路径 */
    output_path: string;
    /** 主体描述 */
    subject_description?: string;
    /** 遮罩图保存路径 */
    mask_path?: string;
}

/**
 * 单个任务的结果
 */
interface TaskResult {
    index: number;
    success: boolean;
    error?: string;
    outputPath?: string;
    maskPath?: string;
    dimensions?: { width: number; height: number; aspectRatio: string };
    multimodal?: MultimodalData[];
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
 * 读取图片文件
 */
async function readImageFile(imagePath: string): Promise<{ data: Buffer; mimeType: string } | null> {
    const uri = resolveUri(imagePath);
    if (!uri) {
        return null;
    }

    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const ext = path.extname(imagePath).toLowerCase();
        let mimeType = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') {
            mimeType = 'image/jpeg';
        } else if (ext === '.webp') {
            mimeType = 'image/webp';
        }

        return {
            data: Buffer.from(content),
            mimeType
        };
    } catch (error) {
        return null;
    }
}

/**
 * 获取图片尺寸（优先使用 sharp，否则手动解析）
 */
async function getImageDimensionsAsync(buffer: Buffer, mimeType: string): Promise<{ width: number; height: number } | null> {
    // 首先尝试使用 sharp（最可靠）
    try {
        const sharp = await getSharp();
        if (sharp) {
            const metadata = await sharp(buffer).metadata();
            if (metadata.width && metadata.height) {
                return { width: metadata.width, height: metadata.height };
            }
        }
    } catch {
        // sharp 不可用或解析失败，继续尝试手动解析
    }

    // 手动解析
    return getImageDimensionsSync(buffer, mimeType);
}

/**
 * 同步获取图片尺寸（通过解析 PNG/JPEG 头部）
 */
function getImageDimensionsSync(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
    try {
        if (mimeType === 'image/png') {
            // PNG magic number: 89 50 4E 47 0D 0A 1A 0A (即 \x89PNG\r\n\x1a\n)
            if (buffer.length >= 24) {
                // 检查 PNG 签名
                const isPNG = buffer[0] === 0x89 &&
                    buffer[1] === 0x50 && // P
                    buffer[2] === 0x4E && // N
                    buffer[3] === 0x47 && // G
                    buffer[4] === 0x0D &&
                    buffer[5] === 0x0A &&
                    buffer[6] === 0x1A &&
                    buffer[7] === 0x0A;
                
                if (isPNG) {
                    // IHDR 块从字节 8 开始，宽高在字节 16-23
                    const width = buffer.readUInt32BE(16);
                    const height = buffer.readUInt32BE(20);
                    if (width > 0 && height > 0 && width < 100000 && height < 100000) {
                        return { width, height };
                    }
                }
            }
        } else if (mimeType === 'image/jpeg') {
            // JPEG 以 FF D8 开头
            if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
                let i = 2;
                while (i < buffer.length - 9) {
                    if (buffer[i] === 0xFF) {
                        const marker = buffer[i + 1];
                        // SOF0-SOF3 标记包含尺寸信息
                        if (marker >= 0xC0 && marker <= 0xC3) {
                            const height = buffer.readUInt16BE(i + 5);
                            const width = buffer.readUInt16BE(i + 7);
                            if (width > 0 && height > 0) {
                                return { width, height };
                            }
                        }
                        // 跳过这个段
                        if (i + 3 < buffer.length) {
                            const segmentLength = buffer.readUInt16BE(i + 2);
                            i += 2 + segmentLength;
                        } else {
                            break;
                        }
                    } else {
                        i++;
                    }
                }
            }
        } else if (mimeType === 'image/webp') {
            if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
                buffer.toString('ascii', 8, 12) === 'WEBP') {
                const format = buffer.toString('ascii', 12, 16);
                if (format === 'VP8 ') {
                    // Lossy WebP
                    const width = buffer.readUInt16LE(26) & 0x3FFF;
                    const height = buffer.readUInt16LE(28) & 0x3FFF;
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                } else if (format === 'VP8L') {
                    // Lossless WebP
                    const b0 = buffer[21];
                    const b1 = buffer[22];
                    const b2 = buffer[23];
                    const b3 = buffer[24];
                    const width = 1 + (((b1 & 0x3F) << 8) | b0);
                    const height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                } else if (format === 'VP8X') {
                    // Extended WebP
                    if (buffer.length >= 30) {
                        const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
                        const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
                        if (width > 0 && height > 0) {
                            return { width, height };
                        }
                    }
                }
            }
        }
    } catch (error) {
        // 解析失败
        console.error('Failed to parse image dimensions:', error);
    }
    return null;
}

/**
 * 计算用于 API 的宽高比字符串
 * 如果图片比例与支持的比例差距过大（>10%），返回 undefined，让 API 自动处理
 */
function calculateAspectRatioForApi(width: number, height: number): string | undefined {
    const ratio = width / height;
    
    const supportedRatios: { [key: string]: number } = {
        '1:1': 1,
        '3:2': 1.5,
        '2:3': 0.667,
        '3:4': 0.75,
        '4:3': 1.333,
        '4:5': 0.8,
        '5:4': 1.25,
        '9:16': 0.5625,
        '16:9': 1.778,
        '21:9': 2.333
    };
    
    let closest = '1:1';
    let minDiff = Infinity;
    
    for (const [name, value] of Object.entries(supportedRatios)) {
        const diff = Math.abs(ratio - value);
        if (diff < minDiff) {
            minDiff = diff;
            closest = name;
        }
    }
    
    // 如果与最接近的支持比例差距超过 10%，不发送比例参数
    const closestValue = supportedRatios[closest];
    const diffPercent = Math.abs(ratio - closestValue) / closestValue;
    if (diffPercent > 0.05) {
        return undefined;
    }
    
    return closest;
}

/**
 * 调用 Gemini API 生成遮罩图
 */
async function generateMaskImage(
    originalImage: { data: string; mimeType: string },
    subjectDescription: string | undefined,
    aspectRatio: string | undefined,
    config: RemoveBackgroundConfig,
    abortSignal?: AbortSignal
): Promise<GeminiImageResponse> {
    const apiKey = config.apiKey;
    if (!apiKey) {
        throw new Error('API Key not configured.');
    }

    const model = config.model || 'gemini-3-pro-image-preview';
    const baseUrl = config.url || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;

    let maskPrompt = `Generate a binary mask image for background removal.

CRITICAL REQUIREMENTS:
- Main subject/foreground: Pure BLACK color (#000000)
- Background: Pure WHITE color (#FFFFFF)
- NO gradients, NO gray colors, NO anti-aliasing
- Sharp, clean edges between subject and background
- The mask should precisely outline the main subject
- Keep the original aspect ratio unchanged`;

    if (subjectDescription) {
        maskPrompt += `\n\nThe main subject to keep is: ${subjectDescription}`;
    }

    const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [
        { text: maskPrompt },
        {
            inline_data: {
                mime_type: originalImage.mimeType,
                data: originalImage.data
            }
        }
    ];

    // 构建 imageConfig，只有在有支持的比例时才发送 aspectRatio
    const imageConfig: { aspectRatio?: string } = {};
    if (aspectRatio) {
        imageConfig.aspectRatio = aspectRatio;
    }

    const requestBody = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['IMAGE'],
            ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {})
        }
    };

    if (abortSignal?.aborted) {
        throw new Error('Request cancelled');
    }

    const fetchFn = createProxyFetch(config.proxyUrl);

    const response = await fetchFn(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return await response.json() as GeminiImageResponse;
}

/**
 * 从响应中提取遮罩图
 */
function extractMaskFromResponse(response: GeminiImageResponse): { data: string; mimeType: string } | null {
    if (response.candidates) {
        for (const candidate of response.candidates) {
            if (candidate.content?.parts) {
                for (const part of candidate.content.parts) {
                    if (part.inlineData) {
                        return {
                            data: part.inlineData.data,
                            mimeType: part.inlineData.mimeType
                        };
                    }
                }
            }
        }
    }
    return null;
}

/**
 * 执行单个抠图任务
 */
async function executeRemoveTask(
    task: RemoveTask,
    index: number,
    config: RemoveBackgroundConfig,
    abortSignal?: AbortSignal
): Promise<TaskResult> {
    const { image_path, output_path, subject_description, mask_path } = task;

    // 验证参数
    if (!image_path) {
        return { index, success: false, error: `Task ${index + 1}: image_path is required` };
    }

    if (!output_path) {
        return { index, success: false, error: `Task ${index + 1}: output_path is required` };
    }

    try {
        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled the background removal`, cancelled: true };
        }

        // 1. 读取原图
        const imageFile = await readImageFile(image_path);
        if (!imageFile) {
            return { index, success: false, error: `Task ${index + 1}: Cannot read image: ${image_path}` };
        }

        const base64Data = imageFile.data.toString('base64');
        
        // 尝试获取尺寸（用于计算宽高比），失败也不影响核心流程
        let dimensions: { width: number; height: number; aspectRatio: string } | null = null;
        let aspectRatioForApi: string | undefined;
        
        try {
            const rawDimensions = await getImageDimensionsAsync(imageFile.data, imageFile.mimeType);
            if (rawDimensions) {
                const ratio = calculateAspectRatio(rawDimensions.width, rawDimensions.height);
                dimensions = {
                    width: rawDimensions.width,
                    height: rawDimensions.height,
                    aspectRatio: ratio
                };
                aspectRatioForApi = calculateAspectRatioForApi(rawDimensions.width, rawDimensions.height);
            }
        } catch {
            // 获取尺寸失败，不传递宽高比参数
        }

        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled the background removal`, cancelled: true };
        }

        // 2. 生成遮罩图
        const maskResponse = await generateMaskImage(
            { data: base64Data, mimeType: imageFile.mimeType },
            subject_description,
            aspectRatioForApi,
            config,
            abortSignal
        );

        if (maskResponse.error) {
            return { index, success: false, error: `Task ${index + 1}: API error - ${maskResponse.error.message}` };
        }

        const maskImage = extractMaskFromResponse(maskResponse);
        if (!maskImage) {
            return { index, success: false, error: `Task ${index + 1}: Failed to generate mask. Content may have been filtered.` };
        }

        // 3. 保存遮罩图（如果指定了路径）
        if (mask_path) {
            const maskUri = resolveUri(mask_path);
            if (maskUri) {
                const maskDirUri = vscode.Uri.joinPath(maskUri, '..');
                try {
                    await vscode.workspace.fs.createDirectory(maskDirUri);
                } catch {
                    // 目录可能已存在
                }
                const maskBuffer = Buffer.from(maskImage.data, 'base64');
                await vscode.workspace.fs.writeFile(maskUri, maskBuffer);
            }
        }

        // 4. 使用 sharp 应用遮罩
        const multimodal: MultimodalData[] = [];
        
        // 获取 sharp（工具依赖已在 ToolRegistry 层面检查，这里应该总是可用）
        const sharp = await getSharp();
        
        if (!sharp) {
            // 这种情况理论上不应该发生（因为依赖未安装时工具不会被提供给 AI）
            return { index, success: false, error: `Task ${index + 1}: sharp library not installed, please install in Settings -> Extension Dependencies` };
        }
        
        const maskBuffer = Buffer.from(maskImage.data, 'base64');
        const originalMeta = await sharp(imageFile.data).metadata();
        
        const resizedMask = await sharp(maskBuffer)
            .resize(originalMeta.width, originalMeta.height)
            .greyscale()
            .raw()
            .toBuffer();
        
        const originalRgba = await sharp(imageFile.data)
            .ensureAlpha()
            .raw()
            .toBuffer();
        
        const width = originalMeta.width!;
        const height = originalMeta.height!;
        const resultData = Buffer.alloc(width * height * 4);
        
        for (let i = 0; i < width * height; i++) {
            const maskValue = resizedMask[i];
            const srcOffset = i * 4;
            const dstOffset = i * 4;
            
            resultData[dstOffset] = originalRgba[srcOffset];
            resultData[dstOffset + 1] = originalRgba[srcOffset + 1];
            resultData[dstOffset + 2] = originalRgba[srcOffset + 2];
            resultData[dstOffset + 3] = maskValue < 128 ? 255 : 0;
        }
        
        const resultBuffer = await sharp(resultData, {
            raw: { width, height, channels: 4 }
        })
            .png()
            .toBuffer();

        // 保存结果
        const outputUri = resolveUri(output_path);
        if (!outputUri) {
            return { index, success: false, error: `Task ${index + 1}: Cannot resolve output path` };
        }

        const dirUri = vscode.Uri.joinPath(outputUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            // 目录可能已存在
        }

        await vscode.workspace.fs.writeFile(outputUri, resultBuffer);

        multimodal.push({
            mimeType: 'image/png',
            data: resultBuffer.toString('base64'),
            name: path.basename(output_path)
        });

        if (mask_path) {
            multimodal.push({
                mimeType: maskImage.mimeType,
                data: maskImage.data,
                name: path.basename(mask_path)
            });
        }

        return {
            index,
            success: true,
            outputPath: output_path,
            maskPath: mask_path,
            dimensions,
            multimodal
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : '';
        
        const isCancelled = abortSignal?.aborted ||
            errorName === 'AbortError' ||
            errorMessage.includes('aborted') ||
            errorMessage.includes('cancelled') ||
            errorMessage.includes('Request cancelled');
        
        return {
            index,
            success: false,
            error: isCancelled
                ? `Task ${index + 1}: User cancelled the background removal`
                : `Task ${index + 1}: ${errorMessage}`,
            cancelled: isCancelled
        };
    }
}

/**
 * 创建抠图工具（支持动态配置）
 *
 * @param maxBatchTasks 单次调用允许的最大任务数
 */
export function createRemoveBackgroundTool(maxBatchTasks: number = 5): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;

    let description = `Remove background from images, generating transparent PNG. Supports single and batch modes.

**Limits**:
- Maximum ${maxBatchTasks} background removal tasks per call

**Single Mode**: Use image_path + output_path parameters
**Batch Mode**: Use images array parameter (max ${maxBatchTasks} tasks)

**How it works**:
1. Uses AI to generate a mask (subject=black, background=white)
2. Sets background to transparent based on the mask
3. Saves as transparent PNG

**Use cases**:
- Product image background removal
- Portrait cutout
- Object extraction
- Creative composite material preparation`;

    if (isMultiRoot) {
        description += `\n\n**Multi-root Workspace**: Use "workspace_name/path" format for paths. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }

    return {
        declaration: {
            name: 'remove_background',
            description,
            category: 'media',
            dependencies: ['sharp'],  // 声明依赖 sharp
            parameters: {
                type: 'object',
                properties: {
                    // 批量模式参数
                    images: {
                        type: 'array',
                        description: 'Batch mode: Background removal task array. Each task can independently configure input, output, and subject description. MUST be an array even for single task.',
                        items: {
                            type: 'object',
                            properties: {
                                image_path: {
                                    type: 'string',
                                    description: 'Source image path (required)'
                                },
                                output_path: {
                                    type: 'string',
                                    description: 'Output file path (required). Recommend using .png extension.'
                                },
                                subject_description: {
                                    type: 'string',
                                    description: 'Subject description (optional). Helps AI identify the subject to keep more accurately.'
                                },
                                mask_path: {
                                    type: 'string',
                                    description: 'Mask image save path (optional). If provided, also saves the mask image.'
                                }
                            },
                            required: ['image_path', 'output_path']
                        }
                    },
                    // 单张模式参数（向后兼容）
                    image_path: {
                        type: 'string',
                        description: isMultiRoot
                            ? 'Single mode: Source image path (required). Use "workspace_name/path" format.'
                            : 'Single mode: Source image path (required). Relative to workspace.'
                    },
                    output_path: {
                        type: 'string',
                        description: isMultiRoot
                            ? 'Single mode: Output file path (required). Recommend using .png extension. Use "workspace_name/path" format.'
                            : 'Single mode: Output file path (required). Recommend using .png extension.'
                    },
                    subject_description: {
                        type: 'string',
                        description: 'Single mode: Subject description (optional). Helps AI identify the subject to keep more accurately. E.g., "person", "product", "cat".'
                    },
                    mask_path: {
                        type: 'string',
                        description: isMultiRoot
                            ? 'Single mode: Mask image save path (optional). If provided, also saves the mask image. Use "workspace_name/path" format.'
                            : 'Single mode: Mask image save path (optional). If provided, also saves the mask image.'
                    }
                }
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const config = (context?.config || {}) as RemoveBackgroundConfig;
            const toolId = context?.toolId || TaskManager.generateTaskId('rmbg');

            const abortController = new AbortController();
            const abortSignal = abortController.signal;

            if (context?.abortSignal) {
                context.abortSignal.addEventListener('abort', () => {
                    abortController.abort();
                });
            }

            // 验证配置
            if (!config.apiKey) {
                return {
                    success: false,
                    error: 'API Key not configured. Please configure image generation tool in settings (Tools Settings -> Image Generation).'
                };
            }

            // 检查使用哪种模式
            const imagesArray = args.images as RemoveTask[] | undefined;
            const singleImagePath = args.image_path as string | undefined;
            const singleOutputPath = args.output_path as string | undefined;

            let tasks: RemoveTask[] = [];

            if (imagesArray && Array.isArray(imagesArray) && imagesArray.length > 0) {
                // 批量模式
                tasks = imagesArray;
            } else if (singleImagePath && singleOutputPath) {
                // 单张模式 - 转换为单任务数组
                tasks = [{
                    image_path: singleImagePath,
                    output_path: singleOutputPath,
                    subject_description: args.subject_description as string | undefined,
                    mask_path: args.mask_path as string | undefined
                }];
            } else {
                return {
                    success: false,
                    error: 'Please use one of the following:\n1. Single mode: Provide image_path and output_path\n2. Batch mode: Provide images array'
                };
            }

            // 获取配置限制
            const configMaxBatchTasks = config.maxBatchTasks || maxBatchTasks;

            // 验证任务数量
            if (tasks.length === 0) {
                return { success: false, error: 'No valid background removal tasks' };
            }

            if (tasks.length > configMaxBatchTasks) {
                return { success: false, error: `Maximum ${configMaxBatchTasks} background removal tasks per call (current: ${tasks.length})` };
            }

            // 注册任务
            TaskManager.registerTask(toolId, TASK_TYPE_REMOVE_BG, abortController, {
                totalTasks: tasks.length
            });

            try {
                // 并发执行所有任务
                const results = await Promise.all(
                    tasks.map((task, index) => executeRemoveTask(task, index, config, abortSignal))
                );

                // 统计结果
                const successResults = results.filter(r => r.success);
                const failedResults = results.filter(r => !r.success && !r.cancelled);
                const cancelledResults = results.filter(r => r.cancelled);

                // 任务完成
                TaskManager.unregisterTask(toolId, 'completed', {
                    totalTasks: tasks.length,
                    successCount: successResults.length
                });

                // 如果所有任务都被取消
                if (cancelledResults.length === results.length) {
                    return {
                        success: false,
                        error: 'User cancelled the background removal request. Please wait for user\'s next instruction.',
                        cancelled: true
                    };
                }

                // 收集所有多模态数据
                const allMultimodal: MultimodalData[] = [];
                const allPaths: string[] = [];
                const maskPaths: string[] = [];
                const warnings: string[] = [];

                for (const result of successResults) {
                    if (result.multimodal) {
                        allMultimodal.push(...result.multimodal);
                    }
                    if (result.outputPath) {
                        allPaths.push(result.outputPath);
                    }
                    if (result.maskPath) {
                        maskPaths.push(result.maskPath);
                    }
                    if (result.error) {
                        warnings.push(result.error);
                    }
                }

                // 生成报告
                const isBatch = tasks.length > 1;
                let message: string;

                if (failedResults.length === 0 && cancelledResults.length === 0) {
                    // 全部成功
                        if (isBatch) {
                            message = `✅ Batch background removal completed: ${successResults.length}/${tasks.length} tasks succeeded\n\nSaved to:\n${allPaths.map(p => `• ${p}`).join('\n')}`;
                        } else {
                            const r = successResults[0];
                            const dimInfo = r.dimensions
                                ? `\n\nDimensions: ${r.dimensions.width}×${r.dimensions.height} (${r.dimensions.aspectRatio})`
                                : '';
                            message = `✅ Background removal completed!${dimInfo}\n\nOutput: ${allPaths[0]}`;
                        }
                    
                    if (maskPaths.length > 0) {
                        message += `\n\nMask paths:\n${maskPaths.map(p => `• ${p}`).join('\n')}`;
                    }
                } else if (successResults.length === 0) {
                    // 全部失败
                    const errors = failedResults.map(r => r.error).join('\n');
                    return {
                        success: false,
                        error: isBatch
                            ? `Batch background removal failed: All ${tasks.length} tasks failed\n\n${errors}`
                            : failedResults[0]?.error || 'Background removal failed'
                    };
                } else {
                    // 部分成功
                    const errors = failedResults.map(r => r.error).join('\n');
                    message = `⚠️ Batch background removal partially completed: ${successResults.length}/${tasks.length} succeeded, ${failedResults.length} failed\n\n`;
                    message += `Saved to:\n${allPaths.map(p => `• ${p}`).join('\n')}\n\n`;
                    if (failedResults.length > 0) {
                        message += `Failure reasons:\n${errors}`;
                    }
                }

                // 添加警告信息
                if (warnings.length > 0) {
                    message += `\n\n⚠️ Warnings:\n${warnings.join('\n')}`;
                }

                // 如果有部分任务被取消
                if (cancelledResults.length > 0) {
                    message += `\n\n⚠️ Note: ${cancelledResults.length} tasks were cancelled by user`;
                }

                // 根据配置决定是否返回多模态数据给 AI（默认关闭以节省 token）
                const shouldReturnImageToAI = config.returnImageToAI === true;
                
                return {
                    success: true,
                    data: {
                        message,
                        toolId,
                        totalTasks: tasks.length,
                        successCount: successResults.length,
                        failedCount: failedResults.length,
                        cancelledCount: cancelledResults.length,
                        paths: allPaths,
                        maskPaths
                    },
                    multimodal: shouldReturnImageToAI && allMultimodal.length > 0 ? allMultimodal : undefined,
                    cancelled: cancelledResults.length > 0
                };

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isCancelled = abortSignal.aborted ||
                    errorMessage.includes('aborted') ||
                    errorMessage.includes('cancelled');

                TaskManager.unregisterTask(
                    toolId,
                    isCancelled ? 'cancelled' : 'error',
                    isCancelled ? undefined : { error: errorMessage }
                );

                if (isCancelled) {
                    return {
                        success: false,
                        error: 'User cancelled the background removal operation.',
                        cancelled: true
                    };
                }

                return {
                    success: false,
                    error: `Background removal failed: ${errorMessage}`
                };
            }
        }
    };
}

/**
 * 注册抠图工具（默认配置）
 */
export function registerRemoveBackground(): Tool {
    return createRemoveBackgroundTool();
}