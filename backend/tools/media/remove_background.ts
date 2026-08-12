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
import { resolveFileToolPathWithInfo, getAllWorkspaces, calculateAspectRatio, formatFileSize } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { readImageFile, getImageDimensions, createFetchSignal } from './imageUtils';
import { createProxyFetch } from '../../modules/channel/proxyFetch';
import { TaskManager, type TaskEvent } from '../taskManager';
import { withLinkedAbort } from '../abortLink';
import { getSharp } from '../../modules/dependencies';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { buildRemoveBackgroundDescriptions } from '../localization/dynamicDescriptions';

/** 抠图任务类型常量 */
const TASK_TYPE_REMOVE_BG = 'remove_background';

/** 抠图输入文件大小上限：超过后先拦截，避免超大图全量读入内存并浪费 API 调用 */
const MAX_REMOVE_BG_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * Gemini API 请求超时（毫秒）：网络挂起时不会无限期等待。
 * 修改原因：remove_background 的 fetch 只有取消信号、无超时保护。
 */
const REMOVE_BG_API_REQUEST_TIMEOUT_MS = 120_000;
/** 逐像素合成最大像素数（约 16MP，4096x4096 为边界值）：超过后在主线程逐像素循环会长时间阻塞并分配数百 MB 缓冲 */
const MAX_REMOVE_BG_PIXELS = 16 * 1024 * 1024;

