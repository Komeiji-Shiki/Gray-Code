/**
 * GrayCode - 函数响应工具
 * 
 * 提供创建和处理 Gemini 多模态函数响应的工具函数
 * 支持 Gemini 3 Pro+ 的多模态函数响应特性
 */

import type { ContentPart } from './types';

/**
 * JSON 引用格式
 * 用于在 functionResponse.response 中引用多模态内容
 */
export interface JsonReference {
    $ref: string;
}

/**
 * 创建 JSON 引用
 * 
 * @param displayName 引用的 displayName
 * @returns JSON 引用对象
 * 
 * @example
 * ```typescript
 * const ref = createJsonRef('image.jpg');
 * // { "$ref": "image.jpg" }
 * ```
 */
export function createJsonRef(displayName: string): JsonReference {
    return { $ref: displayName };
}

/**
 * 检查是否为 JSON 引用
 */
export function isJsonRef(value: unknown): value is JsonReference {
    return (
        typeof value === 'object' &&
        value !== null &&
        '$ref' in value &&
        typeof (value as JsonReference).$ref === 'string'
    );
}

/**
 * 从 JSON 引用中提取 displayName
 */
export function getRefDisplayName(ref: JsonReference): string {
    return ref.$ref;
}

/**
 * 支持的函数响应多模态 MIME 类型（Gemini 3 Pro+）
 */
export const FUNCTION_RESPONSE_MIME_TYPES = [
    // 图片
    'image/png',
    'image/jpeg',
    'image/webp',
    // 文档
    'application/pdf',
    'text/plain'
] as const;

export type FunctionResponseMimeType = typeof FUNCTION_RESPONSE_MIME_TYPES[number];

/**
 * 检查 MIME 类型是否支持函数响应多模态
 */
export function isSupportedForFunctionResponse(mimeType: string): mimeType is FunctionResponseMimeType {
    return FUNCTION_RESPONSE_MIME_TYPES.includes(mimeType as FunctionResponseMimeType);
}

/**
 * 创建简单的函数响应（无多模态内容）
 * 
 * @param name 函数名
 * @param response 响应数据
 * @returns ContentPart 对象
 * 
 * @example
 * ```typescript
 * const part = createFunctionResponse('get_weather', {
 *     temperature: 25,
 *     condition: 'sunny'
 * });
 * ```
 */
export function createFunctionResponse(
    name: string,
    response: Record<string, unknown>
): ContentPart {
    return {
        functionResponse: {
            name,
            response
        }
    };
}

/**
 * 创建包含多模态内容的函数响应（Gemini 3 Pro+）
 * 
 * @param name 函数名
 * @param response 响应数据（可以包含 JSON 引用）
 * @param parts 多模态内容 parts
 * @returns ContentPart 对象
 * 
 * @example
 * ```typescript
 * const part = createMultimodalFunctionResponse(
 *     'get_image',
 *     {
 *         image_ref: createJsonRef('cat.jpg'),
 *         description: 'A cute cat'
 *     },
 *     [
 *         {
 *             fileData: {
 *                 displayName: 'cat.jpg',
 *                 mimeType: 'image/jpeg',
 *                 fileUri: 'gs://bucket/cat.jpg'
 *             }
 *         }
 *     ]
 * );
 * ```
 */
export function createMultimodalFunctionResponse(
    name: string,
    response: Record<string, unknown>,
    parts: ContentPart[]
): ContentPart {
    return {
        functionResponse: {
            name,
            response,
            parts
        }
    };
}

/**
 * 创建带有文件引用的函数响应
 * 
 * @param name 函数名
 * @param fileUri 文件 URI
 * @param mimeType MIME 类型
 * @param displayName 显示名称（用于引用）
 * @param additionalResponse 额外的响应数据
 * @returns ContentPart 对象
 * 
 * @example
 * ```typescript
 * const part = createFunctionResponseWithFile(
 *     'get_document',
 *     'gs://bucket/doc.pdf',
 *     'application/pdf',
 *     'report.pdf',
 *     { title: 'Annual Report' }
 * );
 * ```
 */
export function createFunctionResponseWithFile(
    name: string,
    fileUri: string,
    mimeType: FunctionResponseMimeType,
    displayName: string,
    additionalResponse: Record<string, unknown> = {}
): ContentPart {
    return createMultimodalFunctionResponse(
        name,
        {
            ...additionalResponse,
            file_ref: createJsonRef(displayName)
        },
        [
            {
                fileData: {
                    displayName,
                    mimeType,
                    fileUri
                }
            }
        ]
    );
}

/**
 * 创建带有内嵌数据的函数响应
 * 
 * @param name 函数名
 * @param base64Data Base64 编码的数据
 * @param mimeType MIME 类型
 * @param displayName 显示名称（用于引用）
 * @param additionalResponse 额外的响应数据
 * @returns ContentPart 对象
 * 
 * @example
 * ```typescript
 * const imageData = fs.readFileSync('image.jpg').toString('base64');
 * const part = createFunctionResponseWithInlineData(
 *     'process_image',
 *     imageData,
 *     'image/jpeg',
 *     'result.jpg',
 *     { status: 'processed' }
 * );
 * ```
 */
