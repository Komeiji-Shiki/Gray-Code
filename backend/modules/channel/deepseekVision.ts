/**
 * DeepSeek 图片预处理：按约 1300×1300 总像素预算等比例缩小整图，保留 PDF 逐页转换。
 * 普通图片不再拆块，历史中的旧拆图偏好不改变新的处理规则。
 */

import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import type { Content, ContentPart } from '../conversation/types';
import { LruCache } from './deepseekVisionCache';
import {
    getCanvas,
    getDependencyPath,
    getPdfjs,
    getSharp
} from '../dependencies/runtime';

/** DeepSeek 官方具备视觉能力的当前模型 ID。 */
export const DEEPSEEK_VISION_MODEL = 'deepseek-flash';

/** DeepSeek 对较大图片的近似总像素预算。 */
export const DEEPSEEK_VISION_MAX_IMAGE_PIXELS = 1300 * 1300;

/**
 * 对包含较多图片的请求使用更严格的长边上限。
 * 统一使用 4096，避免图片数量增加到 15 张后触发 DeepSeek 的另一档限制。
 */
export const DEEPSEEK_VISION_MAX_IMAGE_LONG_EDGE = 4096;

/** DeepSeek Vision 单次请求最多接收的图片数。 */
export const DEEPSEEK_VISION_MAX_IMAGES = 600;

/** DeepSeek 请求体上限。 */
export const DEEPSEEK_VISION_MAX_REQUEST_BYTES = 48 * 1024 * 1024;

/** Base64/外部传图方式下的单图原始数据上限。 */
export const DEEPSEEK_VISION_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** PDF 页面渲染倍率：PDF 默认坐标约为 72 DPI，2 倍约为 144 DPI。 */
const PDF_RENDER_SCALE = 2;
/** GIF 帧采样上限：每秒最多 5 帧（避免高帧率/长动画把请求冲击成图片堆）。 */
export const GIF_MAX_FPS = 5;

/** GIF 帧采样间隔（毫秒）。 */
export const GIF_FRAME_INTERVAL_MS = 1000 / GIF_MAX_FPS;

/** sharp metadata 未提供 delay 时假定的每帧时长（毫秒，约 10fps）。 */
const GIF_DEFAULT_FRAME_DELAY_MS = 100;

/** 防止异常 PDF 页面尺寸在栅格化时一次性申请过大的画布。 */
const PDF_MAX_CANVAS_PIXELS = 40_000_000;

/** PDF 渲染结果缓存：最多缓存 8 个文档（按内容哈希）。 */
const PDF_CACHE_MAX_ENTRIES = 8;
/** PDF 渲染结果缓存：总字节预算 128 MiB。 */
const PDF_CACHE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** PDF 渲染结果缓存：单个文档超过 64 MiB 不缓存（防止一条巨无霸挤占预算）。 */
const PDF_CACHE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 图片缩放结果缓存：最多 64 个条目。 */
const RASTER_CACHE_MAX_ENTRIES = 64;
/** 图片缩放结果缓存：总字节预算 64 MiB（按 base64 编码后长度计）。 */
const RASTER_CACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** GIF 帧 PNG 缓存：最多 128 帧。 */
const GIF_FRAME_CACHE_MAX_ENTRIES = 128;
/** GIF 帧 PNG 缓存：总字节预算 64 MiB。 */
const GIF_FRAME_CACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const DEEPSEEK_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
]);

const ORIENTATION_SWAP_VALUES = new Set([5, 6, 7, 8]);

/**
 * DeepSeek Vision 只对明确的视觉模型启用图片预处理。
 *
 * 除官方完整模型名外，允许兼容端点在模型名后添加 :free、版本标签等后缀，
 * 但不会把普通 DeepSeek 文本模型误判为可接收图片的模型。
 */
export function isDeepSeekVisionModel(model?: string): boolean {
    const normalized = model?.trim().toLowerCase() ?? '';
    return /(?:^|\/)deepseek-flash(?:$|:)/.test(normalized) || normalized.includes('deepseek') && normalized.includes('vision');
}

/** 按约 169 万总像素和多图请求的长边上限缩小图片；不放大已经达标的图片。 */
export function calculateDeepSeekDownscaleSize(width: number, height: number): { width: number; height: number } {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new DeepSeekVisionPreprocessingError('Image dimensions must be positive integers.');
    }

    const scale = Math.min(
        Math.sqrt(DEEPSEEK_VISION_MAX_IMAGE_PIXELS / (width * height)),
        DEEPSEEK_VISION_MAX_IMAGE_LONG_EDGE / Math.max(width, height)
    );
    if (scale >= 1) {
        return { width, height };
    }
    return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale))
    };
}

export class DeepSeekVisionPreprocessingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeepSeekVisionPreprocessingError';
    }
}

interface RenderedPdfPage {
    data: Buffer;
    pageNumber: number;
    pageCount: number;
}

interface EncodedImage {
    mimeType: string;
    data: string;
    width: number;
    height: number;
}

/**
 * 模块级预处理结果缓存（按输入字节 sha256 键控）。
 *
 * 缓存跨请求共享：ChannelManager 的请求转发与 TokenCountService 的 token
 * 估算都调用 prepareDeepSeekVisionHistory，同一附件字节只渲染一次。
 * 只缓存成功的 resolved 值，不缓存 in-flight promise——并发未命中时各自
 * 渲染一次最坏只是重复计算，不会让某个请求的 abort 把共享 promise 连带拒绝。
 */
const pdfRenderCache = new LruCache<string, RenderedPdfPage[]>(
    PDF_CACHE_MAX_ENTRIES,
    PDF_CACHE_MAX_TOTAL_BYTES,
    PDF_CACHE_MAX_ENTRY_BYTES
);
const rasterImageCache = new LruCache<string, EncodedImage[]>(
    RASTER_CACHE_MAX_ENTRIES,
    RASTER_CACHE_MAX_TOTAL_BYTES
);
const gifFrameCache = new LruCache<string, Buffer>(
    GIF_FRAME_CACHE_MAX_ENTRIES,
    GIF_FRAME_CACHE_MAX_TOTAL_BYTES
);

/** 清空全部预处理结果缓存（测试隔离 / 手动释放内存用）。 */
export function clearDeepSeekVisionCache(): void {
    pdfRenderCache.clear();
    rasterImageCache.clear();
    gifFrameCache.clear();
}

/** 内容哈希：相同字节得到相同键，附件 id/名称等元数据不参与键。 */
function contentHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 构造基于 @napi-rs/canvas 的 Node 画布工厂类（传给 pdf.js 的 CanvasFactory 参数）。
 *
 * pdf.js 的默认工厂选择依赖其 isNodeJS 检测：`process.versions.electron` 存在且
 * `process.type` 非 'browser'（VS Code 扩展宿主在多数 Electron 进程中即如此）时
 * isNodeJS 为 false，默认会实例化 DOMCanvasFactory；其内部使用
 * `globalThis.document.createElement("canvas")`，Node 宿主中 document 为 undefined，
 * 渲染透明分组/注解等需要 scratch canvas 的页面（CachedCanvases / annotationCanvas）时
 * 直接抛 "Cannot read properties of undefined (reading 'createElement')"。
 *
 * 注意：pdf.js 只认 getDocument 参数中的大写 `CanvasFactory`（要求构造函数/类，
 * 而非实例），实例化时传入 `{ ownerDocument, enableHWA }`，据此显式注入 Node 工厂。
 */
function createNodeCanvasFactory(canvasModule: any): any {
    return class NodeCanvasFactory {
        constructor(_options?: any) {}

        create(width: number, height: number): any {
            const canvas = canvasModule.createCanvas(
                Math.max(1, Math.ceil(width)),
                Math.max(1, Math.ceil(height))
            );
            return { canvas, context: canvas.getContext('2d') };
        }

        reset(canvasAndContext: any, width: number, height: number): void {
            canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
            canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
        }

        destroy(canvasAndContext: any): void {
            canvasAndContext.canvas.width = 0;
            canvasAndContext.canvas.height = 0;
            canvasAndContext.canvas = null;
            canvasAndContext.context = null;
        }
    };
}

/**
 * 从文件系统读取 PDF 标准字体数据（基于路径的工厂）。
 *
 * pdf.js 默认的 DOMStandardFontDataFactory 通过 fetch 加载 standardFontDataUrl，
 * Node 宿主中 file:// URL 不可 fetch，标准字体加载失败只会静默告警，但文本会
 * 渲染为空白/方块——视觉模型看到的图会缺字。这里直接按 baseUrl 读本地文件。
 */
class FileStandardFontDataFactory {
    private readonly baseUrl: string;

    constructor({ baseUrl }: { baseUrl: string }) {
        this.baseUrl = baseUrl;
    }

    async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
        return new Uint8Array(await fs.promises.readFile(path.join(this.baseUrl, filename)));
    }
}

