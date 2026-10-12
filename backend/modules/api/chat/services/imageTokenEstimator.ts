import { imageSize } from 'image-size';
import type { TokenizerOptions } from '../../../../../packages/core/src/tokenizer';

export interface ImageTokenInput {
    mimeType: string;
    data: string;
    width?: number;
    height?: number;
    detail?: 'low' | 'high' | 'original' | 'auto';
}

export interface ImageTokenEstimate {
    tokens: number;
    source: 'model-image-rule' | 'generic-image-baseline';
    rule: string;
}

const imageDimensions = new WeakMap<ImageTokenInput, { data: string; width: number; height: number } | null>();

/** 只读取文件头中的尺寸，不解码像素；同一附件对象不会在每次预算时重新解 Base64。 */
function dimensions(input: ImageTokenInput): { width: number; height: number } | undefined {
    if (input.width && input.height) return { width: input.width, height: input.height };
    const cached = imageDimensions.get(input);
    if (cached?.data === input.data) return cached;
    if (cached === null) return undefined;
    try {
        const size = imageSize(Buffer.from(input.data, 'base64'));
        if (size.width && size.height) {
            const value = { data: input.data, width: size.width, height: size.height };
            imageDimensions.set(input, value);
            return value;
        }
    } catch {
        // File API 引用和不可识别的图片没有可用尺寸，调用方会明确报告媒体基准。
    }
    imageDimensions.set(input, null);
    return undefined;
}

function patchCount(width: number, height: number, patch: number, maxDimension: number, budget: number): number {
    const initialScale = Math.min(1, maxDimension / Math.max(width, height));
    width = Math.max(1, Math.floor(width * initialScale));
    height = Math.max(1, Math.floor(height * initialScale));
    const original = Math.ceil(width / patch) * Math.ceil(height / patch);
    if (original <= budget) return original;
    // 供应方按完整 patch 覆盖缩放后的图片；保留比例并收紧至可容纳的整数 patch 边界。
    const shrink = Math.sqrt(patch * patch * budget / (width * height));
    const scaledWidth = width * shrink / patch;
    const scaledHeight = height * shrink / patch;
    const scale = shrink * Math.min(Math.floor(scaledWidth) / scaledWidth, Math.floor(scaledHeight) / scaledHeight);
    return Math.ceil(Math.max(1, Math.floor(width * scale)) / patch) * Math.ceil(Math.max(1, Math.floor(height * scale)) / patch);
}

/** Claude 对填充后的 28px 网格限额做长边二分，规则与 OpenAI 的缩放不同。 */
function claudePatchCount(width: number, height: number, maxEdge: number, budget: number): number {
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const patches = (edge: number) => Math.ceil(edge / 28) * Math.ceil(Math.max(1, Math.round(edge * short / long)) / 28);
    if (Math.ceil(long / 28) * 28 <= maxEdge && patches(long) <= budget) return patches(long);
    let low = 1;
    let high = long;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (Math.ceil(middle / 28) * 28 <= maxEdge && patches(middle) <= budget) low = middle;
        else high = middle;
    }
    return patches(low);
}

/**
 * 图片计数采用供应方公开规则，返回值仍是输入预算估算。
 * OpenAI: https://developers.openai.com/api/docs/guides/images-vision
 * Claude: https://platform.claude.com/docs/en/build-with-claude/vision
 * Gemini: https://ai.google.dev/gemini-api/docs/media-resolution
 */