export function createFunctionResponseWithInlineData(
    name: string,
    base64Data: string,
    mimeType: FunctionResponseMimeType,
    displayName: string,
    additionalResponse: Record<string, unknown> = {}
): ContentPart {
    // 移除可能存在的 data URL 前缀
    const cleanData = base64Data.replace(/^data:[^;]+;base64,/, '');
    
    return createMultimodalFunctionResponse(
        name,
        {
            ...additionalResponse,
            data_ref: createJsonRef(displayName)
        },
        [
            {
                inlineData: {
                    mimeType,
                    data: cleanData
                }
            }
        ]
    );
}

/**
 * 创建包含多个文件的函数响应
 * 
 * @param name 函数名
 * @param files 文件数组
 * @param additionalResponse 额外的响应数据
 * @returns ContentPart 对象
 * 
 * @example
 * ```typescript
 * const part = createFunctionResponseWithMultipleFiles(
 *     'get_images',
 *     [
 *         { uri: 'gs://bucket/1.jpg', mimeType: 'image/jpeg', name: 'image1.jpg' },
 *         { uri: 'gs://bucket/2.jpg', mimeType: 'image/jpeg', name: 'image2.jpg' }
 *     ],
 *     { count: 2 }
 * );
 * ```
 */
export function createFunctionResponseWithMultipleFiles(
    name: string,
    files: Array<{
        uri: string;
        mimeType: FunctionResponseMimeType;
        name: string;
    }>,
    additionalResponse: Record<string, unknown> = {}
): ContentPart {
    const parts: ContentPart[] = files.map(file => ({
        fileData: {
            displayName: file.name,
            mimeType: file.mimeType,
            fileUri: file.uri
        }
    }));

    const response: Record<string, unknown> = {
        ...additionalResponse,
        files: files.map(file => ({
            name: file.name,
            ref: createJsonRef(file.name)
        }))
    };

    return createMultimodalFunctionResponse(name, response, parts);
}

/**
 * 验证函数响应中的引用是否有效
 * 
 * 检查 response 中的所有 JSON 引用是否在 parts 中有对应的 displayName
 * 
 * @param part 包含 functionResponse 的 ContentPart
 * @returns 验证结果
 */
export function validateFunctionResponseRefs(part: ContentPart): {
    valid: boolean;
    missingRefs: string[];
    duplicateRefs: string[];
} {
    if (!part.functionResponse) {
        return { valid: true, missingRefs: [], duplicateRefs: [] };
    }

    const { response, parts } = part.functionResponse;
    
    if (!parts || parts.length === 0) {
        return { valid: true, missingRefs: [], duplicateRefs: [] };
    }

    // 收集 parts 中的所有 displayName
    const displayNames = new Set<string>();
    const duplicateRefs: string[] = [];
    
    for (const p of parts) {
        let displayName: string | undefined;
        
        if (p.fileData?.displayName) {
            displayName = p.fileData.displayName;
        } else if (p.inlineData?.displayName) {
            // inlineData 同样支持 displayName（Gemini API 字段），带 displayName 的
            // inlineData 也可被 response 的 $ref 引用，必须像 fileData 一样收集，
            // 否则会被误报为 missingRefs。
            displayName = p.inlineData.displayName;
        }
        
        if (displayName) {
            if (displayNames.has(displayName)) {
                duplicateRefs.push(displayName);
            }
            displayNames.add(displayName);
        }
    }

    // 收集 response 中的所有引用
    const refs = new Set<string>();
    const collectRefs = (obj: unknown) => {
        if (isJsonRef(obj)) {
            refs.add(getRefDisplayName(obj));
        } else if (Array.isArray(obj)) {
            obj.forEach(collectRefs);
        } else if (typeof obj === 'object' && obj !== null) {
            Object.values(obj).forEach(collectRefs);
        }
    };
    collectRefs(response);

    // 检查缺失的引用
    const missingRefs: string[] = [];
    for (const ref of refs) {
        if (!displayNames.has(ref)) {
            missingRefs.push(ref);
        }
    }

    return {
        valid: missingRefs.length === 0 && duplicateRefs.length === 0,
        missingRefs,
        duplicateRefs
    };
}

/**
 * 从函数响应中提取所有多模态内容
 * 
 * @param part 包含 functionResponse 的 ContentPart
 * @returns 多模态内容数组
 */
export function extractMultimediaFromFunctionResponse(part: ContentPart): ContentPart[] {
    if (!part.functionResponse?.parts) {
        return [];
    }
    
    return part.functionResponse.parts.filter(
        p => p.inlineData || p.fileData
    );
}

/**
 * 检查函数响应是否包含多模态内容
 */
export function hasFunctionResponseMultimedia(part: ContentPart): boolean {
    return extractMultimediaFromFunctionResponse(part).length > 0;
}