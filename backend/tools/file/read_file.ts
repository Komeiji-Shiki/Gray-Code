/**
 * 读取文件工具
 *
 * 支持读取单个或多个文件
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult, MultimodalData, MultimodalCapability } from '../types';
import { t } from '../../i18n';
import { Logger } from '../../core/logger';
import {
    resolveUri,
    resolveUriWithInfo,
    getAllWorkspaces,
    isMultimodalSupported,
    getMultimodalMimeType,
    isBinaryFile,
    formatFileSize,
    canReadFile,
    getReadFileError,
    isMultimodalSupportedWithConfig,
    canReadFileWithCapability,
    getReadFileErrorWithCapability,
    isImageFile,
    isPdfFile,
    normalizeLineEndingsToLF,
    mapWithConcurrency,
    // WP13 去重：gcd、calculateAspectRatio、ImageDimensions 原来在 read_file.ts 中重复定义，
    // 现改为从 utils.ts 统一导入。
    gcd,
    calculateAspectRatio,
    type ImageDimensions
} from '../utils';

// 文件大小护栏（与 search_in_files 的 5MB 默认上限一致）：
// 超大文件全量读入并全量塞进模型上下文会导致内存与 token 爆炸。
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;

/** 批量读取并发上限（与 list_files 的行数统计一致，避免一次读大量文件时并发无界） */
const BATCH_READ_CONCURRENCY = 8;

const log = Logger.get('ReadFileTool');

/**
 * 行范围选项
 */
interface LineRange {
    startLine?: number;  // 1-based, 包含，不指定则从第 1 行开始
    endLine?: number;    // 1-based, 包含，不指定则读取到文件末尾
}

/**
 * 文件读取请求（支持单独的行范围）
 */
interface FileReadRequest {
    path: string;
    startLine?: number;
    endLine?: number;
}

interface ResolvedLineRangeArgs {
    startLine?: number;
    endLine?: number;
}

/**
 * read_file 多模态调试信息。
 *
 * 添加原因：用户界面已开启“多模态工具”但运行时仍可能收到 false，单靠错误文案无法定位是哪条链路漏传。
 * 添加方式：仅暴露非敏感字段，例如渠道类型、工具模式、配置开关和最终能力，不输出 API Key 或请求正文。
 * 添加目的：让失败结果面板直接展示判断依据，便于确认问题出在设置保存、配置传递还是工具能力计算。
 */
interface ReadFileDebugInfo {
    source: string;
    pathKind: 'image' | 'pdf' | 'binary' | 'text';
    handlerMultimodalEnabled: boolean;
    handlerCapability: MultimodalCapability;
    contextKeys: string[];
    upstream?: Record<string, unknown>;
}

/**
 * 单个文件读取结果
 */
interface ReadResult {
    path: string;
    workspace?: string;
    success: boolean;
    type?: 'text' | 'multimodal' | 'binary';
    content?: string;
    lineCount?: number;      // 返回的行数（如果指定了范围）或总行数
    totalLines?: number;     // 文件总行数（仅在指定范围时返回）
    startLine?: number;      // 实际读取的起始行（仅在指定范围时返回）
    endLine?: number;        // 实际读取的结束行（仅在指定范围时返回）
    mimeType?: string;
    size?: number;
    dimensions?: ImageDimensions;  // 图片尺寸信息
    error?: string;
    debug?: ReadFileDebugInfo;
}

/**
 * 从图片数据解析尺寸
 * 支持 PNG, JPEG, WebP, GIF
 */
