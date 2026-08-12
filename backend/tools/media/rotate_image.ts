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
import { resolveFileToolPathWithInfo, getAllWorkspaces, calculateAspectRatio } from '../utils';
import { ensureOutsideWorkspaceAccessApproved } from '../file/outsideWorkspaceAccess';
import { readImageFile } from './imageUtils';
import { TaskManager, type TaskEvent } from '../taskManager';
import { withLinkedAbort } from '../abortLink';
import { getSharp } from '../../modules/dependencies';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { buildRotateImageDescriptions } from '../localization/dynamicDescriptions';

/** 旋转任务类型常量 */
const TASK_TYPE_ROTATE = 'rotate_image';

/**
 * 旋转输出像素数上限（约 50MP，如 10000×5000）：任意角度旋转的最小包围矩形
 * 可能远大于原图（45° 时约放大 2 倍），输出无上限时超大图会分配数百 MB 缓冲。
 */
const MAX_ROTATE_OUTPUT_PIXELS = 50 * 1024 * 1024;

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
    abortSignal?: AbortSignal,
    context?: ToolContext
): Promise<TaskResult> {
    const { image_path, output_path, angle, format } = task;

    // 验证参数
    if (!image_path) {
        return { index, success: false, error: `Task ${index + 1}: image_path is required` };
    }

    if (!output_path) {
        return { index, success: false, error: `Task ${index + 1}: output_path is required` };
    }

    // angle 校验：仅接受有限数值（isNaN 不拦截 Infinity，Infinity 角度会让 sharp 行为异常）
    if (angle === undefined || angle === null || typeof angle !== 'number' || !Number.isFinite(angle)) {
        return { index, success: false, error: `Task ${index + 1}: angle is required and must be a finite number` };
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

        // 获取输出格式信息
        const outputFormat = getOutputFormat(output_path, format, imageFile.ext);

        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled the rotate operation`, cancelled: true };
        }

        // 输出像素数预检（在 .rotate() 执行前）：用旋转包围矩形公式估算旋转后画布尺寸
        // （w' = |w·cosθ| + |h·sinθ|，h' = |w·sinθ| + |h·cosθ|，与 sharp 自动扩边的
        // 最小包围矩形一致；cos/sin 的周期性天然覆盖任意角度与正负号，无需归一化）。
        // 超限时在分配输出缓冲（超大图可达数百 MB）之前直接返回可读错误，避免先旋转再拒绝。
        const angleRad = (angle * Math.PI) / 180;
        const estimatedRotatedWidth = Math.ceil(
            originalWidth * Math.abs(Math.cos(angleRad)) + originalHeight * Math.abs(Math.sin(angleRad))
        );
        const estimatedRotatedHeight = Math.ceil(
            originalWidth * Math.abs(Math.sin(angleRad)) + originalHeight * Math.abs(Math.cos(angleRad))
        );
        if (estimatedRotatedWidth * estimatedRotatedHeight > MAX_ROTATE_OUTPUT_PIXELS) {
            return {
                index,
                success: false,
                error: `Task ${index + 1}: Rotated image would be too large (estimated ${estimatedRotatedWidth}x${estimatedRotatedHeight} = ${estimatedRotatedWidth * estimatedRotatedHeight} pixels, limit ${MAX_ROTATE_OUTPUT_PIXELS.toLocaleString()} ≈ 50MP). Resize the image first (e.g. resize_image) before rotating.`
            };
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

        // 输出像素数护栏（兜底）：预检按包围矩形公式估算，sharp 实际输出尺寸可能略有出入，
        // 旋转完成后仍复查一次，超限时给出可读错误并提示先缩放
        if (rotatedWidth * rotatedHeight > MAX_ROTATE_OUTPUT_PIXELS) {
            return {
                index,
                success: false,
                error: `Task ${index + 1}: Rotated image would be too large (${rotatedWidth}x${rotatedHeight} = ${rotatedWidth * rotatedHeight} pixels, limit ${MAX_ROTATE_OUTPUT_PIXELS.toLocaleString()} ≈ 50MP). Resize the image first (e.g. resize_image) before rotating.`
            };
        }

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

        // 确保目录存在
        const dirUri = vscode.Uri.joinPath(outputUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            // 目录可能已存在
        }

        await vscode.workspace.fs.writeFile(outputUri, finalBuffer);

        // 构建多模态数据（任务级判定：仅当 returnImageToAI=true 时构造 base64，默认关闭以节省 token）
        const rotateConfig = (context?.config || {}) as RotateImageConfig;
        const shouldReturnImageToAI = rotateConfig.returnImageToAI === true;
        const multimodal: MultimodalData[] = shouldReturnImageToAI ? [{
            mimeType: outputFormat.mimeType,
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

    // 语言感知说明：根据当前实际界面语言（zh-CN/en/ja）生成模型可见说明。
    // 顶层说明（Limits、多根尾巴）与参数说明统一由
    // localization/dynamicDescriptions 的语言感知生成器负责。
    const lang = resolveLocalizationLanguage(getActualLanguage());
    const descriptions = buildRotateImageDescriptions({
        lang,
        maxBatchTasks,
        isMultiRoot,
        workspaceNames: workspaces.map(w => w.name)
    });

    const description = descriptions.description;

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
                                angle: {
                                    type: 'number',
                                    description: descriptions.batchAngle
                                },
                                format: {
                                    type: 'string',
                                    description: descriptions.batchFormat
                                }
                            },
                            required: ['image_path', 'output_path', 'angle']
                        }
                    },
                    // 单张模式参数
                    image_path: {
                        type: 'string',
                        description: descriptions.singleImagePath
                    },
                    output_path: {
                        type: 'string',
                        description: descriptions.singleOutputPath
                    },
                    angle: {
                        type: 'number',
                        description: descriptions.singleAngle
                    },
                    format: {
                        type: 'string',
                        description: descriptions.singleFormat
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
                    tasks.map((task, index) => executeRotateTask(task, index, abortSignal, context))
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