/**
 * 从文件系统读取 CMap（.bcmap）数据，供 CJK 等复合字体映射使用。
 *
 * 与 FileStandardFontDataFactory 同理：DOMCMapReaderFactory 在 Node 宿主中
 * fetch file:// 会失败，导致 CJK 文本空白。
 */
class FileCMapReaderFactory {
    private readonly baseUrl: string;
    readonly isCompressed: boolean;

    constructor({ baseUrl, isCompressed = true }: { baseUrl: string; isCompressed?: boolean }) {
        this.baseUrl = baseUrl;
        this.isCompressed = isCompressed;
    }

    async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
        const suffix = this.isCompressed ? '.bcmap' : '';
        return {
            cMapData: new Uint8Array(await fs.promises.readFile(path.join(this.baseUrl, `${name}${suffix}`))),
            isCompressed: this.isCompressed
        };
    }
}

class DeepSeekVisionProcessor {
    private sharpFactoryPromise?: Promise<any | null>;
    /** 当前请求转换后的图片总数；按历史顺序增量维护，超限立即停止重处理。 */
    private imageCount = 0;

    constructor(private readonly abortSignal?: AbortSignal) {}

    async transformHistory(history: Content[]): Promise<Content[]> {
        const transformed: Content[] = [];
        this.imageCount = countHistoryImages(history);
        if (this.imageCount > DEEPSEEK_VISION_MAX_IMAGES) {
            throw new DeepSeekVisionPreprocessingError(
                `DeepSeek Vision requests support at most ${DEEPSEEK_VISION_MAX_IMAGES} images; history contains ${this.imageCount}.`
            );
        }

        // 旧模式字段保留在原历史中，但不再触发空间拆图。
        for (const content of history) {
            this.throwIfAborted();

            if (content.role !== 'user') {
                transformed.push(content);
                continue;
            }

            const parts = await this.transformParts(content.parts);
            transformed.push({ ...content, parts });
        }

        return transformed;
    }

    private async transformParts(parts: ContentPart[]): Promise<ContentPart[]> {
        const result: ContentPart[] = [];

        for (const part of parts) {
            this.throwIfAborted();

            // Gemini function response 可以在 parts 中嵌套多媒体。递归处理，
            // 使 Responses formatter 的工具输出路径也能获得相同的 PDF/缩放能力。
            if (part.functionResponse?.parts) {
                const nestedParts = await this.transformParts(part.functionResponse.parts);
                result.push({
                    ...part,
                    functionResponse: {
                        ...part.functionResponse,
                        parts: nestedParts
                    }
                });
                continue;
            }

            if (!part.inlineData) {
                result.push(part);
                continue;
            }

            const transformedInlineParts = await this.transformInlineData(part);
            result.push(...transformedInlineParts);
        }

        return result;
    }

    private async transformInlineData(part: ContentPart): Promise<ContentPart[]> {
        const inlineData = part.inlineData!;
        const mimeType = inlineData.mimeType.trim().toLowerCase();
        const buffer = Buffer.from(inlineData.data, 'base64');

        if (mimeType === 'application/pdf') {
            const result: ContentPart[] = [];
            const displayName = inlineData.name || 'attachment.pdf';

            // 逐页渲染并立即转换：达到最终图片上限时当场停止，不再先把整份 PDF
            // 全量栅格化进内存后才发现缩放结果超限。
            await this.renderPdfPages(buffer, async page => {
                this.throwIfAborted();
                const pageImages = await this.transformRasterImage(page.data, 'image/png');
                this.reserveProducedImages(pageImages.length);
                result.push({
                    text: `[PDF page ${page.pageNumber}/${page.pageCount}: ${displayName}]`
                });
                result.push(...pageImages.map(image => ({
                    inlineData: {
                        mimeType: image.mimeType,
                        data: image.data,
                        id: inlineData.id,
                        name: `${displayName} page-${page.pageNumber}`
                    }
                })));
            });

            return result;
        }

        if (mimeType === 'image/gif') {
            // 原 GIF 在初始图片计数中占 1；拆帧前先移除，再逐个登记实际输出。
            this.imageCount -= 1;
            return this.transformGif(buffer, inlineData.name || 'attachment.gif', inlineData.id);
        }

        if (!mimeType.startsWith('image/')) {
            // 文本、音频等附件不属于 DeepSeek Vision 的图片输入，保留给
            // formatter 的既有文本/占位处理。
            return [part];
        }

        const sharp = await this.getSharpFactory();
        if (!sharp) {
            if (!DEEPSEEK_IMAGE_MIME_TYPES.has(mimeType)) {
                throw this.sharpRequiredError(mimeType);
            }
            // 官方支持格式可以继续沿用原始数据；没有 sharp 时至少不破坏
            // 已经可发送的图片，图片缩放能力则由可选依赖提供。
            return [part];
        }

        let metadata: any;
        try {
            metadata = await sharp(buffer).metadata();
        } catch (error) {
            if (DEEPSEEK_IMAGE_MIME_TYPES.has(mimeType)) {
                return [part];
            }
            throw new DeepSeekVisionPreprocessingError(
                `DeepSeek cannot process ${mimeType}: ${this.errorMessage(error)}`
            );
        }

        const dimensions = this.getOrientedDimensions(metadata);
        if (!dimensions) {
            if (DEEPSEEK_IMAGE_MIME_TYPES.has(mimeType)) {
                return [part];
            }
            throw this.sharpRequiredError(mimeType);
        }

        const rawBytes = buffer.length;
        const needsTransform = !DEEPSEEK_IMAGE_MIME_TYPES.has(mimeType)
            || dimensions.width * dimensions.height > DEEPSEEK_VISION_MAX_IMAGE_PIXELS
            || Math.max(dimensions.width, dimensions.height) > DEEPSEEK_VISION_MAX_IMAGE_LONG_EDGE
            || rawBytes > DEEPSEEK_VISION_MAX_IMAGE_BYTES;

        if (!needsTransform) {
            return [part];
        }

        const images = await this.transformRasterImage(buffer, mimeType);
        this.replaceInputImageWithOutputs(images.length);
        const { inlineData: _inlineData, ...partMetadata } = part;
        return images.map(image => ({
            ...partMetadata,
            inlineData: {
                mimeType: image.mimeType,
                data: image.data,
                id: inlineData.id,
                name: inlineData.name
            }
        }));
    }

