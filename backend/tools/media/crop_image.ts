/**
 * 裁切图片工具
 *
 * 使用归一化坐标 (0-1000) 来控制裁切区域：
 * - AI 传入 0-1000 范围的坐标
 * - 工具自动转换为实际像素坐标
 * - 使用 sharp 进行裁切
 * - 返回裁切后的图片
 *
 * 支持单张和批量两种模式
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolResult, MultimodalData, ToolContext, CropImageToolOptions } from '../types';
import { resolveFileToolPathWithInfo, getAllWorkspaces, calculateAspectRatio } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { TaskManager, type TaskEvent } from '../taskManager';
import { withLinkedAbort } from '../abortLink';
import { getSharp } from '../../modules/dependencies';
import { ensureMediaPathsSafe, MEDIA_MAX_INPUT_BYTES } from './pathGuard';

/** 裁切任务类型常量 */
const TASK_TYPE_CROP = 'crop_image';

/**
 * 裁切输出事件类型
 */
export interface CropImageOutputEvent {
    toolId: string;
    type: 'start' | 'progress' | 'complete' | 'cancelled' | 'error';
    data?: {
        message?: string;
        currentTask?: number;
        totalTasks?: number;
    };
    error?: string;
}

/**
 * 订阅裁切输出
 */
export function onCropImageOutput(listener: (event: CropImageOutputEvent) => void): () => void {
    return TaskManager.onTaskEventByType(TASK_TYPE_CROP, (taskEvent: TaskEvent) => {
        const event: CropImageOutputEvent = {
            toolId: taskEvent.taskId,
            type: taskEvent.type as CropImageOutputEvent['type'],
            data: taskEvent.data as CropImageOutputEvent['data'],
            error: taskEvent.error
        };
        listener(event);
    });
}

/**
 * 取消裁切任务
 */
export function cancelCropImage(toolId: string): { success: boolean; error?: string } {
    return TaskManager.cancelTask(toolId);
}

/**
 * 归一化坐标范围
 */
const NORMALIZED_MAX = 1000;

/**
 * 归一化坐标转实际像素
 */
function normalizeCoord(normalized: number, actualSize: number): number {
    // 确保在有效范围内
    const clamped = Math.max(0, Math.min(NORMALIZED_MAX, normalized));
    return Math.round((clamped / NORMALIZED_MAX) * actualSize);
}

/**
 * 裁切图片工具配置（从 context.config 获取）
 */
interface CropImageConfig {
    /** 是否将图片返回给 AI */
    returnImageToAI?: boolean;
}

/**
 * 获取工具配置
 */
function getCropImageOptions(context?: ToolContext): CropImageToolOptions {
    return context?.toolOptions?.cropImage || { useNormalizedCoordinates: true };
}

/**
 * 单个裁切任务
 */
interface CropTask {
    /** 原始图片路径 */
    image_path: string;
    /** 输出文件路径 */
    output_path: string;
    /** 裁切区域左上角 X 坐标 (0-1000) */
    x1: number;
    /** 裁切区域左上角 Y 坐标 (0-1000) */
    y1: number;
    /** 裁切区域右下角 X 坐标 (0-1000) */
    x2: number;
    /** 裁切区域右下角 Y 坐标 (0-1000) */
    y2: number;
}

/**
 * 单个任务的结果
 */
interface TaskResult {
    index: number;
    success: boolean;
    error?: string;
    outputPath?: string;
    originalDimensions?: { width: number; height: number; aspectRatio: string };
    croppedDimensions?: { width: number; height: number; aspectRatio: string };
    multimodal?: MultimodalData[];
    cancelled?: boolean;
}

/**
 * 读取图片文件
 */
