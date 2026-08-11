// 从 utils.ts 拆分而来（图片尺寸计算）

// ==================== 图片尺寸计算工具 ====================

/**
 * 图片尺寸信息
 */
export interface ImageDimensions {
    width: number;
    height: number;
    aspectRatio: string;  // 如 "16:9", "4:3", "1:1"
}

/**
 * 计算最大公约数（迭代实现 + 整数化防御，避免浮点输入导致递归不收敛）
 */
export function gcd(a: number, b: number): number {
    let x = Math.abs(Math.trunc(a));
    let y = Math.abs(Math.trunc(b));
    while (y !== 0) {
        const remainder = x % y;
        x = y;
        y = remainder;
    }
    return x;
}

/**
 * 计算宽高比字符串
 *
 * @param width 宽度
 * @param height 高度
 * @returns 宽高比字符串，如 "16:9", "4:3", "1:1"
 */
export function calculateAspectRatio(width: number, height: number): string {
    if (width <= 0 || height <= 0) {
        return '1:1';
    }
    
    const divisor = gcd(width, height);
    const ratioW = width / divisor;
    const ratioH = height / divisor;
    
    // 如果比例数字太大，使用近似值
    if (ratioW > 100 || ratioH > 100) {
        const ratio = width / height;
        // 常见比例检测
        if (Math.abs(ratio - 16/9) < 0.05) return '16:9';
        if (Math.abs(ratio - 9/16) < 0.05) return '9:16';
        if (Math.abs(ratio - 4/3) < 0.05) return '4:3';
        if (Math.abs(ratio - 3/4) < 0.05) return '3:4';
        if (Math.abs(ratio - 3/2) < 0.05) return '3:2';
        if (Math.abs(ratio - 2/3) < 0.05) return '2:3';
        if (Math.abs(ratio - 1) < 0.05) return '1:1';
        if (Math.abs(ratio - 21/9) < 0.05) return '21:9';
        if (Math.abs(ratio - 9/21) < 0.05) return '9:21';
        // 返回小数比例
        return `${ratio.toFixed(2)}:1`;
    }
    
    return `${ratioW}:${ratioH}`;
}

/**
 * 从宽高创建完整的尺寸信息
 */
export function createImageDimensions(width: number, height: number): ImageDimensions {
    return {
        width,
        height,
        aspectRatio: calculateAspectRatio(width, height)
    };
}

/**
 * 从图片字节数据解析尺寸（统一实现，支持 PNG / JPEG / WebP / GIF）。
 *
 * 修改原因：read_file.ts 的 parseImageDimensions 与 generate_image.ts 的
 * parseImageDimensionsFromBase64 维护了两份几乎相同的解析逻辑（PNG/JPEG/WebP），
 * 修改一处容易漏改另一处。
 * 修改方式：收敛到本函数，两个调用方直接复用；错误路径统一返回 undefined。
 * 行为与两份原实现逐格式等价（GIF 仅 read_file 原有，此处保留作为超集；
 * generate_image 只会收到 PNG/JPEG/WebP，行为不受影响）。
 *
 * @param buffer   图片字节（UTF-8/二进制原样）
 * @param mimeType MIME 类型（image/png、image/jpeg、image/webp、image/gif）
 * @returns 解析成功返回宽高；解析失败或尺寸非法返回 undefined
 */
export function parseImageDimensionsFromBytes(
    buffer: Uint8Array,
    mimeType: string
): { width: number; height: number; aspectRatio?: number } | undefined {
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
                    // VP8 格式需要查找帧头（帧头在偏移 23 开始）
                    width = (buffer[26] | (buffer[27] << 8)) & 0x3FFF;
                    height = (buffer[28] | (buffer[29] << 8)) & 0x3FFF;
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
        
        if (width !== undefined && height !== undefined && width > 0 && height > 0) {
            return { width, height };
        }
    } catch {
        // 解析失败，返回 undefined
    }
    return undefined;
}