    private async transformRasterImage(buffer: Buffer, inputMimeType: string): Promise<EncodedImage[]> {
        // 稳定的内容与尺寸规则对应同一份缓存，后续回合不重复处理相同图片。
        const cacheKey = `${contentHash(buffer)}|${inputMimeType}|resize-1300`;
        const cached = rasterImageCache.get(cacheKey);
        return cached ?? this.downscaleRasterImage(buffer, inputMimeType, cacheKey);
    }

    private async downscaleRasterImage(buffer: Buffer, inputMimeType: string, cacheKey: string): Promise<EncodedImage[]> {
        const sharp = await this.getSharpFactory();
        if (!sharp) {
            throw this.sharpRequiredError(inputMimeType);
        }

        let metadata: any;
        try {
            metadata = await sharp(buffer).metadata();
        } catch (error) {
            throw new DeepSeekVisionPreprocessingError(
                `Unable to read image metadata: ${this.errorMessage(error)}`
            );
        }

        const dimensions = this.getOrientedDimensions(metadata);
        if (!dimensions) {
            throw new DeepSeekVisionPreprocessingError('Unable to determine image dimensions.');
        }

        const target = calculateDeepSeekDownscaleSize(dimensions.width, dimensions.height);
        const outputMimeType = this.chooseOutputMimeType(inputMimeType);

        // 先按 EXIF 方向旋转，再按正确的显示尺寸缩放。
        let pipeline = sharp(buffer).rotate();
        if (target.width !== dimensions.width || target.height !== dimensions.height) {
            pipeline = pipeline.resize(target.width, target.height, { fit: 'fill' });
        }

        const output = await this.encodeImage(pipeline, outputMimeType);
        if (output.length > DEEPSEEK_VISION_MAX_IMAGE_BYTES) {
            throw new DeepSeekVisionPreprocessingError(
                `A processed DeepSeek image is still larger than ${DEEPSEEK_VISION_MAX_IMAGE_BYTES} bytes.`
            );
        }

        const encoded: EncodedImage[] = [{
            mimeType: outputMimeType,
            data: output.toString('base64'),
            width: target.width,
            height: target.height
        }];
        rasterImageCache.set(cacheKey, encoded, encoded[0].data.length);
        return encoded;
    }

    private chooseOutputMimeType(inputMimeType: string): string {
        switch (inputMimeType) {
            case 'image/jpeg':
                // 整图缩小后保留 JPEG 和完整色度，减少再次编码对截图文字的损伤。
                return 'image/jpeg';
            case 'image/webp':
                return 'image/webp';
            case 'image/png':
            case 'image/gif':
            default:
                // PNG is lossless and also converts unsupported image/* inputs to
                // one of the formats DeepSeek officially accepts.
                return 'image/png';
        }
    }

