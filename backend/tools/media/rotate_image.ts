/**
 * 旋转图片工具
 *
 * 将图片顺时针旋转指定角度：
 * - 支持任意角度（正数、负数、超过360度）
 * - 正角度表示顺时针旋转
 * - 负角度表示逆时针旋转
 * - 自动计算最小包围矩形画布
 * - PNG/WebP 填充透明背景
 * - JPG 填充黑色背景
 * - 使用 sharp 进行旋转
 * - 返回旋转后的图片
 *
 * 支持单张和批量两种模式
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolResult, MultimodalData, ToolContext } from '../types';
import { resolveUri, getAllWorkspaces, calculateAspectRatio } from '../utils';
import { TaskManager, type TaskEvent } from '../taskManager';
import { withLinkedAbort } from '../abortLink';
import { getSharp } from '../../modules/dependencies';

/** 旋转任务类型常量 */
const TASK_TYPE_ROTATE = 'rotate_image';

/**
 * 旋转图片工具配置（从 context.config 获取）
 */
interface RotateImageConfig {
    /** 是否将图片返回给 AI */
    returnImageToAI?: boolean;
}

/**
 * 旋转输出事件类型
 */
export interface RotateImageOutputEvent {
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
 * 订阅旋转输出
 */
export function onRotateImageOutput(listener: (event: RotateImageOutputEvent) => void): () => void {
    return TaskManager.onTaskEventByType(TASK_TYPE_ROTATE, (taskEvent: TaskEvent) => {
        const event: RotateImageOutputEvent = {
            toolId: taskEvent.taskId,
            type: taskEvent.type as RotateImageOutputEvent['type'],
            data: taskEvent.data as RotateImageOutputEvent['data'],
            error: taskEvent.error
        };
        listener(event);
    });
}

/**
 * 取消旋转任务
 */
export function cancelRotateImage(toolId: string): { success: boolean; error?: string } {
    return TaskManager.cancelTask(toolId);
}

/**
 * 单个旋转任务
 */
interface RotateTask {
    /** 原始图片路径 */
    image_path: string;
    /** 输出文件路径 */
    output_path: string;
    /** 旋转角度（顺时针，正数；逆时针，负数） */
    angle: number;
    /** 输出格式（可选：png, jpg, jpeg, webp） */
    format?: string;
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
    rotatedDimensions?: { width: number; height: number; aspectRatio: string };
    angle?: number;
    multimodal?: MultimodalData[];
    cancelled?: boolean;
}

/**
 * 读取图片文件
 */
async function readImageFile(imagePath: string): Promise<{ data: Buffer; mimeType: string; ext: string } | null> {
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
        } else if (ext === '.gif') {
            mimeType = 'image/gif';
        }

        return {
            data: Buffer.from(content),
            mimeType,
            ext
        };
    } catch (error) {
        return null;
    }
}

/**
 * 获取输出格式信息
 */
function getOutputFormat(outputPath: string, specifiedFormat?: string, originalExt?: string): {
    ext: string;
    mimeType: string;
    background: { r: number; g: number; b: number; alpha: number };
} {
    // 优先使用指定的格式，否则从输出路径获取，最后使用原始格式
    let ext: string;
    if (specifiedFormat) {
        ext = specifiedFormat.toLowerCase();
        if (!ext.startsWith('.')) {
            ext = '.' + ext;
        }
    } else {
        ext = path.extname(outputPath).toLowerCase();
        if (!ext && originalExt) {
            ext = originalExt;
        }
    }

    // 标准化格式
    if (ext === '.jpeg') ext = '.jpg';

    // 确定 MIME 类型和背景色
    let mimeType: string;
    let background: { r: number; g: number; b: number; alpha: number };

    if (ext === '.jpg') {
        mimeType = 'image/jpeg';
        // JPEG 不支持透明，填充黑色
        background = { r: 0, g: 0, b: 0, alpha: 1 };
    } else if (ext === '.webp') {
        mimeType = 'image/webp';
        // WebP 支持透明
        background = { r: 0, g: 0, b: 0, alpha: 0 };
    } else {
        // 默认 PNG
        ext = '.png';
        mimeType = 'image/png';
        // PNG 支持透明
        background = { r: 0, g: 0, b: 0, alpha: 0 };
    }

    return { ext, mimeType, background };
}

/**
 * 执行单个旋转任务
 */