function parseImageDimensions(buffer: Uint8Array, mimeType: string): ImageDimensions | undefined {
    try {
        let width: number | undefined;
        let height: number | undefined;
        
        if (mimeType === 'image/png') {
            // PNG: 宽度在偏移 16-19，高度在 20-23（大端序）
            if (buffer.length >= 24 &&
                buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
                width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
                height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
            }
        } else if (mimeType === 'image/jpeg') {
            // JPEG: 需要查找 SOF0/SOF2 标记
            let offset = 2;  // 跳过 FFD8
            while (offset < buffer.length - 9) {
                if (buffer[offset] !== 0xFF) {
                    offset++;
                    continue;
                }
                const marker = buffer[offset + 1];
                // SOF0 (0xC0) 或 SOF2 (0xC2) 标记包含尺寸
                if (marker === 0xC0 || marker === 0xC2) {
                    height = (buffer[offset + 5] << 8) | buffer[offset + 6];
                    width = (buffer[offset + 7] << 8) | buffer[offset + 8];
                    break;
                }
                // 跳到下一个标记
                const length = (buffer[offset + 2] << 8) | buffer[offset + 3];
                offset += 2 + length;
            }
        } else if (mimeType === 'image/webp') {
            // WebP: 检查 RIFF 头和 VP8/VP8L/VP8X 块
            if (buffer.length >= 30 &&
                buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
                buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
                // VP8X (扩展格式)
                if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x58) {
                    width = ((buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1);
                    height = ((buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1);
                }
                // VP8L (无损格式)
                else if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4C) {
                    const signature = buffer[21];
                    if (signature === 0x2F) {
                        const bits = (buffer[22] | (buffer[23] << 8) | (buffer[24] << 16) | (buffer[25] << 24));
                        width = (bits & 0x3FFF) + 1;
                        height = ((bits >> 14) & 0x3FFF) + 1;
                    }
                }
                // VP8 (有损格式)
                else if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) {
                    // VP8 格式需要查找帧头
                    if (buffer.length >= 30) {
                        // 帧头在偏移 23 开始
                        width = (buffer[26] | (buffer[27] << 8)) & 0x3FFF;
                        height = (buffer[28] | (buffer[29] << 8)) & 0x3FFF;
                    }
                }
            }
        } else if (mimeType === 'image/gif') {
            // GIF: 宽度在偏移 6-7，高度在 8-9（小端序）
            if (buffer.length >= 10 &&
                buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
                width = buffer[6] | (buffer[7] << 8);
                height = buffer[8] | (buffer[9] << 8);
            }
        }
        
        if (width && height && width > 0 && height > 0) {
            return {
                width,
                height,
                aspectRatio: calculateAspectRatio(width, height)
            };
        }
    } catch (e) {
        // 解析失败，返回 undefined
    }
    return undefined;
}

function normalizeLineNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? value
        : undefined;
}

function resolveLineRangeArgs(args: Record<string, unknown>): ResolvedLineRangeArgs {
    // 修改原因：模型经常按其他文件读取工具的习惯传 line/maxLines/limit，而 read_file 原本只接受 startLine/endLine，会被 strict schema 直接拒绝。
    // 修改方式：保留 startLine/endLine 作为规范字段，同时把 line/maxLine/maxLines/limit 收敛为同一个 LineRange 语义。
    // 修改目的：提高工具调用容错率，并让“读取第 N 行”或“读取最多 N 行”的自然表达无需失败后重试。
    const explicitStartLine = normalizeLineNumber(args.startLine);
    const explicitEndLine = normalizeLineNumber(args.endLine);
    const aliasLine = normalizeLineNumber(args.line);
    const aliasMaxLine = normalizeLineNumber(args.maxLine);
    const maxLines = normalizeLineNumber(args.maxLines) ?? normalizeLineNumber(args.limit);

    let startLine = explicitStartLine ?? aliasLine;
    let endLine = explicitEndLine ?? aliasMaxLine;

    if (endLine === undefined && maxLines !== undefined) {
        const baseLine = startLine ?? 1;
        startLine = baseLine;
        endLine = baseLine + maxLines - 1;
    } else if (explicitStartLine === undefined && explicitEndLine === undefined && aliasLine !== undefined && aliasMaxLine === undefined) {
        // 修改原因：单独的 line 更接近“读取这一行”，而不是 startLine 的“从这一行读到文件末尾”。
        // 修改方式：只有在没有 maxLines/maxLine/endLine 时，把 line=N 解释为 N..N。
        // 修改目的：让模型或用户表达“line: 42”时得到最符合直觉的单行结果。
        endLine = aliasLine;
    }

    return { startLine, endLine };
}