    private async encodeImage(pipeline: any, mimeType: string): Promise<Buffer> {
        switch (mimeType) {
            case 'image/jpeg':
                return pipeline.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
            case 'image/webp':
                return pipeline.webp({ lossless: true }).toBuffer();
            case 'image/png':
            default:
                return pipeline.png({ compressionLevel: 9 }).toBuffer();
        }
    }

    private getOrientedDimensions(metadata: any): { width: number; height: number } | null {
        if (!metadata?.width || !metadata?.height) return null;
        const width = Number(metadata.width);
        const height = Number(metadata.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return null;
        }

        if (ORIENTATION_SWAP_VALUES.has(Number(metadata.orientation))) {
            return { width: height, height: width };
        }
        return { width, height };
    }


    /**
     * 把 GIF 动画按时间轴采样拆帧后逐帧发送。
     *
     * 沿用动画的时间轴采样：读取帧数和每帧延迟，按每秒最多 GIF_MAX_FPS 帧采样，
     * 把选中的帧渲染为 PNG 并复用 transformRasterImage 做等比例缩放，
     * 确保模型能看到动画的完整演进而不只是首帧。
     */
    private async transformGif(buffer: Buffer, displayName: string, id?: string): Promise<ContentPart[]> {
        const sharp = await this.getSharpFactory();
        if (!sharp) {
            throw this.sharpRequiredError('image/gif');
        }

        let frameCount = 1;
        let delays: number[] = [];
        try {
            const metadata = await sharp(buffer, { animated: true }).metadata();
            const parsedFrameCount = Number(metadata.pages);
            frameCount = Number.isFinite(parsedFrameCount) && parsedFrameCount > 0
                ? Math.max(1, Math.trunc(parsedFrameCount))
                : 1;
            const rawDelays = Array.isArray(metadata.delay) ? metadata.delay : [];
            // metadata.delay 在损坏/特殊 GIF 上可能少于或多于 pages：严格按 frameCount
            // 重建，缺项/非法项回落 100ms，多余项丢弃，后续索引永远有对应时间。
            delays = Array.from({ length: frameCount }, (_, index) => {
                const value = Number(rawDelays[index]);
                return Number.isFinite(value) && value > 0 ? value : GIF_DEFAULT_FRAME_DELAY_MS;
            });
        } catch (error) {
            throw new DeepSeekVisionPreprocessingError(`Unable to read GIF metadata: ${this.errorMessage(error)}`);
        }

        if (frameCount > DEEPSEEK_VISION_MAX_IMAGES) {
            throw new DeepSeekVisionPreprocessingError(
                `The GIF has ${frameCount} frames, exceeding DeepSeek's ${DEEPSEEK_VISION_MAX_IMAGES}-image request limit.`
            );
        }

        // 时间轴：每帧的起始时间（毫秒）。
        const frameStarts: number[] = [];
        let totalDurationMs = 0;
        for (const delay of delays) {
            frameStarts.push(totalDurationMs);
            totalDurationMs += delay;
        }

        const findFrameAt = (timeMs: number): number => {
            let index = 0;
            for (let i = 0; i < frameStarts.length; i++) {
                if (frameStarts[i] <= timeMs) {
                    index = i;
                } else {
                    break;
                }
            }
            return index;
        };

        // 采样：t = 0, GIF_FRAME_INTERVAL_MS, 2*GIF_FRAME_INTERVAL_MS, ...
        // 至少覆盖首帧；尾部最后一帧即使显示时间短也保留（避免动画结尾丢失）。
        const selectedFrames = new Set<number>();
        for (let sampleTime = 0; sampleTime < totalDurationMs; sampleTime += GIF_FRAME_INTERVAL_MS) {
            selectedFrames.add(findFrameAt(sampleTime));
        }
        selectedFrames.add(frameCount - 1);

        const result: ContentPart[] = [];
        const selectedIndexes = [...selectedFrames].sort((a, b) => a - b);
        // 帧提取+PNG 编码是 GIF 链路中的大头，按（GIF 哈希#帧号）缓存；
        // 帧的缩放结果由 rasterImageCache 兜底。
        const gifHash = contentHash(buffer);
        for (const frameIndex of selectedIndexes) {
            this.throwIfAborted();
            const frameCacheKey = `${gifHash}#${frameIndex}`;
            let frameBuffer = gifFrameCache.get(frameCacheKey);
            if (!frameBuffer) {
                frameBuffer = await this.renderGifFrame(sharp, buffer, frameIndex);
                gifFrameCache.set(frameCacheKey, frameBuffer, frameBuffer.length);
            }
            const frameImages = await this.transformRasterImage(frameBuffer, 'image/png');
            this.reserveProducedImages(frameImages.length);
            const startSeconds = (frameStarts[frameIndex] / 1000).toFixed(1);
            const endSeconds = ((frameStarts[frameIndex] + delays[frameIndex]) / 1000).toFixed(1);
            result.push({
                text: `[GIF frame ${frameIndex + 1}/${frameCount} (${startSeconds}s-${endSeconds}s): ${displayName}]`
            });
            result.push(...frameImages.map(image => ({
                inlineData: {
                    mimeType: image.mimeType,
                    data: image.data,
                    id,
                    name: `${displayName} frame-${frameIndex + 1}`
                }
            })));
        }

        return result;
    }

