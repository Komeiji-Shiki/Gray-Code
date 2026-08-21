/**
 * DeepSeek Vision 专用输入预处理。
 *
 * DeepSeek Vision 会把较大的图片按约 800×800 的总像素数缩小。这里在请求
 * 发出前把图片切成不超过该像素预算的完整分块，并把 PDF 栅格化为逐页图片，
 * 使模型看到的是原始分辨率的多个局部，而不是服务端缩小后的整张图。
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
} from '../dependencies';

/** DeepSeek 官方 Vision 实验模型 ID。 */
export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp';

/** DeepSeek 对较大图片的近似总像素预算。 */
export const DEEPSEEK_VISION_MAX_TILE_PIXELS = 800 * 800;

/**
 * 对包含较多图片的请求使用更严格的长边上限。
 * 统一使用 4096，避免图片数量增加到 15 张后触发 DeepSeek 的另一档限制。
 */
export const DEEPSEEK_VISION_MAX_TILE_LONG_EDGE = 4096;

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
/** 图片分块结果缓存：最多 64 个条目。 */
const RASTER_CACHE_MAX_ENTRIES = 64;
/** 图片分块结果缓存：总字节预算 64 MiB（按 base64 编码后长度计）。 */
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

export interface DeepSeekTileGrid {
    columns: number;
    rows: number;
}

export interface DeepSeekTileRegion {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * DeepSeek Vision 只对明确的视觉模型启用图片预处理。
 *
 * 除官方完整模型名外，允许兼容端点在模型名后添加 :free、版本标签等后缀，
 * 但不会把普通 DeepSeek 文本模型误判为可接收图片的模型。
 */
export function isDeepSeekVisionModel(model?: string): boolean {
    const normalized = model?.trim().toLowerCase() ?? '';
    return normalized.includes('deepseek') && normalized.includes('vision');
}

/**
 * 计算把图片等比例缩放至 DeepSeek 像素预算（约 800×800 总像素）内的目标尺寸。
 *
 * 与 calculateDeepSeekTileGrid 不同，这里不拆分图片，而是主动把整张图缩小到
 * 预算以内（保持宽高比），让 DeepSeek 无法触发服务端压缩；原图已满足预算时
 * 原样返回，避免无谓的重编码损失。
 *
 * 同时约束长边不超过 DEEPSEEK_VISION_MAX_TILE_LONG_EDGE：极端超宽/超高的
 * 全景图虽然总像素不高，但单边长可能触发 DeepSeek 的另一档服务端限制
 * （与 tile 网格的长边约束同口径）。
 */
export function calculateDeepSeekDownscaleSize(width: number, height: number): { width: number; height: number } {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new DeepSeekVisionPreprocessingError('Image dimensions must be positive integers.');
    }

    const scale = Math.min(
        Math.sqrt(DEEPSEEK_VISION_MAX_TILE_PIXELS / (width * height)),
        DEEPSEEK_VISION_MAX_TILE_LONG_EDGE / Math.max(width, height)
    );
    if (scale >= 1) {
        return { width, height };
    }
    return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale))
    };
}

/**
 * 根据原图尺寸计算分块网格。
 *
 * 网格中的每个实际分块都满足：
 * - 总像素数不超过 DEEPSEEK_VISION_MAX_TILE_PIXELS；
 * - 长边不超过 DEEPSEEK_VISION_MAX_TILE_LONG_EDGE。
 *
 * 在分块数相同时，优先选择更接近原图宽高比的分块形状，减少不必要的分块。
 */
