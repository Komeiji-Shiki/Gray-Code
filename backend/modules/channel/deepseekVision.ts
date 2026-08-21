/**
 * DeepSeek Vision 专用输入预处理。
 *
 * DeepSeek Vision 会把较大的图片按约 800×800 的总像素数缩小。这里在请求
 * 发出前把图片切成不超过该像素预算的完整分块，并把 PDF 栅格化为逐页图片，
 * 使模型看到的是原始分辨率的多个局部，而不是服务端缩小后的整张图。
 */

import * as path from 'path';
import type { Content, ContentPart } from '../conversation/types';
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

class DeepSeekVisionProcessor {
    private sharpFactoryPromise?: Promise<any | null>;

    constructor(private readonly abortSignal?: AbortSignal) {}

    async transformHistory(history: Content[]): Promise<Content[]> {
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
            // 使 Responses formatter 的工具输出路径也能获得相同的 PDF/分块能力。
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
            const pages = await this.renderPdf(buffer);
            const result: ContentPart[] = [];
            const displayName = inlineData.name || 'attachment.pdf';

            for (const page of pages) {
                this.throwIfAborted();
                const pageImages = await this.transformRasterImage(page.data, 'image/png');
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

        const images = await this.transformRasterImage(buffer, mimeType);
        const { inlineData: _inlineData, ...partMetadata } = part;
        return images.map((image, index) => ({
            ...partMetadata,
            inlineData: {
                mimeType: image.mimeType,
                data: image.data,
                id: inlineData.id,
                name: inlineData.name
                    ? `${inlineData.name} tile-${index + 1}`
                    : undefined
            }
        }));
    }

    private async transformRasterImage(buffer: Buffer, inputMimeType: string): Promise<EncodedImage[]> {
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
    private async transformGif(buffer: Buffer, displayName: string, id?: string): Promise<ContentPart[]> {
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
        for (const frameIndex of selectedIndexes) {
            this.throwIfAborted();
            const frameBuffer = await this.renderGifFrame(sharp, buffer, frameIndex);
            const frameImages = await this.transformRasterImage(frameBuffer, 'image/png');
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

        const standardFontsRoot = getDependencyPath('pdfjs-dist');
        const standardFontDataUrl = standardFontsRoot
            ? `${path.join(standardFontsRoot, 'standard_fonts')}${path.sep}`
            : undefined;

        let document: any;
        try {
            document = await pdfjs.getDocument({
                data: new Uint8Array(buffer),
                disableWorker: true,
                useSystemFonts: false,
                ...(standardFontDataUrl ? { standardFontDataUrl } : {})
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