    /**
     * 提取 GIF 的单个帧并编码为 PNG（透明背景填充白色，避免模型把透明区域看作黑色）。
     *
     * 为什么必须显式指定 pages: 1：sharp/libvips 对 animated 输入会把所有帧读为
     * 垂直堆叠的 "toilet roll"（metadata.height = pages × pageHeight）。只给 page 而
     * 不给 pages 时，输出是从该帧到结尾的全部剩余帧的垂直卷——本地实测 62 帧 GIF
     * 的 frame 0 输出 240×15128（62 帧叠图），模型看到的是一张超长拼图而不是单帧。
     * pages: 1 让输出精确回到单帧，供后续缩放/压缩链路正常处理。
     */
    private async renderGifFrame(sharp: any, buffer: Buffer, frameIndex: number): Promise<Buffer> {
        return await sharp(buffer, { page: frameIndex, pages: 1, animated: true })
            .flatten({ background: '#ffffff' })
            .png({ compressionLevel: 9 })
            .toBuffer();
    }
    private async renderPdfPages(
        buffer: Buffer,
        onPage: (page: RenderedPdfPage) => Promise<void>
    ): Promise<void> {
        const cacheKey = contentHash(buffer);
        const cached = pdfRenderCache.get(cacheKey);
        if (cached) {
            for (const page of cached) {
                this.throwIfAborted();
                await onPage(page);
            }
            return;
        }

        const canvasModule = await getCanvas();
        const pdfjsModule = await getPdfjs();
        if (!canvasModule || !pdfjsModule) {
            throw new DeepSeekVisionPreprocessingError(
                'DeepSeek PDF vision requires the optional pdfjs-dist and @napi-rs/canvas dependencies.'
            );
        }

        const globalScope = globalThis as any;
        for (const name of ['DOMMatrix', 'Path2D', 'ImageData']) {
            if (!globalScope[name] && canvasModule[name]) {
                globalScope[name] = canvasModule[name];
            }
        }

        const pdfjs = pdfjsModule.default?.getDocument
            ? pdfjsModule.default
            : pdfjsModule;
        if (typeof pdfjs.getDocument !== 'function') {
            throw new DeepSeekVisionPreprocessingError('The installed pdfjs-dist module has no getDocument API.');
        }

        const pdfjsRoot = getDependencyPath('pdfjs-dist');
        if (pdfjsRoot) {
            const workerPath = path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs');
            const fallbackWorkerPath = path.join(pdfjsRoot, 'build', 'pdf.worker.mjs');
            const resolvedWorkerPath = fs.existsSync(workerPath) ? workerPath : fallbackWorkerPath;
            if (fs.existsSync(resolvedWorkerPath)) {
                pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolvedWorkerPath).href;
            }
        }

        const standardFontDataUrl = pdfjsRoot
            ? `${path.join(pdfjsRoot, 'standard_fonts')}${path.sep}`
            : undefined;
        const cMapRoot = pdfjsRoot && fs.existsSync(path.join(pdfjsRoot, 'cmaps'))
            ? path.join(pdfjsRoot, 'cmaps')
            : undefined;

        let document: any;
        try {
            document = await pdfjs.getDocument({
                data: new Uint8Array(buffer),
                disableWorker: true,
                useSystemFonts: false,
                disableFontFace: true,
                isOffscreenCanvasSupported: false,
                CanvasFactory: createNodeCanvasFactory(canvasModule),
                ...(standardFontDataUrl ? {
                    standardFontDataUrl,
                    StandardFontDataFactory: FileStandardFontDataFactory
                } : {}),
                ...(cMapRoot ? {
                    cMapUrl: `${cMapRoot}${path.sep}`,
                    cMapPacked: true,
                    CMapReaderFactory: FileCMapReaderFactory
                } : {})
            }).promise;
        } catch (error) {
            throw new DeepSeekVisionPreprocessingError(
                `Unable to read PDF attachment: ${this.errorMessage(error)}`
            );
        }

