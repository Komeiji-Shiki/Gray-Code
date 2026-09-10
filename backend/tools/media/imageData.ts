import { parseImageDimensions } from '../shared/imageDimensions';
import { getSharp } from '../../modules/dependencies/runtime';
export { parseImageDimensions } from '../shared/imageDimensions';
export function parseImageDimensionsFromBase64(base64Data: string, mimeType: string): { width: number; height: number } | null {
    try {
        return parseImageDimensions(Buffer.from(base64Data, 'base64'), mimeType);
    } catch {
        return null;
    }
}

/**
 * 获取图片尺寸（优先 sharp，失败回退手动解析）
 */
export async function getImageDimensions(buffer: Buffer, mimeType: string): Promise<{ width: number; height: number } | null> {
    try {
        const sharp = await getSharp();
        if (sharp) {
            const metadata = await sharp(buffer).metadata();
            if (metadata.width && metadata.height) {
                return { width: metadata.width, height: metadata.height };
            }
        }
    } catch {
        // sharp 不可用或解析失败，继续尝试手动解析
    }
    return parseImageDimensions(buffer, mimeType);
}


/**
 * 给 fetch 请求组合外部取消信号与超时：任一触发即中止请求。
 *
 * 修改原因：generate_image / remove_background 的 Gemini API 请求只有取消信号、无超时保护，
 *          网络挂起时请求可能无限期等待。
 * 修改方式：手动组合 AbortController（不用 AbortSignal.any，兼容 Electron 内置 Node < 20.3）；
 *          调用方必须在 finally 中调用 cleanup 清理定时器与监听器。
 */
export function createFetchSignal(
    abortSignal: AbortSignal | undefined,
    timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
        cleanup();
        controller.abort(abortSignal?.reason);
    };
    if (abortSignal?.aborted) {
        controller.abort(abortSignal.reason);
    } else {
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        timeoutId = setTimeout(() => controller.abort(new Error(`API request timed out after ${timeoutMs}ms`)), timeoutMs);
    }
    return { signal: controller.signal, cleanup };
}