export function parseImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
    try {
        if (mimeType === 'image/png') {
            // PNG: 签名 + IHDR 块宽高（偏移 16-23，大端序）
            if (buffer.length >= 24 &&
                buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
                buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
                const width = buffer.readUInt32BE(16);
                const height = buffer.readUInt32BE(20);
                if (width > 0 && height > 0 && width < 100000 && height < 100000) {
                    return { width, height };
                }
            }
        } else if (mimeType === 'image/jpeg') {
            // JPEG: 扫描 SOF0-SOF3 标记
            if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
                let i = 2;
                while (i < buffer.length - 9) {
                    if (buffer[i] === 0xFF) {
                        const marker = buffer[i + 1];
                        if (marker >= 0xC0 && marker <= 0xC3) {
                            const height = buffer.readUInt16BE(i + 5);
                            const width = buffer.readUInt16BE(i + 7);
                            if (width > 0 && height > 0) {
                                return { width, height };
                            }
                        }
                        if (i + 3 < buffer.length) {
                            const segmentLength = buffer.readUInt16BE(i + 2);
                            i += 2 + segmentLength;
                        } else {
                            break;
                        }
                    } else {
                        i++;
                    }
                }
            }
        } else if (mimeType === 'image/webp') {
            if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
                buffer.toString('ascii', 8, 12) === 'WEBP') {
                const format = buffer.toString('ascii', 12, 16);
                if (format === 'VP8 ') {
                    // Lossy WebP
                    const width = buffer.readUInt16LE(26) & 0x3FFF;
                    const height = buffer.readUInt16LE(28) & 0x3FFF;
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                } else if (format === 'VP8L') {
                    // Lossless WebP
                    const b0 = buffer[21];
                    const b1 = buffer[22];
                    const b2 = buffer[23];
                    const b3 = buffer[24];
                    const width = 1 + (((b1 & 0x3F) << 8) | b0);
                    const height = 1 + (((b3 & 0xF) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                } else if (format === 'VP8X') {
                    // Extended WebP
                    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
                    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                }
            }
        }
    } catch {
        // 解析失败
    }
    return null;
}
