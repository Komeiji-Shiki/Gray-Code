/**
 * GrayCode - 多模态内容工具
 * 
 * 提供创建和处理 Gemini 多模态内容的工具函数
 */

import type { ContentPart } from './types';

/**
 * 支持的图片 MIME 类型
 */
export const IMAGE_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif'
] as const;

/**
 * 支持的音频 MIME 类型
 */
export const AUDIO_MIME_TYPES = [
    'audio/x-aac',
    'audio/flac',
    'audio/mp3',
    'audio/m4a',
    'audio/mpeg',
    'audio/mpga',
    'audio/mp4',
    'audio/ogg',
    'audio/pcm',
    'audio/wav',
    'audio/webm'
] as const;

/**
 * 支持的视频 MIME 类型
 */
export const VIDEO_MIME_TYPES = [
    'video/x-flv',
    'video/quicktime',
    'video/mpeg',
    'video/mpegs',
    'video/mpg',
    'video/mp4',
    'video/webm',
    'video/wmv',
    'video/3gpp'
] as const;

/**
 * 支持的文档/文本 MIME 类型
 */
export const DOCUMENT_MIME_TYPES = [
    'application/pdf',
    'text/plain'
] as const;

/**
 * 所有支持的 MIME 类型
 */
export const SUPPORTED_MIME_TYPES = [
    ...IMAGE_MIME_TYPES,
    ...AUDIO_MIME_TYPES,
    ...VIDEO_MIME_TYPES,
    ...DOCUMENT_MIME_TYPES
] as const;

export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];
export type AudioMimeType = typeof AUDIO_MIME_TYPES[number];
export type VideoMimeType = typeof VIDEO_MIME_TYPES[number];
export type DocumentMimeType = typeof DOCUMENT_MIME_TYPES[number];
export type SupportedMimeType = typeof SUPPORTED_MIME_TYPES[number];

/**
 * 多模态内容类型
 */
export type MultimediaType = 'image' | 'audio' | 'video' | 'document' | 'unknown';

/**
 * 检查 MIME 类型是否被支持
 */
export function isSupportedMimeType(mimeType: string): mimeType is SupportedMimeType {
    return SUPPORTED_MIME_TYPES.includes(mimeType as SupportedMimeType);
}

/**
 * 根据 MIME 类型判断内容类型
 */
export function getMultimediaType(mimeType: string): MultimediaType {
    if (IMAGE_MIME_TYPES.includes(mimeType as ImageMimeType)) {
        return 'image';
    }
    if (AUDIO_MIME_TYPES.includes(mimeType as AudioMimeType)) {
        return 'audio';
    }
    if (VIDEO_MIME_TYPES.includes(mimeType as VideoMimeType)) {
        return 'video';
    }
    if (DOCUMENT_MIME_TYPES.includes(mimeType as DocumentMimeType)) {
        return 'document';
    }
    return 'unknown';
}

/**
 * 创建内嵌数据的 ContentPart
 * 
 * @param mimeType MIME 类型
 * @param base64Data Base64 编码的数据（不带前缀）
 * @returns ContentPart 对象
 * 
 * @example
 * ```typescript
 * // 从文件读取并创建
 * const imageData = fs.readFileSync('image.jpg').toString('base64');
 * const part = createInlineDataPart('image/jpeg', imageData);
 * 
 * // 添加到消息
 * await manager.addMessage('chat-001', 'user', [
 *     createInlineDataPart('image/jpeg', imageData),
 *     { text: '这是什么？' }
 * ]);
 * ```
 */
export function createInlineDataPart(
    mimeType: SupportedMimeType,
    base64Data: string
): ContentPart {
    // 移除可能存在的 data URL 前缀
    const cleanData = base64Data.replace(/^data:[^;]+;base64,/, '');
    
    return {
        inlineData: {
            mimeType,
            data: cleanData
        }
    };
}

/**
 * 创建图片内嵌数据
 */
export function createImagePart(
    mimeType: ImageMimeType,
    base64Data: string
): ContentPart {
    return createInlineDataPart(mimeType, base64Data);
}

/**
 * 创建音频内嵌数据
 */
export function createAudioPart(
    mimeType: AudioMimeType,
    base64Data: string
): ContentPart {
    return createInlineDataPart(mimeType, base64Data);
}

/**
 * 创建视频内嵌数据
 */
export function createVideoPart(
    mimeType: VideoMimeType,
    base64Data: string
): ContentPart {
    return createInlineDataPart(mimeType, base64Data);
}

/**
 * 创建文档内嵌数据
 */
export function createDocumentPart(
    mimeType: DocumentMimeType,
    base64Data: string
): ContentPart {
    return createInlineDataPart(mimeType, base64Data);
}

/**
 * 从 Data URL 创建 ContentPart
 * 
 * @param dataUrl 完整的 Data URL (例如: "data:image/jpeg;base64,/9j/4AAQ...")
 * @returns ContentPart 对象，如果解析失败返回 null
 * 
 * @example
 * ```typescript
 * const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg...';
 * const part = createPartFromDataUrl(dataUrl);
 * if (part) {
 *     await manager.addMessage('chat-001', 'user', [part, { text: '分析这张图片' }]);
 * }
 * ```
 */
export function createPartFromDataUrl(dataUrl: string): ContentPart | null {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
        return null;
    }
    
    const [, mimeType, base64Data] = match;
    
    if (!isSupportedMimeType(mimeType)) {
        return null;
    }
    
    return createInlineDataPart(mimeType, base64Data);
}

/**
 * 获取 inlineData 的大小（字节）
 */
export function getInlineDataSize(part: ContentPart): number {
    if (!part.inlineData) {
        return 0;
    }
    
    // Base64 编码后的大小约为原始数据的 4/3
    const base64Length = part.inlineData.data.length;
    return Math.ceil((base64Length * 3) / 4);
}

/**
 * 将 inlineData 转换为 Data URL
 * 
 * @param part 包含 inlineData 的 ContentPart
 * @returns Data URL 字符串，如果没有 inlineData 返回 null
 */
export function inlineDataToDataUrl(part: ContentPart): string | null {
    if (!part.inlineData) {
        return null;
    }
    
    return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
}

/**
 * 检查 ContentPart 是否包含多模态内容
 */
export function hasMultimediaContent(part: ContentPart): boolean {
    return !!(part.inlineData || part.fileData);
}

/**
 * 获取 ContentPart 中的多模态类型
 */
export function getPartMultimediaType(part: ContentPart): MultimediaType | null {
    if (part.inlineData) {
        return getMultimediaType(part.inlineData.mimeType);
    }
    if (part.fileData) {
        return getMultimediaType(part.fileData.mimeType);
    }
    return null;
}