        // 只在完整文档渲染成功且原始页 PNG 总量不超过单项预算时缓存；一旦超出，
        // 立即释放已收集引用，后续页面仍逐页处理但不再为缓存保留第二份数据。
        let cachePages: RenderedPdfPage[] | null = [];
        let cacheBytes = 0;

        try {
            const pageCount = Number(document.numPages) || 0;
            if (pageCount <= 0) {
                throw new DeepSeekVisionPreprocessingError('The PDF attachment contains no pages.');
            }
            if (pageCount > DEEPSEEK_VISION_MAX_IMAGES) {
                throw new DeepSeekVisionPreprocessingError(
                    `The PDF has ${pageCount} pages, exceeding DeepSeek's ${DEEPSEEK_VISION_MAX_IMAGES}-image request limit.`
                );
            }

            for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
                this.throwIfAborted();
                let page: any;
                let canvas: any;
                let rendered: RenderedPdfPage;
                try {
                    page = await document.getPage(pageNumber);
                    const baseViewport = page.getViewport({ scale: PDF_RENDER_SCALE });
                    const basePixels = baseViewport.width * baseViewport.height;
                    const renderScale = basePixels > PDF_MAX_CANVAS_PIXELS
                        ? PDF_RENDER_SCALE * Math.sqrt(PDF_MAX_CANVAS_PIXELS / basePixels)
                        : PDF_RENDER_SCALE;
                    const viewport = page.getViewport({ scale: renderScale });
                    canvas = canvasModule.createCanvas(
                        Math.max(1, Math.ceil(viewport.width)),
                        Math.max(1, Math.ceil(viewport.height))
                    );
                    await page.render({
                        canvasContext: canvas.getContext('2d'),
                        viewport
                    }).promise;
                    rendered = {
                        data: canvas.toBuffer('image/png'),
                        pageNumber,
                        pageCount
                    };
                } catch (error) {
                    throw new DeepSeekVisionPreprocessingError(
                        `Unable to render PDF page ${pageNumber}: ${this.errorMessage(error)}`
                    );
                } finally {
                    await page?.cleanup?.();
                    if (canvas) {
                        canvas.width = 0;
                        canvas.height = 0;
                    }
                }

                if (cachePages) {
                    cacheBytes += rendered.data.length;
                    if (cacheBytes <= PDF_CACHE_MAX_ENTRY_BYTES) {
                        cachePages.push(rendered);
                    } else {
                        cachePages = null;
                    }
                }

                // 先处理当前页再继续 getPage：图片数量超限或转换失败会立即中止剩余页面。
                await onPage(rendered);
            }

