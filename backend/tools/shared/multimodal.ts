// 从 utils.ts 拆分而来（多模态 MIME/类型判断/读权限判定/渠道多模态能力）

import * as path from 'path';
import { t } from '../../i18n';

/**
 * MIME 类型映射（仅限多模态工具调用支持的格式）
 *
 * 支持的类型：
 * - 图片：image/png, image/jpeg, image/webp
 * - 文档：application/pdf, text/plain
 */
/**
 * 支持作为图片读取的扩展名与 MIME 映射（单一来源）。
 *
 * 覆盖常见图片格式：PNG/JPEG/GIF/WebP（多数端点原生支持），以及
 * BMP/TIFF/SVG/ICO/HEIC/HEIF/AVIF（视端点能力，由 DeepSeek Vision 预处理等
 * 下游环节用 sharp 转码为标准格式；无法转码时会返回明确的错误提示）。
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jfif': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.avif': 'image/avif',
};

/** 支持作为图片读取的扩展名集合（供 isImageFile / BINARY_EXTENSIONS 复用） */
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));

const MULTIMODAL_MIME_TYPES: Record<string, string> = {
    ...IMAGE_MIME_TYPES,
    // 文档（仅支持 PDF）
    '.pdf': 'application/pdf',
};

/**
 * 支持多模态返回的文件扩展名（图片和 PDF）
 */
const MULTIMODAL_EXTENSIONS = new Set([
    ...IMAGE_EXTENSIONS,
    '.pdf',                              // 文档
]);

/**
 * 多模态工具支持的 MIME 类型
 */
export const MULTIMODAL_SUPPORTED_TYPES = {
    /** 图片类型 */
    images: Object.values(IMAGE_MIME_TYPES),
    /** 文档类型 */
    documents: ['application/pdf', 'text/plain'],
    /** 所有支持的类型 */
    all: [...Object.values(IMAGE_MIME_TYPES), 'application/pdf', 'text/plain']
};

/**
 * 所有已知的二进制文件扩展名
 */
const BINARY_EXTENSIONS = new Set([
    // 图片（与 IMAGE_EXTENSIONS 保持单一来源，避免列表漂移）
    ...IMAGE_EXTENSIONS,
    // 音频
    '.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac', '.m4a', '.wma',
    // 视频
    '.mp4', '.mov', '.avi', '.wmv', '.webm', '.mkv', '.3gp', '.flv', '.m4v',
    // 文档
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // 其他二进制
    '.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

/**
 * 获取文件的 MIME 类型
 */
export function getMultimodalMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return MULTIMODAL_MIME_TYPES[ext] || null;
}

/**
 * 检查是否支持多模态返回
 */
export function isMultimodalSupported(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return MULTIMODAL_EXTENSIONS.has(ext);
}

/**
 * 检查是否是二进制文件
 */
export function isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/**
 * 检查文件扩展名是否为图片
 */
export function isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 检查文件扩展名是否为 PDF
 */
export function isPdfFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.pdf';
}

/**
 * 检查是否支持多模态返回（根据配置）
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 是否支持多模态返回
 */
export function isMultimodalSupportedWithConfig(filePath: string, multimodalEnabled: boolean): boolean {
    if (!multimodalEnabled) {
        // 禁用多模态时，不返回任何多模态数据
        return false;
    }
    return isMultimodalSupported(filePath);
}

/**
 * 检查文件是否允许读取（根据多模态配置）
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 是否允许读取
 */
export function canReadFile(filePath: string, multimodalEnabled: boolean): boolean {
    // 文本文件总是允许读取
    if (!isBinaryFile(filePath)) {
        return true;
    }
    
    // 二进制文件只有在启用多模态且支持多模态返回时才允许读取
    if (multimodalEnabled && isMultimodalSupported(filePath)) {
        return true;
    }
    
    return false;
}

/**
 * 获取不支持读取的原因
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 错误消息，如果允许读取则返回 null
 */