/** 生成图片过大的可读错误（供 API 调用前与逐像素合成前两处共用） */
function buildRemoveBgImageTooLargeError(index: number, width: number, height: number): string {
    return `Task ${index + 1}: Image is too large (${width}x${height} = ${width * height} pixels, limit ${MAX_REMOVE_BG_PIXELS.toLocaleString()} ≈ 16MP). Resize the image first (e.g. resize_image) before removing the background.`;
}

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

    // 发送请求（传递取消信号 + 超时保护：网络挂起时不会无限期等待）
    const { signal: fetchSignal, cleanup: cleanupFetchSignal } = createFetchSignal(abortSignal, REMOVE_BG_API_REQUEST_TIMEOUT_MS);
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
    abortSignal?: AbortSignal,
    context?: ToolContext
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
        const imageFile = await readImageFile(image_path, context);
        if (!imageFile) {
            return { index, success: false, error: `Task ${index + 1}: Cannot read image: ${image_path}` };
        }

        // 输入文件大小护栏：超大图全量读入后还会 base64 编码并发送给 API，先按文件大小拦截。
        if (imageFile.data.byteLength > MAX_REMOVE_BG_IMAGE_BYTES) {
            return {
                index,
                success: false,
                error: `Task ${index + 1}: Image file is too large (${formatFileSize(imageFile.data.byteLength)}, limit ${formatFileSize(MAX_REMOVE_BG_IMAGE_BYTES)}). Resize the image (e.g. resize_image) before removing the background.`
            };
        }

        const base64Data = imageFile.data.toString('base64');
        
        // 尝试获取尺寸（用于计算宽高比），失败也不影响核心流程
        let dimensions: { width: number; height: number; aspectRatio: string } | null = null;
        let aspectRatioForApi: string | undefined;
        
        try {
            const rawDimensions = await getImageDimensions(imageFile.data, imageFile.mimeType);
            if (rawDimensions) {
                // 像素数护栏：超大图（如 50MP）在 API 调用后的逐像素合成会长时间阻塞主线程，先拦截，避免浪费 API 调用。
                if (rawDimensions.width * rawDimensions.height > MAX_REMOVE_BG_PIXELS) {
                    return {
                        index,
                        success: false,
                        error: buildRemoveBgImageTooLargeError(index, rawDimensions.width, rawDimensions.height)
                    };
                }
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
        // 语义特殊：按读路径处理（resolveFileToolPathWithInfo + read 策略审批）
        // 保存失败不再静默跳过：返回可读 warning（随成功结果以 ⚠️ Warnings 回传模型）
        let maskSaveWarning: string | undefined;
        if (mask_path) {
            const { uri: maskUri, isOutsideWorkspace: maskOutside } = resolveFileToolPathWithInfo(mask_path);
            const maskAccessError = maskOutside
                ? ensureOutsideWorkspaceAccessApproved('read_file', { path: mask_path }, context)
                : null;
            if (!maskUri) {
                maskSaveWarning = `Task ${index + 1}: mask_path could not be resolved, mask image was NOT saved: ${mask_path}`;
            } else if (maskAccessError) {
                maskSaveWarning = `Task ${index + 1}: mask_path was rejected by access policy, mask image was NOT saved: ${maskAccessError}`;
            } else {
                try {
                    const maskDirUri = vscode.Uri.joinPath(maskUri, '..');
                    try {
                        await vscode.workspace.fs.createDirectory(maskDirUri);
                    } catch {
                        // 目录可能已存在
                    }
                    const maskBuffer = Buffer.from(maskImage.data, 'base64');
                    await vscode.workspace.fs.writeFile(maskUri, maskBuffer);
                } catch (writeError) {
                    maskSaveWarning = `Task ${index + 1}: failed to save mask image: ${writeError instanceof Error ? writeError.message : String(writeError)}`;
                }
            }
        }

        // 4. 使用 sharp 应用遮罩
        // 任务级判定：仅当 returnImageToAI=true 时构造 base64 多模态数据（默认关闭以节省 token）
        const shouldReturnImageToAI = config.returnImageToAI === true;
        const multimodal: MultimodalData[] = [];
        
        // 获取 sharp（工具依赖已在 ToolRegistry 层面检查，这里应该总是可用）
        const sharp = await getSharp();
        
        if (!sharp) {
            // 这种情况理论上不应该发生（因为依赖未安装时工具不会被提供给 AI）
            return { index, success: false, error: `Task ${index + 1}: sharp library not installed, please install in Settings -> Extension Dependencies` };
        }
        
        const maskBuffer = Buffer.from(maskImage.data, 'base64');
        const originalMeta = await sharp(imageFile.data).metadata();

        // 像素数护栏（权威兜底）：逐像素合成是主线程 width*height 次 JS 循环，进入前必须校验尺寸。
        // 此处以 sharp metadata（合成循环实际使用的尺寸源）为准，即使前面 getImageDimensionsAsync 失败也能拦截。
        if (originalMeta.width && originalMeta.height && originalMeta.width * originalMeta.height > MAX_REMOVE_BG_PIXELS) {
            return {
                index,
                success: false,
                error: buildRemoveBgImageTooLargeError(index, originalMeta.width, originalMeta.height)
            };
        }
        
        // 显式 fit: 'fill'：遮罩必须无裁切地拉伸到原图尺寸，否则宽高比不一致时
        // 默认 fit: 'cover' 会裁掉遮罩边缘，导致主体缺失/错位
        const resizedMask = await sharp(maskBuffer)
            .resize(originalMeta.width, originalMeta.height, { fit: 'fill' })
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
        const { uri: outputUri, isOutsideWorkspace: outputOutside } = resolveFileToolPathWithInfo(output_path);
        if (!outputUri) {
            return { index, success: false, error: `Task ${index + 1}: Cannot resolve output path` };
        }

        // 工作区外写入：按 write 策略审批（与 write_file 保持一致）
        if (outputOutside) {
            const writeAccessError = ensureOutsideWorkspaceAccessApproved('write_file', { path: output_path }, context);
            if (writeAccessError) {
                return { index, success: false, error: `Task ${index + 1}: ${writeAccessError}` };
            }
        }

        const dirUri = vscode.Uri.joinPath(outputUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            // 目录可能已存在
        }

        await vscode.workspace.fs.writeFile(outputUri, resultBuffer);

        if (shouldReturnImageToAI) {
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
        }

        return {
            index,
            success: true,
            outputPath: output_path,
            // 遮罩未保存成功时不再宣称已保存（maskPath 由上层用于生成 Mask paths 列表）
            maskPath: maskSaveWarning ? undefined : mask_path,
            dimensions: dimensions ?? undefined,
            multimodal,
            // 成功结果携带 error 字段会被上层聚合为 ⚠️ Warnings（既有约定）
            ...(maskSaveWarning ? { error: maskSaveWarning } : {})
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : '';
        
        // 修改原因：超时保护（createFetchSignal 的 timeout abort）会让 fetch 以 AbortError 拒绝，
        // 仅凭 errorName/message 会把请求超时误判为用户取消。
        // 修改方式：以用户 abortSignal 是否真的 aborted 为准；AbortError/消息检查仅作无信号时的后备。
        const isCancelled = abortSignal?.aborted === true ||
            (errorName === 'AbortError' && !abortSignal) ||
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

    // 语言感知说明：根据当前实际界面语言（zh-CN/en/ja）生成模型可见说明。
    // 顶层说明（Limits、单张/批量模式、多根尾巴）与参数说明统一由
    // localization/dynamicDescriptions 的语言感知生成器负责。
    const lang = resolveLocalizationLanguage(getActualLanguage());
    const descriptions = buildRemoveBackgroundDescriptions({
        lang,
        maxBatchTasks,
        isMultiRoot,
        workspaceNames: workspaces.map(w => w.name)
    });

    const description = descriptions.description;

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
                        description: descriptions.images,
                        items: {
                            type: 'object',
                            properties: {
                                image_path: {
                                    type: 'string',
                                    description: descriptions.batchImagePath
                                },
                                output_path: {
                                    type: 'string',
                                    description: descriptions.batchOutputPath
                                },
                                subject_description: {
                                    type: 'string',
                                    description: descriptions.batchSubjectDescription
                                },
                                mask_path: {
                                    type: 'string',
                                    description: descriptions.batchMaskPath
                                }
                            },
                            required: ['image_path', 'output_path']
                        }
                    },
                    // 单张模式参数（向后兼容）
                    image_path: {
                        type: 'string',
                        description: descriptions.singleImagePath
                    },
                    output_path: {
                        type: 'string',
                        description: descriptions.singleOutputPath
                    },
                    subject_description: {
                        type: 'string',
                        description: descriptions.singleSubjectDescription
                    },
                    mask_path: {
                        type: 'string',
                        description: descriptions.singleMaskPath
                    }
                }
            }
        },
        handler: withLinkedAbort(async (args, context: ToolContext | undefined, abortController): Promise<ToolResult> => {
            const config = (context?.config || {}) as RemoveBackgroundConfig;
            const toolId = context?.toolId || TaskManager.generateTaskId('rmbg');

            const abortSignal = abortController.signal;

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
                    // 与同文件其他早退分支保持一致：先注销任务再返回，避免任务管理器残留永久 running 任务
                    TaskManager.unregisterTask(toolId, 'error', { error: `Duplicate output_path detected: ${duplicateOutputTask.output_path}. Each task must write to a unique output path.` });
                    return { success: false, error: `Duplicate output_path detected: ${duplicateOutputTask.output_path}. Each task must write to a unique output path.` };
                }

                const results = await Promise.all(
                    tasks.map((task, index) => executeRemoveTask(task, index, config, abortSignal, context))
                );

                // 统计结果
                const successResults = results.filter(r => r.success);
                const failedResults = results.filter(r => !r.success && !r.cancelled);
                const cancelledResults = results.filter(r => r.cancelled);

                // 任务完成（若所有任务均被取消，终态为 cancelled）
                const allCancelled = cancelledResults.length === results.length;
                TaskManager.unregisterTask(
                    toolId,
                    allCancelled ? 'cancelled' : 'completed',
                    allCancelled ? undefined : {
                        totalTasks: tasks.length,
                        successCount: successResults.length
                    }
                );

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
                // 修改原因：超时保护（createFetchSignal 的 timeout abort）会让 fetch 以 AbortError 拒绝，
                // 仅凭 errorMessage 会把请求超时误判为用户取消。以用户 abortSignal 是否真的 aborted 为准。
                const isCancelled = abortSignal.aborted === true ||
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
        })
    };
}

/**
 * 注册抠图工具（默认配置）
 */
export function registerRemoveBackground(): Tool {
    return createRemoveBackgroundTool();
}