            if (cachePages) {
                pdfRenderCache.set(cacheKey, cachePages, cacheBytes);
            }
        } finally {
            await this.cleanupPdf(document);
        }
    }

    private async cleanupPdf(document: any): Promise<void> {
        try {
            await document.cleanup?.();
        } catch {
            // cleanup is best effort; the rendered buffers are already detached.
        }
        try {
            await document.destroy?.();
        } catch {
            // cleanup is best effort.
        }
    }

    private reserveProducedImages(count: number): void {
        if (!Number.isInteger(count) || count < 0) {
            throw new DeepSeekVisionPreprocessingError('Invalid DeepSeek Vision output image count.');
        }
        if (this.imageCount + count > DEEPSEEK_VISION_MAX_IMAGES) {
            throw new DeepSeekVisionPreprocessingError(
                `DeepSeek Vision preprocessing would produce more than ${DEEPSEEK_VISION_MAX_IMAGES} images.`
            );
        }
        this.imageCount += count;
    }

    private replaceInputImageWithOutputs(outputCount: number): void {
        this.imageCount = Math.max(0, this.imageCount - 1);
        this.reserveProducedImages(outputCount);
    }

    private async getSharpFactory(): Promise<any | null> {
        if (!this.sharpFactoryPromise) {
            this.sharpFactoryPromise = getSharp();
        }
        return this.sharpFactoryPromise;
    }

    private sharpRequiredError(mimeType: string): DeepSeekVisionPreprocessingError {
        return new DeepSeekVisionPreprocessingError(
            `DeepSeek Vision preprocessing of ${mimeType} requires the optional sharp dependency.`
        );
    }

    private throwIfAborted(): void {
        if (this.abortSignal?.aborted) {
            throw new DeepSeekVisionPreprocessingError('DeepSeek Vision preprocessing was cancelled.');
        }
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

/** 为 DeepSeek Vision 请求准备不持久化的历史副本。 */
export async function prepareDeepSeekVisionHistory(
    history: Content[],
    model?: string,
    enabled: boolean = true,
    abortSignal?: AbortSignal
): Promise<Content[]> {
    if (!enabled || !isDeepSeekVisionModel(model)) {
        return history;
    }

    const processor = new DeepSeekVisionProcessor(abortSignal);
    const transformed = await processor.transformHistory(history);
    const imageCount = countHistoryImages(transformed);
    if (imageCount > DEEPSEEK_VISION_MAX_IMAGES) {
        throw new DeepSeekVisionPreprocessingError(
            `DeepSeek Vision requests support at most ${DEEPSEEK_VISION_MAX_IMAGES} images; preprocessing produced ${imageCount}.`
        );
    }
    return transformed;
}

/** 统计统一 Content 历史中所有顶层及嵌套图片。 */
export function countHistoryImages(history: Content[]): number {
    let count = 0;
    const visitParts = (parts: ContentPart[]): void => {
        for (const part of parts) {
            if (part.inlineData && part.inlineData.mimeType.toLowerCase().startsWith('image/')) {
                count++;
            }
            if (part.fileData && part.fileData.mimeType.toLowerCase().startsWith('image/')) {
                count++;
            }
            if (part.functionResponse?.parts) {
                visitParts(part.functionResponse.parts);
            }
        }
    };

    for (const content of history) {
        if (content.role === 'user') {
            visitParts(content.parts);
        }
    }
    return count;
}

interface DeepSeekImagePayload {
    encodedBytes: number;
    isImage: boolean;
}

/**
 * 校验 formatter 最终生成的 DeepSeek 请求体。
 * 这一步放在 formatter 之后，因此也会覆盖 custom body 注入的内容大小。
 */
export function validateDeepSeekVisionRequestBody(body: unknown): void {
    let serialized: string;
    try {
        serialized = JSON.stringify(body);
    } catch (error) {
        throw new DeepSeekVisionPreprocessingError(
            `Unable to measure the DeepSeek Vision request body: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    const requestBytes = Buffer.byteLength(serialized, 'utf8');
    if (requestBytes > DEEPSEEK_VISION_MAX_REQUEST_BYTES) {
        throw new DeepSeekVisionPreprocessingError(
            `DeepSeek Vision request body is ${requestBytes} bytes, exceeding the ${DEEPSEEK_VISION_MAX_REQUEST_BYTES}-byte limit.`
        );
    }

    const payloads: DeepSeekImagePayload[] = [];
    const visited = new Set<object>();
    const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (visited.has(value as object)) return;
        visited.add(value as object);

        const item = value as any;
        if (item.type === 'image_url') {
            const url = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
            if (typeof url === 'string') {
                payloads.push({
                    encodedBytes: getDataUrlPayloadBytes(url),
                    isImage: true
                });
            }
        } else if (item.type === 'input_image') {
            const url = item.image_url;
            if (typeof url === 'string') {
                payloads.push({
                    encodedBytes: getDataUrlPayloadBytes(url),
                    isImage: true
                });
            }
        } else if (item.type === 'image' && item.source?.type === 'base64') {
            const data = typeof item.source.data === 'string' ? item.source.data : '';
            payloads.push({
                encodedBytes: data.length,
                isImage: true
            });
        }

        for (const nested of Object.values(item)) {
            visit(nested);
        }
    };
    visit(body);

    if (payloads.length > DEEPSEEK_VISION_MAX_IMAGES) {
        throw new DeepSeekVisionPreprocessingError(
            `DeepSeek Vision request contains ${payloads.length} images, exceeding the ${DEEPSEEK_VISION_MAX_IMAGES}-image limit.`
        );
    }

    for (const payload of payloads) {
        if (!payload.isImage || payload.encodedBytes <= 0) continue;
        const decodedBytes = Math.floor((payload.encodedBytes * 3) / 4);
        if (decodedBytes > DEEPSEEK_VISION_MAX_IMAGE_BYTES) {
            throw new DeepSeekVisionPreprocessingError(
                `A DeepSeek Vision image is ${decodedBytes} bytes, exceeding the ${DEEPSEEK_VISION_MAX_IMAGE_BYTES}-byte limit.`
            );
        }
    }
}

function getDataUrlPayloadBytes(url: string): number {
    const comma = url.indexOf(',');
    if (comma < 0 || !url.slice(0, comma).toLowerCase().startsWith('data:')) {
        // External URLs still count as images, but have no inline byte payload to check.
        return 0;
    }
    return url.length - comma - 1;
}