function getPathKind(filePath: string): ReadFileDebugInfo['pathKind'] {
    if (isImageFile(filePath)) return 'image';
    if (isPdfFile(filePath)) return 'pdf';
    if (isBinaryFile(filePath)) return 'binary';
    return 'text';
}

/**
 * 读取单个文件
 *
 * @param filePath 文件路径
 * @param capability 多模态能力
 * @param isMultiRoot 是否是多工作区模式
 * @param lineRange 行范围（可选）
 */
async function readSingleFile(
    filePath: string,
    capability: MultimodalCapability,
    multimodalEnabled: boolean,
    isMultiRoot: boolean,
    lineRange?: LineRange,
    debug?: ReadFileDebugInfo
): Promise<{
    result: ReadResult;
    multimodal?: MultimodalData[];
}> {
    const { uri, workspace, error } = resolveUriWithInfo(filePath);
    if (!uri) {
        return {
            result: {
                path: filePath,
                success: false,
                error: error || 'No workspace folder open'
            }
        };
    }

    // 检查是否允许读取此文件
    if (!canReadFileWithCapability(filePath, capability)) {
        const readError = getReadFileErrorWithCapability(filePath, multimodalEnabled, capability);
        // 调试原因：这里是“多模态工具未启用”错误的最终出口，需要把判定快照写入日志和工具结果。
        // 调试方式：日志用于 OutputChannel/控制台，result.debug 用于前端 read_file 面板。
        // 调试目的：用户无需复现到调试器，也能看到 resolvedMultimodalEnabled、capability 和上游 config 是否一致。
        log.warn('read_file.rejected_by_multimodal_capability', {
            path: filePath,
            error: readError,
            debug
        });
        return {
            result: {
                path: filePath,
                workspace: isMultiRoot ? workspace?.name : undefined,
                success: false,
                error: readError || t('tools.file.readFile.cannotReadFile'),
                debug
            }
        };
    }

    try {
        // 文件大小护栏：超大文件拒绝全量读取（对比 search_in_files 有 5MB 上限、
        // list_files 有 4MB 上限，read_file 之前无任何护栏）。
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_READ_FILE_BYTES) {
            return {
                result: {
                    path: filePath,
                    workspace: isMultiRoot ? workspace?.name : undefined,
                    success: false,
                    error: `File is too large (${formatFileSize(stat.size)}, limit ${formatFileSize(MAX_READ_FILE_BYTES)}). Use search_in_files to locate specific content instead of reading the whole file.`
                }
            };
        }

        const content = await vscode.workspace.fs.readFile(uri);
        const fileName = path.basename(filePath);
        
        // 检查是否支持多模态返回
        let shouldReturnMultimodal = false;
        if (isImageFile(filePath) && capability.supportsImages) {
            shouldReturnMultimodal = true;
        } else if (isPdfFile(filePath) && capability.supportsDocuments) {
            shouldReturnMultimodal = true;
        }
        
        if (shouldReturnMultimodal) {
            const mimeType = getMultimodalMimeType(filePath);
            if (mimeType) {
                const base64Data = Buffer.from(content).toString('base64');
                
                // 解析图片尺寸（仅对图片文件）
                let dimensions: ImageDimensions | undefined;
                if (isImageFile(filePath)) {
                    dimensions = parseImageDimensions(content, mimeType);
                }
                
                return {
                    result: {
                        path: filePath,
                        workspace: isMultiRoot ? workspace?.name : undefined,
                        success: true,
                        type: 'multimodal',
                        mimeType,
                        size: content.byteLength,
                        dimensions
                    },
                    multimodal: [{
                        mimeType,
                        data: base64Data,
                        name: fileName
                    }]
                };
            }
        }
        
        // 检查是否是其他二进制文件（不支持多模态返回）
        if (isBinaryFile(filePath)) {
            return {
                result: {
                    path: filePath,
                    workspace: isMultiRoot ? workspace?.name : undefined,
                    success: true,
                    type: 'binary',
                    size: content.byteLength
                }
            };
        }
        
        // 文本文件：返回带行号的内容
        const text = normalizeLineEndingsToLF(new TextDecoder().decode(content));
        const allLines = text.split('\n');
        const totalLines = allLines.length;
        
        // 处理行范围
        let selectedLines: string[];
        let actualStartLine: number | undefined;
        let actualEndLine: number | undefined;
        
        if (lineRange) {
            // 确定起始行：默认从第 1 行开始
            let startLine = lineRange.startLine ?? 1;
            if (startLine < 1) startLine = 1;
            if (startLine > totalLines) {
                return {
                    result: {
                        path: filePath,
                        workspace: isMultiRoot ? workspace?.name : undefined,
                        success: false,
                        totalLines,
                        error: `startLine (${startLine}) exceeds total lines (${totalLines})`
                    }
                };
            }
            
            // 确定结束行：默认读取到文件末尾
            let endLine = lineRange.endLine ?? totalLines;
            if (endLine > totalLines) endLine = totalLines;
            if (endLine < startLine) endLine = startLine;
            
            actualStartLine = startLine;
            actualEndLine = endLine;
            selectedLines = allLines.slice(startLine - 1, endLine);
        } else {
            selectedLines = allLines;
        }
        
        // 添加行号前缀
        const startLineNum = actualStartLine ?? 1;
        const numberedLines = selectedLines.map((line, index) => {
            const lineNum = startLineNum + index;
            return `${lineNum.toString().padStart(4)} | ${line}`;
        });
        
        // 构建返回结果
        const result: ReadResult = {
            path: filePath,
            workspace: isMultiRoot ? workspace?.name : undefined,
            success: true,
            type: 'text',
            content: numberedLines.join('\n'),
            lineCount: selectedLines.length
        };
        
        // 如果指定了行范围，添加额外信息
        if (lineRange) {
            result.totalLines = totalLines;
            result.startLine = actualStartLine;
            result.endLine = actualEndLine;
        }
        
        return { result };
    } catch (error) {
        return {
            result: {
                path: filePath,
                workspace: isMultiRoot ? workspace?.name : undefined,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            }
        };
    }
}