export function getReadFileError(filePath: string, multimodalEnabled: boolean): string | null {
    if (canReadFile(filePath, multimodalEnabled)) {
        return null;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    
    if (isImageFile(filePath) || isPdfFile(filePath)) {
        return t('multimodal.cannotReadFile', { ext });
    }
    
    return t('multimodal.cannotReadBinaryFile', { ext });
}

// ==================== 渠道类型多模态支持 ====================

/**
 * 渠道类型
 */
export type ChannelType = 'gemini' | 'gemini-interactions' | 'openai' | 'anthropic' | 'openai-responses';

/**
 * 工具模式
 */
export type ToolMode = 'function_call' | 'xml' | 'json';

/**
 * 多模态能力
 */
export interface MultimodalCapability {
    /** 是否支持图片 */
    supportsImages: boolean;
    /** 是否支持文档（PDF） */
    supportsDocuments: boolean;
    /** 是否支持回传多模态数据到历史记录 */
    supportsHistoryMultimodal: boolean;
}

/**
 * 获取渠道的多模态能力
 * 
 * 根据渠道类型和工具模式，定义不同的多模态支持级别：
 * - gemini: 全面支持所有多模态功能
 * - openai: 
 *   - function_call 模式不支持多模态工具
 *   - xml/json 模式只支持图片，不支持文档
 * - anthropic: 全部支持
 * - custom: 保守处理，假设全部支持
 * 
 * @param channelType 渠道类型
 * @param toolMode 工具模式
 * @param multimodalEnabled 是否启用多模态工具
 * @returns 多模态能力
 */
export function getMultimodalCapability(
    channelType: ChannelType,
    toolMode: ToolMode,
    multimodalEnabled: boolean
): MultimodalCapability {
    // 如果未启用多模态工具，不支持任何多模态功能
    if (!multimodalEnabled) {
        return {
            supportsImages: false,
            supportsDocuments: false,
            supportsHistoryMultimodal: false,
        };
    }
    
    switch (channelType) {
        case 'gemini':
        case 'gemini-interactions':
            // Gemini 全面支持（Interactions API 与 generateContent 多模态能力一致）
            return {
                supportsImages: true,
                supportsDocuments: true,
                supportsHistoryMultimodal: true,
            };
            
        case 'openai':
            if (toolMode === 'function_call') {
                // OpenAI function_call 模式：工具响应不能包含图片数据
                // （OpenAI API 要求 tool result 必须是字符串）
                return {
                    supportsImages: false,
                    supportsDocuments: false,
                    supportsHistoryMultimodal: false,
                };
            } else {
                // OpenAI xml/json 模式：
                // - 支持图片（作为 user 消息附件发送）
                // - 不支持文档（PDF）
                // - 历史中的图片可以正常发送（作为 user 消息的 image_url 类型）
                return {
                    supportsImages: true,
                    supportsDocuments: false,
                    supportsHistoryMultimodal: true, // 历史中的图片可以作为 user 消息发送
                };
            }
            
        case 'openai-responses':
            // OpenAI Responses API 全面支持多模态（图片和文档）
            return {
                supportsImages: true,
                supportsDocuments: true,
                supportsHistoryMultimodal: true,
            };
            
        case 'anthropic':
            // Anthropic 全面支持多模态（图片和文档）
            return {
                supportsImages: true,
                supportsDocuments: true,
                supportsHistoryMultimodal: true,
            };
            
        default:
            return {
                supportsImages: false,
                supportsDocuments: false,
                supportsHistoryMultimodal: false,
            };
    }
}

/**
 * 根据渠道能力检查文件是否允许读取
 * 
 * @param filePath 文件路径
 * @param capability 多模态能力
 * @returns 是否允许读取
 */
export function canReadFileWithCapability(filePath: string, capability: MultimodalCapability): boolean {
    // 文本文件总是允许读取
    if (!isBinaryFile(filePath)) {
        return true;
    }
    
    // 检查图片支持
    if (isImageFile(filePath)) {
        return capability.supportsImages;
    }
    
    // 检查文档支持（PDF）
    if (isPdfFile(filePath)) {
        return capability.supportsDocuments;
    }
    
    return false;
}

/**
 * 获取不支持读取的详细原因（带渠道能力信息）
 *
 * @param filePath 文件路径
 * @param multimodalEnabled 是否启用多模态工具
 * @param capability 多模态能力（可选）
 * @returns 错误消息，如果允许读取则返回 null
 */
export function getReadFileErrorWithCapability(
    filePath: string,
    multimodalEnabled: boolean,
    capability?: MultimodalCapability
): string | null {
    // 如果有能力信息，使用能力检查
    if (capability) {
        if (canReadFileWithCapability(filePath, capability)) {
            return null;
        }
    } else {
        if (canReadFile(filePath, multimodalEnabled)) {
            return null;
        }
    }
    
    const ext = path.extname(filePath).toLowerCase();
    
    if (!multimodalEnabled) {
        if (isImageFile(filePath) || isPdfFile(filePath)) {
            return t('multimodal.cannotReadFile', { ext });
        }
    } else if (capability) {
        if (isImageFile(filePath) && !capability.supportsImages) {
            return t('multimodal.cannotReadImage', { ext });
        }
        if (isPdfFile(filePath) && !capability.supportsDocuments) {
            return t('multimodal.cannotReadDocument', { ext });
        }
    }
    
    return t('multimodal.cannotReadBinaryFile', { ext });
}

/**
 * 检查 MIME 类型是否为图片
 */
export function isMimeTypeImage(mimeType: string): boolean {
    return MULTIMODAL_SUPPORTED_TYPES.images.includes(mimeType);
}

/**
 * 检查 MIME 类型是否为文档
 */
export function isMimeTypeDocument(mimeType: string): boolean {
    return MULTIMODAL_SUPPORTED_TYPES.documents.includes(mimeType);
}
