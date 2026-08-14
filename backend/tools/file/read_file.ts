/**
 * 读取文件工具
 *
 * 支持读取单个或多个文件
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult, MultimodalData, MultimodalCapability } from '../types';
import { parseArgs } from '../types';
import { t, getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import { buildReadFileDescriptions } from '../localization/dynamicDescriptions';
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
    // WP13 去重：calculateAspectRatio、ImageDimensions 原来在 read_file.ts 中重复定义，
    // 现改为从 utils.ts 统一导入（gcd 仅被已删除的本地 parseImageDimensions 使用，不再导入）。
    calculateAspectRatio,
    type ImageDimensions
} from '../utils';
// 修改原因：read_file 本地副本的 parseImageDimensions 与 media/imageUtils 重复实现且行为漂移
// （JPEG SOF 覆盖、WebP VP8L 位解析不一致），统一复用 imageUtils 实现，删除本地副本。
import { parseImageDimensions as parseImageDimensionsFromImageUtils } from '../media/imageUtils';
import { ensureOutsideWorkspaceAccessApproved } from './outsideWorkspaceAccess';

// 文件大小护栏（与 search_in_files 的 5MB 默认上限一致）已统一收敛到 shared/fileSizeGuards
import { MAX_READ_FILE_BYTES } from '../shared/fileSizeGuards';

/** 批量读取并发上限（与 list_files 的行数统计一致，避免一次读大量文件时并发无界） */
const BATCH_READ_CONCURRENCY = 8;

/**
 * 批量 files 条数上限（发现 16）：超出截断并在结果中置 truncated。
 * 与 get_symbols 的 MAX_SYMBOL_PATHS = 20 同口径——单文件 5MB 护栏挡不住
 * 批量路径的累计爆炸（50 张图 × 5MB ≈ 250MB base64 一次性读入内存）。
 */
const MAX_BATCH_FILES = 20;

/**
 * 多模态附件累计字节上限（原始字节，base64 编码前）：超出后不再追加 inlineData 附件，
 * 并在结果中置 truncated/multimodalTruncated，让模型知道附件被截断。
 */
const MAX_BATCH_MULTIMODAL_BYTES = 24 * 1024 * 1024;

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
 * 批量读取的单个文件条目（对应 schema 的 files[] 元素）。
 */
interface ReadFileBatchItem {
    path: string;
    startLine?: number;
    endLine?: number;
}

/**
 * read_file 的规范化参数形状（含 compat 透传的行范围别名）。
 */
interface ReadFileArgs {
    path?: string;
    files?: ReadFileBatchItem[];
    startLine?: number;
    endLine?: number;
    // 兼容透传参数（不向模型宣传，由 handler 解释语义）
    line?: number;
    maxLine?: number;
    maxLines?: number;
    limit?: number;
}

/**
 * 行范围参数的公共形状：resolveLineRangeArgs 只关心这些字段，
 * 既接受顶层参数也接受 files[] 条目。
 */
interface ReadFileLineRangeArgs {
    startLine?: unknown;
    endLine?: unknown;
    line?: unknown;
    maxLine?: unknown;
    maxLines?: unknown;
    limit?: unknown;
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

function normalizeLineNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? value
        : undefined;
}