export function calculateDeepSeekTileGrid(width: number, height: number): DeepSeekTileGrid {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new DeepSeekVisionPreprocessingError('Image dimensions must be positive integers.');
    }

    const minimumColumns = Math.max(1, Math.ceil(width / DEEPSEEK_VISION_MAX_TILE_LONG_EDGE));
    const idealColumns = Math.max(
        minimumColumns,
        Math.ceil(Math.sqrt((width * height) / DEEPSEEK_VISION_MAX_TILE_PIXELS))
    );

    // 只在实际可能的列数附近搜索；极端超宽图片仍由 minimumColumns 覆盖。
    const maximumColumns = Math.min(
        width,
        Math.max(minimumColumns, Math.min(16_384, idealColumns + 256))
    );

    let best: {
        grid: DeepSeekTileGrid;
        count: number;
        aspectDistance: number;
    } | undefined;

    for (let columns = minimumColumns; columns <= maximumColumns; columns++) {
        const tileWidth = Math.ceil(width / columns);
        const heightPerTileByPixels = Math.floor(DEEPSEEK_VISION_MAX_TILE_PIXELS / tileWidth);
        if (heightPerTileByPixels <= 0) continue;

        let rows = Math.max(
            1,
            Math.ceil(height / DEEPSEEK_VISION_MAX_TILE_LONG_EDGE),
            Math.ceil(height / heightPerTileByPixels)
        );

        // 由于 ceil(width / columns) 与最后一行的实际尺寸可能不同，最终复核。
        while (
            tileWidth * Math.ceil(height / rows) > DEEPSEEK_VISION_MAX_TILE_PIXELS
            || Math.ceil(height / rows) > DEEPSEEK_VISION_MAX_TILE_LONG_EDGE
        ) {
            rows++;
        }

        const tileHeight = Math.ceil(height / rows);
        const count = columns * rows;
        const originalAspect = width / height;
        const tileAspect = tileWidth / tileHeight;
        const aspectDistance = Math.abs(Math.log(tileAspect / originalAspect));

        if (
            !best
            || count < best.count
            || (count === best.count && aspectDistance < best.aspectDistance)
        ) {
            best = {
                grid: { columns, rows },
                count,
                aspectDistance
            };
        }
    }

    // 正常尺寸一定会在 minimumColumns 处得到候选；保留明确错误而不是返回非法网格。
    if (!best) {
        throw new DeepSeekVisionPreprocessingError('Unable to calculate a safe image tile grid.');
    }

    return best.grid;
}