async function executeRotateTask(
    task: RotateTask,
    index: number,
    abortSignal?: AbortSignal
): Promise<TaskResult> {
    const { image_path, output_path, angle, format } = task;

    // 验证参数
    if (!image_path) {
        return { index, success: false, error: `Task ${index + 1}: image_path is required` };
    }

    if (!output_path) {
        return { index, success: false, error: `Task ${index + 1}: output_path is required` };
    }

    if (angle === undefined || angle === null || isNaN(angle)) {
        return { index, success: false, error: `Task ${index + 1}: angle is required and must be a valid number` };
    }

    try {
        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled the rotate operation`, cancelled: true };
        }

        // 获取 sharp
        const sharp = await getSharp();
        
        if (!sharp) {
            return { index, success: false, error: `Task ${index + 1}: sharp library not installed, please install in Settings -> Extension Dependencies` };
        }

        // 读取原图
        const imageFile = await readImageFile(image_path);
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

        // 获取输出格式信息
        const outputFormat = getOutputFormat(output_path, format, imageFile.ext);

        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled the rotate operation`, cancelled: true };
        }

        // sharp 的 rotate 是顺时针的，我们的 API 也使用顺时针
        // sharp 会自动计算最小包围矩形
        const rotatedBuffer = await sharp(imageFile.data)
            .rotate(angle, {
                background: outputFormat.background
            })
            .toBuffer();

        // 获取旋转后的尺寸
        const rotatedMetadata = await sharp(rotatedBuffer).metadata();
        const rotatedWidth = rotatedMetadata.width || originalWidth;
        const rotatedHeight = rotatedMetadata.height || originalHeight;

        // 转换为目标格式
        let finalBuffer: Buffer;

        if (outputFormat.ext === '.jpg') {
            finalBuffer = await sharp(rotatedBuffer).jpeg({ quality: 90 }).toBuffer();
        } else if (outputFormat.ext === '.webp') {
            finalBuffer = await sharp(rotatedBuffer).webp({ quality: 90 }).toBuffer();
        } else {
            finalBuffer = await sharp(rotatedBuffer).png().toBuffer();
        }

        // 保存结果
        const outputUri = resolveUri(output_path);
        if (!outputUri) {
            return { index, success: false, error: `Task ${index + 1}: Cannot resolve output path` };
        }

        // 确保目录存在
        const dirUri = vscode.Uri.joinPath(outputUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            // 目录可能已存在
        }

        await vscode.workspace.fs.writeFile(outputUri, finalBuffer);

        // 构建多模态数据
        const multimodal: MultimodalData[] = [{
            mimeType: outputFormat.mimeType,
            data: finalBuffer.toString('base64'),
            name: path.basename(output_path)
        }];

        return {
            index,
            success: true,
            outputPath: output_path,
            originalDimensions: {
                width: originalWidth,
                height: originalHeight,
                aspectRatio: calculateAspectRatio(originalWidth, originalHeight)
            },
            rotatedDimensions: {
                width: rotatedWidth,
                height: rotatedHeight,
                aspectRatio: calculateAspectRatio(rotatedWidth, rotatedHeight)
            },
            angle,
            multimodal
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : '';
        
        const isCancelled = abortSignal?.aborted ||
            errorName === 'AbortError' ||
            errorMessage.includes('aborted') ||
            errorMessage.includes('cancelled');
        
        return {
            index,
            success: false,
            error: isCancelled
                ? `Task ${index + 1}: User cancelled the rotate operation`
                : `Task ${index + 1}: ${errorMessage}`,
            cancelled: isCancelled
        };
    }
}

/**
 * 创建旋转图片工具
 *
 * @param maxBatchTasks 单次调用允许的最大任务数
 */