async function readImageFile(imagePath: string, context?: ToolContext): Promise<{ data: Buffer; mimeType: string } | null> {
    const { uri, isOutsideWorkspace } = resolveFileToolPathWithInfo(imagePath, context?.activeWorkspaceUri);
    if (!uri) {
        return null;
    }

    // 工作区外读取：按 read 策略审批（deny 拒绝 / ask 需确认 / allow 放行）
    if (isOutsideWorkspace) {
        const readAccessError = ensureOutsideWorkspaceAccessApproved('read_file', { path: imagePath }, context);
        if (readAccessError) {
            return null;
        }
    }

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MEDIA_MAX_INPUT_BYTES) {
            console.warn(`Image file exceeds ${MEDIA_MAX_INPUT_BYTES} bytes: ${imagePath}`);
            return null;
        }

        const content = await vscode.workspace.fs.readFile(uri);
        const ext = path.extname(imagePath).toLowerCase();
        let mimeType = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') {
            mimeType = 'image/jpeg';
        } else if (ext === '.webp') {
            mimeType = 'image/webp';
        } else if (ext === '.gif') {
            mimeType = 'image/gif';
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
 * 执行单个裁切任务
 */
async function executeCropTask(
    task: CropTask,
    index: number,
    abortSignal?: AbortSignal,
    options?: CropImageToolOptions,
    context?: ToolContext
): Promise<TaskResult> {
    const { image_path, output_path, x1, y1, x2, y2 } = task;
    const useNormalized = options?.useNormalizedCoordinates ?? true;

    // 验证参数
    if (!image_path) {
        return { index, success: false, error: `Task ${index + 1}: image_path is required` };
    }

    if (!output_path) {
        return { index, success: false, error: `Task ${index + 1}: output_path is required` };
    }

    // 验证坐标范围（NaN/Infinity 会穿透 < 0 / > max 比较，显式要求有限数；仅在归一化模式下检查范围）
    if (useNormalized) {
        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2) ||
            x1 < 0 || x1 > NORMALIZED_MAX || y1 < 0 || y1 > NORMALIZED_MAX ||
            x2 < 0 || x2 > NORMALIZED_MAX || y2 < 0 || y2 > NORMALIZED_MAX) {
            return { index, success: false, error: `Task ${index + 1}: Coordinates must be finite numbers in range 0-${NORMALIZED_MAX}` };
        }
    } else {
        // 像素模式：坐标必须为有限非负数
        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2) ||
            x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) {
            return { index, success: false, error: `Task ${index + 1}: Coordinates must be finite non-negative numbers` };
        }
    }

    // 验证坐标逻辑
    if (x1 >= x2 || y1 >= y2) {
        return { index, success: false, error: `Task ${index + 1}: x1 must be less than x2, y1 must be less than y2` };
    }

    const inputPathError = ensureMediaPathsSafe(image_path, undefined, undefined, context?.activeWorkspaceUri);
    if (inputPathError) {
        return { index, success: false, error: `Task ${index + 1}: ${inputPathError}` };
    }

    try {
        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled the crop operation`, cancelled: true };
        }

        // 获取 sharp（工具依赖已在 ToolRegistry 层面检查）
        const sharp = await getSharp();
        
        if (!sharp) {
            return { index, success: false, error: `Task ${index + 1}: sharp library not installed, please install in Settings -> Extension Dependencies` };
        }

        // 读取原图
        const imageFile = await readImageFile(image_path, context);
        if (!imageFile) {
            return { index, success: false, error: `Task ${index + 1}: Cannot read image: ${image_path}` };
        }

        // 获取图片尺寸
        const metadata = await sharp(imageFile.data).metadata();
        if (!metadata.width || !metadata.height) {
            return { index, success: false, error: `Task ${index + 1}: Cannot get image dimensions` };
        }

        const originalWidth = metadata.width;
        const originalHeight = metadata.height;

        // 根据配置决定是否转换坐标
        let left: number, top: number, right: number, bottom: number;
        
        if (useNormalized) {
            // 归一化模式：转换 0-1000 坐标为实际像素
            left = normalizeCoord(x1, originalWidth);
            top = normalizeCoord(y1, originalHeight);
            right = normalizeCoord(x2, originalWidth);
            bottom = normalizeCoord(y2, originalHeight);
        } else {
            // 像素模式：直接使用传入的坐标，但需要确保不超出图片边界
            left = Math.max(0, Math.min(x1, originalWidth));
            top = Math.max(0, Math.min(y1, originalHeight));
            right = Math.max(0, Math.min(x2, originalWidth));
            bottom = Math.max(0, Math.min(y2, originalHeight));
        }

        const cropWidth = right - left;
        const cropHeight = bottom - top;

        if (cropWidth <= 0 || cropHeight <= 0) {
            return { index, success: false, error: `Task ${index + 1}: Invalid crop region (width or height is 0)` };
        }

        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled the crop operation`, cancelled: true };
        }

        // 执行裁切
        const croppedBuffer = await sharp(imageFile.data)
            .extract({
                left,
                top,
                width: cropWidth,
                height: cropHeight
            })
            .toBuffer();

        // 确定输出格式
        const outputExt = path.extname(output_path).toLowerCase();
        let finalBuffer: Buffer;
        let outputMimeType = 'image/png';

        if (outputExt === '.jpg' || outputExt === '.jpeg') {
            finalBuffer = await sharp(croppedBuffer).jpeg({ quality: 90 }).toBuffer();
            outputMimeType = 'image/jpeg';
        } else if (outputExt === '.webp') {
            finalBuffer = await sharp(croppedBuffer).webp({ quality: 90 }).toBuffer();
            outputMimeType = 'image/webp';
        } else {
            finalBuffer = await sharp(croppedBuffer).png().toBuffer();
            outputMimeType = 'image/png';
        }

        // 保存结果
        const { uri: outputUri, isOutsideWorkspace: outputOutside } = resolveFileToolPathWithInfo(output_path, context?.activeWorkspaceUri);
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

        // 确保目录存在
        const dirUri = vscode.Uri.joinPath(outputUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            // 目录可能已存在
        }

        await vscode.workspace.fs.writeFile(outputUri, finalBuffer);

        // 构建多模态数据（任务级判定：仅当 returnImageToAI=true 时构造 base64，默认关闭以节省 token）
        const cropConfig = (context?.config || {}) as CropImageConfig;
        const shouldReturnImageToAI = cropConfig.returnImageToAI === true;
        const multimodal: MultimodalData[] = shouldReturnImageToAI ? [{
            mimeType: outputMimeType,
            data: finalBuffer.toString('base64'),
            name: path.basename(output_path)
        }] : [];

        return {
            index,
            success: true,
            outputPath: output_path,
            originalDimensions: {
                width: originalWidth,
                height: originalHeight,
                aspectRatio: calculateAspectRatio(originalWidth, originalHeight)
            },
            croppedDimensions: {
                width: cropWidth,
                height: cropHeight,
                aspectRatio: calculateAspectRatio(cropWidth, cropHeight)
            },
            multimodal
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : '';
        
        const isCancelled = abortSignal?.aborted === true ||
            (errorName === 'AbortError' && !abortSignal) ||
            errorMessage.includes('cancelled') ||
            errorMessage.includes('canceled');
        
        return {
            index,
            success: false,
            error: isCancelled
                ? `Task ${index + 1}: User cancelled the crop operation`
                : `Task ${index + 1}: ${errorMessage}`,
            cancelled: isCancelled
        };
    }
}