/** 根据网格生成无重叠、无空洞的行优先分块区域。 */
export function buildDeepSeekTileRegions(
    width: number,
    height: number,
    grid: DeepSeekTileGrid = calculateDeepSeekTileGrid(width, height)
): DeepSeekTileRegion[] {
    const regions: DeepSeekTileRegion[] = [];

    for (let row = 0; row < grid.rows; row++) {
        const top = Math.floor((row * height) / grid.rows);
        const bottom = Math.floor(((row + 1) * height) / grid.rows);
        for (let column = 0; column < grid.columns; column++) {
            const left = Math.floor((column * width) / grid.columns);
            const right = Math.floor(((column + 1) * width) / grid.columns);
            regions.push({
                left,
                top,
                width: right - left,
                height: bottom - top
            });
        }
    }

    return regions;
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

    constructor(private readonly abortSignal?: AbortSignal) {}

    async transformHistory(history: Content[], tileSplit: boolean = true): Promise<Content[]> {
        const transformed: Content[] = [];

        for (const content of history) {
            this.throwIfAborted();

            // DeepSeek Vision 只允许图片出现在 user 输入中。工具返回的多媒体
            // 通常也已经归入 user 消息；assistant/system 历史保持原样，避免改变
            // 既有工具/思考回放语义。
            if (content.role !== 'user') {
                transformed.push(content);
                continue;
            }

            const parts = await this.transformParts(content.parts, tileSplit);
            transformed.push({ ...content, parts });
        }

        return transformed;
    }

    private async transformParts(parts: ContentPart[], tileSplit: boolean): Promise<ContentPart[]> {
        const result: ContentPart[] = [];

        for (const part of parts) {
            this.throwIfAborted();

            // Gemini function response 可以在 parts 中嵌套多媒体。递归处理，
            // 使 Responses formatter 的工具输出路径也能获得相同的 PDF/分块能力。
            if (part.functionResponse?.parts) {
                const nestedParts = await this.transformParts(part.functionResponse.parts, tileSplit);
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

            const transformedInlineParts = await this.transformInlineData(part, tileSplit);
            result.push(...transformedInlineParts);
        }

        return result;
    }

    private async transformInlineData(part: ContentPart, tileSplit: boolean): Promise<ContentPart[]> {
        const inlineData = part.inlineData!;
        const mimeType = inlineData.mimeType.trim().toLowerCase();
        const buffer = Buffer.from(inlineData.data, 'base64');

        if (mimeType === 'application/pdf') {
            const pages = await this.renderPdf(buffer);
            const result: ContentPart[] = [];
            const displayName = inlineData.name || 'attachment.pdf';

            for (const page of pages) {
                this.throwIfAborted();
                const pageImages = await this.transformRasterImage(page.data, 'image/png', tileSplit);
                result.push({
                    text: `[PDF page ${page.pageNumber}/${page.pageCount}: ${displayName}]`
                });
                result.push(...pageImages.map((image, index) => ({
                    inlineData: {
                        mimeType: image.mimeType,
                        data: image.data,
                        id: inlineData.id,
                        name: `${displayName} page-${page.pageNumber}-tile-${index + 1}`
                    }
                })));
            }

            return result;
        }

        if (mimeType === 'image/gif') {
            // 修改原因：DeepSeek 对 GIF 只取第一帧。这里按时间轴采样（每秒最多
            // GIF_MAX_FPS 帧）把动画拆成多张 PNG，让模型看到完整动画内容。
            return this.transformGif(buffer, inlineData.name || 'attachment.gif', inlineData.id, tileSplit);
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
            // 已经可发送的图片，图片分块能力则由可选依赖提供。
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
            || dimensions.width * dimensions.height > DEEPSEEK_VISION_MAX_TILE_PIXELS
            || Math.max(dimensions.width, dimensions.height) > DEEPSEEK_VISION_MAX_TILE_LONG_EDGE
            || rawBytes > DEEPSEEK_VISION_MAX_IMAGE_BYTES;

        if (!needsTransform) {
            return [part];
        }

        const images = await this.transformRasterImage(buffer, mimeType, tileSplit);
        const { inlineData: _inlineData, ...partMetadata } = part;
        return images.map((image, index) => ({
            ...partMetadata,
            inlineData: {
                mimeType: image.mimeType,
                data: image.data,
                id: inlineData.id,
                name: inlineData.name
                    ? (images.length > 1 ? `${inlineData.name} tile-${index + 1}` : inlineData.name)
                    : undefined
            }
        }));
    }

    private async transformRasterImage(buffer: Buffer, inputMimeType: string, tileSplit: boolean = true): Promise<EncodedImage[]> {
        // 缓存命中：同一图片字节（含 PDF 页 PNG、GIF 帧 PNG）的处理结果复用。
        // 缓存键必须包含处理模式：分块与压缩是两种不同输出，混用会把压缩图送去分块
        // （或把分块图送去压缩）导致请求内容漂移。
        const mode = tileSplit ? 'tile' : 'downscale';
        const cacheKey = `${contentHash(buffer)}|${inputMimeType}|${mode}`;
        const cached = rasterImageCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        if (!tileSplit) {
            return this.downscaleRasterImage(buffer, inputMimeType, cacheKey);
        }

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

        const grid = calculateDeepSeekTileGrid(dimensions.width, dimensions.height);
        const regions = buildDeepSeekTileRegions(dimensions.width, dimensions.height, grid);
        const outputMimeType = this.chooseOutputMimeType(inputMimeType);
        const encoded: EncodedImage[] = [];

        for (const region of regions) {
            this.throwIfAborted();

            // rotate() without arguments applies EXIF orientation before extract,
            // so a portrait JPEG with orientation metadata is tiled in visual order.
            let pipeline = sharp(buffer).rotate();
            const isWholeImage = regions.length === 1
                && region.left === 0
                && region.top === 0
                && region.width === dimensions.width
                && region.height === dimensions.height;

            if (!isWholeImage) {
                pipeline = pipeline.extract(region);
            }

            const output = await this.encodeImage(pipeline, outputMimeType);
            if (output.length > DEEPSEEK_VISION_MAX_IMAGE_BYTES) {
                throw new DeepSeekVisionPreprocessingError(
                    `A processed DeepSeek image is still larger than ${DEEPSEEK_VISION_MAX_IMAGE_BYTES} bytes.`
                );
            }

            encoded.push({
                mimeType: outputMimeType,
                data: output.toString('base64'),
                width: region.width,
                height: region.height
            });
        }

        const totalBytes = encoded.reduce((sum, image) => sum + image.data.length, 0);
        rasterImageCache.set(cacheKey, encoded, totalBytes);
        return encoded;
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

        // rotate() without arguments applies EXIF orientation before resize,
        // so a portrait JPEG with orientation metadata is downscaled in visual order.
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
                // Preserve JPEG without the additional chroma loss caused by a
                // default-quality re-encode; DeepSeek is the component doing the
                // requested vision resize, not this preprocessing stage.
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
     * 背景：DeepSeek 对 GIF 只取第一帧。这里读取动画元数据（帧数 + 每帧延迟），
     * 按每秒最多 GIF_MAX_FPS 帧（GIF_FRAME_INTERVAL_MS 间隔）在时间轴上采样，
     * 把选中的帧渲染为 PNG 并复用 transformRasterImage 做大小分块，
     * 确保模型能看到动画的完整演进而不只是首帧。
     */
    private async transformGif(buffer: Buffer, displayName: string, id?: string, tileSplit: boolean = true): Promise<ContentPart[]> {
        const sharp = await this.getSharpFactory();
        if (!sharp) {
            throw this.sharpRequiredError('image/gif');
        }

        let frameCount = 1;
        let delays: number[] = [];
        try {
            const metadata = await sharp(buffer, { animated: true }).metadata();
            frameCount = Number(metadata.pages) || 1;
            // delay 数组单位是毫秒（libvips 语义）；缺失时按每帧 100ms 估算时间轴。
            delays = Array.isArray(metadata.delay)
                ? metadata.delay.map((d: number) => (Number.isFinite(d) && Number(d) > 0 ? Number(d) : GIF_DEFAULT_FRAME_DELAY_MS))
                : Array.from({ length: frameCount }, () => GIF_DEFAULT_FRAME_DELAY_MS);
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
        // 帧的分块结果由 rasterImageCache 兜底。
        const gifHash = contentHash(buffer);
        for (const frameIndex of selectedIndexes) {
            this.throwIfAborted();
            const frameCacheKey = `${gifHash}#${frameIndex}`;
            let frameBuffer = gifFrameCache.get(frameCacheKey);
            if (!frameBuffer) {
                frameBuffer = await this.renderGifFrame(sharp, buffer, frameIndex);
                gifFrameCache.set(frameCacheKey, frameBuffer, frameBuffer.length);
            }
            const frameImages = await this.transformRasterImage(frameBuffer, 'image/png', tileSplit);
            const startSeconds = (frameStarts[frameIndex] / 1000).toFixed(1);
            const endSeconds = ((frameStarts[frameIndex] + delays[frameIndex]) / 1000).toFixed(1);
            result.push({
                text: `[GIF frame ${frameIndex + 1}/${frameCount} (${startSeconds}s-${endSeconds}s): ${displayName}]`
            });
            result.push(...frameImages.map((image, index) => ({
                inlineData: {
                    mimeType: image.mimeType,
                    data: image.data,
                    id,
                    name: `${displayName} frame-${frameIndex + 1}-tile-${index + 1}`
                }
            })));
        }

        return result;
    }

    /** 提取 GIF 的单个帧并编码为 PNG（透明背景填充白色，避免模型把透明区域看作黑色）。 */
    private async renderGifFrame(sharp: any, buffer: Buffer, frameIndex: number): Promise<Buffer> {
        return await sharp(buffer, { page: frameIndex, animated: true })
            .flatten({ background: '#ffffff' })
            .png({ compressionLevel: 9 })
            .toBuffer();
    }
    private async renderPdf(buffer: Buffer): Promise<RenderedPdfPage[]> {
        // 缓存命中：同一份 PDF 字节在多轮对话/请求转发/token 估算之间复用，
        // 不再重新 getDocument + 逐页栅格化。
        const cacheKey = contentHash(buffer);
        const cached = pdfRenderCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const canvasModule = await getCanvas();
        const pdfjsModule = await getPdfjs();
        if (!canvasModule || !pdfjsModule) {
            throw new DeepSeekVisionPreprocessingError(
                'DeepSeek PDF vision requires the optional pdfjs-dist and @napi-rs/canvas dependencies.'
            );
        }

        // pdfjs uses these browser globals while drawing standard font paths.
        // @napi-rs/canvas provides compatible Node implementations.
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

        // pdfjs-dist 4.x 的 fake worker（disableWorker: true）内部仍会执行
        // `await import(workerSrc)` 加载 pdf.worker.mjs；若不设置 GlobalWorkerOptions.workerSrc，
        // PDFWorker.workerSrc getter 会直接抛 "No GlobalWorkerOptions.workerSrc specified."。
        // Node 环境下 import() 需要 file:// URL，裸路径会解析失败（ERR_MODULE_NOT_FOUND）。
        // 主模块走的是 legacy build（getPdfjs 加载 legacy/build/pdf.mjs），fake worker
        // 必须对应加载 legacy/build/pdf.worker.mjs，避免浏览器构建在 Node 下访问 DOM API 失败。
        const pdfjsRoot = getDependencyPath('pdfjs-dist');
        if (pdfjsRoot) {
            const workerPath = path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.mjs');
            const fallbackWorkerPath = path.join(pdfjsRoot, 'build', 'pdf.worker.mjs');
            const resolvedWorkerPath = fs.existsSync(workerPath) ? workerPath : fallbackWorkerPath;
            if (fs.existsSync(resolvedWorkerPath)) {
                pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolvedWorkerPath).href;
            }
        }

        const standardFontsRoot = pdfjsRoot;
        const standardFontDataUrl = standardFontsRoot
            ? `${path.join(standardFontsRoot, 'standard_fonts')}${path.sep}`
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
                // isNodeJS=false 的宿主（VS Code/Electron）中 pdf.js 默认走 DOM 路径：
                // disableFontFace 默认 false → FontLoader 访问 document（style/fonts），
                // isOffscreenCanvasSupported 默认 true → worker 侧 OffscreenCanvas 检测。
                // 与 Node 默认行为对齐需要显式关闭；字体数据由下方工厂从文件系统读取。
                disableFontFace: true,
                isOffscreenCanvasSupported: false,
                // 显式注入 Node 画布工厂：默认工厂在 isNodeJS=false 宿主中为
                // DOMCanvasFactory，渲染透明分组/注解页时访问 document.createElement 崩溃。
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

        const pageCount = Number(document.numPages) || 0;
        if (pageCount <= 0) {
            await this.cleanupPdf(document);
            throw new DeepSeekVisionPreprocessingError('The PDF attachment contains no pages.');
        }
        if (pageCount > DEEPSEEK_VISION_MAX_IMAGES) {
            await this.cleanupPdf(document);
            throw new DeepSeekVisionPreprocessingError(
                `The PDF has ${pageCount} pages, exceeding DeepSeek's ${DEEPSEEK_VISION_MAX_IMAGES}-image request limit.`
            );
        }

        const pages: RenderedPdfPage[] = [];
        try {
            for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
                this.throwIfAborted();
                const page = await document.getPage(pageNumber);
                const baseViewport = page.getViewport({ scale: PDF_RENDER_SCALE });
                const basePixels = baseViewport.width * baseViewport.height;
                const renderScale = basePixels > PDF_MAX_CANVAS_PIXELS
                    ? PDF_RENDER_SCALE * Math.sqrt(PDF_MAX_CANVAS_PIXELS / basePixels)
                    : PDF_RENDER_SCALE;
                const viewport = page.getViewport({ scale: renderScale });
                const canvas = canvasModule.createCanvas(
                    Math.max(1, Math.ceil(viewport.width)),
                    Math.max(1, Math.ceil(viewport.height))
                );

                try {
                    await page.render({
                        canvasContext: canvas.getContext('2d'),
                        viewport
                    }).promise;
                    pages.push({
                        data: canvas.toBuffer('image/png'),
                        pageNumber,
                        pageCount
                    });
                } finally {
                    page.cleanup?.();
                }
            }
        } catch (error) {
            throw new DeepSeekVisionPreprocessingError(
                `Unable to render PDF page: ${this.errorMessage(error)}`
            );
        } finally {
            await this.cleanupPdf(document);
        }

        const totalBytes = pages.reduce((sum, page) => sum + page.data.length, 0);
        pdfRenderCache.set(cacheKey, pages, totalBytes);
        return pages;
    }

    private async cleanupPdf(document: any): Promise<void> {
        try {
            document.cleanup?.();
        } catch {
            // cleanup is best effort; the rendered buffers are already detached.
        }
        try {
            await document.destroy?.();
        } catch {
            // cleanup is best effort.
        }
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
    abortSignal?: AbortSignal,
    tileSplit: boolean = true
): Promise<Content[]> {
    if (!enabled || !isDeepSeekVisionModel(model)) {
        return history;
    }

    const processor = new DeepSeekVisionProcessor(abortSignal);
    const transformed = await processor.transformHistory(history, tileSplit);
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