function resolveLineRangeArgs(args: ReadFileLineRangeArgs): ResolvedLineRangeArgs {
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
                    // 复用 imageUtils.parseImageDimensions（返回 { width, height }），
                    // 再补 aspectRatio 以保持 ImageDimensions 形状。
                    // 注意：imageUtils 实现不解析 GIF 尺寸，GIF 图片不再返回 dimensions。
                    const parsed = parseImageDimensionsFromImageUtils(Buffer.from(content), mimeType);
                    if (parsed) {
                        dimensions = {
                            width: parsed.width,
                            height: parsed.height,
                            aspectRatio: calculateAspectRatio(parsed.width, parsed.height)
                        };
                    }
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
        // 修改原因：text.split('\n') 会把结尾换行产生一个尾部空串（如 'a\n' → ['a','']），
        // 该幻影空行被编号成一行且 lineCount 虚增（'a\n' 应只有 1 行）。
        // 修改方式：以换行结尾时先去掉末尾 '\n' 再 split，行数与编辑器/wc 的行数习惯一致。
        const allLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
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
    channelType?: 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses' | 'custom',
    toolMode?: 'function_call' | 'xml' | 'json'
): Tool {
    // 获取工作区信息
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;
    
    // 语言感知说明：根据当前实际界面语言（zh-CN/en/ja）生成模型可见说明。
    // 顶层说明（多模态四分支、行号/行范围说明、多根尾巴）与 path/files 等参数说明
    // 统一由 localization/dynamicDescriptions 的语言感知生成器负责（目录只覆盖参数，
    // 不覆盖动态顶层说明），避免静态文本覆盖掉运行时动态信息。
    const lang = resolveLocalizationLanguage(getActualLanguage());
    const readFileDescriptions = buildReadFileDescriptions({
        lang,
        multimodalEnabled,
        channelType,
        toolMode,
        isMultiRoot,
        workspaceNames: workspaces.map(w => w.name)
    });

    const description = readFileDescriptions.description;
    const pathDescription = readFileDescriptions.path;
    const batchPathDescription = readFileDescriptions.batchPath;
    
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
                        description: readFileDescriptions.files,
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
                                    description: readFileDescriptions.batchStartLine
                                },
                                endLine: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: readFileDescriptions.batchEndLine
                                }
                            },
                            required: ['path']
                        }
                    },
                    startLine: {
                        type: 'integer',
                        minimum: 1,
                        description: readFileDescriptions.startLine
                    },
                    endLine: {
                        type: 'integer',
                        minimum: 1,
                        description: readFileDescriptions.endLine
                    }
                }
            }
        },
        handler: async (args, context): Promise<ToolResult> => {
            // 修改原因：read_file handler 入口缺少工作区外策略兜底（绝对路径可读取工作区外文件）。
            // 修改方式：与其余文件工具一致，入口处调用 ensureOutsideWorkspaceAccessApproved（读策略 deny/ask/allow）。
            const accessError = ensureOutsideWorkspaceAccessApproved('read_file', args, context);
            if (accessError) {
                return { success: false, error: accessError };
            }

            // 上游已 normalizeToolArgs + validateToolArgs 校验，这里仅做编译期类型收窄
            const typed = parseArgs<ReadFileArgs>(args);

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
            
            const hasSinglePath = typeof typed.path === 'string' && typed.path.trim() !== '';
            let batchFiles = Array.isArray(typed.files) ? typed.files : undefined;
            // 某些 function-calling 客户端会把未提供的可选数组补成 []。当 path 有值时，
            // 空 files 应视为“未提供批量参数”，不能误判成单双模式冲突。
            const hasBatchFiles = !!batchFiles && batchFiles.length > 0;

            // 批量条数上限（发现 16）：超出截断并在结果中置 truncated 标记
            const batchFilesTruncated = !!batchFiles && batchFiles.length > MAX_BATCH_FILES;
            if (batchFilesTruncated && batchFiles) {
                batchFiles = batchFiles.slice(0, MAX_BATCH_FILES);
            }

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
            if (hasBatchFiles && batchFiles) {
                fileRequests = batchFiles.map(file => ({
                    path: typeof file.path === 'string' ? file.path : '',
                    ...resolveLineRangeArgs(file)
                }));
            } else {
                const resolvedLineRange = resolveLineRangeArgs(typed);
                fileRequests = [{
                    path: typed.path as string,
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
            let multimodalBytes = 0;
            let multimodalTruncated = false;

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
                        // 多模态附件累计字节上限（发现 16）：条数上限之外再加累计护栏，
                        // 超限附件不再追加进 inlineData（文本结果仍保留），并标记截断。
                        const size = typeof result.size === 'number' ? result.size : 0;
                        if (multimodalBytes + size > MAX_BATCH_MULTIMODAL_BYTES) {
                            multimodalTruncated = true;
                        } else {
                            multimodalBytes += size;
                            allMultimodal.push(...multimodal);
                        }
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
                    multiRoot: isMultiRoot,
                    // 发现 16：files 超条数上限或多模态附件超累计字节上限时置位
                    truncated: batchFilesTruncated || multimodalTruncated,
                    multimodalTruncated
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