/**
 * 创建读取文件工具
 *
 * @param multimodalEnabled 是否启用多模态工具（可选，用于生成不同的工具声明）
 * @param channelType 渠道类型（可选）
 * @param toolMode 工具模式（可选）
 */
export function createReadFileTool(
    multimodalEnabled?: boolean,
    channelType?: 'gemini' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
    toolMode?: 'function_call' | 'xml' | 'json'
): Tool {
    // 获取工作区信息
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    // 根据多模态配置和渠道类型生成不同的工具描述
    let description: string;
    
    // 行号格式说明
    const lineNumberNote = '\n\n说明：读取文本文件时，返回内容会带行号前缀（例如 "   1 | code here"）。这些数字和 "|" 只是定位标记，不属于文件正文；编辑文件时不要把它们写回去。';
    
    // 行范围说明。
    // 单文件兼容别名（line/maxLine/maxLines/limit）不再写进描述和 schema 向模型宣传：
    // 每轮请求都会携带工具声明，别名参数既烧 token 又鼓励旧写法。
    // 它们仍通过 declaration 的 paramAliases/compatParams 被接受（见下方声明）。
    const lineRangeNote = '\n\n行范围：单文件读取时使用顶层 startLine/endLine；批量读取时在每个 files[] 项中分别设置 startLine/endLine。只有已经知道准确行号时才填写（例如来自 get_symbols、goto_definition、find_references、list_files、find_files 或之前 read_file 的结果）。不要猜行号；不确定时不要填写行范围，先读取完整文件或使用搜索工具定位。';

    // 多模态/二进制行范围限制说明（多模态开启时强调）
    const lineRangeBinaryRestrictionNote =
        '\n\n重要：startLine/endLine 只适用于文本文件。读取图片、PDF、音频、视频或其他二进制/多模态文件时无需填写行范围；即使误填，工具也会忽略这些行范围参数。';
    
    if (!multimodalEnabled) {
        // 未启用多模态时，只支持文本文件
        description = '读取工作区中的一个或多个文件。当前支持类型：文本文件。' + lineNumberNote + lineRangeNote;
    } else if (channelType === 'openai') {
        // OpenAI 格式有特殊限制
        if (toolMode === 'function_call') {
            // OpenAI function_call 模式不支持多模态
            description = '读取工作区中的一个或多个文件。当前支持类型：文本文件。' + lineNumberNote + lineRangeNote;
        } else {
            // OpenAI xml/json 模式只支持图片
            description = '读取工作区中的一个或多个文件。当前支持类型：文本文件、图片（PNG/JPEG/WebP）。图片会作为多模态数据返回。' + lineNumberNote + lineRangeNote + lineRangeBinaryRestrictionNote;
        }
    } else {
        // Gemini 和 Anthropic 全面支持
        description = '读取工作区中的一个或多个文件。当前支持类型：文本文件、图片（PNG/JPEG/WebP）、文档（PDF）。图片和文档会作为多模态数据返回。' + lineNumberNote + lineRangeNote + lineRangeBinaryRestrictionNote;
    }
    
    // 多工作区说明
    if (isMultiRoot) {
        description += '\n\n多根工作区：path 与 files[].path 必须使用 "workspace_name/path" 格式来指定工作区。';
    }
    
    // 路径参数描述
    let pathDescription = '单文件读取时使用。要读取的文件路径，相对于当前工作区根目录。例如：src/main.ts。';
    if (isMultiRoot) {
        pathDescription = `单文件读取时使用。当前是多根工作区，必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`;
    }
    const batchPathDescription = isMultiRoot
        ? `批量读取的文件路径。必须使用 "workspace_name/path" 格式。可用工作区：${workspaces.map(w => w.name).join(', ')}。`
        : '批量读取的文件路径，相对于当前工作区根目录。例如：src/main.ts。';
    
    return {
        declaration: {
            name: 'read_file',
            readOnly: true,
            strict: true,  // API 端强制 schema 校验
            description,
            category: 'file',
            // maxLine 与 endLine 完全等价 → 纯改名别名
            paramAliases: { maxLine: 'endLine' },
            // line / maxLines / limit 需要组合计算语义（见 resolveLineRangeArgs），
            // 不剥离、由 handler 解释
            compatParams: ['line', 'maxLines', 'limit'],
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: pathDescription
                    },
                    files: {
                        type: 'array',
                        description: '批量读取时使用。每个文件可以分别指定文本行范围；不要与顶层 path/startLine/endLine 同时使用。',
                        items: {
                            type: 'object',
                            properties: {
                                path: {
                                    type: 'string',
                                    description: batchPathDescription
                                },
                                startLine: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '该文本文件的起始行号，1-based，包含该行。非文本文件会忽略。'
                                },
                                endLine: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '该文本文件的结束行号，1-based，包含该行。非文本文件会忽略。'
                                }
                            },
                            required: ['path']
                        }
                    },
                    startLine: {
                        type: 'integer',
                        minimum: 1,
                        description: '起始行号，1-based，包含该行。仅文本文件可用。读取图片/PDF 等非文本文件时会被忽略。指定后从该行读取到文件末尾，或读取到 endLine。'
                    },
                    endLine: {
                        type: 'integer',
                        minimum: 1,
                        description: '结束行号，1-based，包含该行。仅文本文件可用。读取图片/PDF 等非文本文件时会被忽略。未指定 startLine 时，从文件开头读取到该行。'
                    }
                }
            }
        },
        handler: async (args, context): Promise<ToolResult> => {
            // 从 context 中获取多模态能力
            const multimodalEnabled = context?.multimodalEnabled === true;
            const capability = context?.capability as MultimodalCapability ?? {
                supportsImages: false,
                supportsDocuments: false,
                supportsHistoryMultimodal: false
            };
            
            // 获取工作区信息
            const workspaces = getAllWorkspaces();
            const isMultiRoot = workspaces.length > 1;
            
            // 调试上下文与文件无关的部分在循环外预计算（避免批量读取时每文件重建）
            const debugContextKeys = Object.keys(context ?? {}).sort();
            const upstreamDebug = typeof context?.multimodalDebug === 'object' && context.multimodalDebug !== null
                ? context.multimodalDebug as Record<string, unknown>
                : undefined;
            
            const hasSinglePath = typeof args.path === 'string' && args.path.trim() !== '';
            const batchFiles = Array.isArray(args.files) ? args.files : undefined;
            // 某些 function-calling 客户端会把未提供的可选数组补成 []。当 path 有值时，
            // 空 files 应视为“未提供批量参数”，不能误判成单双模式冲突。
            const hasBatchFiles = !!batchFiles && batchFiles.length > 0;

            if (hasSinglePath && hasBatchFiles) {
                return { success: false, error: 'Provide either path or files, not both.' };
            }
            if (!hasSinglePath && batchFiles?.length === 0) {
                return { success: false, error: 'files must contain at least one file request.' };
            }
            if (!hasSinglePath && !hasBatchFiles) {
                return { success: false, error: 'Either path or files is required.' };
            }

            let fileRequests: FileReadRequest[];
            if (hasBatchFiles) {
                fileRequests = (batchFiles as Array<Record<string, unknown>>).map(file => ({
                    path: typeof file.path === 'string' ? file.path : '',
                    ...resolveLineRangeArgs(file)
                }));
            } else {
                const resolvedLineRange = resolveLineRangeArgs(args);
                fileRequests = [{
                    path: args.path as string,
                    startLine: resolvedLineRange.startLine,
                    endLine: resolvedLineRange.endLine
                }];
            }

            const invalidRequestIndex = fileRequests.findIndex(file => file.path.trim() === '');
            if (invalidRequestIndex !== -1) {
                return { success: false, error: `files[${invalidRequestIndex}].path is required` };
            }

            const results: ReadResult[] = [];
            const allMultimodal: MultimodalData[] = [];
            let successCount = 0;
            let failCount = 0;

            // 批量读取受控并发：替代逐文件串行 await（批量读大量文件时串行耗时线性增长）
            // mapWithConcurrency 保持输入顺序，聚合结果与 fileRequests 一一对应
            const batchOutcomes = await mapWithConcurrency(fileRequests, BATCH_READ_CONCURRENCY, async (fileReq) => {
                // 行范围只对文本文件有意义；非文本/多模态文件即使误传也忽略。
                let lineRange: LineRange | undefined;
                if (!isBinaryFile(fileReq.path) && (fileReq.startLine !== undefined || fileReq.endLine !== undefined)) {
                    lineRange = {
                        startLine: fileReq.startLine,
                        endLine: fileReq.endLine
                    };
                }

                const debug: ReadFileDebugInfo = {
                    source: 'read_file.handler',
                    pathKind: getPathKind(fileReq.path),
                    handlerMultimodalEnabled: multimodalEnabled,
                    handlerCapability: capability,
                    contextKeys: debugContextKeys,
                    upstream: upstreamDebug
                };
                return readSingleFile(
                    fileReq.path,
                    capability,
                    multimodalEnabled,
                    isMultiRoot,
                    lineRange,
                    debug
                );
            });

            for (const { result, multimodal } of batchOutcomes) {
                results.push(result);

                if (result.success) {
                    successCount++;
                    if (multimodal) {
                        allMultimodal.push(...multimodal);
                    }
                } else {
                    failCount++;
                }
            }

            const allSuccess = failCount === 0;
            return {
                success: allSuccess,
                data: {
                    results,
                    successCount,
                    failCount,
                    totalCount: fileRequests.length,
                    multiRoot: isMultiRoot
                },
                multimodal: allMultimodal.length > 0 ? allMultimodal : undefined,
                error: allSuccess ? undefined : `${failCount} file${failCount === 1 ? '' : 's'} failed to read`
            };
        }
    };
}

/**
 * 注册读取文件工具
 */
export function registerReadFile(): Tool {
    return createReadFileTool();
}