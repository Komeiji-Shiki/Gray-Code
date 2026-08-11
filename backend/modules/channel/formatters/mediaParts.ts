/**
 * GrayCode - 附件 MIME 分类与转换工具
 *
 * 不同 API 对附件（inlineData）的支持格式不同：
 * - OpenAI Chat Completions：图片 → image_url，文本 → text，其余不支持
 * - OpenAI Responses：图片 → input_image，文本 → input_text，其余不支持
 * - Anthropic：图片 → image，PDF → document，文本 → text，其余不支持
 * - Gemini：原生 inlineData，无需转换
 *
 * 各 formatter 根据本模块的分类结果决定如何序列化附件，
 * 避免把 txt 等文本文件错误地当作图片发送，导致 API 返回
 * "unknown variant image_url, expected text" 之类的 400 错误。
 */

/** 非 text/* 前缀的文本类 MIME 类型（application/* 常见文本格式） */
const EXTRA_TEXT_MIME_TYPES = [
    'application/json',
    'application/xml',
    'application/x-yaml',
    'application/yaml',
    'application/javascript',
    'application/x-javascript',
    'application/x-sh',
    'application/x-python-code',
    'application/x-httpd-php',
    'application/rtf',
    'application/x-www-form-urlencoded'
] as const;

/**
 * 判断 MIME 类型是否为文本内容（可安全解码为 UTF-8 文本发送）
 */
export function isTextMimeType(mimeType: string): boolean {
    if (!mimeType) {
        return false;
    }
    if (mimeType.startsWith('text/')) {
        return true;
    }
    return (EXTRA_TEXT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

/**
 * 判断 MIME 类型是否为图片
 */
export function isImageMimeType(mimeType: string): boolean {
    return !!mimeType && mimeType.startsWith('image/');
}

/**
 * 判断 MIME 类型是否为 PDF 文档
 */
export function isPdfMimeType(mimeType: string): boolean {
    return mimeType === 'application/pdf';
}

/**
 * 将 Base64 数据解码为 UTF-8 文本
 */
export function decodeBase64Text(base64: string): string {
    return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * 生成不支持格式附件的文本占位
 *
 * 当附件格式当前 API 不支持直接发送时（如 PDF/音视频发往
 * OpenAI Chat Completions），用一条文本说明代替，避免整个请求被拒绝，
 * 同时让模型知道用户曾附带文件。
 *
 * @param mimeType 附件的 MIME 类型
 * @returns 占位文本
 */
export function buildUnsupportedAttachmentText(mimeType: string): string {
    return `[附件 (${mimeType})：当前渠道不支持直接发送该格式]`;
}

/**
 * 将文本类附件包装为带标记的文本内容
 *
 * @param base64 Base64 编码的附件数据
 * @returns 解码后的文本（带附件内容标记）
 */
export function buildTextAttachmentContent(base64: string): string {
    return `[附件内容]\n\n${decodeBase64Text(base64)}`;
}