export function estimateImageTokens(input: ImageTokenInput, options: TokenizerOptions = {}): ImageTokenEstimate {
    const model = options.model?.toLowerCase() ?? '';
    if (/^gemini-3(?:[.-]|$)/.test(model)) {
        const resolution = options.mediaResolution ?? 'high';
        const tokens = { low: 280, medium: 560, high: 1120, ultra_high: 2240 }[resolution];
        return { tokens, source: 'model-image-rule', rule: 'gemini-3-media-resolution' };
    }
    const size = dimensions(input);
    if (!size) return { tokens: 1600, source: 'generic-image-baseline', rule: 'unknown-image-dimensions' };
    const { width, height } = size;
    const detail = input.detail ?? options.imageDetail ?? 'auto';

    if (/^claude-/.test(model)) {
        const version = model.match(/(?:opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/) ?? model.match(/^claude-(\d+)(?:[.-](\d+))?/);
        const highResolution = !!version && (Number(version[1]) > 4 || (Number(version[1]) === 4 && Number(version[2]) >= 7));
        return {
            tokens: claudePatchCount(width, height, highResolution ? 2576 : 1568, highResolution ? 4784 : 1568),
            source: 'model-image-rule', rule: highResolution ? 'claude-high-resolution-patches' : 'claude-standard-patches'
        };
    }
    if (/^gemini-[12](?:[.-]|$)/.test(model)) {
        const crop = Math.max(1, Math.min(768, Math.floor(Math.min(width, height) / 1.5)));
        return { tokens: width <= 384 && height <= 384 ? 258 : Math.ceil(width / crop) * Math.ceil(height / crop) * 258,
            source: 'model-image-rule', rule: 'gemini-image-tiles' };
    }

    const currentPatchModel = /^gpt-(?:6-astra|5\.(?:[2456]))(?:[.-]|$)/.test(model);
    const smallPatchModel = /^(?:gpt-4\.1-(?:mini|nano)|gpt-5-(?:mini|nano)|o4-mini)(?:-|$)/.test(model);
    if (currentPatchModel || smallPatchModel) {
        let maxDimension = 2048;
        let budget = 6144;
        let multiplier = 1.2;
        if (/gpt-4\.1-mini/.test(model)) multiplier = 1.62;
        else if (/gpt-4\.1-nano/.test(model)) { multiplier = 2.46; budget = 1536; }
        else if (/gpt-5-nano/.test(model)) { multiplier = 1.5; budget = 1536; }
        else if (/o4-mini/.test(model)) { multiplier = 1.72; budget = 1536; }
        else if (/gpt-5-mini/.test(model)) budget = 1536;
        if (/^gpt-(?:6-astra|5\.[456])(?:[.-]|$)/.test(model)) {
            const modern = /^gpt-(?:6-astra|5\.[56])(?:[.-]|$)/.test(model);
            const original = detail === 'original' || (detail === 'auto' && modern);
            if (original) {
                const uncapped = /^gpt-(?:6-astra|5\.6)(?:[.-]|$)/.test(model);
                maxDimension = uncapped ? 65535 : 6000;
                budget = uncapped ? Infinity : 10000;
            } else if (detail === 'low' && modern) {
                maxDimension = 512;
                budget = Infinity;
            } else if (detail !== 'low') {
                maxDimension = model.startsWith('gpt-6-astra') ? 65535 : 2048;
                budget = 2500;
            }
        }
        return { tokens: Math.ceil(patchCount(width, height, 32, maxDimension, budget) * multiplier),
            source: 'model-image-rule', rule: 'openai-image-patches' };
    }

    const mini = /^gpt-4o-mini(?:-|$)/.test(model);
    const gpt5Tiles = /^gpt-5(?:\.1)?(?:-|$)/.test(model);
    const reasoningTiles = /^(?:o1|o1-pro|o3)(?:-|$)/.test(model);
    if (mini || gpt5Tiles || reasoningTiles || /^(?:gpt-4o|gpt-4\.1)(?:-|$)/.test(model)) {
        const base = mini ? 2833 : gpt5Tiles ? 70 : reasoningTiles ? 75 : 85;
        const tile = mini ? 5667 : gpt5Tiles ? 140 : reasoningTiles ? 150 : 170;
        const scale = Math.min(1, 2048 / Math.max(width, height), 768 / Math.min(width, height));
        const tiles = Math.ceil(Math.floor(width * scale) / 512) * Math.ceil(Math.floor(height * scale) / 512);
        return { tokens: detail === 'low' ? base : base + tile * tiles, source: 'model-image-rule', rule: 'openai-image-tiles' };
    }
    return { tokens: Math.min(1600, Math.ceil(width * height / 750)), source: 'generic-image-baseline', rule: 'generic-pixel-area' };
}