export function createRotateImageTool(maxBatchTasks: number = 10): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;

    let description = `Rotate image tool. Rotates images clockwise to specified angle.

**Features**:
- Supports any rotation angle (positive, negative, over 360 degrees)
- Positive angles rotate clockwise
- Negative angles rotate counter-clockwise
- Automatically calculates minimum bounding rectangle canvas

**Background Fill**:
- PNG/WebP: Transparent background
- JPEG: Black background

**Parameters**:
- angle: Rotation angle (required, positive for clockwise)
- image_path: Source image path (required)
- output_path: Output file path (required)
- format: Output format (optional: png, jpg, webp. If not specified, uses original format or infers from output path)

**Examples**:
- Rotate 90° clockwise: angle=90
- Rotate 45° counter-clockwise: angle=-45
- Rotate 180° (flip): angle=180

**Supported Formats**: PNG, JPEG, WebP (selected based on format parameter or output path extension)

**Limits**:
- Maximum ${maxBatchTasks} rotate tasks per call`;

    if (isMultiRoot) {
        description += `\n\n**Multi-root Workspace**: Use "workspace_name/path" format for paths. Available workspaces: ${workspaces.map(w => w.name).join(', ')}`;
    }

    return {
        declaration: {
            name: 'rotate_image',
            description,
            category: 'media',
            dependencies: ['sharp'],
            parameters: {
                type: 'object',
                properties: {
                    // 批量模式参数
                    images: {
                        type: 'array',
                        description: 'Batch mode: Rotate task array. Each task can independently configure input, output, angle, and format. MUST be an array even for single task.',
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
                                angle: {
                                    type: 'number',
                                    description: 'Rotation angle (required, positive for clockwise, any value)'
                                },
                                format: {
                                    type: 'string',
                                    description: 'Output format (optional: png, jpg, webp)'
                                }
                            },
                            required: ['image_path', 'output_path', 'angle']
                        }
                    },
                    // 单张模式参数
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
                    angle: {
                        type: 'number',
                        description: 'Single mode: Rotation angle (required, positive for clockwise, any value)'
                    },
                    format: {
                        type: 'string',
                        description: 'Single mode: Output format (optional: png, jpg, webp)'
                    }
                }
            }
        },
        handler: withLinkedAbort(async (args, context: ToolContext | undefined, abortController): Promise<ToolResult> => {
            const toolId = context?.toolId || TaskManager.generateTaskId('rotate');
            const config = (context?.config || {}) as RotateImageConfig;

            const abortSignal = abortController.signal;

            // 检查使用哪种模式
            const imagesArray = args.images as RotateTask[] | undefined;
            const singleImagePath = args.image_path as string | undefined;
            const singleOutputPath = args.output_path as string | undefined;
            const singleAngle = args.angle as number | undefined;
            const singleFormat = args.format as string | undefined;

            let tasks: RotateTask[] = [];

            if (imagesArray && Array.isArray(imagesArray) && imagesArray.length > 0) {
                // 批量模式
                tasks = imagesArray;
            } else if (singleImagePath && singleOutputPath && singleAngle !== undefined) {
                // 单张模式 - 转换为单任务数组
                tasks = [{
                    image_path: singleImagePath,
                    output_path: singleOutputPath,
                    angle: singleAngle,
                    format: singleFormat
                }];
            } else {
                return {
                    success: false,
                    error: 'Please use one of the following:\n1. Single mode: Provide image_path, output_path, angle\n2. Batch mode: Provide images array'
                };
            }

            // 验证任务数量
            if (tasks.length === 0) {
                return { success: false, error: 'No valid rotate tasks' };
            }

            if (tasks.length > maxBatchTasks) {
                return { success: false, error: `Maximum ${maxBatchTasks} rotate tasks per call (current: ${tasks.length})` };
            }

            // 注册任务
            TaskManager.registerTask(toolId, TASK_TYPE_ROTATE, abortController, {
                totalTasks: tasks.length
            });

            try {
                // 并发执行所有任务
                const results = await Promise.all(
                    tasks.map((task, index) => executeRotateTask(task, index, abortSignal))
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
                        error: 'User cancelled the rotate request. Please wait for user\'s next instruction.',
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
                        message = `✅ Batch rotate completed: ${successResults.length}/${tasks.length} tasks succeeded\n\nSaved to:\n${allPaths.map(p => `• ${p}`).join('\n')}`;
                    } else {
                        const r = successResults[0];
                        const direction = (r.angle || 0) >= 0 ? 'clockwise' : 'counter-clockwise';
                        message = `✅ Rotate completed!\n\nRotation: ${Math.abs(r.angle || 0)}° (${direction})\nOriginal: ${r.originalDimensions?.width}×${r.originalDimensions?.height} (${r.originalDimensions?.aspectRatio})\nRotated: ${r.rotatedDimensions?.width}×${r.rotatedDimensions?.height} (${r.rotatedDimensions?.aspectRatio})\n\nOutput: ${allPaths[0]}`;
                    }
                } else if (successResults.length === 0) {
                    // 全部失败
                    const errors = failedResults.map(r => r.error).join('\n');
                    return {
                        success: false,
                        error: isBatch
                            ? `Batch rotate failed: All ${tasks.length} tasks failed\n\n${errors}`
                            : failedResults[0]?.error || 'Rotate failed'
                    };
                } else {
                    // 部分成功
                    const errors = failedResults.map(r => r.error).join('\n');
                    message = `⚠️ Batch rotate partially completed: ${successResults.length}/${tasks.length} succeeded, ${failedResults.length} failed\n\n`;
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
                        error: 'User cancelled the rotate operation.',
                        cancelled: true
                    };
                }

                return {
                    success: false,
                    error: `Rotate failed: ${errorMessage}`
                };
            }
        })
    };
}

/**
 * 注册旋转图片工具（默认配置）
 */
export function registerRotateImage(): Tool {
    return createRotateImageTool();
}