/**
 * 生成工具描述（根据配置动态生成）
 */
function generateDescription(maxBatchTasks: number, isMultiRoot: boolean, workspaces: { name: string }[], useNormalized: boolean): string {
    let description: string;
    
    if (useNormalized) {
        description = `Crop image tool. Uses normalized coordinates (0-1000) to specify the crop region.

**Coordinate System (Normalized Mode)**:
- Uses normalized coordinates in range 0-1000
- (0, 0) represents top-left corner
- (1000, 1000) represents bottom-right corner
- Tool automatically converts to actual pixel coordinates

**Parameters**:
- x1, y1: Top-left corner coordinates of crop region (0-1000)
- x2, y2: Bottom-right corner coordinates of crop region (0-1000)
- x1 must be less than x2, y1 must be less than y2

**Examples**:
- Crop top-left quarter: x1=0, y1=0, x2=500, y2=500
- Crop center region: x1=250, y1=250, x2=750, y2=750
- Crop bottom-right: x1=500, y1=500, x2=1000, y2=1000`;
    } else {
        description = `Crop image tool. Uses pixel coordinates to specify the crop region.

**Coordinate System (Pixel Mode)**:
- Uses actual pixel coordinates of the image
- (0, 0) represents top-left corner
- Coordinates are in pixels
- Need to calculate coordinates based on actual image dimensions

**Parameters**:
- x1, y1: Top-left corner coordinates (pixels)
- x2, y2: Bottom-right corner coordinates (pixels)
- x1 must be less than x2, y1 must be less than y2

**Examples** (assuming 1920x1080 image):
- Crop top-left quarter: x1=0, y1=0, x2=960, y2=540
- Crop center region: x1=480, y1=270, x2=1440, y2=810
- Crop bottom-right: x1=960, y1=540, x2=1920, y2=1080`;
    }

    description += `

**Supported Formats**: PNG, JPEG, WebP (auto-selected based on output path extension)

**Limits**:
- Maximum ${maxBatchTasks} crop tasks per call`;

    if (isMultiRoot) {
        description += `\n\n**Multi-root Workspace**: Use "workspace_name/path" format for paths. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }

    return description;
}

/**
 * 创建裁切图片工具
 *
 * @param maxBatchTasks 单次调用允许的最大任务数
 * @param defaultOptions 默认工具配置
 */
export function createCropImageTool(maxBatchTasks: number = 10, defaultOptions?: CropImageToolOptions): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    const useNormalized = defaultOptions?.useNormalizedCoordinates ?? true;

    const description = generateDescription(maxBatchTasks, isMultiRoot, workspaces, useNormalized);

    return {
        declaration: {
            name: 'crop_image',
            description,
            category: 'media',
            dependencies: ['sharp'],  // 声明依赖 sharp
            parameters: {
                type: 'object',
                properties: {
                    // 批量模式参数
                    images: {
                        type: 'array',
                        description: 'Batch mode: Array of crop tasks. Each task can independently configure input, output and crop coordinates. MUST be an array even for single task.',
                        items: {
                            type: 'object',
                            properties: {
                                image_path: {
                                    type: 'string',
                                    description: 'Source image path (required)'
                                },
                                output_path: {
                                    type: 'string',
                                    description: 'Output file path (required)'
                                },
                                x1: {
                                    type: 'integer',
                                    description: 'Crop region top-left X coordinate (0-1000)'
                                },
                                y1: {
                                    type: 'integer',
                                    description: 'Crop region top-left Y coordinate (0-1000)'
                                },
                                x2: {
                                    type: 'integer',
                                    description: 'Crop region bottom-right X coordinate (0-1000)'
                                },
                                y2: {
                                    type: 'integer',
                                    description: 'Crop region bottom-right Y coordinate (0-1000)'
                                }
                            },
                            required: ['image_path', 'output_path', 'x1', 'y1', 'x2', 'y2']
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
                            ? 'Single mode: Output file path (required). Use "workspace_name/path" format.'
                            : 'Single mode: Output file path (required).'
                    },
                    x1: {
                        type: 'integer',
                        description: useNormalized
                            ? 'Single mode: Crop region top-left X coordinate (0-1000, required)'
                            : 'Single mode: Crop region top-left X coordinate (pixels, required)'
                    },
                    y1: {
                        type: 'integer',
                        description: useNormalized
                            ? 'Single mode: Crop region top-left Y coordinate (0-1000, required)'
                            : 'Single mode: Crop region top-left Y coordinate (pixels, required)'
                    },
                    x2: {
                        type: 'integer',
                        description: useNormalized
                            ? 'Single mode: Crop region bottom-right X coordinate (0-1000, required)'
                            : 'Single mode: Crop region bottom-right X coordinate (pixels, required)'
                    },
                    y2: {
                        type: 'integer',
                        description: useNormalized
                            ? 'Single mode: Crop region bottom-right Y coordinate (0-1000, required)'
                            : 'Single mode: Crop region bottom-right Y coordinate (pixels, required)'
                    }
                }
            }
        },
        handler: withLinkedAbort(async (args, context: ToolContext | undefined, abortController): Promise<ToolResult> => {
            const toolId = context?.toolId || TaskManager.generateTaskId('crop');
            const config = (context?.config || {}) as CropImageConfig;
            
            // 获取工具配置（优先使用上下文配置，其次使用默认配置）
            const options = getCropImageOptions(context);
            // 如果没有上下文配置，使用创建时的默认配置
            const effectiveOptions: CropImageToolOptions = {
                useNormalizedCoordinates: options.useNormalizedCoordinates ?? defaultOptions?.useNormalizedCoordinates ?? true
            };

            const abortSignal = abortController.signal;

            // 检查使用哪种模式
            const imagesArray = args.images as CropTask[] | undefined;
            const singleImagePath = args.image_path as string | undefined;
            const singleOutputPath = args.output_path as string | undefined;
            const singleX1 = args.x1 as number | undefined;
            const singleY1 = args.y1 as number | undefined;
            const singleX2 = args.x2 as number | undefined;
            const singleY2 = args.y2 as number | undefined;

            let tasks: CropTask[] = [];

            if (imagesArray && Array.isArray(imagesArray) && imagesArray.length > 0) {
                // 批量模式
                tasks = imagesArray;
            } else if (singleImagePath && singleOutputPath && 
                       singleX1 !== undefined && singleY1 !== undefined && 
                       singleX2 !== undefined && singleY2 !== undefined) {
                // 单张模式 - 转换为单任务数组
                tasks = [{
                    image_path: singleImagePath,
                    output_path: singleOutputPath,
                    x1: singleX1,
                    y1: singleY1,
                    x2: singleX2,
                    y2: singleY2
                }];
            } else {
                return {
                    success: false,
                    error: 'Please use one of the following:\n1. Single mode: Provide image_path, output_path, x1, y1, x2, y2\n2. Batch mode: Provide images array'
                };
            }

            // 验证任务数量
            if (tasks.length === 0) {
                return { success: false, error: 'No valid crop tasks' };
            }

            if (tasks.length > maxBatchTasks) {
                return { success: false, error: `Maximum ${maxBatchTasks} crop tasks per call (current: ${tasks.length})` };
            }

            // 注册任务
            TaskManager.registerTask(toolId, TASK_TYPE_CROP, abortController, {
                totalTasks: tasks.length
            });

            try {
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

                // 并发执行所有任务
                const results = await Promise.all(
                    tasks.map((task, index) => executeCropTask(task, index, abortSignal, effectiveOptions, context))
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
                        error: 'User cancelled the crop request. Please wait for user\'s next instruction.',
                        cancelled: true
                    };
                }

                // 收集所有多模态数据
                const allMultimodal: MultimodalData[] = [];
                const allPaths: string[] = [];

                for (const result of successResults) {
                    if (result.multimodal) {
                        allMultimodal.push(...result.multimodal);
                    }
                    if (result.outputPath) {
                        allPaths.push(result.outputPath);
                    }
                }

                // 生成报告
                const isBatch = tasks.length > 1;
                let message: string;

                if (failedResults.length === 0 && cancelledResults.length === 0) {
                    // 全部成功
                    if (isBatch) {
                        message = `✅ Batch crop completed: ${successResults.length}/${tasks.length} tasks succeeded\n\nSaved to:\n${allPaths.map(p => `• ${p}`).join('\n')}`;
                    } else {
                        const r = successResults[0];
                        message = `✅ Crop completed!\n\nOriginal: ${r.originalDimensions?.width}×${r.originalDimensions?.height} (${r.originalDimensions?.aspectRatio})\nCropped: ${r.croppedDimensions?.width}×${r.croppedDimensions?.height} (${r.croppedDimensions?.aspectRatio})\n\nOutput: ${allPaths[0]}`;
                    }
                } else if (successResults.length === 0) {
                    // 全部失败
                    const errors = failedResults.map(r => r.error).join('\n');
                    return {
                        success: false,
                        error: isBatch
                            ? `Batch crop failed: All ${tasks.length} tasks failed\n\n${errors}`
                            : failedResults[0]?.error || 'Crop failed'
                    };
                } else {
                    // 部分成功
                    const errors = failedResults.map(r => r.error).join('\n');
                    message = `⚠️ Batch crop partially completed: ${successResults.length}/${tasks.length} succeeded, ${failedResults.length} failed\n\n`;
                    message += `Saved to:\n${allPaths.map(p => `• ${p}`).join('\n')}\n\n`;
                    if (failedResults.length > 0) {
                        message += `Failure reasons:\n${errors}`;
                    }
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
                        paths: allPaths
                    },
                    multimodal: shouldReturnImageToAI && allMultimodal.length > 0 ? allMultimodal : undefined,
                    cancelled: cancelledResults.length > 0
                };

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isCancelled = abortSignal.aborted === true ||
                    errorMessage.includes('cancelled') ||
                    errorMessage.includes('canceled');

                TaskManager.unregisterTask(
                    toolId,
                    isCancelled ? 'cancelled' : 'error',
                    isCancelled ? undefined : { error: errorMessage }
                );

                if (isCancelled) {
                    return {
                        success: false,
                        error: 'User cancelled the crop operation.',
                        cancelled: true
                    };
                }

                return {
                    success: false,
                    error: `Crop failed: ${errorMessage}`
                };
            }
        })
    };
}

/**
 * 注册裁切图片工具（默认配置）
 */
export function registerCropImage(): Tool {
    return createCropImageTool();
}
